import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { DEFAULT_COMPACTION_RESERVE_TOKENS } from "../../server/soft-cap.js";

/** 不起 server：伪造 settingsSvc + convs，直接调原型方法验逻辑。 */
function serviceWith(settings: { softCapTokens: number; softCapByModel: Record<string, number> }, sessions: unknown[]) {
	const svc = Object.create(ClientSession.prototype) as {
		settingsSvc: { current: typeof settings };
		convs: Map<string, unknown>;
	};
	svc.settingsSvc = { current: settings };
	svc.convs = new Map(sessions.map((s, i) => [`c${i}`, { session: s }]));
	return svc;
}

function fakeSession(model: { provider: string; id: string } | null, window: number) {
	const applyOverrides = vi.fn();
	return {
		model,
		getSessionStats: () => ({ contextUsage: { tokens: 1000, contextWindow: window, percent: 1 } }),
		settingsManager: { applyOverrides },
		_captured: applyOverrides,
	};
}

describe("applyCompactionOverrides", () => {
	it("保持 SDK 默认 reserveTokens（16384），不把 W - C 注入 SDK", () => {
		const s1 = fakeSession({ provider: "xai", id: "grok-4" }, 500000);
		const s2 = fakeSession({ provider: "openai", id: "gpt-4o" }, 128000);
		const svc = serviceWith({ softCapTokens: 190000, softCapByModel: {} }, [s1, s2]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s1._captured).toHaveBeenCalledWith({
			compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
		expect(s2._captured).toHaveBeenCalledWith({
			compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
	});

	it("未就绪会话抛错不连累其他会话", () => {
		const bad = {
			model: { provider: "a", id: "b" },
			settingsManager: {
				applyOverrides: () => {
					throw new Error("gone");
				},
			},
		};
		const good = fakeSession({ provider: "a", id: "b" }, 200000);
		const svc = serviceWith({ softCapTokens: 100000, softCapByModel: {} }, [bad, good]);
		expect(() => ClientSession.prototype.applyCompactionOverrides.call(svc)).not.toThrow();
		expect(good._captured).toHaveBeenCalledWith({
			compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS },
		});
	});
});

describe("activeSoftCap", () => {
	it("合法返回 cap，非法/关闭返回 null", () => {
		const cap = (
			settings: { softCapTokens: number; softCapByModel: Record<string, number> },
			model: unknown,
			window: number,
		) =>
			ClientSession.prototype.activeSoftCap.call(
				{
					settingsSvc: { current: settings },
					session: { model },
				},
				window,
			);
		expect(cap({ softCapTokens: 190000, softCapByModel: {} }, { provider: "xai", id: "grok-4" }, 500000)).toBe(190000);
		expect(cap({ softCapTokens: 0, softCapByModel: {} }, { provider: "xai", id: "grok-4" }, 500000)).toBeNull();
		// cap 太接近或超过物理上限（保留少于 SOFT_CAP_MIN_HEADROOM）
		expect(cap({ softCapTokens: 199500, softCapByModel: {} }, { provider: "a", id: "b" }, 200000)).toBeNull();
		expect(cap({ softCapTokens: 300000, softCapByModel: {} }, { provider: "a", id: "b" }, 128000)).toBeNull();
	});
});

describe("triggerSoftCapCompactionIfExceeded", () => {
	const trigger = (
		ClientSession.prototype as unknown as Record<string, (this: unknown, conv: unknown) => Promise<boolean>>
	).triggerSoftCapCompactionIfExceeded;

	function makeContext(tokens: number, window: number, softCap: number, isStreaming = false) {
		const compact = vi.fn().mockResolvedValue(undefined);
		const conv = {
			session: {
				model: { provider: "xai", id: "grok-4" },
				isStreaming,
				compact,
				getSessionStats: () => ({
					contextUsage: { tokens, contextWindow: window, percent: (tokens / window) * 100 },
				}),
			},
			lastCompactionTokens: null,
			lastTurnBaseTokens: 1000,
		};
		const svc = {
			settingsSvc: {
				current: {
					softCapTokens: softCap,
					softCapByModel: {},
				},
			},
			currentBaseTokens: () => 1000,
			isBlankConversation: () => false,
			hasSettledAssistantUsage: () => true,
			estimateNonSystemTokens: () => 0,
			activeSoftCap: ClientSession.prototype.activeSoftCap,
			getEffectiveContextTokens: (ClientSession.prototype as unknown as Record<string, (c: unknown) => number>)
				.getEffectiveContextTokens,
			emit: vi.fn(),
		};
		return { conv, svc, compact };
	}

	it("当前 tokens 超过软上限时主动调用 session.compact()", async () => {
		const { conv, svc, compact } = makeContext(310000, 1000000, 300000);
		const result = await trigger.call(svc, conv);
		expect(result).toBe(true);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("当前 tokens 未超过软上限时不触发压缩", async () => {
		const { conv, svc, compact } = makeContext(250000, 1000000, 300000);
		const result = await trigger.call(svc, conv);
		expect(result).toBe(false);
		expect(compact).not.toHaveBeenCalled();
	});

	it("正在流式输出中（isStreaming = true）不主动打断", async () => {
		const { conv, svc, compact } = makeContext(350000, 1000000, 300000, true);
		const result = await trigger.call(svc, conv);
		expect(result).toBe(false);
		expect(compact).not.toHaveBeenCalled();
	});

	it("SDK 报 Already compacted 或 Nothing to compact 时静默处理，不外抛异常", async () => {
		const { conv, svc, compact } = makeContext(350000, 1000000, 300000);
		compact.mockRejectedValue(new Error("Already compacted"));
		const result = await trigger.call(svc, conv);
		expect(result).toBe(false);
	});
});
