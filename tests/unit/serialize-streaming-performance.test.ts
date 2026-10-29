import { describe, expect, it, vi } from "vitest";
import { serializeMessage, serializeStreamingMessage, type AgentMessage } from "../../server/serialize.js";

function assistant(content: unknown[]): AgentMessage {
	return {
		role: "assistant",
		content,
		timestamp: 123,
		model: "test",
		provider: "test",
		stopReason: "toolUse",
		errorMessage: "example",
		usage: { cost: { total: 0.25 } },
	} as AgentMessage;
}

describe("streaming serialization", () => {
	it("serializes tool arguments once per snapshot and preserves assistant metadata", () => {
		const toJSON = vi.fn(() => ({ command: "echo hello" }));
		const message = assistant([
			{ type: "text", text: "Ready" },
			{ type: "thinking", thinking: "Plan" },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { toJSON } },
		]);
		const expected = serializeMessage(message, 0)!;
		toJSON.mockClear();
		const actual = serializeStreamingMessage(message);
		expect(toJSON).toHaveBeenCalledTimes(1);
		expect(actual).toEqual({ ...expected, id: "stream-123" });
	});
	it("keeps streaming-only incomplete marker removal", () => {
		const message = assistant([{ type: "text", text: "Visible [[conv:rename:unfinished" }]);
		expect(serializeStreamingMessage(message)?.content).toEqual([{ type: "text", text: "Visible", truncated: false }]);
		expect(serializeMessage(message, 0)?.content).not.toEqual(serializeStreamingMessage(message)?.content);
	});
	it("preserves non-assistant fallbacks and system filtering", () => {
		const message = { role: "user", content: "hello", timestamp: 5 } as AgentMessage;
		expect(serializeStreamingMessage(message)).toEqual({ ...serializeMessage(message, 0), id: "stream-5" });
		expect(serializeStreamingMessage({ role: "system", content: "hidden" } as any)).toBeNull();
	});
});
