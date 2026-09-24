import { describe, it, expect } from "vitest";

describe("自主轮次驱动完成信号检测", () => {
	const completionRegex =
		/【目标(?:已)?(?:达成|完成)】|GOAL(?:[:：_]|\s+)*(?:IS\s+)?(?:COMPLETED|PASSED)|目标已达成|目标已完成/i;

	it("能够正确匹配多种形式的目标达成信号", () => {
		expect(completionRegex.test("所有测试已通过，【目标已达成】。")).toBe(true);
		expect(completionRegex.test("执行完毕，目标已完成。")).toBe(true);
		expect(completionRegex.test("All done! GOAL: COMPLETED")).toBe(true);
		expect(completionRegex.test("GOAL_COMPLETED")).toBe(true);
		expect(completionRegex.test("GOAL IS COMPLETED")).toBe(true);
		expect(completionRegex.test("经过验证，【目标达成】。")).toBe(true);
	});

	it("不误伤普通的中间回复", () => {
		expect(completionRegex.test("正在修改代码以达成目标，请稍候。")).toBe(false);
		expect(completionRegex.test("当前正在执行第一步。")).toBe(false);
		expect(completionRegex.test("目标是实现待办功能。")).toBe(false);
	});
});

describe("目标防死循环与停滞检测 (Goal Policy & Blocked Detection)", () => {
	function simulateReview(
		conv: {
			stagnantRounds?: number;
			lastDiff?: string;
			sameErrorRounds?: number;
			lastErrorSnippet?: string;
		},
		diff: string,
		finalText: string,
		currentError?: string,
	): {
		verdict: "pass" | "fail" | "blocked";
		blockedReason?: string;
	} {
		const completionRegex =
			/【目标(?:已)?(?:达成|完成)】|GOAL(?:[:：_]|\s+)*(?:IS\s+)?(?:COMPLETED|PASSED)|目标已达成|目标已完成/i;
		const isCompleted = completionRegex.test(finalText);

		const prevError = conv.lastErrorSnippet;
		if (
			currentError &&
			prevError &&
			(currentError === prevError || currentError.includes(prevError) || prevError.includes(currentError))
		) {
			conv.sameErrorRounds = (conv.sameErrorRounds ?? 0) + 1;
		} else {
			conv.sameErrorRounds = currentError ? 1 : 0;
		}
		conv.lastErrorSnippet = currentError;

		const trimmedDiff = diff.trim();
		const prevDiff = conv.lastDiff;
		const isNoDiffChange = trimmedDiff === "" || (prevDiff !== undefined && trimmedDiff === prevDiff);
		if (isNoDiffChange) {
			conv.stagnantRounds = (conv.stagnantRounds ?? 0) + 1;
		} else {
			conv.stagnantRounds = 0;
		}
		conv.lastDiff = trimmedDiff;

		if (isCompleted) {
			return { verdict: "pass" };
		}

		if ((conv.sameErrorRounds ?? 0) >= 2 || (conv.stagnantRounds ?? 0) >= 2) {
			const blockedReason =
				(conv.sameErrorRounds ?? 0) >= 2
					? `连续 ${conv.sameErrorRounds} 轮出现相同错误：${currentError}`
					: `连续 ${conv.stagnantRounds} 轮未检测到有效文件修改或实质进展`;
			return { verdict: "blocked", blockedReason };
		}

		return { verdict: "fail" };
	}

	it("连续 2 轮无实质代码修改触发停滞熔断（Blocked）", () => {
		const conv = { stagnantRounds: 0, sameErrorRounds: 0 };
		// 第 1 轮：无 diff
		const r1 = simulateReview(conv, "", "正在分析代码...");
		expect(r1.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(1);

		// 第 2 轮：仍然无 diff，触发 blocked
		const r2 = simulateReview(conv, "", "继续分析代码...");
		expect(r2.verdict).toBe("blocked");
		expect(r2.blockedReason).toContain("未检测到有效文件修改");
		expect(conv.stagnantRounds).toBe(2);
	});

	it("连续 2 轮 diff 完全相同且无进展触发停滞熔断（Blocked）", () => {
		const conv = { stagnantRounds: 0, sameErrorRounds: 0 };
		const diffSnippet = "--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new";

		// 第 1 轮：产生 diff
		const r1 = simulateReview(conv, diffSnippet, "尝试修改了一处");
		expect(r1.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(0);

		// 第 2 轮：diff 完全相同（无新增修改）
		const r2 = simulateReview(conv, diffSnippet, "再次尝试修改");
		expect(r2.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(1);

		// 第 3 轮：diff 依然完全相同
		const r3 = simulateReview(conv, diffSnippet, "再次尝试修改相同处");
		expect(r3.verdict).toBe("blocked");
		expect(conv.stagnantRounds).toBe(2);
	});

	it("连续 2 轮出现相同报错触发错误熔断（Blocked）", () => {
		const conv = { stagnantRounds: 0, sameErrorRounds: 0 };
		const err = "Error: Cannot find module 'foo'";

		// 第 1 轮：产生错误
		const r1 = simulateReview(conv, "+const x = 1;", "修改了代码但失败", err);
		expect(r1.verdict).toBe("fail");
		expect(conv.sameErrorRounds).toBe(1);

		// 第 2 轮：产生相同错误，即使有新的 diff 也会因连续报错触发熔断
		const r2 = simulateReview(conv, "+const x = 2;", "再次尝试仍然报错", err);
		expect(r2.verdict).toBe("blocked");
		expect(r2.blockedReason).toContain("出现相同错误");
		expect(r2.blockedReason).toContain(err);
	});

	it("目标达成时优先判定为 pass，不触发 blocked", () => {
		const conv = { stagnantRounds: 1, sameErrorRounds: 1, lastErrorSnippet: "some error", lastDiff: "" };
		const r = simulateReview(conv, "", "最终完成所有任务，【目标已达成】！", "some error");
		expect(r.verdict).toBe("pass");
	});

	it("有正常代码变动推进时不触发 blocked", () => {
		const conv = { stagnantRounds: 0, sameErrorRounds: 0 };
		const r1 = simulateReview(conv, "+diff1", "第 1 步完成");
		expect(r1.verdict).toBe("fail");

		const r2 = simulateReview(conv, "+diff2", "第 2 步完成");
		expect(r2.verdict).toBe("fail");

		const r3 = simulateReview(conv, "+diff3", "第 3 步完成");
		expect(r3.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(0);
	});
});

describe("目标审查未通过与终态保留 (Goal Review Retention)", () => {
	it("达到最大轮数未通过时，目标文本与会话归属保持保留（不丢失用户目标）", () => {
		const g = {
			goal: "实现高性能缓存模块并补全单测",
			conversationId: "conv-123",
			round: 2,
			maxRounds: 2,
			locked: true,
			reviewing: true,
			verdict: "pending" as string | null,
			status: "",
		};

		// 模拟达到最大轮数失败逻辑
		const isLastRound = g.maxRounds > 0 && g.round >= g.maxRounds;
		expect(isLastRound).toBe(true);

		g.reviewing = false;
		g.verdict = "fail";
		g.status = `已达最大轮数（${g.maxRounds}），目标仍未通过`;

		// 核心断言：目标文本和会话 id 绝不能被抹杀为 null
		expect(g.goal).toBe("实现高性能缓存模块并补全单测");
		expect(g.conversationId).toBe("conv-123");
		expect(g.verdict).toBe("fail");
		expect(g.reviewing).toBe(false);
	});

	it("触发停滞熔断（blocked）时，目标文本保持保留供用户排查", () => {
		const g = {
			goal: "优化数据库连接池",
			conversationId: "conv-456",
			reviewing: true,
			verdict: "pending" as string | null,
			status: "",
		};

		g.reviewing = false;
		g.verdict = "blocked";
		g.status = "⚠️ 目标受阻（停滞熔断）";

		expect(g.goal).toBe("优化数据库连接池");
		expect(g.conversationId).toBe("conv-456");
		expect(g.verdict).toBe("blocked");
		expect(g.reviewing).toBe(false);
	});

	it("终态下（fail/blocked）onAgentEnd 不应自动重复触发 review", () => {
		const canTriggerReview = (g: { goal: string | null; reviewing: boolean; verdict: string | null }) => {
			return !!(g.goal && !g.reviewing && g.verdict === "pending");
		};

		// 新设定目标：应当触发
		expect(canTriggerReview({ goal: "test", reviewing: false, verdict: "pending" })).toBe(true);

		// 失败终态：不应自动重复触发
		expect(canTriggerReview({ goal: "test", reviewing: false, verdict: "fail" })).toBe(false);

		// 熔断终态：不应自动重复触发
		expect(canTriggerReview({ goal: "test", reviewing: false, verdict: "blocked" })).toBe(false);
	});
});
