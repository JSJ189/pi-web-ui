/**
 * tests/unit/slack-features.test.ts
 * Tests for Slack Bot plugin:
 * - Pure helpers (marker stripping, accountId hashing, mention stripping)
 * - SlackBotBridge duplex flow (whitelist, slash commands, chat dispatch, and run_end reply)
 */

import { describe, expect, it, vi } from "vitest";
import { extractSlackText, peerAccountId, SlackBotBridge, stripInternalMarkers } from "../../plugins/slack/index.mjs";

describe("Slack 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 sl_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("U12345678");
		const id2 = peerAccountId("U12345678");
		expect(id1).toBe(id2);
		expect(id1.startsWith("sl_")).toBe(true);
		expect(peerAccountId("")).toBe("sl_default");
	});

	it("extractSlackText 剥离机器人 <@U123456> 提及标签", () => {
		const text = "<@U_BOT_123> 帮我写一个快速排序算法 <@U_BOT_123>";
		expect(extractSlackText(text, "U_BOT_123")).toBe("帮我写一个快速排序算法");
	});
});

describe("SlackBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的用户会被拒绝并收到提示信息", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new SlackBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				botToken: "xoxb-mock",
				appToken: "xapp-mock",
				allowedUsers: ["U_ALLOWED_1", "U_ALLOWED_2"],
			}),
		});

		await bridge.onInboundEvent({
			user: "U_STRANGER",
			channel: "C_123",
			text: "你好",
			ts: "123456.789",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/chat.postMessage"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("Access Restricted"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new SlackBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				botToken: "xoxb-mock",
				appToken: "xapp-mock",
			}),
		});

		await bridge.onInboundEvent({
			user: "U_ALLOWED_1",
			channel: "C_123",
			text: "/help",
			ts: "123456.789",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/chat.postMessage"),
			expect.objectContaining({
				body: expect.stringContaining("Slack Bot Help"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_sl_1" });

		const bridge = new SlackBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				botToken: "xoxb-mock",
				appToken: "xapp-mock",
			}),
		});

		await bridge.start();

		await bridge.onInboundEvent({
			user: "U_ALLOWED_1",
			channel: "C_123",
			text: "帮我写一个函数",
			ts: "123456.789",
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^sl_/),
			}),
		);

		const convId = chatSpy.mock.calls[0][0].conversationId;

		runHandler!({
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:sl]]",
			},
		});

		await runHandler!({
			conversationId: convId,
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/chat.postMessage"),
			expect.objectContaining({
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});
