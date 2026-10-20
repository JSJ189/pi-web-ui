import { describe, expect, it } from "vitest";
import { clusterMessages, isPureToolMessage } from "../../web/src/components/MessageList.js";
import type { UiMessage } from "../../web/src/types.js";

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

	it("流式末尾候选消息平滑聚类：首帧尚无内容或仅为空文本时，紧随已有工具集群保持聚类，防止瞬时 single 闪烁", () => {
		const baseMessages: UiMessage[] = [
			{ id: "u1", role: "user", content: [{ type: "text", text: "请查找并读取" }] } as unknown as UiMessage,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "grep" }],
			} as unknown as UiMessage,
			{ id: "tr1", role: "toolResult" } as unknown as UiMessage,
		];

		// 场景 A：首帧流式消息 content 为空数组，紧随已有的 a1 工具集群
		const streamingEmpty: UiMessage = {
			id: "stream-1",
			role: "assistant",
			content: [],
		} as unknown as UiMessage;

		const clusteredEmpty = clusterMessages([...baseMessages, streamingEmpty]);
		expect(clusteredEmpty.length).toBe(2);
		expect(clusteredEmpty[0].type).toBe("single"); // u1
		expect(clusteredEmpty[1].type).toBe("tool_cluster");
		if (clusteredEmpty[1].type === "tool_cluster") {
			// stream-1 平滑进入已有集群，绝不提前以 single 形式坠落到下一行
			expect(clusteredEmpty[1].messages.map((m) => m.id)).toEqual(["a1", "stream-1"]);
		}

		// 场景 B：首帧流式消息仅带空 text 块
		const streamingEmptyText: UiMessage = {
			id: "stream-1",
			role: "assistant",
			content: [{ type: "text", text: "   " }],
		} as unknown as UiMessage;

		const clusteredEmptyText = clusterMessages([...baseMessages, streamingEmptyText]);
		expect(clusteredEmptyText.length).toBe(2);
		expect(clusteredEmptyText[1].type).toBe("tool_cluster");
		if (clusteredEmptyText[1].type === "tool_cluster") {
			expect(clusteredEmptyText[1].messages.map((m) => m.id)).toEqual(["a1", "stream-1"]);
		}

		// 场景 C：下一帧流式消息带出了第二个 toolCall（read），顺理成章保持在集群内
		const streamingWithTool: UiMessage = {
			id: "stream-1",
			role: "assistant",
			content: [{ type: "toolCall", id: "tc2", name: "read" }],
		} as unknown as UiMessage;

		const clusteredTool = clusterMessages([...baseMessages, streamingWithTool]);
		expect(clusteredTool.length).toBe(2);
		expect(clusteredTool[1].type).toBe("tool_cluster");
		if (clusteredTool[1].type === "tool_cluster") {
			expect(clusteredTool[1].messages.map((m) => m.id)).toEqual(["a1", "stream-1"]);
		}

		// 场景 D：若流式消息产生非空正文，则立即脱离工具集群，作为 single 在下方独立渲染
		const streamingWithText: UiMessage = {
			id: "stream-1",
			role: "assistant",
			content: [{ type: "text", text: "已找到相应文件，正在处理..." }],
		} as unknown as UiMessage;

		const clusteredWithText = clusterMessages([...baseMessages, streamingWithText]);
		expect(clusteredWithText.length).toBe(3);
		expect(clusteredWithText[0].type).toBe("single"); // u1
		expect(clusteredWithText[1].type).toBe("tool_cluster"); // a1
		if (clusteredWithText[1].type === "tool_cluster") {
			expect(clusteredWithText[1].messages.map((m) => m.id)).toEqual(["a1"]);
		}
		expect(clusteredWithText[2].type).toBe("single"); // stream-1 作为独立正文流
		if (clusteredWithText[2].type === "single") {
			expect(clusteredWithText[2].message.id).toBe("stream-1");
		}
	});
});
