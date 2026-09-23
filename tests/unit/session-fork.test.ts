import { describe, it, expect } from "vitest";

describe("会话分支派生（Session Fork）", () => {
	interface MockEntry {
		id: string;
		parentId: string | null;
		type: string;
		message?: {
			role: "user" | "assistant" | "toolResult" | "bashExecution";
			timestamp?: number;
			toolCallId?: string;
			content?: unknown;
		};
		timestamp?: string;
	}

	function resolveMessageEntry(entries: MockEntry[], messageId: string): MockEntry | null {
		const userSeqByTs = new Map<number, number>();
		const assistantSeqByTs = new Map<number, number>();
		let globalSeq = 0;

		for (const entry of entries) {
			globalSeq += 1;
			if (entry.id === messageId) return entry;
			if (entry.type === "message" && entry.message) {
				const m = entry.message;
				let uiId = "";
				if (m.role === "user") {
					const ts = m.timestamp ?? 0;
					const seq = (userSeqByTs.get(ts) ?? 0) + 1;
					userSeqByTs.set(ts, seq);
					uiId = `u-${ts}-${seq}`;
				} else if (m.role === "assistant") {
					const ts = m.timestamp ?? 0;
					const seq = (assistantSeqByTs.get(ts) ?? 0) + 1;
					assistantSeqByTs.set(ts, seq);
					uiId = `a-${ts}-${seq}`;
				} else if (m.role === "toolResult") {
					uiId = `t-${m.toolCallId}`;
				} else if (m.role === "bashExecution") {
					uiId = `b-${m.timestamp}-${globalSeq}`;
				}
				if (uiId === messageId) return entry;
			}
		}
		return entries.find((e) => e.id === messageId) ?? null;
	}

	function computeTargetLeafId(entry: MockEntry, position: "before" | "at"): string | null {
		return position === "at" ? entry.id : entry.parentId;
	}

	it("准确解析 user 消息 ID 并支持 before/at 切分", () => {
		const entries: MockEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", timestamp: 1000 } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", timestamp: 1005 } },
			{ id: "e3", parentId: "e2", type: "message", message: { role: "user", timestamp: 2000 } },
			{ id: "e4", parentId: "e3", type: "message", message: { role: "assistant", timestamp: 2005 } },
		];

		const entryE3 = resolveMessageEntry(entries, "u-2000-1");
		expect(entryE3).toBeDefined();
		expect(entryE3?.id).toBe("e3");

		// before: 截取到该问题之前，即 e2（上一条助手消息）
		expect(computeTargetLeafId(entryE3!, "before")).toBe("e2");

		// at: 包含该问题自身，即 e3
		expect(computeTargetLeafId(entryE3!, "at")).toBe("e3");
	});

	it("准确解析 assistant 消息 ID 并支持 before/at 切分", () => {
		const entries: MockEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", timestamp: 1000 } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "assistant", timestamp: 1005 } },
			{ id: "e3", parentId: "e2", type: "message", message: { role: "user", timestamp: 2000 } },
			{ id: "e4", parentId: "e3", type: "message", message: { role: "assistant", timestamp: 2005 } },
		];

		const entryE2 = resolveMessageEntry(entries, "a-1005-1");
		expect(entryE2).toBeDefined();
		expect(entryE2?.id).toBe("e2");

		// before: 截取到 e1
		expect(computeTargetLeafId(entryE2!, "before")).toBe("e1");

		// at: 截取到 e2
		expect(computeTargetLeafId(entryE2!, "at")).toBe("e2");
	});

	it("准确解析 toolResult 消息 ID", () => {
		const entries: MockEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", timestamp: 1000 } },
			{ id: "e2", parentId: "e1", type: "message", message: { role: "toolResult", toolCallId: "call_abc123" } },
		];

		const entryTool = resolveMessageEntry(entries, "t-call_abc123");
		expect(entryTool).toBeDefined();
		expect(entryTool?.id).toBe("e2");
		expect(computeTargetLeafId(entryTool!, "before")).toBe("e1");
	});

	it("在首条消息之前派生时 targetLeafId 为 null（代表空白会话起点）", () => {
		const entries: MockEntry[] = [
			{ id: "e1", parentId: null, type: "message", message: { role: "user", timestamp: 1000 } },
		];
		const entry = resolveMessageEntry(entries, "u-1000-1");
		expect(entry).toBeDefined();
		expect(computeTargetLeafId(entry!, "before")).toBe(null);
	});
});
