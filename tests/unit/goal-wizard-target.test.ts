/**
 * issue #292：目标调研跨会话落盘 + 原始草案卡片保留。
 *
 * 修的是两件事：
 *  1) setGoal 原来硬读 activeConv，调研跑完时若用户切走了就直接把结果丢掉
 *     （"已切换对话，目标调研结果已丢弃"）。现在可以 targetConvId 指定落点，
 *     调研结果落到"发起调研的那个对话"上。
 *  2) 调研开始先往发起对话推一张「原始目标草案」卡片，中断/取消后用户的原始
 *     输入仍然可见可复制（pushWizardCard 本来就发给发起对话，而不是当前对话）。
 *
 * 这里只覆盖 setGoal 的落点语义（纯逻辑、不碰模型）；startGoalWizard 的
 * 端到端流程见 tests/ 下的手工 smoke。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { GoalService, type GoalConversation, type GoalHost } from "../../server/goal-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const sent: ServerMessage[] = [];

const bootHost: GoalHost = {
	clientId: "c",
	agentDir: "/tmp/agent",
	stateStore: {
		getGoalPrefs: () => null,
		saveGoalPrefs: () => {},
	} as unknown as GoalHost["stateStore"],
	webUi: null as unknown as GoalHost["webUi"],
	emit: (msg) => void sent.push(msg),
	flushSnapshot: () => {},
	isDisposed: () => false,
	quiesceBlocked: () => false,
	activeConvId: () => "conv-a",
	activeConv: () => ({}) as GoalConversation,
	getConv: () => undefined,
	cwd: () => "/tmp/proj",
	reviewSettings: () => ({ reviewPrompt: "", reviewDisabledSkills: [] }),
	gitDiff: async () => "",
	goalModeEnabled: () => true,
};
const bootSvc = new GoalService(bootHost);

function makeConv(id: string, title: string): GoalConversation {
	return {
		id,
		title,
		cwd: "/tmp/proj",
		session: {
			isStreaming: false,
			sendUserMessage: async () => {},
			sendCustomMessage: async () => {},
		} as unknown as GoalConversation["session"],
		wizardRunning: false,
		goalGeneration: 0,
		goalReviewGeneration: 0,
		goal: bootSvc.makeGoalStatus(),
	};
}

function makeService(): { svc: GoalService; convs: Map<string, GoalConversation> } {
	const convs = new Map<string, GoalConversation>([
		["conv-a", makeConv("conv-a", "会话 A")],
		["conv-b", makeConv("conv-b", "会话 B")],
	]);
	const host: GoalHost = {
		clientId: "c",
		agentDir: "/tmp/agent",
		stateStore: {
			getGoalPrefs: () => null,
			saveGoalPrefs: () => {},
		} as unknown as GoalHost["stateStore"],
		webUi: null as unknown as GoalHost["webUi"],
		emit: (msg) => void sent.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
		quiesceBlocked: () => false,
		activeConvId: () => "conv-a", // 用户停在 A
		activeConv: () => convs.get("conv-a")!,
		getConv: (id) => convs.get(id),
		cwd: () => "/tmp/proj",
		reviewSettings: () => ({ reviewPrompt: "", reviewDisabledSkills: [] }),
		gitDiff: async () => "",
		goalModeEnabled: () => true,
	};
	return { svc: new GoalService(host), convs };
}

const notices = () => sent.filter((m) => m.type === "notice") as { text: string; level: string }[];

beforeEach(() => {
	sent.length = 0;
});

describe("setGoal 落点（issue #292）", () => {
	it("默认仍落在活动对话上（行为不变）", async () => {
		const { svc, convs } = makeService();
		await svc.setGoal("写测试");
		expect(convs.get("conv-a")!.goal.goal).toBe("写测试");
		expect(convs.get("conv-a")!.goal.conversationId).toBe("conv-a");
		expect(convs.get("conv-b")!.goal.goal).toBeNull();
	});

	it("targetConvId 指定落点：切走也能把调研结果写回发起对话", async () => {
		const { svc, convs } = makeService();
		// 用户在 B 里发起调研、然后切到 A（activeConvId = conv-a）
		await svc.setGoal("提炼后的目标", { targetConvId: "conv-b", autoStart: false });
		expect(convs.get("conv-b")!.goal.goal).toBe("提炼后的目标");
		// goal 归属跟着落点走，不会被活动对话的 agent_end 消费掉
		expect(convs.get("conv-b")!.goal.conversationId).toBe("conv-b");
		expect(convs.get("conv-a")!.goal.goal).toBeNull();
	});

	it("targetConvId 指向已关闭的对话：响亮拒绝，不落到别处", async () => {
		const { svc, convs } = makeService();
		await svc.setGoal("提炼后的目标", { targetConvId: "conv-gone", autoStart: false });
		const warn = notices().find((n) => n.level === "warning");
		expect(warn?.text).toContain("已关闭");
		expect(convs.get("conv-a")!.goal.goal).toBeNull();
		expect(convs.get("conv-b")!.goal.goal).toBeNull();
	});

	it("空文本仍是清除（targetConvId 不改变清除语义的调用方）", async () => {
		const { svc, convs } = makeService();
		await svc.setGoal("先设一个", { autoStart: false });
		await svc.setGoal("");
		expect(convs.get("conv-a")!.goal.goal).toBeNull();
	});
});
