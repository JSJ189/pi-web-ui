/**
 * 目标模式 2.0（唯一路径）的循环单测：执行对话干活 + 当前对话当审查者。
 *
 * 全链路用 fake GoalHost 驱动，不需要真模型：
 *   - 服务端循环：派活给常驻执行者 → 等它结束 → 取样 → 把审查指令交给主对话；
 *   - 「主对话的 verdict」由测试直接调 onAgentEnd 模拟（就是 agent_end 钩子的入口）；
 *   - 断言轮次推进、pass/受阻收尾、审查重试、服务端熔断、降级回 self。
 *
 * 先例：tests/unit/goal-wizard-target.test.ts（同一套 fake host 手法）。
 */
import { describe, it, expect } from "vitest";
import { GoalService, type GoalConversation, type GoalHost, type RoleWaitOutcome } from "../../server/goal-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const EXEC_ID = "sa-exec";

function makeConv(svc: GoalService, mainSent: string[], mainLastText: { value: string }): GoalConversation {
	const conv: GoalConversation = {
		id: "conv-a",
		title: "会话 A",
		cwd: "/tmp/proj",
		session: {
			isStreaming: false,
			isIdle: true,
			sendUserMessage: async (text: string) => void mainSent.push(text),
			sendCustomMessage: async () => {},
			getLastAssistantText: () => mainLastText.value,
			getSessionStats: () => ({ totalMessages: 0 }),
		} as unknown as GoalConversation["session"],
		wizardRunning: false,
		goalGeneration: 0,
		goalReviewGeneration: 0,
		goal: svc.makeGoalStatus(),
	};
	return Object.assign(conv, { mainSent, mainLastText });
}

interface Harness {
	svc: GoalService;
	host: GoalHost;
	sent: ServerMessage[];
	spawned: { role: string; prompt: string; model?: string | null }[];
	steered: string[];
	stopped: string[];
	dismissed: string[];
	conv: () => GoalConversation & { mainSent: string[]; mainLastText: { value: string } };
	/** 模拟执行对话被用户关掉（之后 hasConv 返回 false）。 */
	setGone: (v: boolean) => void;
}

/** fake host：脚本化执行者结局 / diff 序列 / 生成失败。 */
function makeHarness(opts?: {
	spawnFails?: boolean;
	waitOutcomes?: RoleWaitOutcome[];
	diffs?: string[];
	readRole?: () => { text: string; errorSnippet?: string } | undefined;
	/** 执行对话一失联（模拟用户在左栏把它关了）。 */
	gone?: boolean;
}): Harness {
	const goneFlag = { value: opts?.gone === true };
	const sent: ServerMessage[] = [];
	const spawned: Harness["spawned"] = [];
	const steered: string[] = [];
	const stopped: string[] = [];
	const dismissed: string[] = [];
	const convs = new Map<string, GoalConversation>();
	// 主对话收到的全部消息（既服务端 kick，也委派循环交回的审查指令）。
	const mainSent: string[] = [];
	const mainLastText = { value: "" };
	let waitIdx = 0;
	let diffIdx = 0;
	const host: GoalHost = {
		clientId: "c",
		agentDir: "/tmp/agent",
		stateStore: {
			getGoalPrefs: () => null,
			saveGoalPrefs: () => {},
		} as unknown as GoalHost["stateStore"],
		webUi: null as unknown as GoalHost["webUi"],
		emit: (m) => void sent.push(m),
		flushSnapshot: () => {},
		isDisposed: () => false,
		quiesceBlocked: () => false,
		activeConvId: () => "conv-a",
		activeConv: () => convs.get("conv-a")!,
		getConv: (id) => convs.get(id),
		cwd: () => "/tmp/proj",
		// 每轮取样一次 diff：默认每轮都不同（= 有进展），脚本化时按序取（同值 = 停滞）。
		gitDiff: async () => {
			const arr = opts?.diffs;
			if (!arr || arr.length === 0) return `diff-${++diffIdx}`;
			return arr[Math.min(diffIdx++, arr.length - 1)]!;
		},
		goalModeEnabled: () => true,
		lang: () => "zh",
		roleDeadlineMs: () => 1000,
		spawnRoleAgent: async ({ role, prompt, model }) => {
			if (opts?.spawnFails) throw new Error("子代理数量已达上限（16 个）");
			spawned.push({ role, prompt, model });
			return EXEC_ID;
		},
		waitRoleAgent: async () => {
			const arr = opts?.waitOutcomes;
			if (!arr || arr.length === 0) return "done";
			return arr[Math.min(waitIdx++, arr.length - 1)]!;
		},
		sendRoleAgent: async (convId, message) => {
			if (convId === EXEC_ID) steered.push(message);
			else mainSent.push(message);
			return true;
		},
		readRoleAgent: (id) => (id === EXEC_ID ? (opts?.readRole?.() ?? { text: "已改完并自测通过。" }) : undefined),
		stopRoleAgent: async (id) => void stopped.push(id),
		dismissRoleAgent: async (id) => void dismissed.push(id),
		hasConv: (id) => (goneFlag.value ? false : id === EXEC_ID || convs.has(id)),
	};
	const boot = new GoalService(host);
	const conv = Object.assign(makeConv(boot, mainSent, mainLastText), { mainSent, mainLastText });
	convs.set("conv-a", conv);
	return {
		svc: boot,
		host,
		sent,
		spawned,
		steered,
		stopped,
		dismissed,
		conv: () => conv as unknown as ReturnType<Harness["conv"]>,
		setGone: (v) => {
			goneFlag.value = v;
		},
	};
}

const notices = (h: Harness): string[] =>
	(h.sent.filter((m) => m.type === "notice") as { text: string }[]).map((m) => m.text);

describe("委托执行（Plan A / delegated）", () => {
	it("设目标即拉起常驻执行者，执行轮结束后把审查指令交给主对话", async () => {
		const h = makeHarness();
		await h.svc.setGoal("把 README 补全", { maxRounds: 0, locked: true });

		expect(h.spawned).toHaveLength(1);
		expect(h.spawned[0]!.role).toBe("executor");
		expect(h.spawned[0]!.prompt).toContain("把 README 补全");
		// 主对话没有被注入「请开始实现」（它是审查者，干活的是执行对话）
		expect(h.conv().mainSent.some((t) => t.includes("现在开始实现"))).toBe(false);

		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		const reviewPrompt = h.conv().mainSent.at(-1)!;
		expect(reviewPrompt).toContain("验收者");
		expect(reviewPrompt).toContain("已改完并自测通过。");
		expect(reviewPrompt).toContain('"verdict"');
		expect(h.conv().goal.round).toBe(1);
		expect(h.conv().goal.phase).toBe("reviewing");
		expect(h.conv().goal.roles?.executor?.convId).toBe(EXEC_ID);
	});

	it("verdict=pass → 清目标并移出执行对话", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 A", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		h.conv().mainLastText.value = '{"verdict":"pass","feedback":"全部满足"}';
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.goal).toBeNull();
		expect(h.conv().goal.verdict).toBe("pass");
		expect(h.conv().goal.phase).toBe("idle");
		expect(h.dismissed).toContain(EXEC_ID);
		expect(h.conv().mainSent.some((t) => t.includes("目标已达成并通过审查"))).toBe(true);
	});

	it("verdict=fail → 审查意见派回同一个执行对话（记忆连续），轮次 +1", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 B", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"还差单测"}';
		h.svc.onAgentEnd(h.conv(), false);

		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().goal.round).toBe(2);
		expect(h.spawned).toHaveLength(1); // 复用同一个执行对话，不重开
		expect(h.steered).toHaveLength(1);
		expect(h.steered[0]).toContain("还差单测");
		expect(h.steered[0]).toContain("第 2");
	});

	it("审查回合不给 JSON：收紧契约重试一次，仍无 → 受阻（保留目标）", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 C", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		h.conv().mainLastText.value = "我觉得差不多了（没有 JSON）";
		h.svc.onAgentEnd(h.conv(), false);
		// 第二次审查请求（重试）
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(h.conv().mainSent.at(-1)).toContain("只回一个 JSON");
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.phase).toBe("blocked");
		expect(h.conv().goal.goal).toBe("目标 C"); // 受阻保留目标文本，用户可处置
		expect(h.spawned).toHaveLength(1); // 受阻轮没有再派活
		expect(notices(h).some((t) => t.includes("受阻"))).toBe(true);
	});

	it("连续两轮工作区零改动 → 服务端熔断（不问审查者）", async () => {
		const h = makeHarness({ diffs: ["same-diff", "same-diff", "same-diff"] });
		await h.svc.setGoal("目标 D", { maxRounds: 0, locked: true });
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"还不行"}';
		// 第 1、2 轮由审查者判 fail；第 3 轮取样发现连续两轮无进展 → 直接受阻
		await h.svc.whenAwaitingVerdict("conv-a");
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenAwaitingVerdict("conv-a");
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.round).toBe(3);
		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.feedback).toContain("未检测到有效文件修改");
	});

	it("宿主没有角色对话桥 → 拒绝设目标（目标模式只有一条路径，不降级）", async () => {
		const h = makeHarness();
		// 模拟未接线 / 非 pi 引擎：抽掉 spawnRoleAgent
		delete (h.host as { spawnRoleAgent?: unknown }).spawnRoleAgent;
		await h.svc.setGoal("目标 K", { maxRounds: 0, locked: true });
		expect(h.conv().goal.goal).toBeNull();
		expect(h.spawned).toHaveLength(0);
		expect(notices(h).some((t) => t.includes("不支持"))).toBe(true);
	});

	it("执行对话拉不起来（配额满）→ 当场中止并把原因摆到目标条（不再降级）", async () => {
		const h = makeHarness({ spawnFails: true });
		await h.svc.setGoal("目标 E", { maxRounds: 0, locked: true });
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.spawned).toHaveLength(0);
		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.phase).toBe("blocked");
		expect(h.conv().goal.status).toContain("执行对话创建失败");
		expect(h.conv().mainSent.some((t) => t.includes("现在开始实现"))).toBe(false); // 不再注入 self kick
		expect(notices(h).some((t) => t.includes("无法创建执行对话"))).toBe(true);
		expect(notices(h).some((t) => t.includes("普通对话名额"))).toBe(true);
	});

	it("执行者本轮超时 → 停掉它并在预算内继续下一轮（反馈写明超时）", async () => {
		const h = makeHarness({ waitOutcomes: ["timeout", "done"] });
		await h.svc.setGoal("目标 F", { maxRounds: 3, locked: true });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		// 超时轮不花审查 token：第一条派回执行者的消息就是超时反馈
		expect(h.stopped).toContain(EXEC_ID);
		expect(h.steered.at(-1)).toContain("超时");
		expect(h.conv().goal.round).toBe(2);
	});

	it("执行者被手动中止（子代理 ⏹）→ 循环立即收束，不再派下一轮", async () => {
		const h = makeHarness({ waitOutcomes: ["canceled", "done"] });
		await h.svc.setGoal("目标 H", { maxRounds: 0, locked: true });
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.feedback).toContain("已暂停");
		expect(h.conv().goal.round).toBe(1); // 没有因为中止而再派一轮
		expect(h.steered).toHaveLength(0); // 不得再向执行对话追加回合
		expect(h.conv().goal.goal).toBe("目标 H"); // 目标保留，可重新设定或点停止退出
	});

	it("执行对话被移出（hasConv=false）→ 受阻收尾，不留在指向死对话的状态", async () => {
		const h = makeHarness();
		await h.svc.setGoal("目标 I", { maxRounds: 0, locked: true });
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"继续"}';
		await h.svc.whenAwaitingVerdict("conv-a");
		// 用户在审查期间把执行对话关掉 → 下一轮派活前发现失联
		h.setGone(true);
		h.svc.onAgentEnd(h.conv(), false);
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.conv().goal.verdict).toBe("blocked");
		expect(h.conv().goal.feedback).toContain("被移出");
		expect(h.conv().goal.roles?.executor).toBeUndefined(); // 不留指向死对话的按钮
		expect(h.spawned).toHaveLength(1); // 不会自己重新拉起一个执行者
		expect(h.steered).toHaveLength(0); // 也不会向死对话追加回合
	});

	it("循环进行中 clearGoal（■ 停止目标）= 停掉并移出执行对话", async () => {
		const h = makeHarness({ diffs: ["a", "b"] });
		await h.svc.setGoal("目标 J", { maxRounds: 0, locked: true });
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"继续"}';
		await h.svc.whenAwaitingVerdict("conv-a");
		h.svc.onAgentEnd(h.conv(), false); // 审查 fail → 进入第 2 轮派活
		await h.svc.whenAwaitingVerdict("conv-a");
		expect(h.steered).toHaveLength(1);
		await h.svc.clearGoal();
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.stopped).toContain(EXEC_ID);
		expect(h.dismissed).toContain(EXEC_ID);
		expect(h.conv().goal.goal).toBeNull();
		expect(h.steered).toHaveLength(1); // 停止后再无新的派活
	});

	it("clearGoal 会停掉并移出常驻执行对话（循环不再派活）", async () => {
		const h = makeHarness({ diffs: ["a", "b"] });
		await h.svc.setGoal("目标 G", { maxRounds: 0, locked: true });
		await h.svc.whenAwaitingVerdict("conv-a");
		await h.svc.clearGoal();
		await h.svc.whenDelegatedSettled("conv-a");

		expect(h.stopped).toContain(EXEC_ID);
		expect(h.dismissed).toContain(EXEC_ID);
		expect(h.conv().goal.goal).toBeNull();
		// 清目标后到来的 verdict 不得改状态（代次作废）
		h.conv().mainLastText.value = '{"verdict":"pass","feedback":"晚到的结论"}';
		h.svc.onAgentEnd(h.conv(), false);
		expect(h.conv().goal.verdict).toBe("pending");
		expect(h.spawned).toHaveLength(1);
	});
});
