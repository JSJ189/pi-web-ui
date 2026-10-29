import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";

it.each([false, true])("rebuilds the same DSH session and recovers the runtime (invalid log: %s)", async (invalid) => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-edit-"));
	try {
		const file = join(dir, "session.jsonl");
		const records = [
			{ type: "session", id: "sid", cwd: dir },
			{ type: "user/message", seq: 0, data: { id: "old", content: [] } },
			{ type: "assistant/message", seq: 1, data: { id: "answer", content: [] } },
			{ type: "user/message", seq: 2, data: { id: "target", content: [] } },
			{ type: "assistant/message", seq: 3, data: { id: "discard", content: [] } },
		];
		writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const conv = {
			id: "c1",
			fromDisk: false,
			sessionId: "sid",
			sessionFile: file,
			cwd: dir,
			messages: [
				{ id: "u-old", role: "user", content: [] },
				{ id: "answer", role: "assistant", content: [] },
				{ id: "file", role: "custom", customType: "file", content: [] },
				{ id: "u-target", role: "user", content: [] },
				{ id: "discard", role: "assistant", content: [] },
			],
			queue: { steering: ["stale"], followUp: ["stale"] },
			messageIds: new Set(),
		};
		const attachments = [{ mode: "quote", quote: { text: "new quote" } }];
		const promptConv = vi.fn();
		const emit = vi.fn();
		const runtime = {
			kill: vi.fn(async () => {
				session.activeId = "other";
			}),
			start: vi.fn(),
			_request: vi.fn(),
		};
		const session = Object.assign(Object.create(DshClientSession.prototype), {
			activeId: "c1",
			convs: new Map([
				["c1", conv],
				["sibling", { ...conv, id: "sibling", fromDisk: false }],
			]),
			cwd: dir,
			runtime,
			quiesceBlocked: () => false,
			promptConv,
			emit,
			emitConversations: vi.fn(),
			flushSnapshot: vi.fn(),
		});
		if (invalid) writeFileSync(file, "invalid log");
		await session.editMessage("u-target", "edited", attachments);
		expect(runtime.start).toHaveBeenCalled();
		expect(session.convs.get("sibling").fromDisk).toBe(true);
		if (invalid) {
			expect(emit).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
			expect(promptConv).not.toHaveBeenCalled();
			expect(conv.messages).toHaveLength(5);
			expect(conv.fromDisk).toBe(true);
			return;
		}
		expect(emit).not.toHaveBeenCalled();
		expect(session.convs.size).toBe(2);
		expect(conv.id).toBe("c1");
		expect(conv.sessionId).toBe("sid");
		expect(session.activeId).toBe("other");
		expect(runtime._request).toHaveBeenCalledWith("session/resume", { sessionId: "sid" });
		expect(promptConv).toHaveBeenCalledWith(conv, "edited", attachments);
		expect(conv.messages.map((m) => m.id)).toEqual(["u-old", "answer"]);
		expect(conv.queue).toEqual({ steering: [], followUp: [] });
		expect(
			readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((s) => JSON.parse(s)),
		).toEqual(records.slice(0, 3));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
