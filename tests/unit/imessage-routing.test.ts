import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMessageBotBridge, sendMacOSIMessage } from "../../plugins/imessage/index.mjs";

function setup(chat?: any) {
	const exec = vi.fn().mockResolvedValue({ stdout: "[]" });
	const host = {
		chat: chat || vi.fn().mockResolvedValue({ conversationId: "real", runId: "run" }),
		abortRun: vi.fn().mockResolvedValue({ ok: true }),
		cwd: process.cwd(),
	};
	const bridge = new IMessageBotBridge({ host, getConfig: () => ({}), execFileImpl: exec });
	return { bridge, exec, host };
}
const msg = (text: string, chatId = "room", extra: any = {}) => ({ sender: "a@example.com", chatId, text, ...extra });

describe("iMessage command, routing and media behavior", () => {
	it("buffers early completion and uses runId after takeover", async () => {
		const { bridge, exec, host } = setup();
		host.chat = vi.fn(async () => {
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "real",
				runId: "r",
				message: { role: "assistant", content: "answer" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "moved", runId: "r" });
			return { conversationId: "real", runId: "r" };
		});
		await bridge.onInboundMessage(msg("hello"));
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec.mock.calls[0][1][1]).toContain("answer");
		expect(exec.mock.calls[0][1][1]).toContain('chat id "room"');
		expect(bridge.getStatus().messagesReplied).toBe(1);
		await bridge.onInboundMessage(msg("next"));
		expect(host.chat.mock.calls[1][0].conversationId).toBe("moved");
	});
	it("isolates the same sender across rooms and threads and ignores foreign runs", async () => {
		const { bridge, exec, host } = setup();
		let i = 0;
		host.chat = vi.fn(async () => ({ conversationId: `c${++i}`, runId: `r${i}` }));
		await bridge.onInboundMessage(msg("one", "roomA"));
		await bridge.onInboundMessage(msg("two", "roomB"));
		await bridge.onInboundMessage(msg("three", "roomA", { threadId: "thread" }));
		expect(new Set(host.chat.mock.calls.map((c: any) => c[0].accountId)).size).toBe(3);
		await bridge.handleRunEvent({ type: "run_end", conversationId: "c1", runId: "foreign" });
		expect(exec).not.toHaveBeenCalled();
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "new-owner",
			runId: "r2",
			message: { role: "assistant", content: "B only" },
		});
		await bridge.handleRunEvent({ type: "run_end", conversationId: "new-owner", runId: "r2" });
		expect(exec.mock.calls[0][1][1]).toContain('chat id "roomB"');
	});
	it("unknown slash commands and invalid settings never reach the model", async () => {
		const { bridge, exec, host } = setup();
		for (const text of ["/bogus", "/thinking wrong", "/model missing-provider", "/cwd /no/such/path"]) {
			await bridge.onInboundMessage(msg(text));
		}
		expect(host.chat).not.toHaveBeenCalled();
		expect(exec).toHaveBeenCalledTimes(4);
		await bridge.onInboundMessage(msg("/model provider/model"));
		await bridge.onInboundMessage(msg("/thinking high"));
		await bridge.onInboundMessage(msg("hello"));
		expect(host.chat).toHaveBeenCalledWith(expect.objectContaining({ model: "provider/model", thinkingLevel: "high" }));
		await bridge.onInboundMessage(msg("/abort"));
		expect(host.abortRun).toHaveBeenCalledWith("run");
	});
	it("sends actual imageData and local file references, reports unsupported attachments", async () => {
		const dir = await mkdtemp(join(tmpdir(), "imessage-media-"));
		try {
			const path = join(dir, "x.png");
			await writeFile(path, Buffer.from("image"));
			const { bridge, host } = setup();
			await bridge.onInboundMessage(msg("", "room", { attachments: [{ path, mimeType: "image/png" }] }));
			expect(host.chat.mock.calls[0][0].attachments).toEqual([
				{ path: "", imageData: Buffer.from("image").toString("base64"), mimeType: "image/png", name: "x.png" },
			]);
			const other = setup();
			await other.bridge.onInboundMessage(msg("", "room", { attachments: [{ path, mimeType: "audio/mp4" }] }));
			expect(other.host.chat.mock.calls[0][0].attachments[0]).toMatchObject({ path, mode: "reference" });
			const unknown = setup();
			await unknown.bridge.onInboundMessage(msg("", "room", { attachments: [{ path, mimeType: "unknown" }] }));
			expect(unknown.host.chat).not.toHaveBeenCalled();
			expect(unknown.exec.mock.calls[0][1][1]).toContain("不支持");
			const send = vi.fn().mockResolvedValue({});
			await sendMacOSIMessage({ chatId: "group" }, "", { execFileImpl: send, file: path });
			expect(send.mock.calls[0][1][1]).toContain("POSIX file");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("reports dispatch errors and delivery failures", async () => {
		const { bridge, exec } = setup(vi.fn().mockRejectedValue(new Error("denied")));
		await bridge.onInboundMessage(msg("hello"));
		expect(exec.mock.calls[0][1][1]).toContain("denied");
		exec.mockRejectedValueOnce(new Error("automation denied"));
		await expect(bridge.onInboundMessage(msg("/help"))).rejects.toThrow("automation denied");
		expect(bridge.getStatus().lastError).toContain("automation denied");
	});
	it("new, clear and cwd use fresh daemon account epochs", async () => {
		const { bridge, host } = setup();
		await bridge.onInboundMessage(msg("first"));
		await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
		await bridge.onInboundMessage(msg("/new"));
		await bridge.onInboundMessage(msg("second"));
		expect(host.chat.mock.calls[0][0].accountId).not.toBe(host.chat.mock.calls[1][0].accountId);
		await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
		await bridge.onInboundMessage(msg(`/cwd ${process.cwd()}`));
		await bridge.onInboundMessage(msg("third"));
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[2][0].accountId);
		expect(host.chat.mock.calls[2][0].conversationId).toBeUndefined();
	});
	it("stop bypasses an unresolved chat receipt and aborts it when it arrives", async () => {
		let resolveChat: any;
		const { bridge, host, exec } = setup(
			vi.fn(
				() =>
					new Promise((resolve) => {
						resolveChat = resolve;
					}),
			),
		);
		const pending = bridge.onInboundMessage(msg("hello"));
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalled());
		await bridge.onInboundMessage(msg("/stop"));
		expect(exec).toHaveBeenCalled();
		resolveChat({ conversationId: "late", runId: "late-run" });
		await pending;
		expect(host.abortRun).toHaveBeenCalledWith("late-run");
		expect(bridge.pendingRuns.size).toBe(0);
	});
	it("polls Messages database read-only and routes group messages", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ stdout: '[{"id":10}]' })
			.mockResolvedValueOnce({ stdout: '[{"id":11,"sender":"a","chatId":"group","text":"/help","is_from_me":0}]' })
			.mockResolvedValue({ stdout: "[]" });
		const bridge = new IMessageBotBridge({ host: {}, getConfig: () => ({}), execFileImpl: exec, platform: "darwin" });
		await bridge.start();
		await bridge.poll();
		await bridge.stop();
		expect(exec.mock.calls[0][1]).toContain("-readonly");
		expect(exec.mock.calls[2][1][1]).toContain('chat id "group"');
	});
});
