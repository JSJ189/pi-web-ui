/**
 * tests/unit/qq-features.test.ts
 * Tests for QQ Bot plugin:
 * - Pure helpers (marker stripping, accountId hashing, mention stripping)
 * - QqBotBridge duplex flow (whitelist, slash commands, chat dispatch, and run_end reply)
 */

import { describe, expect, it, vi } from "vitest";
import { extractQqText, peerAccountId, QqBotBridge, stripInternalMarkers } from "../../plugins/qq/index.mjs";

describe("QQ 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 qq_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("OPENID_123456");
		const id2 = peerAccountId("OPENID_123456");
		expect(id1).toBe(id2);
		expect(id1.startsWith("qq_")).toBe(true);
		expect(peerAccountId("")).toBe("qq_default");
	});

	it("extractQqText 剥离机器人 <@!botId> 与 <@botId> 标签", () => {
		const text1 = "<@!10203040> 帮我写一个快速排序算法";
		expect(extractQqText(text1, "10203040")).toBe("帮我写一个快速排序算法");

		const text2 = "<@10203040> 帮我写一个函数";
		expect(extractQqText(text2, "10203040")).toBe("帮我写一个函数");
	});
});

describe("QqBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的用户会被拒绝，不触发 host.chat", async () => {
		const chatSpy = vi.fn();
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
				allowedUsers: ["ALLOWED_USER_1"],
			}),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_qq_1",
				channel_id: "c_123",
				author: { id: "STRANGER_USER", bot: false },
				content: "你好",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).not.toHaveBeenCalled();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_1" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_qq_2",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "/help",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("QQ 机器人帮助"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token", id: "m_reply_2" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_qq_1" });

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		await bridge.start();

		await bridge.onInboundMessage(
			{
				id: "msg_qq_3",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "帮我写一个函数",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^qq_/),
			}),
		);

		const convId = chatSpy.mock.calls[0][0].conversationId;

		runHandler!({
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:qq]]",
			},
		});

		await runHandler!({
			conversationId: convId,
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("长回复按 3000 字分块后，replyMessage 调用时的 msg_seq 严格从 1 递增", async () => {
		const replySpy = vi.fn().mockResolvedValue({});
		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_qq_long" });

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		bridge.replyMessage = replySpy;
		await bridge.start();

		await bridge.onInboundMessage(
			{
				id: "msg_qq_4",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "请生成长文本",
			},
			"AT_MESSAGE_CREATE",
		);

		const convId = chatSpy.mock.calls[0][0].conversationId;

		// 构造超过 3000 字的长回复，使其切为至少 2 块
		const longReply = "A".repeat(3500);
		runHandler!({
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: longReply,
			},
		});

		await runHandler!({
			conversationId: convId,
			type: "run_end",
		});

		expect(replySpy).toHaveBeenCalledTimes(2);
		expect(replySpy.mock.calls[0][2]).toBe(1);
		expect(replySpy.mock.calls[1][2]).toBe(2);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("ensureAccessToken：未到期直接复用，到期惰性刷新", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "token_v2", expires_in: 7200 }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const bridge = new QqBotBridge({
			host: { chat: vi.fn() },
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		// 初始状态：持有还有很长时间过期的 token
		bridge.accessToken = "token_v1";
		bridge.tokenExpiresAt = Date.now() + 7200 * 1000;

		// 未到期调用：直接复用，不发起网络请求
		const t1 = await bridge.ensureAccessToken();
		expect(t1).toBe("token_v1");
		expect(fetchMock).not.toHaveBeenCalled();

		// 模拟 token 进入 5 分钟刷新余量区间
		bridge.tokenExpiresAt = Date.now() + 60 * 1000;

		const t2 = await bridge.ensureAccessToken();
		expect(t2).toBe("token_v2");
		expect(bridge.accessToken).toBe("token_v2");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});
