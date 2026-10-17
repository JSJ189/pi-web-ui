import { describe, expect, it } from "vitest";
import type { UiContentBlock, UiMessage, UiTextBlock } from "../../web/src/types.js";

function asText(block: UiContentBlock): UiTextBlock | null {
	return block.type === "text" && typeof (block as UiTextBlock).text === "string" ? (block as UiTextBlock) : null;
}

function isPureToolMessage(m: UiMessage): boolean {
	if (m.role !== "assistant") return false;
	if (m.customType) return false;
	if (!Array.isArray(m.content) || m.content.length === 0) return false;
	const hasText = m.content.some((b) => {
		const t = asText(b);
		return t && t.text.trim().length > 0;
	});
	if (hasText) return false;
	return m.content.some((b) => b.type === "toolCall" || b.type === "thinking");
}

type MessageClusterItem =
	{ type: "single"; message: UiMessage } | { type: "tool_cluster"; id: string; messages: UiMessage[] };

function clusterMessages(list: readonly UiMessage[]): MessageClusterItem[] {
	const out: MessageClusterItem[] = [];
	let currentCluster: { type: "tool_cluster"; id: string; messages: UiMessage[] } | null = null;

	for (const m of list) {
		if (m.role === "system" || m.role === "toolResult") continue;

		if (isPureToolMessage(m)) {
			if (!currentCluster) {
				currentCluster = { type: "tool_cluster", id: `cluster-${m.id}`, messages: [m] };
				out.push(currentCluster);
			} else {
				currentCluster.messages.push(m);
			}
		} else {
			currentCluster = null;
			out.push({ type: "single", message: m });
		}
	}
	return out;
}

describe("回合工具流聚类与隔离机制 (Turn Tool Trail)", () => {
	it("同一回答回合内的连续中间工具消息精确聚合成同一个工具集群", () => {
		const messages: UiMessage[] = [
			{ id: "u1", role: "user", content: [{ type: "text", text: "查找文件" }] } as unknown as UiMessage,
			{
				id: "a1",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "想一下" },
					{ type: "toolCall", id: "tc1", name: "grep" },
				],
			} as unknown as UiMessage,
			{ id: "tr1", role: "toolResult" } as unknown as UiMessage,
			{
				id: "a2",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "read" }],
			} as unknown as UiMessage,
			{ id: "tr2", role: "toolResult" } as unknown as UiMessage,
			{
				id: "a3",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc3", name: "bash" }],
			} as unknown as UiMessage,
			{
				id: "a4",
				role: "assistant",
				content: [{ type: "text", text: "这是最终回答正文" }],
			} as unknown as UiMessage,
		];

		const clustered = clusterMessages(messages);
		expect(clustered.length).toBe(3);

		// 项 1：用户提问
		expect(clustered[0].type).toBe("single");
		if (clustered[0].type === "single") {
			expect(clustered[0].message.id).toBe("u1");
		}

		// 项 2：连续工具集群（a1, a2, a3）
		expect(clustered[1].type).toBe("tool_cluster");
		if (clustered[1].type === "tool_cluster") {
			expect(clustered[1].id).toBe("cluster-a1");
			expect(clustered[1].messages.length).toBe(3);
			expect(clustered[1].messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
		}

		// 项 3：最终正文回答
		expect(clustered[2].type).toBe("single");
		if (clustered[2].type === "single") {
			expect(clustered[2].message.id).toBe("a4");
		}
	});

	it("多回合对话之间严格隔离，绝不跨回合串联混排", () => {
		const messages: UiMessage[] = [
			// 第一回合
			{ id: "u1", role: "user", content: [{ type: "text", text: "提问一" }] } as unknown as UiMessage,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "grep" }],
			} as unknown as UiMessage,
			{
				id: "a2",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "read" }],
			} as unknown as UiMessage,
			{
				id: "a3",
				role: "assistant",
				content: [{ type: "text", text: "回答一" }],
			} as unknown as UiMessage,

			// 第二回合
			{ id: "u2", role: "user", content: [{ type: "text", text: "提问二" }] } as unknown as UiMessage,
			{
				id: "a4",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc3", name: "edit" }],
			} as unknown as UiMessage,
			{
				id: "a5",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc4", name: "bash" }],
			} as unknown as UiMessage,
			{
				id: "a6",
				role: "assistant",
				content: [{ type: "text", text: "回答二" }],
			} as unknown as UiMessage,
		];

		const clustered = clusterMessages(messages);
		expect(clustered.length).toBe(6);

		// 第一回合结构
		expect(clustered[0].type).toBe("single"); // u1
		expect(clustered[1].type).toBe("tool_cluster"); // a1 + a2
		if (clustered[1].type === "tool_cluster") {
			expect(clustered[1].messages.map((m) => m.id)).toEqual(["a1", "a2"]);
		}
		expect(clustered[2].type).toBe("single"); // a3

		// 第二回合结构
		expect(clustered[3].type).toBe("single"); // u2
		expect(clustered[4].type).toBe("tool_cluster"); // a4 + a5
		if (clustered[4].type === "tool_cluster") {
			expect(clustered[4].messages.map((m) => m.id)).toEqual(["a4", "a5"]);
		}
		expect(clustered[5].type).toBe("single"); // a6
	});
});
