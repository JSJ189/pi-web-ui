import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FeishuBotBridge } from "../../plugins/feishu/bot-bridge.mjs";
import { createMedia } from "../../plugins/feishu/media.mjs";
import { receiveAttachments } from "../../plugins/feishu/runtime.mjs";

const projectWorkspace = join(tmpdir(), "feishu-project");
const nextWorkspace = join(tmpdir(), "feishu-next");

function setup() {
	const host = {
		cwd: projectWorkspace,
		chat: vi.fn(),
		abortRun: vi.fn().mockResolvedValue({ ok: true }),
		models: { list: vi.fn().mockResolvedValue([{ provider: "p", id: "m" }]) },
	};
	const reply = vi.fn().mockResolvedValue({ success: true });
	const download = vi
		.fn()
		.mockResolvedValue({ data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png" });
	const bridge = new FeishuBotBridge({
		host,
		getConfig: () => ({ groupResponseMode: "all" }),
		replyMessage: reply,
		sendMessage: vi.fn(),
		reactMessage: vi.fn(),
		downloadResource: download,
	} as any);
	let id = 0;
	const inbound = (text = "hello", chat = "group-a", thread = "", type = "text", content?: any) =>
		bridge.onInboundMessage({
			sender: { sender_id: { open_id: "user" } },
			message: {
				message_id: `message-${++id}`,
				chat_type: "group",
				chat_id: chat,
				thread_id: thread,
				message_type: type,
				content: JSON.stringify(content || { text }),
			},
		});
	return { bridge, host, reply, download, inbound };
}

describe("Feishu runtime contracts", () => {
	it("new, clear and cwd rotate account epochs rather than reusing host context", async () => {
		const { bridge, host, inbound } = setup();
		let n = 0;
		host.chat.mockImplementation(async () => ({ conversationId: `c${++n}`, runId: `r${n}` }));
		await inbound();
		const accounts = [host.chat.mock.calls.at(-1)?.[0].accountId];
		for (const command of ["/new", "/clear", `/cwd ${nextWorkspace}`]) {
			await bridge.handleRunEvent({ type: "run_end", runId: `r${n}` });
			await inbound(command);
			await inbound();
			accounts.push(host.chat.mock.calls.at(-1)?.[0].accountId);
		}
		expect(new Set(accounts).size).toBe(4);
	});

	it.each(["relative/project", "E:relative", ...(process.platform === "win32" ? [] : ["E:/next"])])(
		"rejects non-absolute cwd %s without changing workspace or conversation identity",
		async (workspace) => {
			const { bridge, host, inbound, reply } = setup();
			host.chat.mockResolvedValueOnce({ conversationId: "c1", runId: "r1" });
			await inbound();
			const accountId = host.chat.mock.calls[0][0].accountId;
			await bridge.handleRunEvent({ type: "run_end", runId: "r1" });
			await inbound(`/cwd ${workspace}`);
			expect(reply.mock.calls.at(-1)?.[1].text).toContain("请提供工作区绝对路径");
			expect(host.chat).toHaveBeenCalledTimes(1);
			host.chat.mockResolvedValueOnce({ conversationId: "c1", runId: "r2" });
			await inbound();
			expect(host.chat.mock.calls[1][0]).toMatchObject({ cwd: projectWorkspace, accountId, conversationId: "c1" });
		},
	);

	it("stop bypasses unresolved download and dispatch, cancelling eventual work", async () => {
		const { bridge, host, inbound, download, reply } = setup();
		let resolveDownload!: (value: any) => void;
		download.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveDownload = resolve;
				}),
		);
		const downloading = inbound("", "a", "", "image", { image_key: "k" });
		await inbound("/stop", "a");
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("取消");
		resolveDownload({ data: Buffer.from("png"), mimeType: "image/png" });
		await downloading;
		expect(host.chat).not.toHaveBeenCalled();
		let resolveChat!: (value: any) => void;
		host.chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveChat = resolve;
				}),
		);
		const dispatching = inbound("hello", "a");
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalled());
		await inbound("/stop", "a");
		resolveChat({ conversationId: "c", runId: "r" });
		await dispatching;
		expect(host.abortRun).toHaveBeenCalledWith("r");
		expect(bridge.pendingRuns.size).toBe(0);
	});
	it("buffers early events by stable run id and ignores other runs in the same conversation", async () => {
		const { bridge, host, inbound, reply } = setup();
		host.chat.mockImplementation(async () => {
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "c",
				runId: "other",
				message: { role: "assistant", content: "WRONG" },
			});
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "renamed",
				runId: "r",
				message: { role: "assistant", content: "RIGHT" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "renamed", runId: "r" });
			return { conversationId: "c", runId: "r" };
		});
		await inbound();
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply.mock.calls[0][1].text).toBe("RIGHT");
		expect(bridge.pendingRuns.size).toBe(0);
	});

	it("isolates the same sender across groups and threads and replies every chunk in the source thread", async () => {
		const { bridge, host, inbound, reply } = setup();
		let n = 0;
		host.chat.mockImplementation(async () => ({ conversationId: `c${++n}`, runId: `r${n}` }));
		await inbound("a", "a", "t1");
		await inbound("b", "b", "t1");
		await inbound("c", "a", "t2");
		expect(new Set(host.chat.mock.calls.map(([req]) => req.accountId)).size).toBe(3);
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "c1",
			runId: "foreign",
			message: { role: "assistant", content: "WRONG" },
		});
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "moved",
			runId: "r1",
			message: { role: "assistant", content: "x".repeat(8000) },
		});
		await bridge.handleRunEvent({ type: "run_end", conversationId: "moved", runId: "r1" });
		expect(reply.mock.calls.length).toBeGreaterThan(1);
		for (const [, req] of reply.mock.calls) expect(req).toMatchObject({ messageId: "message-1", replyInThread: true });
	});

	it("routes every command locally, validates settings and stops using host abortRun", async () => {
		const { bridge, host, inbound, reply } = setup();
		for (const command of [
			"/help",
			"/status",
			"/model",
			"/model p/m",
			"/thinking high",
			`/cwd ${nextWorkspace}`,
			"/new",
			"/clear",
			"/unknown",
			"/thinking invalid",
		])
			await inbound(command);
		expect(host.chat).not.toHaveBeenCalled();
		expect(reply.mock.calls.at(-2)?.[1].text).toContain("未知命令");
		host.chat.mockResolvedValue({ conversationId: "c", runId: "r" });
		await inbound();
		expect(host.chat.mock.calls[0][0]).toMatchObject({ cwd: nextWorkspace, model: "p/m", thinkingLevel: "high" });
		await inbound("/stop");
		await inbound("/abort");
		expect(host.abortRun).toHaveBeenCalledWith("r");
		await bridge.handleRunEvent({ type: "run_end", runId: "r", stopReason: "aborted" });
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("停止");
	});

	it("passes real image and file/audio/video attachments and reports unknown types and download failure", async () => {
		const { host, inbound, download, reply, bridge } = setup();
		let n = 0;
		host.chat.mockImplementation(async () => ({ conversationId: `c${++n}`, runId: `r${n}` }));
		await inbound("", "a", "", "image", { image_key: "img" });
		expect(host.chat.mock.calls[0][0].attachments[0]).toMatchObject({
			path: "",
			mimeType: "image/png",
			imageData: expect.any(String),
		});
		for (const type of ["file", "audio", "media"]) {
			download.mockResolvedValue({ data: Buffer.from("bytes"), mimeType: "application/octet-stream" });
			await inbound("", type, "", type, { file_key: "file", file_name: "test.bin" });
			expect(host.chat.mock.calls.at(-1)?.[0].attachments[0].fileData).toBe(Buffer.from("bytes").toString("base64"));
		}
		await inbound("", "x", "", "sticker", {});
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("不支持");
		download.mockRejectedValue(new Error("download denied"));
		await inbound("", "x", "", "image", { image_key: "bad" });
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("download denied");
		expect(bridge.status.lastError).toContain("download denied");
	});

	it("rejects missing receipts and gives delivery failure feedback", async () => {
		const { host, inbound, reply, bridge } = setup();
		host.chat.mockResolvedValue({ conversationId: "c" });
		await inbound();
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("runId");
		host.chat.mockResolvedValue({ conversationId: "c", runId: "r" });
		await inbound();
		reply.mockRejectedValueOnce(new Error("card rejected"));
		await bridge.handleRunEvent({ type: "run_end", runId: "r" });
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("回复发送失败");
	});

	it("enforces image count and per-item/aggregate byte limits", async () => {
		const resource = { key: "k", type: "image", name: "x.png" };
		await expect(receiveAttachments(Array(9).fill(resource), vi.fn(), {}, "m")).rejects.toThrow("8");
		await expect(
			receiveAttachments(
				[resource],
				async () => ({ data: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: "image/png" }),
				{},
				"m",
			),
		).rejects.toThrow("10MiB");
		await expect(
			receiveAttachments(
				Array(3).fill(resource),
				async () => ({ data: Buffer.alloc(8 * 1024 * 1024), mimeType: "image/png" }),
				{},
				"m",
			),
		).rejects.toThrow("20MiB");
	});

	it("shares the 20MiB decoded-byte budget across imageData and fileData", async () => {
		const image = { key: "image", type: "image", name: "x.png" };
		const file = { key: "file", type: "file", name: "x.bin" };
		const tenMiB = Buffer.alloc(10 * 1024 * 1024);
		const download = async () => ({ data: tenMiB, mimeType: "image/png" });
		const attachments = await receiveAttachments([image, file], download, {}, "m");
		expect(attachments).toHaveLength(2);
		expect(Buffer.from(attachments[0].imageData!, "base64").length).toBe(tenMiB.length);
		expect(Buffer.from(attachments[1].fileData!, "base64").length).toBe(tenMiB.length);
		await expect(receiveAttachments([image, file, file], download, {}, "m")).rejects.toThrow("20MiB");
		await expect(
			receiveAttachments(
				[file],
				async () => ({ data: Buffer.alloc(tenMiB.length + 1), mimeType: "application/octet-stream" }),
				{},
				"m",
			),
		).rejects.toThrow("10MiB");
	});

	it("uploads media with actual multipart bytes, validates codec and API failures", async () => {
		const request = vi
			.fn()
			.mockImplementation(
				async (..._args: any[]) =>
					new Response(JSON.stringify({ code: 0, data: { image_key: "img", file_key: "file" } })),
			);
		const fs = {
			stat: vi.fn().mockResolvedValue({ type: "file", size: 8 }),
			read: vi.fn().mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
		};
		const media = createMedia({
			host: { fs },
			getToken: async () => "token",
			getBaseUrl: () => "https://open.feishu.cn",
			request,
		});
		for (const [msgType, filePath] of [
			["image", "x.png"],
			["audio", "x.opus"],
			["media", "x.mp4"],
			["file", "x.pdf"],
		]) {
			const payload = await media.upload({}, { msgType, filePath, duration: 1000 });
			expect(payload.msg_type).toBe(msgType);
			expect(request.mock.calls.at(-1)?.[1].body).toBeInstanceOf(FormData);
		}
		await expect(media.upload({}, { msgType: "audio", filePath: "x.mp3", duration: 1000 })).rejects.toThrow("opus");
		request.mockResolvedValue(new Response("denied", { status: 403 }));
		await expect(media.download({}, { messageId: "m", key: "k", type: "image", name: "x.png" })).rejects.toThrow("403");
	});
});
