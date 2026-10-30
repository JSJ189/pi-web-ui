import { describe, expect, it, vi } from "vitest";
import { requestNewChat, resolveNewChatResult } from "../../web/src/new-chat-request";
import { createPluginHostApi } from "../../web/src/plugin-host";
import type { ClientMessage } from "../../web/src/types";

describe("correlated new chat acknowledgement", () => {
	it("only resolves the matching request and preserves its target", async () => {
		let id = "";
		const promise = requestNewChat((message) => {
			if (message.type === "new_chat") id = message.requestId!;
			return true;
		});
		resolveNewChatResult({ type: "new_chat_result", requestId: "unrelated", ok: true, conversationId: "wrong" });
		resolveNewChatResult({ type: "new_chat_result", requestId: id, ok: true, conversationId: "created" });
		expect(await promise).toBe("created");
	});
	it("rejects failed and timed-out requests", async () => {
		expect(await requestNewChat(() => false, 10)).toBeNull();
		expect(
			await requestNewChat((message) => {
				if (message.type === "new_chat")
					resolveNewChatResult({ type: "new_chat_result", requestId: message.requestId!, ok: false });
				return true;
			}, 10),
		).toBeNull();
		expect(await requestNewChat(() => true, 5)).toBeNull();
	});
	it("user switching to B cannot impersonate a successful new_chat", async () => {
		const sent: ClientMessage[] = [];
		let active = "A";
		const api = createPluginHostApi({
			send: (message) => {
				sent.push(message);
				if (message.type === "new_chat") {
					active = "B";
					resolveNewChatResult({ type: "new_chat_result", requestId: message.requestId!, ok: false });
				}
				return true;
			},
			isReady: () => true,
			getCwd: () => "/project",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => active,
			isConversationBlank: () => false,
			setView: () => {},
			timeoutMs: 10,
			pollMs: 1,
		});
		const onResult = vi.fn();
		api.startChat({ prompt: "deploy", newChat: true, onResult });
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(sent.map((message) => message.type)).toEqual(["new_chat"]);
		expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
	});
});
