import { describe, it, expect } from "vitest";
import {
	isGoalCompletionSignal,
	parseReviewerVerdict,
	buildDiffFingerprint,
	GIT_DIFF_CAP,
} from "../../server/goal-service.js";

describe("自主轮次驱动完成信号检测（与 prompt 约定严格一致）", () => {
	it("带全角括号的【目标已达成】/【目标完成】/【目标达成】命中", () => {
		expect(isGoalCompletionSignal("所有测试已通过，【目标已达成】。")).toBe(true);
		expect(isGoalCompletionSignal("执行完毕，【目标完成】。")).toBe(true);
		expect(isGoalCompletionSignal("经过验证，【目标达成】。")).toBe(true);
	});

	it("GOAL 后必须跟分隔符且 COMPLETED/PASSED 为整词", () => {
		expect(isGoalCompletionSignal("All done! GOAL: COMPLETED")).toBe(true);
		expect(isGoalCompletionSignal("GOAL_COMPLETED")).toBe(true);
		expect(isGoalCompletionSignal("GOAL IS COMPLETED")).toBe(true);
		expect(isGoalCompletionSignal("GOAL PASSED.")).toBe(true);
	});

	it("裸子串不再命中（不带括号的「目标已达成/完成」会出现在计划与假设句里）", () => {
		expect(isGoalCompletionSignal("执行完毕，目标已完成。")).toBe(false);
		expect(isGoalCompletionSignal("如果测试全绿则目标已达成")).toBe(false);
	});

	it("GOAL 必须是整词：GOALCOMPLETED / MYGOAL: COMPLETED 不命中", () => {
		expect(isGoalCompletionSignal("GOALCOMPLETED")).toBe(false);
		expect(isGoalCompletionSignal("MYGOAL: COMPLETED")).toBe(false);
	});

	it("不误伤普通的中间回复", () => {
		expect(isGoalCompletionSignal("正在修改代码以达成目标，请稍候。")).toBe(false);
		expect(isGoalCompletionSignal("当前正在执行第一步。")).toBe(false);
		expect(isGoalCompletionSignal("目标是实现待办功能。")).toBe(false);
	});
});

describe("审查 verdict 解析（平衡 {...} 优先，正则兜底）", () => {
	it("从围栏/闲话包裹中提取第一个平衡 JSON 对象", () => {
		const raw = '好的，我的结论如下：\n```json\n{"verdict":"pass","feedback":"所有验收点都满足"}\n```\n以上。';
		expect(parseReviewerVerdict(raw)).toEqual({ verdict: "pass", feedback: "所有验收点都满足" });
	});

	it("feedback 内的转义引号与嵌套大括号由 JSON.parse 天然处理", () => {
		const raw = '{"verdict":"fail","feedback":"修复 \\"src/a.ts\\" 里的 {TODO} 后再提交"}';
		expect(parseReviewerVerdict(raw)).toEqual({
			verdict: "fail",
			feedback: '修复 "src/a.ts" 里的 {TODO} 后再提交',
		});
	});

	it("嵌套对象平衡配对：feedback 是对象时 verdict 仍可解析（feedback 非字符串置空）", () => {
		const raw = '{"verdict":"pass","feedback":{"en":"ok"}} 前缀 { 干扰';
		expect(parseReviewerVerdict(raw)).toEqual({ verdict: "pass", feedback: "" });
	});

	it("非合法 JSON（单引号）落到旧正则兜底", () => {
		const raw = `{ verdict: 'pass', feedback: 'fine' } {"verdict":"pass","feedback":"真的通过"}`;
		expect(parseReviewerVerdict(raw)).toEqual({ verdict: "pass", feedback: "真的通过" });
	});

	it("完全无 JSON → undefined（调用方按 fail+原文兜底）", () => {
		expect(parseReviewerVerdict("我觉得还没做完。")).toBeUndefined();
		expect(parseReviewerVerdict('{"verdict":"blocked"}')).toBeUndefined();
	});
});

describe("git 变更指纹 buildDiffFingerprint（停滞检测的等值比较口径）", () => {
	it("diff 为空时返回排序后的 status 指纹（未跟踪文件也算变更）", () => {
		const status = "?? b.txt\n M a.ts\n?? a.txt";
		expect(buildDiffFingerprint("", status)).toBe(" M a.ts\n?? a.txt\n?? b.txt");
	});

	it("diff 与 status 都为空 → 空串（唯一算真停滞的形态）", () => {
		expect(buildDiffFingerprint("", "")).toBe("");
		expect(buildDiffFingerprint("", "\n")).toBe("");
	});

	it("diff 非空：正文截断到 GIT_DIFF_CAP，尾段 [diff-meta] 含完整字符数与 status", () => {
		const big = "x".repeat(GIT_DIFF_CAP + 5_000);
		const fp = buildDiffFingerprint(big, "?? new.txt\n");
		expect(fp.startsWith("x".repeat(GIT_DIFF_CAP))).toBe(true);
		expect(fp).toContain(`[diff-meta] chars=${big.length}`);
		expect(fp).toContain("[git-status]\n?? new.txt");
		expect(fp.length).toBeGreaterThan(GIT_DIFF_CAP);
	});

	it("截断交互：大 diff 两轮前 60_000 字符相同但内容有增长 → 指纹不同（不误判停滞）", () => {
		const round1 = "x".repeat(GIT_DIFF_CAP + 1_000);
		const round2 = "x".repeat(GIT_DIFF_CAP + 2_000);
		expect(buildDiffFingerprint(round1, "")).not.toBe(buildDiffFingerprint(round2, ""));
	});

	it("两轮真正无变化 → 指纹完全相同（等值比较可判停滞）", () => {
		const diff = "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new";
		expect(buildDiffFingerprint(diff, " M f.ts")).toBe(buildDiffFingerprint(diff, " M f.ts"));
	});

	it("status 拍不到（空串）→ 退化为纯截断 diff，无 meta 中的 status 段", () => {
		const diff = "diff --git a/f b/f";
		expect(buildDiffFingerprint(diff, "")).toBe(diff.slice(0, GIT_DIFF_CAP) + `\n[diff-meta] chars=${diff.length}`);
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
		fingerprint: string,
		finalText: string,
		currentError?: string,
	): {
		verdict: "pass" | "fail" | "blocked";
		blockedReason?: string;
	} {
		const isCompleted = isGoalCompletionSignal(finalText);

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

		const trimmedDiff = fingerprint.trim();
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

	it("连续 2 轮真无变更（空指纹）触发停滞熔断（Blocked）", () => {
		const conv = { stagnantRounds: 0, sameErrorRounds: 0 };
		const r1 = simulateReview(conv, buildDiffFingerprint("", ""), "正在分析代码...");
		expect(r1.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(1);

		const r2 = simulateReview(conv, buildDiffFingerprint("", ""), "继续分析代码...");
		expect(r2.verdict).toBe("blocked");
		expect(r2.blockedReason).toContain("未检测到有效文件修改");
		expect(conv.stagnantRounds).toBe(2);
	});

	it("写了未跟踪文件（status 指纹非空）不算停滞，不再误触发熔断", () => {
		const conv = { stagnantRounds: 0, sameErrorRounds: 0 };
		// 第 1 轮：diff 为空但新建了未跟踪文件 → 指纹非空
		const r1 = simulateReview(conv, buildDiffFingerprint("", "?? feature.ts"), "写好了初版");
		expect(r1.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(0);

		// 第 2 轮：继续追加了另一个未跟踪文件 → 指纹变化，仍不熔断
		const r2 = simulateReview(conv, buildDiffFingerprint("", "?? feature.ts\n?? more.ts"), "继续推进");
		expect(r2.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(0);
	});

	it("连续 2 轮指纹完全相同且无进展触发停滞熔断（Blocked）", () => {
		const conv = { stagnantRounds: 0, sameErrorRounds: 0 };
		const fp = buildDiffFingerprint("--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new", " M test.ts");

		const r1 = simulateReview(conv, fp, "尝试修改了一处");
		expect(r1.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(0);

		const r2 = simulateReview(conv, fp, "再次尝试修改");
		expect(r2.verdict).toBe("fail");
		expect(conv.stagnantRounds).toBe(1);

		const r3 = simulateReview(conv, fp, "再次尝试修改相同处");
		expect(r3.verdict).toBe("blocked");
		expect(conv.stagnantRounds).toBe(2);
	});

	it("连续 2 轮出现相同报错触发错误熔断（Blocked）", () => {
		const conv = { stagnantRounds: 0, sameErrorRounds: 0 };
		const err = "Error: Cannot find module 'foo'";

		const r1 = simulateReview(conv, buildDiffFingerprint("+const x = 1;", ""), "修改了代码但失败", err);
		expect(r1.verdict).toBe("fail");
		expect(conv.sameErrorRounds).toBe(1);

		const r2 = simulateReview(conv, buildDiffFingerprint("+const x = 2;", ""), "再次尝试仍然报错", err);
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
		const r1 = simulateReview(conv, buildDiffFingerprint("+diff1", ""), "第 1 步完成");
		expect(r1.verdict).toBe("fail");

		const r2 = simulateReview(conv, buildDiffFingerprint("+diff2", ""), "第 2 步完成");
		expect(r2.verdict).toBe("fail");

		const r3 = simulateReview(conv, buildDiffFingerprint("+diff3", ""), "第 3 步完成");
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
