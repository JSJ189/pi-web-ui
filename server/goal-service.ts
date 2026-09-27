/**
 * goal-service — 目标模式 2.0：目标状态机 + 服务端驱动的「执行 ↔ 审查」循环 + 调研向导，
 * 从 agent-service.ts 抽出。
 *
 * 职责：
 *  - setGoal/clearGoal/setGoalPrefs：目标状态机 + 偏好「全局记忆」（client-state.json）
 *  - 委托循环（**唯一**的审查/执行路径，目标模式 2.0）：主对话 = 审查者，服务端另起一个
 *    常驻执行对话干活。一轮 = 派活 → 等它结束 → 取样（工作区 diff 指纹 + 执行者会话的
 *    错误特征）→ 把审查指令交给主对话 → 解析 verdict → 判定（pass / 再来一轮 /
 *    熔断 / 预算用尽）。轮次、熔断、代次全在服务端，模型不得自循环。
 *  - startGoalWizard：AI 提炼——独立调研会话经 goal_ask 工具逐题提问（对话框桥接浏览器），
 *    收敛出 GOAL: 后自动设为目标并启动循环
 *
 * 历史说明：v1 的「隐藏隔离审查会话 + 自治标记」路径（runGoalReview / isAutonomous /
 * GOAL_COMPLETION_RE）已按产品决策删除，只留委托一条。`GoalStatus.reviewModel` 字段名
 * 保留（DSH 引擎仍在构造该状态），pi 侧语义已变为「调研（向导）模型」记忆位 ——
 * 审查者在委托模式下就是主对话，不再有独立的审查模型。
 *
 * 经 GoalHost 窄接口与 ClientSession 解耦（同 settings-service 模式）：对话记录按
 * 结构化子集 GoalConversation 传入（真实 Conversation 满足该结构），会话创建/对话框
 * 取消/git diff 等宿主能力走回调，便于独立测试。UI 文案直接中文（服务端 notice 约定）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	defineTool,
	ModelRuntime,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { GoalStatus, ServerMessage } from "./protocol.js";
import type { ClientStateStore } from "./client-state.js";
import { pick, type ServerLang } from "./i18n.js";
import { parseModelSpec } from "./attachments.js";
import type { WebUIContext } from "./webui-context.js";

/** ClientSession 私有 Conversation 中 goal 家族会触碰的字段（结构化子集）。 */
export interface GoalConversation {
	id: string;
	/** Display title (used in notices that name the conversation). */
	title: string;
	cwd: string;
	session: AgentSession;
	/** 调研进行中（互斥审查触发）。 */
	wizardRunning: boolean;
	/** set/clear/stop 都 +1：作废还在飞的异步审查回调。 */
	goalGeneration: number;
	goalReviewGeneration: number;
	goal: GoalStatus;
	/** 连续无文件改动/无进展轮数 */
	stagnantRounds?: number;
	/** 上一轮的 git diff 快照 */
	lastDiff?: string;
	/** 上一轮的错误特征 */
	lastErrorSnippet?: string;
	/** 连续相同错误轮数 */
	sameErrorRounds?: number;
	/** 目标模式 2.0（只有委托执行一条路径）：常驻执行者角色对话。
	 *  非空即表示本轮循环使用委托执行；`generation` 用于角色对话被外部重建后作废旧回调。 */
	roleExec?: { convId: string; generation: number };
	/** 委托执行：服务端已把审查指令交给主对话、正在等它的 verdict（非空 = 审查回合在飞）。 */
	awaitingVerdict?: { round: number };
	/** 委托执行：审查回合没给出 JSON 的重试次数（最多 1 次，避免无限加轮）。 */
	verdictRetry?: number;
}

/** 角色对话一轮的结局（waitRoleAgent 返回）。 */
export type RoleWaitOutcome = "done" | "error" | "canceled" | "timeout" | "gone";

/** 委托执行：主对话审查回合的结论（含解析失败 / 超时 / 失联三种显式状态）。 */
type DelegatedVerdict = { verdict: "pass" | "fail"; feedback: string } | "invalid" | "timeout" | "gone";

/** ClientSession 提供给本服务的宿主能力（窄接口）。 */
export interface GoalHost {
	clientId: string;
	agentDir: string;
	stateStore: ClientStateStore;
	webUi: WebUIContext;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	/** quiesce 排空中拒绝新调研。 */
	quiesceBlocked: () => boolean;
	activeConvId: () => string;
	activeConv: () => GoalConversation;
	getConv: (id: string) => GoalConversation | undefined;
	/** 客户端工作目录（wizard 的 in-memory session 用）。 */
	cwd: () => string;
	gitDiff: (cwd: string) => Promise<string>;
	/** 面向模型/工具返回字符串的服务端语言（默认英文）；推给 UI 的 notice 仍走 text+textEn 双字段。 */
	lang?: () => ServerLang;
	/** 目标模式总开关（设置面板「目标审查」页可关）。关 → 拒绝设目标/调研/审查。 */
	goalModeEnabled: () => boolean;
	// ---------------------------------------------------------------------
	// 目标模式 2.0 的角色对话桥（唯一审查/执行路径）。全部可选：缺席（未接线 /
	// 非 pi 引擎）时 setGoal 直接拒绝设目标并说明原因。
	// ---------------------------------------------------------------------
	/** 拉起常驻角色子代理（走既有子代理通道：模板/模型/思考强度/配额全复用）。 */
	spawnRoleAgent?: (opts: {
		role: "executor" | "reviewer";
		prompt: string;
		cwd: string;
		/** 显式模型（"provider/id"）；null/未传 = 模板模型 → 面板默认 → 跟随主对话。 */
		model?: string | null;
		/** 归属会话（左栏嵌套 + 相对 cwd 解析 + 跟随模型取数）。 */
		parentId?: string;
		/** 左栏/历史里显示的标题（落盘对话没有「子代理」微标，靠前缀保持可辨识）。 */
		title?: string;
	}) => Promise<string>;
	/** 事件驱动地等该对话「当前回合结束」（**严禁**实现成轮询）。 */
	waitRoleAgent?: (convId: string, timeoutMs: number) => Promise<RoleWaitOutcome>;
	/** 续跑：子代理 = 新回合；主对话 = 用户消息（按 deliverAs 排队/插话）。 */
	sendRoleAgent?: (convId: string, message: string, deliverAs?: "steer" | "followUp") => Promise<boolean>;
	/** 该对话最后一条 assistant 文本 + 最近错误特征（停滞/同错取数用）。 */
	readRoleAgent?: (convId: string) => { text: string; errorSnippet?: string } | undefined;
	/** 中止该对话正在跑的回合（角色轮超时 / 清目标时用）。 */
	stopRoleAgent?: (convId: string) => Promise<void>;
	/** 收尾：移出角色子代理（目标完成/清除时用）；主对话槽位实现为 no-op。 */
	dismissRoleAgent?: (convId: string) => Promise<void>;
	/** 该对话是否仍存在（子代理被移出后 steer 静默 no-op，循环必须显式判）。 */
	hasConv?: (convId: string) => boolean;
	/** 角色轮等待上限（毫秒）；缺省 20 分钟（与工具看门狗同口径）。 */
	roleDeadlineMs?: () => number;
}

/** 提取 raw 中第一个括号平衡的 {...} 子串（字符串字面量内的引号/转义/花括号不参与配对）。 */
function firstBalancedJsonObject(raw: string): string | undefined {
	const start = raw.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return raw.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * 解析审查模型的 verdict 输出（纯函数）。优先取第一个平衡 {...} 做 JSON.parse：
 * 模型常包 markdown 围栏或前后闲话，feedback 里也可能有 \" 转义与嵌套引号，
 * 这些由 JSON 语义天然处理；整体解析失败（单引号/尾逗号等）再退回旧的宽松
 * 正则逐字段抠。两者都失败返回 undefined，调用方按「无 JSON」处理。
 */
export function parseReviewerVerdict(raw: string): { verdict: "pass" | "fail"; feedback: string } | undefined {
	const json = firstBalancedJsonObject(raw);
	if (json !== undefined) {
		try {
			const value = JSON.parse(json) as { verdict?: unknown; feedback?: unknown };
			if (value && typeof value === "object" && !Array.isArray(value)) {
				if (value.verdict === "pass" || value.verdict === "fail") {
					return { verdict: value.verdict, feedback: typeof value.feedback === "string" ? value.feedback : "" };
				}
			}
		} catch {
			// 不是合法 JSON（围栏残留/单引号/尾逗号）→ 落到正则兜底
		}
	}
	const m = raw.match(/\{\s*"verdict"\s*:\s*"(pass|fail)"[^}]*\}/);
	if (m) {
		const fm = raw.match(/"feedback"\s*:\s*"([^"]*)"/);
		return { verdict: m[1] as "pass" | "fail", feedback: fm?.[1] ?? "" };
	}
	return undefined;
}

/** diff 正文进审查 prompt 的截断上限（完整规模信息走 [diff-meta] 尾段）。 */
export const GIT_DIFF_CAP = 60_000;

/**
 * 由 git 原始输出构造「变更指纹」（纯函数，供 AgentService.gitDiff 与单测共用）。
 *  - diff 正文非空 → 截断正文 + [diff-meta] 尾段（完整字符数 + 排序后的 status
 *    指纹）。尾段永不参与截断：大 diff 两轮的前 60_000 字符可能完全相同（改动
 *    落在截断线之后），只比截断正文会把持续推进误判成停滞；对内容变化敏感的
 *    完整字符数让 prevDiff 等值比较能区分「真没变」与「变了但被截断」。
 *  - diff 正文为空 → 排序后的 `git status --porcelain` 指纹（未跟踪文件不进
 *    diff，却是新工作区最常见的实际进展）；两段都空（返回 ""）才算真停滞。
 *  - status 输出为空/拍不到 → 对应段省略，退化为旧版纯 diff 行为。
 */
export function buildDiffFingerprint(diffOut: string, statusOut: string): string {
	let status = "";
	if (statusOut.trim() !== "") {
		// porcelain 不承诺输出有序，显式排序保证指纹逐轮稳定可比。
		status = statusOut
			.split("\n")
			.filter((line) => line.trim() !== "")
			.sort()
			.join("\n")
			.slice(0, 20_000);
	}
	if (diffOut.trim() === "") return status;
	const meta = `\n[diff-meta] chars=${diffOut.length}${status ? `\n[git-status]\n${status}` : ""}`;
	return diffOut.slice(0, GIT_DIFF_CAP) + meta;
}

/**
 * 提取会话最近产生的错误特征（纯函数，供停滞与相同报错检测）。
 * 从后往前扫最近 6 条消息：toolResult.isError 优先，其次非 0 退出的 bashExecution；
 * 都没有再退回从最终文本里找 Error/Exception/Fail/Fatal 行。
 * 抽成纯函数是因为委托执行（Plan A）要拿**执行者子代理**的错误特征（而不是主对话的）。
 */
export function extractErrorSnippetFromSession(session: unknown, text: string): string | undefined {
	try {
		const messages = (session as AgentSession | undefined)?.agent?.state?.messages;
		if (Array.isArray(messages)) {
			for (let i = messages.length - 1; i >= 0 && i >= messages.length - 6; i--) {
				const m = messages[i];
				if (m.role === "toolResult" && m.isError) {
					const errText = m.content
						?.map((c) => (c.type === "text" ? c.text : ""))
						.join(" ")
						.trim();
					if (errText) return errText.slice(0, 300);
				}
				if (m.role === "bashExecution" && m.exitCode && m.exitCode !== 0) {
					const snippet = m.output?.trim().slice(-300);
					if (snippet) return `bash exit ${m.exitCode}: ${snippet}`;
				}
			}
		}
	} catch {
		// Ignore
	}
	const errMatch = text.match(/(?:(?:Error|Exception|Fail|Fatal):[^\n]+)/i);
	if (errMatch) {
		return errMatch[0].trim().slice(0, 300);
	}
	return undefined;
}

/** System prompt for the goal-wizard session. The wizard asks the user a few
 *  questions (via its goal_ask tool) to scope a raw requirement into a precise,
 *  reviewable goal, then emits ONLY the final goal text as its last message. */
function wizardPrompt(draft: string): string {
	return [
		`You are a goal-clarification wizard. The user has stated a raw requirement. Your job is to turn it into ONE precise, actionable goal that a coding agent can fully satisfy and that can be strictly reviewed.`, // eslint-disable-line max-len
		``,
		`# User's raw requirement`, // eslint-disable-line no-regex-spaces
		draft,
		``,
		`Use your goal_ask tool to ask the user focused questions to pin down the essential, ambiguous details.`,
		`Convergence guidelines:`,
		`- Ask ONE question at a time, strictly 1 to 3 questions total: what exactly to build/do, scope boundaries (what NOT to do), acceptance criteria / done-definition, and any constraints (style, performance, environment).`, // eslint-disable-line max-len
		`- Prefer multiple-choice with 2-4 mutually exclusive options and place your recommended choice FIRST.`,
		`- In each option, concisely explain the impact or tradeoff. Use open questions only for things that genuinely need free text.`, // eslint-disable-line max-len
		`Once you have enough to write an unambiguous, reviewable goal, STOP asking and reply with EXACTLY this format and nothing else (no preamble, no bullets):`, // eslint-disable-line max-len
		`GOAL: <one concrete, verifiable sentence describing the deliverable and its acceptance criteria>`, // eslint-disable-line max-len
		`If the user cancels or stops answering (the tool reports a cancellation), still produce a sensible best-effort goal from what you already know.`, // eslint-disable-line max-len
	].join("\n");
}

export class GoalService {
	/** Defaults remembered for newly-created conversations. Each conversation
	 * receives its own GoalStatus, so reviews can run concurrently. */
	private prefs = {
		reviewModel: null as string | null,
		maxRounds: 0,
		locked: true,
		/** 目标模式 2.0：委托执行者模型。 */
		execModel: null as string | null,
	};
	/** Aborts the currently-running goal wizard (user clicked ✗ / timed out). Drives
	 *  the in-flight goal_ask dialog to resolve as cancelled and (via the run
	 *  signal) stops the wizard session's agent run. Recreated per wizard. */
	private wizardAbort: AbortController | null = null;
	/** The wizard's AgentSession while it runs — lets clearGoal truly terminate it
	 *  (abort the run), not just flip a flag. */
	private wizardSession: AgentSession | null = null;
	/** Conversation that owns the one browser wizard currently in flight. */
	private wizardOwnerId: string | null = null;
	/** True when the wizard was cancelled externally (✗ / clear_goal / timeout) —
	 *  startGoalWizard reads this after the run to avoid setting a goal. */
	private wizardCancelled = false;
	// ---------------------------------------------------------------------
	// 目标模式 2.0（只有委托执行）的循环状态。
	// ---------------------------------------------------------------------
	/** 正在等主对话（审查者）verdict 的循环：convId → resolve。 */
	private verdictWaiters = new Map<string, (v: DelegatedVerdict) => void>();
	/** 「已把审查指令交给主对话」的观测点（waitForVerdict 登记后触发；测试/宿主观测用）。 */
	private verdictSignals = new Map<string, Set<() => void>>();
	/** 每个对话至多一个在飞循环（convid → promise）。 */
	private delegatedLoops = new Map<string, Promise<void>>();
	/** Idle-timeout for the wizard: if no answer arrives within this window (a
	 *  dialog is up but the user doesn't respond), the wizard is auto-cancelled. */
	private static readonly WIZARD_IDLE_TIMEOUT_MS = 5 * 60_000;
	/** Absolute deadline for the whole wizard session (model latency guard). */
	private static readonly WIZARD_MAX_TOTAL_MS = 20 * 60_000;

	constructor(private readonly host: GoalHost) {
		// Restore last-used goal/review preferences so model & rounds survive reload.
		const gPrefs = host.stateStore.getGoalPrefs(host.clientId);
		if (gPrefs) {
			this.prefs = {
				reviewModel: gPrefs.reviewModel,
				maxRounds: gPrefs.maxRounds,
				locked: gPrefs.locked,
				execModel: gPrefs.execModel ?? null,
			};
		}
	}

	/** Remembered defaults (model choice / rounds cap / lock). */
	get reviewPrefs() {
		return this.prefs;
	}

	/** 当前服务端语言（英文默认，未接线前保持原有英文行为）。 */
	private lang(): ServerLang {
		return this.host.lang?.() ?? "en";
	}

	/** 目标模式总开关（设置面板可关）。关 → 所有目标入口拒绝、审查不再触发。 */
	private goalEnabled(): boolean {
		return this.host.goalModeEnabled();
	}

	/** Create independent goal state for one conversation. Preferences are
	 * client-wide defaults, while goal text/review progress is not shared. */
	makeGoalStatus(): GoalStatus {
		return {
			conversationId: null,
			goal: null,
			reviewModel: this.prefs.reviewModel,
			maxRounds: this.prefs.maxRounds,
			locked: this.prefs.locked,
			execModel: this.prefs.execModel,
			phase: "idle",
			reviewing: false,
			round: 0,
			status: "",
			verdict: "pending",
			wizard: {
				active: false,
				draft: "",
				model: null,
				step: 0,
				maxSteps: 6,
				status: "",
			},
		};
	}

	/** Push the active conversation's goal status to the client (the goal bar
	 * restores remembered prefs when nothing is active). */
	emitGoalStatus(): void {
		const goal = this.host.activeConv().goal;
		if (!goal.goal && !goal.reviewing && !goal.wizard.active) {
			goal.reviewModel = this.prefs.reviewModel;
			goal.maxRounds = this.prefs.maxRounds;
			goal.locked = this.prefs.locked;
			goal.execModel = this.prefs.execModel;
		}
		this.host.emit({ type: "goal_status", status: { ...goal } });
	}

	/**
	 * Set (or clear) the active goal. `goal === ""` clears it. The goal is
	 * applied to the CURRENT active conversation of this project; reviews check
	 * whatever run finishes next (agent_end).
	 *
	 * `opts.targetConvId` retargets the write to a specific conversation — used by
	 * the goal wizard, which runs in the background while the user may have
	 * switched away: the refined goal must land in the conversation that LAUNCHED
	 * the survey (issue #292), not in whatever conversation happens to be active
	 * and not be thrown away.
	 */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			/** 目标模式 2.0：委托执行者模型（"provider/id"；空 = 跟随模板/主对话）。 */
			execModel?: string;
			/** Apply the goal to this conversation instead of the active one. */
			targetConvId?: string;
			/** Kick the main agent into generating as soon as the goal is set.
			 *  Default true (set from the goal bar). The wizard passes false — it
			 *  kicks off its own generation after auto-setting the refined goal. */
			autoStart?: boolean;
		},
	): Promise<void> {
		const text = (goalText ?? "").trim();
		if (!text) {
			await this.clearGoal();
			return;
		}
		if (!this.goalEnabled()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
				textEn: "Goal mode is off: enable it under Settings → Goal review first.",
			});
			return;
		}
		// 目标模式 2.0 只有一条路径（执行对话干活 + 当前对话验收），需要宿主提供角色
		// 对话桥（spawn/wait/send/read/stop/dismiss）；缺任何一个（未接线 / 非 pi
		// 引擎）则在**动目标状态之前**就拒绝并说明原因。
		if (!this.roleBridgeReady()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标模式需要支持「执行对话」的引擎（当前引擎不支持，目标未设置）。",
				textEn:
					"Goal mode requires an engine that supports executor conversations (unsupported here; the goal was not set).",
			});
			return;
		}
		// A goal is scoped to the conversation it is set on (default: the active
		// one). This prevents an agent_end from a newly-created/switched conversation
		// from consuming the previous conversation's goal.
		const targetConv = opts?.targetConvId ? this.host.getConv(opts.targetConvId) : undefined;
		if (opts?.targetConvId && !targetConv) {
			// The targeted conversation is gone (closed / disposed) — refuse loudly
			// instead of silently landing the goal somewhere else.
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `目标未设置：发起目标调研的对话已关闭。`,
				textEn: `Goal not set: the conversation that started the survey is gone.`,
			});
			return;
		}
		const conv = targetConv ?? this.host.activeConv();
		const goalConversationId = conv.id;
		conv.goalGeneration += 1;
		// 上一轮目标可能还留着常驻执行者子代理（委托执行）：先停掉再开新的，
		// 否则旧循环会在新目标上继续派活（代次已作废，但角色对话得收）。
		this.stopDelegated(conv);
		const goal = conv.goal;
		goal.reviewing = false;
		goal.conversationId = goalConversationId;
		goal.goal = text;
		// Model & rounds preference semantics ("全局记忆"):
		//  - reviewModel undefined → keep the remembered choice; empty → main model.
		//  - maxRounds 0 = unlimited (default); >0 = finite cap (clamped to 50).
		if (opts?.reviewModel !== undefined) goal.reviewModel = opts.reviewModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) goal.locked = opts.locked;
		if (opts?.execModel !== undefined) goal.execModel = opts.execModel || null;
		this.prefs = {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
			execModel: goal.execModel ?? null,
		};
		// Persist the chosen preferences so they survive reload.
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
			execModel: this.prefs.execModel,
		});
		// Reset the loop for a freshly-set goal (single-shot goals start at 0).
		conv.stagnantRounds = 0;
		conv.lastDiff = undefined;
		conv.lastErrorSnippet = undefined;
		conv.sameErrorRounds = 0;
		conv.awaitingVerdict = undefined;
		conv.verdictRetry = 0;
		goal.round = 0;
		goal.reviewing = false;
		goal.verdict = "pending";
		goal.feedback = undefined;
		goal.phase = "idle";
		goal.roles = {};
		goal.wizard.active = false;
		goal.wizard.status = "";
		goal.wizard.statusEn = "";
		goal.status = "目标已设，等待生成…";
		goal.statusEn = "Goal set, waiting to generate…";
		this.emitGoalStatus();
		this.host.emit({
			type: "notice",
			level: "info",
			text: `🎯 已设目标：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
			textEn: `🎯 Goal set: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
		});
		// Auto-start generation right after setting the goal (unless this setGoal is
		// the wizard's internal one, which kicks off itself). This makes the direct
		// goal-bar path behave like the AI-提炼 path: set a target → agent begins.
		if (opts?.autoStart !== false) {
			// 目标模式 2.0（唯一路径）：主对话当审查者，干活的是常驻执行对话 ——
			// 不向主对话注入「请开始实现」，改由服务端驱动循环（等执行者跑完再把
			// 审查指令交给主对话）。
			this.startDelegatedLoop(conv, conv.goalGeneration, text);
			this.host.flushSnapshot();
		}
	}

	/**
	 * Collaborative target wizard. Turns a raw user requirement into a refined
	 * goal by spinning up an ISOLATED wizard session (own fresh ModelRuntime +
	 * in-memory session, so its model choice is its own) that questions the user
	 * via `goal_ask` (multiple-choice + free-text, bridged to the browser through
	 * the existing select/input dialog), converging on a goal, then auto-sets it.
	 * Mutually exclusive with the review loop of the same conversation.
	 */
	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		if (this.host.quiesceBlocked()) return;
		if (!this.goalEnabled()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
				textEn: "Goal mode is off: enable it under Settings → Goal review first.",
			});
			return;
		}
		const draft = (text ?? "").trim();
		if (!draft) return;

		// The wizard and its progress cards belong to the conversation that
		// launched it. If the user switches away, do not later set a goal on the
		// new active conversation while the wizard is still finishing.
		const wizardConversationId = this.host.activeConvId();
		const wizardConversation = this.host.activeConv();
		// Human-readable name for notices that must say WHICH conversation the survey
		// belongs to (issue #292: the user is expected to switch away mid-survey).
		const wizardConversationTitle = wizardConversation.title;
		if (wizardConversation.wizardRunning || this.wizardOwnerId !== null) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "已有目标调研进行中，请等它完成…",
				textEn: "A goal survey is already running — wait for it to finish…",
			});
			return;
		}
		if (wizardConversation.goal.reviewing) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "正在审查中，无法开始目标调研，请稍等…",
				textEn: "A review is running; cannot start a goal survey yet…",
			});
			return;
		}

		// Questions are NOT capped (调研不限制) — the wizard converges on its own;
		// the idle- and total-timeouts are the only guards. maxSteps is purely a
		// soft UI indicator, not a hard stop.
		const maxSteps = 20;
		wizardConversation.wizardRunning = true;
		this.wizardOwnerId = wizardConversationId;
		this.wizardCancelled = false;
		this.wizardAbort = new AbortController();
		this.wizardSession = null;
		const wgoal = wizardConversation.goal;
		wgoal.wizard.active = true;
		wgoal.wizard.draft = draft;
		wgoal.wizard.model = opts?.wizardModel ?? null;
		// Remember the model choice (and persist rounds/lock) — global memory.
		if (opts?.wizardModel !== undefined && opts.wizardModel !== null) wgoal.reviewModel = opts.wizardModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			wgoal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) wgoal.locked = opts.locked;
		this.prefs = {
			reviewModel: wgoal.reviewModel,
			maxRounds: wgoal.maxRounds,
			locked: wgoal.locked,
			execModel: wgoal.execModel ?? null,
		};
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: wgoal.reviewModel,
			maxRounds: wgoal.maxRounds,
			locked: wgoal.locked,
			execModel: wgoal.execModel ?? null,
		});
		wgoal.wizard.step = 0;
		wgoal.wizard.maxSteps = maxSteps;
		wgoal.wizard.status = "调研中…";
		wgoal.wizard.statusEn = "Scoping…";
		wgoal.status = "目标调研中…";
		wgoal.statusEn = "Scoping the goal…";
		this.emitGoalStatus();
		// Idle-timeout: cancel the wizard if no question is answered within the
		// window (a stale dialog with no user response must not run forever). A
		// fresh timer is armed for each question; cleared once the run ends.
		const ac = this.wizardAbort;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const armIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				if (!ac.signal.aborted) {
					this.wizardCancelled = true;
					ac.abort(
						new Error(
							pick(
								this.lang(),
								"目标调研超时（等待回答过久）",
								"Goal survey timed out (waited too long for an answer)",
								"goal.wizard.idle.timeout",
							),
						),
					);
				}
			}, GoalService.WIZARD_IDLE_TIMEOUT_MS);
			idleTimer.unref?.();
		};
		const clearIdle = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
		};
		armIdle();
		// Total-duration guard: hard cap on the whole wizard session (model
		// latency / unexpected loops must not run forever).
		const totalTimer = setTimeout(() => {
			if (!ac.signal.aborted) {
				this.wizardCancelled = true;
				ac.abort(
					new Error(
						pick(
							this.lang(),
							"目标调研超过总时长上限",
							"Goal survey exceeded the total time limit",
							"goal.wizard.total.timeout",
						),
					),
				);
			}
		}, GoalService.WIZARD_MAX_TOTAL_MS);
		totalTimer.unref?.();
		this.host.emit({
			type: "notice",
			level: "info",
			text: `🔍 正在围绕需求展开调研：${draft.slice(0, 60)}${draft.length > 60 ? "…" : ""}`,
			textEn: `🔍 Surveying the requirement: ${draft.slice(0, 60)}${draft.length > 60 ? "…" : ""}`,
		});

		// The main conversation to show wizard progress cards in.
		const mainSession = wizardConversation.session;
		// The raw draft gets its own read-only card BEFORE the first question, so the
		// flow starts from a visible anchor. If the survey is interrupted (idle/total
		// timeout, ✗, or the user switching away and never coming back), the original
		// requirement is still readable and copyable in THIS conversation instead of
		// having to be retyped (issue #292).
		await this.pushWizardCard(
			mainSession,
			pick(this.lang(), `🎯 原始目标草案：${draft}`, `🎯 Initial goal draft: ${draft}`, "goal.wizard.draft.card", {
				draft,
			}),
			{ draft },
		);

		let refinedGoal = "";
		let goalEphemeralDir: string | undefined;
		try {
			const wmSpec = opts?.wizardModel ? parseModelSpec(opts.wizardModel) : null; // "provider/id" 解析（唯一事实源）
			const services = await createAgentSessionServices({
				cwd: wizardConversation.cwd,
				agentDir: this.host.agentDir,
				modelRuntime: await ModelRuntime.create({
					authPath: join(this.host.agentDir, "auth.json"),
					modelsPath: join(this.host.agentDir, "models.json"),
				}),
			});

			let model;
			if (wmSpec) model = services.modelRuntime.getModel(wmSpec.provider, wmSpec.id);
			if (!model) {
				const mainModel = mainSession.model as
					| {
							provider?: string;
							id?: string;
					  }
					| undefined;
				if (mainModel?.provider && mainModel.id)
					model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
			}

			// The wizard asks the user questions via this tool; each call bridges one
			// select/input dialog to the browser and returns the user's answer.
			let qStep = 0;
			const goalAsk = defineTool({
				name: "goal_ask",
				label: "Ask the user",
				description:
					"Ask the user ONE focused question at a time to scope down the goal. " +
					"Provide 2-4 mutually exclusive options with the recommended option first, " +
					"briefly noting its impact or tradeoff; or ask an open question. Returns the user's chosen answer.",
				parameters: Type.Object({
					question: Type.String({ description: "The question to ask" }),
					options: Type.Optional(
						Type.Array(Type.String(), {
							description: "2-4 mutually exclusive options (recommended option first)",
						}),
					),
				}),
				// ONE question at a time. Sequential execution prevents the agent from
				// firing parallel goal_ask calls whose dialogs would overwrite each other
				// in the single browser modal (leaving earlier ones deadlocked — the
				// reported "调研卡住").
				executionMode: "sequential",
				execute: async (_id, params, _sig, _onUpdate, ctx) => {
					const lang = this.lang();
					qStep += 1;
					if (qStep > maxSteps) {
						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										"(达到最大提问数，请直接给出收敛后的目标文本作为最终答案)",
										"(Max questions reached — stop asking and reply with the converged goal text as your final answer)",
										"goal.wizard.max.questions",
									),
								},
							],
							details: {},
						};
					}
					// Show the question in the main flow BEFORE blocking on the dialog, so
					// the user sees the wizard working even before answering.
					wgoal.wizard.step = qStep;
					wgoal.wizard.status = `调研中：请回答第 ${qStep} 题`;
					wgoal.wizard.statusEn = `Scoping: please answer question ${qStep}`;
					this.emitGoalStatus();
					try {
						armIdle();
						const isChoice = !!(params.options && params.options.length > 0);
						const qTitle = pick(
							lang,
							`🔍 第 ${qStep} 题：${params.question}`,
							`🔍 Question ${qStep}: ${params.question}`,
							"goal.wizard.question.title",
							{ qStep: qStep, "params.question": params.question },
						);
						const optionsJoined = params.options!.join(" / ");
						const choiceSuffixZh = isChoice ? `【${optionsJoined}】` : "";
						const choiceSuffixEn = isChoice ? ` [${optionsJoined}]` : "";
						await this.pushWizardCard(
							mainSession,
							pick(
								lang,
								`🔍 第 ${qStep} 题：${params.question}${choiceSuffixZh}`,
								`🔍 Question ${qStep}: ${params.question}${choiceSuffixEn}`,
								"goal.wizard.question.card",
								{
									qStep: qStep,
									"params.question": params.question,
									choiceSuffixZh: choiceSuffixZh,
									choiceSuffixEn: choiceSuffixEn,
								},
							),
							{ question: params.question },
						);
						// Resolve the pending dialog as cancelled if the wizard is aborted.
						let aborted = false;
						const onAbort = () => {
							aborted = true;
						};
						ac.signal.addEventListener("abort", onAbort, { once: true });
						const choose = isChoice ? ctx.ui.select(qTitle, params.options!) : ctx.ui.input(qTitle);
						const ans = (await choose) as string | boolean | undefined;
						ac.signal.removeEventListener("abort", onAbort);
						if (aborted || ac.signal.aborted) {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											"(调研已取消，请不要继续提问，直接结束对话)",
											"(The survey was cancelled — stop asking and end the conversation)",
											"goal.wizard.cancelled.stop",
										),
									},
								],
								details: {},
							};
						}
						if (ans === undefined || ans === null || ans === false || ans === "") {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											"(用户已取消调研，请直接给出你当前收敛的目标文本作为最终答案)",
											"(The user cancelled the survey — reply with your best-effort goal text as the final answer)",
											"goal.wizard.cancelled.best",
										),
									},
								],
								details: {},
							};
						}
						// Record the answer in the flow too (instant append, main session idle).
						await this.pushWizardCard(
							mainSession,
							pick(lang, `↳ 您的回答：${ans}`, `↳ Your answer: ${ans}`, "goal.wizard.answer.card", { ans: ans }),
							{
								question: params.question,
								answer: String(ans),
							},
						);
						return {
							content: [
								{
									type: "text",
									text: pick(lang, `用户回答：${ans}`, `User answer: ${ans}`, "goal.wizard.answer.return", {
										ans: ans,
									}),
								},
							],
							details: {},
						};
					} catch (err) {
						const errMsg = (err as Error).message;
						return {
							content: [
								{
									type: "text",
									text: ac.signal.aborted
										? pick(
												lang,
												"(调研已取消，请不要继续提问，直接结束对话)",
												"(The survey was cancelled — stop asking and end the conversation)",
												"goal.wizard.cancelled.aborted",
											)
										: pick(lang, `提问失败：${errMsg}`, `Failed to ask: ${errMsg}`, "goal.wizard.ask.failed", {
												errMsg: errMsg,
											}),
								},
							],
							details: {},
						};
					}
				},
			});

			const sm = SessionManager.inMemory(this.host.cwd());
			goalEphemeralDir = join(services.agentDir, "goal-sessions", `wizard-${Date.now()}`);
			try {
				mkdirSync(goalEphemeralDir, { recursive: true });
				(sm as unknown as { sessionDir: string }).sessionDir = goalEphemeralDir;
			} catch {}

			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: sm,
				customTools: [goalAsk],
				...(model ? { model } : {}),
			});
			const wizard = srv.session;
			this.wizardSession = wizard;
			await wizard.bindExtensions({ mode: "rpc", uiContext: this.host.webUi });
			// Cancel watcher: when the user ✗s / idle-timeout fires, truly stop the
			// wizard's agent run (not just mark it).
			if (!ac.signal.aborted) {
				ac.signal.addEventListener(
					"abort",
					() => {
						void wizard.abort().catch(() => {});
						// Close the unanswered browser dialog(s) the wizard may have up.
						this.host.webUi.cancelPendingDialogs();
					},
					{ once: true },
				);
			}
			await wizard.prompt(wizardPrompt(draft));
			refinedGoal = wizard.getLastAssistantText()?.trim() ?? "";
			// The wizard is prompted to emit "GOAL: <text>". Parse past the marker;
			// if it didn't follow, strip a leading preamble line and keep the rest.
			const goalMatch = refinedGoal.match(/GOAL\s*[:：]\s*([\s\S]*)/i);
			if (goalMatch) {
				refinedGoal = goalMatch[1].trim();
			} else {
				const lines = refinedGoal.split("\n").filter((l) => l.trim());
				if (lines.length > 1 && !/[。.!?？]\s*$/.test(lines[0])) {
					// First line looks like preamble (no sentence-ending punctuation).
					refinedGoal = lines.slice(1).join(" ").trim();
				}
			}
			await srv.session.dispose();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `目标调研失败：${(err as Error).message}`,
				textEn: `Goal survey failed: ${(err as Error).message}`,
			});
		} finally {
			clearIdle();
			clearTimeout(totalTimer);
			wizardConversation.wizardRunning = false;
			if (this.wizardOwnerId === wizardConversationId) this.wizardOwnerId = null;
			wgoal.wizard.active = false;
			wgoal.wizard.step = 0;
			wgoal.wizard.status = "";
			wgoal.wizard.statusEn = "";
			this.wizardSession = null;
			if (goalEphemeralDir) {
				try {
					rmSync(goalEphemeralDir, { recursive: true, force: true });
				} catch {}
			}
			this.emitGoalStatus();
		}

		// Aborted externally (✗ / clear_goal / idle-timeout): do NOT set a goal. The raw
		// draft card stays in the launching conversation's flow, so the user can read
		// it back (and retry) instead of having to retype it (issue #292).
		if (ac.signal.aborted || this.wizardCancelled) {
			this.host.emit({
				type: "notice",
				level: "info",
				text:
					`目标调研已取消${ac.signal.reason ? `：${String((ac.signal.reason as Error)?.message ?? ac.signal.reason)}` : ""}` +
					`。原始目标草案已保留在会话「${wizardConversationTitle}」的消息流中，可复制后重新发起。`,
				textEn:
					`Goal survey cancelled${ac.signal.reason ? `: ${String((ac.signal.reason as Error)?.message ?? ac.signal.reason)}` : ""}` +
					`. The initial goal draft is preserved in the conversation "${wizardConversationTitle}" — copy it and start over.`,
			});
			this.wizardAbort = null;
			return;
		}
		if (!refinedGoal.trim()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `调研未产出有效目标，请重试（原始目标草案在会话「${wizardConversationTitle}」的消息流中）`,
				textEn: `The survey produced no usable goal — retry (the initial draft is in the conversation "${wizardConversationTitle}")`,
			});
			return;
		}
		// The survey belongs to the conversation that launched it. The user is EXPECTED
		// to switch away while the questions are being answered (check code, read docs),
		// so "active ≠ launcher" is the normal case, not an error: land the refined goal
		// on the launcher instead of discarding the work (issue #292).
		const targetConv = this.host.getConv(wizardConversationId);
		if (!targetConv) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `目标调研完成，但发起会话「${wizardConversationTitle}」已关闭，结果未应用（可在新会话里重新发起）。`,
				textEn: `The survey finished, but the conversation that started it ("${wizardConversationTitle}") is gone — the result was not applied. Start a new survey.`,
			});
			return;
		}
		const switchedAway = this.host.activeConvId() !== wizardConversationId;
		// Auto-set the refined goal. The wizard workflow implies "set a goal and
		// work until it passes", so default LOCKED=true unless the user explicitly
		// turned the lock off (a lock lets the review loop keep revising to pass;
		// without it the review is single-shot).
		const wantLocked = opts?.locked === undefined ? true : opts.locked;
		await this.setGoal(refinedGoal, {
			reviewModel: wgoal.reviewModel ?? undefined,
			maxRounds: opts?.maxRounds,
			locked: wantLocked,
			// 目标模式 2.0：执行者模型随调研一起带过去（wizard 与目标条共用记忆偏好）。
			execModel: wgoal.execModel ?? undefined,
			// Land the goal on the conversation that launched the survey, even if the
			// user is looking at another one right now (issue #292).
			targetConvId: wizardConversationId,
			// The wizard kicks off generation itself below — avoid a double kick.
			autoStart: false,
		});
		this.wizardCancelled = false;
		this.wizardAbort = null;
		this.host.emit({
			type: "notice",
			level: "info",
			text: switchedAway
				? `🎯 会话「${wizardConversationTitle}」目标调研完成，目标已设为：${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""}（已切回该会话开始生成）`
				: `🎯 调研完成，目标已设为：${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""}`,
			textEn: switchedAway
				? `🎯 Survey done in "${wizardConversationTitle}", goal set: ${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""} (switch back to that conversation to watch it generate)`
				: `🎯 Survey done, goal set: ${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""}`,
		});
		// 目标模式 2.0（唯一路径）：不向主对话注入「开始实现」——它在目标模式下是审查者，
		// 干活的另有执行对话，改由服务端循环驱动（setGoal 已把 goal 落在发起会话上）。
		if (targetConv.goal.goal) {
			this.startDelegatedLoop(targetConv, targetConv.goalGeneration, targetConv.goal.goal);
			this.host.flushSnapshot();
		}
	}

	/** Persist goal/review preference defaults (model, rounds cap, locked) without
	 *  touching the active goal — so changes in the goal bar are remembered across
	 *  reloads. maxRounds 0 = unlimited. Emits goal_status so the UI stays synced. */
	async setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
		execModel?: string;
	}): Promise<void> {
		if (!this.goalEnabled()) return;
		const goal = this.host.activeConv().goal;
		if (opts?.reviewModel !== undefined) goal.reviewModel = opts?.reviewModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) goal.locked = opts.locked;
		// 执行者模型：目标进行中不换轨（换模型对已存在的执行对话无效）——只记偏好，
		// 下一个目标生效并明确告知。
		const hasExecOpt = opts?.execModel !== undefined;
		if (goal.goal && hasExecOpt) {
			this.host.emit({
				type: "notice",
				level: "info",
				text: "执行模型将在下一个目标生效（当前目标继续用启动时的模型跑完）。",
				textEn: "The executor model applies to the next goal (the current one keeps the model it started with).",
			});
		} else if (hasExecOpt) {
			goal.execModel = opts?.execModel || null;
		}
		this.prefs = {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
			execModel: hasExecOpt ? opts?.execModel || null : this.prefs.execModel,
		};
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
			execModel: this.prefs.execModel,
		});
		this.emitGoalStatus();
	}

	/** Clear the active goal (cancels the review loop AND aborts a running
	 *  goal wizard — truly terminating its in-flight dialog + agent run). */
	async clearGoal(): Promise<void> {
		const conv = this.host.activeConv();
		conv.goalGeneration += 1;
		// 委托执行：停掉在飞的执行者（循环靠代次作废 + 代次守卫退出）。
		this.stopDelegated(conv);
		conv.stagnantRounds = 0;
		conv.lastDiff = undefined;
		conv.lastErrorSnippet = undefined;
		conv.sameErrorRounds = 0;
		const goal = conv.goal;
		goal.reviewing = false;
		goal.conversationId = null;
		goal.goal = null;
		goal.reviewing = false;
		goal.verdict = "pending";
		goal.feedback = undefined;
		goal.wizard.active = false;
		goal.wizard.status = "";
		goal.wizard.statusEn = "";
		goal.status = "";
		goal.statusEn = "";
		goal.phase = "idle";
		goal.roles = {};
		this.emitGoalStatus();
		// Abort a running wizard for real (✗ in the goal bar while scoping).
		if (this.wizardOwnerId === this.host.activeConvId()) {
			this.wizardCancelled = true;
			this.host.webUi.cancelPendingDialogs();
			this.wizardAbort?.abort();
			const ws2 = this.wizardSession;
			this.wizardSession = null;
			if (ws2) {
				await ws2.abort().catch(() => {});
				ws2.dispose();
			}
			this.wizardAbort = null;
		}
	}

	/**
	 * agent_end hook. `aborted` = the finished run ended by manual stop; in that
	 * case any active goal of THIS conversation is cleared so the review loop
	 * stops too (a half-finished run must not be reviewed — endless loop).
	 * Otherwise, spawn the isolated reviewer if a goal is pending. Returns a
	 * notice text for the host to emit (manual-stop case), or null.
	 */
	onAgentEnd(conv: GoalConversation, aborted: boolean): { text: string; textEn: string } | null {
		const g = conv.goal;
		if (aborted) {
			if (g.goal && g.conversationId === conv.id) {
				conv.goalGeneration += 1;
				// 委托执行：手动停止也要把在飞的执行者停掉（否则它还在后台改工作区）。
				this.stopDelegated(conv);
				conv.stagnantRounds = 0;
				conv.lastDiff = undefined;
				conv.lastErrorSnippet = undefined;
				conv.sameErrorRounds = 0;
				g.conversationId = null;
				g.goal = null;
				g.reviewing = false;
				g.verdict = "pending";
				g.feedback = undefined;
				g.phase = "idle";
				g.roles = {};
				g.status = "已手动停止，目标审查已中止";
				g.statusEn = "Stopped manually, goal review aborted";
				this.emitGoalStatus();
				return {
					text: "⏹ 已手动停止，目标审查已中止（想继续可重新设定目标）",
					textEn: "⏹ Stopped manually, goal review aborted (set a new goal to continue)",
				};
			}
			return null;
		}
		// 本对话就是审查者：只有服务端把审查指令交给它之后结束的那个回合才是审查回合
		// （awaitingVerdict 非空）；其余 agent_end（用户在执行期聊天/插话）一律不当
		// 审查结果，也不会重新触发任何循环（目标模式 2.0 只有委托一条路径）。
		if (g.goal && g.conversationId === conv.id && conv.awaitingVerdict) {
			this.deliverDelegatedVerdict(conv);
		}
		return null;
	}

	// =====================================================================
	/** Insert a wizard progress card into the MAIN conversation flow and render it
	 *  IMMEDIATELY (the main session is idle while the wizard runs in its own
	 *  session, so — unlike nextTurn, which queues until the next user prompt —
	 *  sending without a delivery option appends + persists + emits at once). */
	private async pushWizardCard(
		sess: AgentSession,
		text: string,
		details?: { question?: string; answer?: string; draft?: string },
	): Promise<void> {
		try {
			await sess.sendCustomMessage({
				customType: "goal-wizard",
				content: [{ type: "text", text }],
				display: true,
				details: { type: "goal-wizard", ...details },
			});
		} catch {
			// Card insertion is cosmetic — never block the question flow on it.
		}
	}

	/** 目标模式 2.0（唯一路径：主对话 = 审查者 + 常驻执行对话）
	//
	// 干活的是服务端拉起的常驻执行对话（落盘、左栏可见可点开）。服务端持有整台
	// 状态机，一轮 = 派活 → 等它结束 → 取样（工作区 diff 指纹 + **执行者会话**
	// 错误特征）→ 把审查指令交给主对话 → 解析 verdict → 判定（pass / 再来一轮 /
	// 熔断 / 预算用尽）。模型不得自循环，轮次与熔断全在服务端
	// （详见 docs/goal-conversation-design.md §3/§4）。
	// =====================================================================

	/** 角色对话桥是否齐备（缺一即无法运行目标模式：setGoal 直接拒绝）。 */
	private roleBridgeReady(): boolean {
		const h = this.host;
		return !!(h.spawnRoleAgent && h.waitRoleAgent && h.sendRoleAgent && h.readRoleAgent && h.hasConv);
	}

	/** 角色轮等待上限：与工具看门狗同口径（默认 20 分钟）。 */
	private roleDeadline(): number {
		const v = this.host.roleDeadlineMs?.();
		return typeof v === "number" && v > 0 ? v : 20 * 60_000;
	}

	/** 代次守卫：目标没被改/清、会话还在才算本轮有效。 */
	private isCurrentDelegated(conv: GoalConversation, goalGeneration: number): boolean {
		return (
			!this.host.isDisposed() &&
			this.host.getConv(conv.id) === conv &&
			conv.goal.conversationId === conv.id &&
			conv.goalGeneration === goalGeneration &&
			!!conv.goal.goal
		);
	}

	private isConvStreaming(conv: GoalConversation): boolean {
		try {
			return conv.session?.isStreaming === true;
		} catch {
			return false;
		}
	}

	/** 启动委托循环（同一对话同时只允许一个）。 */
	private startDelegatedLoop(conv: GoalConversation, goalGeneration: number, goalText: string): void {
		if (this.delegatedLoops.has(conv.id)) return;
		const loop = this.runDelegatedLoop(conv, goalGeneration, goalText)
			.catch((err) => {
				void this.finishDelegated(
					conv,
					goalGeneration,
					"blocked",
					conv.goal.round,
					`循环内部错误：${err instanceof Error ? err.message : String(err)}`,
					goalText,
				);
			})
			.finally(() => {
				if (this.delegatedLoops.get(conv.id) === loop) this.delegatedLoops.delete(conv.id);
			});
		this.delegatedLoops.set(conv.id, loop);
	}

	/** 观测/测试用：等某对话的委托循环走到「已把审查指令交给主对话」这一步。 */
	whenAwaitingVerdict(convId: string, timeoutMs = 5000): Promise<boolean> {
		if (this.verdictWaiters.has(convId)) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const set = this.verdictSignals.get(convId) ?? new Set<() => void>();
			this.verdictSignals.set(convId, set);
			let done = false;
			const fire = (): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				set.delete(fire);
				if (set.size === 0) this.verdictSignals.delete(convId);
				resolve(true);
			};
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				set.delete(fire);
				if (set.size === 0) this.verdictSignals.delete(convId);
				resolve(false);
			}, timeoutMs);
			timer.unref?.();
			set.add(fire);
		});
	}

	/**
	 * 观测/测试用：等某对话的委托循环收束（循环已结束后立刻返回）。
	 * 注意：循环在「等执行者」或「等 verdict」时不会收束 —— 那两个时点用
	 * whenAwaitingVerdict / 脚本化的 waitRoleAgent 推进。
	 */
	async whenDelegatedSettled(convId: string): Promise<void> {
		const loop = this.delegatedLoops.get(convId);
		if (loop) await loop.catch(() => {});
	}

	private signalAwaitingVerdict(convId: string): void {
		const set = this.verdictSignals.get(convId);
		if (!set) return;
		for (const fn of set) fn();
	}

	/** 停掉该对话的委托循环并收掉常驻执行者（幂等；清目标/重设目标/中止时调）。 */
	private stopDelegated(conv: GoalConversation): void {
		conv.awaitingVerdict = undefined;
		const settle = this.verdictWaiters.get(conv.id);
		if (settle) {
			this.verdictWaiters.delete(conv.id);
			settle("gone");
		}
		const exec = conv.roleExec;
		conv.roleExec = undefined;
		if (exec) {
			void this.host.stopRoleAgent?.(exec.convId).catch(() => {});
			void this.host.dismissRoleAgent?.(exec.convId).catch(() => {});
		}
		conv.goal.roles = {};
		conv.goal.phase = "idle";
	}

	/** 轮次标签（"/M"；不限轮时为空串）。 */
	private roundsLabel(budget: number): string {
		return budget > 0 && Number.isFinite(budget) ? `/${budget}` : "";
	}

	private async runDelegatedLoop(conv: GoalConversation, goalGeneration: number, goalText: string): Promise<void> {
		let feedback = "";
		for (;;) {
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;
			const g = conv.goal;
			// 轮次预算：locked=false = 单次（一轮就收）；locked=true 且 maxRounds>0 = 有限轮。
			const budget = g.locked ? (g.maxRounds > 0 ? Math.min(g.maxRounds, 50) : Number.POSITIVE_INFINITY) : 1;
			if (g.round >= budget) {
				await this.finishDelegated(conv, goalGeneration, "exhausted", g.round, feedback, goalText);
				return;
			}
			const round = g.round + 1;
			g.round = round;
			g.reviewing = true;
			g.verdict = "pending";
			g.feedback = undefined;
			g.phase = "executing";
			g.status = `执行中（第 ${round}${this.roundsLabel(budget)} 轮）…`;
			g.statusEn = `Executing (round ${round}${this.roundsLabel(budget)})…`;
			conv.verdictRetry = 0;
			this.emitGoalStatus();

			// ① 派发：首轮 spawn 常驻执行者，之后向同一个它追加回合（记忆连续）。
			const execId = await this.dispatchExecutor(conv, goalGeneration, goalText, round, budget, feedback);
			if (!execId) return; // 已降级 / 已收尾
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			// ② 等执行者本轮结束（事件驱动，上限 = 看门狗口径）。
			const outcome = await this.host.waitRoleAgent!(execId, this.roleDeadline());
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			// ③ 取样：工作区 diff 指纹 + 执行者会话的错误特征（主对话是审查者，它的
			//    工具报错不代表执行受挫 —— 取数口径见设计文档 §4.5）。
			const sample = await this.sampleRound(conv, execId);
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			if (outcome !== "done") {
				// 「人为中止」与「对话失联」是终点事件：用户按了子代理的 ⏹ / 把执行对话关了，
				// 就是要停下 —— 这里绝不能再派一轮（否则看起来像「关了自己又启动」）。
				if (outcome === "gone" || outcome === "canceled") {
					const reason =
						outcome === "gone"
							? this.roleFailureText("exec-gone")
							: this.roleFailureText("canceled", sample.errorSnippet ?? "");
					await this.finishDelegated(conv, goalGeneration, "blocked", round, reason, goalText);
					return;
				}
				// 超时 / 报错：不花审查 token，直接进下一轮（预算内）。
				feedback = this.roleFailureText(outcome === "timeout" ? "timeout" : "error", sample.errorSnippet ?? "");
				if (outcome === "timeout") await this.host.stopRoleAgent?.(execId).catch(() => {});
				continue; // 顶部自增轮次后重新派活
			}

			// 熔断：停滞 / 同错连续两轮 → 直接终止（不问审查者，省 token；判定权始终在服务端）。
			if ((conv.sameErrorRounds ?? 0) >= 2 || (conv.stagnantRounds ?? 0) >= 2) {
				await this.finishDelegated(conv, goalGeneration, "blocked", round, "", goalText);
				return;
			}

			// ④⑤ 把审查指令交给主对话（= 审查者），等它的 verdict。
			g.phase = "reviewing";
			g.reviewing = true;
			g.status = `审查中（第 ${round}${this.roundsLabel(budget)} 轮）…`;
			g.statusEn = `Reviewing (round ${round}${this.roundsLabel(budget)})…`;
			this.emitGoalStatus();
			const verdict = await this.askDelegatedReview(conv, goalGeneration, round, budget, sample.output);
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;
			if (verdict === "invalid" || verdict === "timeout" || verdict === "gone") {
				await this.finishDelegated(
					conv,
					goalGeneration,
					"blocked",
					round,
					this.roleFailureText(`review-${verdict}`),
					goalText,
				);
				return;
			}
			if (verdict.verdict === "pass") {
				await this.finishDelegated(conv, goalGeneration, "pass", round, verdict.feedback, goalText);
				return;
			}
			feedback = verdict.feedback;
			// fail：回到循环顶部（预算检查在那里兜底）。
		}
	}

	/** 派发一轮执行：首轮 spawn 常驻执行者，之后 steer 同一个（记忆连续）。 */
	private async dispatchExecutor(
		conv: GoalConversation,
		goalGeneration: number,
		goalText: string,
		round: number,
		budget: number,
		feedback: string,
	): Promise<string | undefined> {
		const host = this.host;
		const g = conv.goal;
		const existing = conv.roleExec;
		if (existing) {
			// 执行对话被移出 / 服务重启 → 执行者记忆已丢：重建会静默换个「新人」，
			// 按受阻收尾比悄悄换人可靠（设计文档 §4.6 失效矩阵）。
			const alive = host.hasConv ? host.hasConv(existing.convId) : true;
			if (!alive) {
				await this.finishDelegated(conv, goalGeneration, "blocked", round, this.roleFailureText("exec-gone"), goalText);
				return undefined;
			}
			const sent = await host.sendRoleAgent!(
				existing.convId,
				this.executorRoundPrompt(goalText, round, budget, feedback),
			);
			if (!sent) {
				await this.finishDelegated(conv, goalGeneration, "blocked", round, this.roleFailureText("exec-gone"), goalText);
				return undefined;
			}
			return existing.convId;
		}
		try {
			const convId = await host.spawnRoleAgent!({
				role: "executor",
				prompt: this.executorRoundPrompt(goalText, round, budget, ""),
				cwd: conv.cwd,
				model: g.execModel ?? null,
				parentId: conv.id,
				// 落盘对话在左栏/历史里没有「子代理」微标，用带前缀的标题保持可辨识。
				title: this.roleConvTitle(goalText),
			});
			conv.roleExec = { convId, generation: (conv.roleExec?.generation ?? 0) + 1 };
			g.roles = { ...g.roles, executor: { convId, spawned: true } };
			this.emitGoalStatus();
			return convId;
		} catch (err) {
			// 配额满 / runtime 创建失败：目标模式只有委托一条路径，没有可降级对象。
			await this.abortOnSpawnFailure(conv, goalGeneration, goalText, err instanceof Error ? err.message : String(err));
			return undefined;
		}
	}

	/** 取样一轮：工作区 diff 指纹 + 执行者会话错误特征（熔断信号独立于 verdict）。 */
	private async sampleRound(
		conv: GoalConversation,
		execId: string,
	): Promise<{ output: string; errorSnippet?: string }> {
		const read = this.host.readRoleAgent?.(execId);
		const output = read?.text ?? "";
		let diffOut = "";
		try {
			diffOut = await this.host.gitDiff(conv.cwd);
		} catch {
			diffOut = "";
		}
		const currentError = read?.errorSnippet ?? extractErrorSnippetFromSession(undefined, output);
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
		const trimmed = diffOut.trim();
		const prevDiff = conv.lastDiff;
		const noChange = trimmed === "" || (prevDiff !== undefined && trimmed === prevDiff);
		conv.stagnantRounds = noChange ? (conv.stagnantRounds ?? 0) + 1 : 0;
		conv.lastDiff = trimmed;
		return { output, errorSnippet: currentError };
	}

	/** 审查：把审查指令交给主对话，等 verdict；无 JSON 允许重试一次。 */
	private async askDelegatedReview(
		conv: GoalConversation,
		goalGeneration: number,
		round: number,
		budget: number,
		execOutput: string,
	): Promise<DelegatedVerdict> {
		for (let attempt = 0; attempt < 2; attempt++) {
			// 委托执行下用户仍可自由聊天：先等主对话空闲，否则审查指令会被当成
			// steer 插进用户自己的回合里（语义冲突）。
			const idle = await this.waitMainIdle(conv);
			if (!this.isCurrentDelegated(conv, goalGeneration)) return "gone";
			if (!idle) return "timeout";
			const text =
				attempt === 0
					? this.reviewerRoundPrompt(conv.goal.goal ?? "", round, budget, execOutput)
					: this.verdictRetryPrompt();
			const verdict = await this.deliverAndWait(conv, round, text);
			if (verdict !== "invalid") return verdict;
			conv.verdictRetry = attempt + 1;
		}
		return "invalid";
	}

	/** 等主对话空闲（事件驱动，不轮询）；超上限返回 false。 */
	private async waitMainIdle(conv: GoalConversation): Promise<boolean> {
		const end = Date.now() + this.roleDeadline();
		for (;;) {
			if (!this.isConvStreaming(conv)) return true;
			if (Date.now() >= end) return false;
			const r = await this.host.waitRoleAgent?.(conv.id, Math.min(30_000, end - Date.now()));
			if (r === "gone") return false;
		}
	}

	/** 投递审查指令并等 onAgentEnd 送来 verdict（登记 waiter 后再投递，防抢跑）。 */
	private async deliverAndWait(conv: GoalConversation, round: number, text: string): Promise<DelegatedVerdict> {
		const host = this.host;
		conv.awaitingVerdict = { round };
		const verdict = await new Promise<DelegatedVerdict>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (v: DelegatedVerdict): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (this.verdictWaiters.get(conv.id) === settle) this.verdictWaiters.delete(conv.id);
				resolve(v);
			};
			this.verdictWaiters.set(conv.id, settle);
			timer = setTimeout(() => settle("timeout"), this.roleDeadline());
			timer.unref?.();
			this.signalAwaitingVerdict(conv.id);
			void host.sendRoleAgent!(conv.id, text, "followUp")
				.then((ok) => {
					if (!ok) settle("gone");
				})
				.catch(() => settle("gone"));
		});
		if (conv.awaitingVerdict?.round === round) conv.awaitingVerdict = undefined;
		return verdict;
	}

	/** onAgentEnd 钩子：审查回合结束 → 取主对话最后一条 assistant 文本解析 verdict。 */
	private deliverDelegatedVerdict(conv: GoalConversation): void {
		const settle = this.verdictWaiters.get(conv.id);
		if (!settle) return;
		this.verdictWaiters.delete(conv.id);
		conv.awaitingVerdict = undefined;
		let text = "";
		try {
			text = conv.session.getLastAssistantText() ?? "";
		} catch {
			text = "";
		}
		settle(parseReviewerVerdict(text) ?? "invalid");
	}

	/** 收尾：pass / blocked / exhausted / 异常 → 状态、通知、角色对话清理。 */
	private async finishDelegated(
		conv: GoalConversation,
		goalGeneration: number,
		kind: "pass" | "blocked" | "exhausted",
		round: number,
		feedback: string,
		goalText: string,
	): Promise<void> {
		if (!this.isCurrentDelegated(conv, goalGeneration)) return;
		const g = conv.goal;
		if (conv.awaitingVerdict) {
			const settle = this.verdictWaiters.get(conv.id);
			this.verdictWaiters.delete(conv.id);
			conv.awaitingVerdict = undefined;
			settle?.("gone");
		}
		const budget = g.locked ? (g.maxRounds > 0 ? Math.min(g.maxRounds, 50) : 0) : 1;
		const roundsZh = budget > 0 ? `第 ${round}/${budget} 轮` : `第 ${round} 轮（不限）`;
		const roundsEn = budget > 0 ? `Round ${round}/${budget}` : `Round ${round} (unlimited)`;
		g.reviewing = false;
		// 角色对话收尾：停掉在飞的回合；pass 时移出左栏（受阻/未通过保留供用户点开查看）。
		if (conv.roleExec) {
			const execId = conv.roleExec.convId;
			await this.host.stopRoleAgent?.(execId).catch(() => {});
			if (kind === "pass") {
				conv.roleExec = undefined;
				await this.host.dismissRoleAgent?.(execId).catch(() => {});
			}
		}

		if (kind === "pass") {
			g.verdict = "pass";
			g.feedback = feedback;
			g.phase = "idle";
			g.roles = {};
			g.status = "✅ 已通过目标审查";
			g.statusEn = "✅ Goal review passed";
			g.conversationId = null;
			g.goal = null;
			this.host.emit({ type: "notice", level: "info", text: "✅ 目标已通过审查", textEn: "✅ Goal passed review" });
			this.emitGoalStatus();
			try {
				const passText = pick(
					this.lang(),
					`✅ 目标已达成并通过审查（第 ${round} 轮）。\n\n目标：${goalText}\n\n${feedback}\n\n（目标模式已解除，接下来按你的普通指令响应。）`,
					`✅ Goal achieved and passed review (round ${round}).\n\nGoal: ${goalText}\n\n${feedback}\n\n(Goal mode is off — respond to further instructions normally.)`,
					"goal.review.pass",
					{ round: round, goalText: goalText, feedback: feedback },
				);
				await conv.session.sendUserMessage(passText, {
					deliverAs: conv.session.isStreaming ? "steer" : "followUp",
				});
			} catch {
				// Best-effort.
			}
			this.host.flushSnapshot();
			return;
		}

		if (kind === "exhausted") {
			g.verdict = "fail";
			g.feedback = feedback;
			g.phase = "idle";
			if (g.locked && g.maxRounds > 0) {
				g.status = `已达最大轮数（${g.maxRounds}），目标仍未通过`;
				g.statusEn = `Max rounds reached (${g.maxRounds}), goal still failing`;
			} else {
				g.status = `目标未通过（${roundsZh}）`;
				g.statusEn = `Goal failed (${roundsEn})`;
			}
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标未通过审查（已达最大轮数）",
				textEn: "Goal failed review (max rounds reached)",
			});
			try {
				const capped = budget > 0 ? budget : "不限";
				const cappedEn = budget > 0 ? budget : "unlimited";
				await conv.session.sendUserMessage(
					pick(
						this.lang(),
						`❌ 目标未通过审查（第 ${round}/${capped} 轮）。\n\n目标：${goalText}\n\n审查意见：${feedback}`,
						`❌ Goal failed review (round ${round}/${cappedEn}).\n\nGoal: ${goalText}\n\nFeedback: ${feedback}`,
						"goal.review.fail",
						{ round: round, capped: capped, goalText: goalText, feedback: feedback, cappedEn: cappedEn },
					),
					{ deliverAs: conv.session.isStreaming ? "steer" : "followUp" },
				);
			} catch {
				// Best-effort.
			}
			g.reviewing = false;
			this.emitGoalStatus();
			this.host.flushSnapshot();
			return;
		}

		// blocked：保留目标文本让用户看见并处置（与既有熔断口径一致）。
		// 执行对话已不在时清掉角色引用（不留指向死对话的「执行对话」按钮），并确保
		// `conv.roleExec` 也清掉：循环已停，只有用户重新设目标才会再派一个执行者。
		const execAlive = conv.roleExec ? (this.host.hasConv?.(conv.roleExec.convId) ?? true) : false;
		if (!execAlive) {
			conv.roleExec = undefined;
			g.roles = {};
		}
		const reason =
			feedback.trim() !== ""
				? feedback.trim()
				: (conv.sameErrorRounds ?? 0) >= 2
					? `连续 ${conv.sameErrorRounds} 轮出现相同错误：${conv.lastErrorSnippet ?? ""}`
					: `连续 ${conv.stagnantRounds} 轮未检测到有效文件修改或实质进展`;
		g.verdict = "blocked";
		g.feedback = reason;
		g.phase = "blocked";
		g.status = "⚠️ 目标受阻（委托执行已暂停）";
		g.statusEn = "⚠️ Goal blocked (delegated execution paused)";
		this.host.emit({
			type: "notice",
			level: "warning",
			text: "⚠️ 目标执行受阻：委托执行已暂停（可在目标条重新设定目标继续）",
			textEn: "⚠️ Goal blocked: delegated execution paused (set the goal again to continue)",
		});
		try {
			await conv.session.sendUserMessage(
				pick(
					this.lang(),
					`⚠️ 目标执行受阻（${roundsZh}）。\n\n目标：${goalText}\n\n原因：${reason}\n\n（委托执行已暂停，不会自己重新派活。要彻底退出目标模式：点目标条右侧的 ■ 停止目标（取消）；想继续就重新设定目标。）`,
					`⚠️ Goal execution blocked (${roundsEn}).\n\nGoal: ${goalText}\n\nReason: ${reason}\n\n(Delegated execution is paused and will not dispatch again by itself. To leave goal mode entirely, press ■ Stop goal (cancel) in the goal bar; to resume, set the goal again.)`,
					"goal.role.blocked",
					{ round: round, goalText: goalText, reason: reason },
				),
				{ deliverAs: conv.session.isStreaming ? "steer" : "followUp" },
			);
		} catch {
			// Best-effort.
		}
		this.emitGoalStatus();
		this.host.flushSnapshot();
	}

	/** 角色对话在左栏/历史里的标题（落盘对话没有「子代理」微标，靠前缀可辨识）。 */
	private roleConvTitle(goalText: string): string {
		const brief = goalText.replace(/\s+/g, " ").trim().slice(0, 40);
		const withTail = goalText.trim().length > 40 ? "…" : "";
		return pick(
			this.lang(),
			`[目标执行] ${brief}${withTail}`,
			`[Goal executor] ${brief}${withTail}`,
			"goal.role.conv_title",
		);
	}

	/** 拉起执行对话失败（配额满 / runtime 创建失败）：目标模式只有这一条路径，
	 *  没有可降级的对象 —— 当场中止循环并把原因摆到目标条上（用户可在左栏关掉几个
	 *  对话后重新设定目标）。 */
	private async abortOnSpawnFailure(
		conv: GoalConversation,
		goalGeneration: number,
		goalText: string,
		reason: string,
	): Promise<void> {
		const g = conv.goal;
		g.verdict = "blocked";
		g.phase = "blocked";
		g.roles = {};
		g.feedback = reason;
		g.status = "执行对话创建失败，目标未开始";
		g.statusEn = "Failed to create the executor conversation; the goal did not start";
		this.emitGoalStatus();
		this.host.emit({
			type: "notice",
			level: "warning",
			text: `无法创建执行对话，目标未开始：${reason}`,
			textEn: `Could not create the executor conversation; the goal did not start: ${reason}`,
		});
		if (/上限|limit/i.test(reason)) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "提示：执行对话会占掉本项目的一个普通对话名额（上限 8 个），可在左栏关掉几个对话后重新设定目标。",
				textEn:
					"Tip: the executor conversation takes one of the project's regular conversation slots (max 8) — close a few chats in the left panel, then set the goal again.",
			});
		}
		this.host.flushSnapshot();
	}

	/** 委托执行的角色轮提示词：执行者（干活）与审查者（判定）。双语走 pick。 */ private executorRoundPrompt(
		goalText: string,
		round: number,
		budget: number,
		feedback: string,
	): string {
		const rounds = this.roundsLabel(budget);
		const prev = feedback.trim();
		return pick(
			this.lang(),
			`【目标 · 第 ${round}${rounds} 轮】\n\n${goalText}\n\n${prev ? `上一轮审查意见：\n${prev}\n\n` : ""}要求：\n- 直接修改工作区（不要只在回复里描述改动），做完用一段话说明「改了什么、怎么验证的」。\n- 禁止向用户提问（本对话由服务端自动驱动，弹窗会被按取消返回）。\n- 禁止派生或等待其他子代理（轮次由服务端控制，你只负责这一轮）。`,
			`[Goal · round ${round}${rounds}]\n\n${goalText}\n\n${prev ? `Review feedback from the previous round:\n${prev}\n\n` : ""}Requirements:\n- Change the workspace directly (don't just describe it), then summarize in one paragraph what you changed and how you verified it.\n- Do NOT ask the user anything (this conversation is server-driven; dialogs are auto-cancelled).\n- Do NOT spawn or wait for other subagents (the server owns the rounds; you own this one only).`,
			"goal.role.exec",
		);
	}

	private reviewerRoundPrompt(goalText: string, round: number, budget: number, execOutput: string): string {
		const rounds = this.roundsLabel(budget);
		const out = execOutput.trim().slice(0, 4000);
		return pick(
			this.lang(),
			`你是严格、独立的验收者。只判断目标是否被完全满足：不要相信描述，去看工作区的实际状态。\n\n【目标】\n${goalText}\n\n【这是第 ${round}${rounds} 轮】\n\n【执行者本轮自述】\n${out || "（执行者本轮没有给出自述）"}\n\n你可以用只读手段核实：read / grep / scm（只读 git）/ 只读 bash（跑测试）。\n\n只输出一个 JSON 对象，不要有任何其他文本、不要代码围栏：\n{"verdict":"pass","feedback":"<一句话：满足了什么>"}\n{"verdict":"fail","feedback":"<可以直接动手改的具体待改项>"}`,
			`You are a strict, independent acceptor. Judge only whether the goal is fully satisfied: do not trust the summary — inspect the actual workspace state.\n\n# Goal\n${goalText}\n\n# This is round ${round}${rounds}\n\n# Executor's summary this round\n${out || "(the executor produced no summary)"}\n\nYou may verify with read-only means: read / grep / scm (read-only git) / read-only bash (run tests).\n\nReply with ONLY one JSON object — no other text, no code fences:\n{"verdict":"pass","feedback":"<one short sentence: what was satisfied>"}\n{"verdict":"fail","feedback":"<concrete items the executor must fix>"}`,
			"goal.role.review",
		);
	}

	private verdictRetryPrompt(): string {
		return pick(
			this.lang(),
			`你上一条回复没有给出约定的 JSON。现在只回一个 JSON 对象，不要有任何其他文本或代码围栏：\n{"verdict":"pass|fail","feedback":"…"}`,
			`Your last reply did not contain the required JSON. Reply with ONLY one JSON object now — no other text, no code fences:\n{"verdict":"pass|fail","feedback":"..."}`,
			"goal.role.review.retry",
		);
	}

	/** 委托执行受阻时的原因文案（双语走 pick，key 全局唯一）。 */
	private roleFailureText(kind: string, detail = ""): string {
		const detailZh = detail ? `（${detail.slice(0, 160)}）` : "";
		const detailEn = detail ? ` (${detail.slice(0, 160)})` : "";
		const zh: Record<string, string> = {
			timeout: `上一轮执行超时，未完成既定改动${detailZh}。请拆成更小的步骤完成。`,
			canceled: `执行被手动中止${detailZh}，目标循环已暂停（不会自己重新派活）。`,
			error: `上一轮执行报错${detailZh}。请先排查错误再继续。`,
			"exec-gone": "执行对话已被移出或服务重启，执行者记忆已丢失，目标循环已暂停（不会自己重新派活）。",
			"review-timeout": "审查回合超时，未收到结论。",
			"review-gone": "审查对话已不可用，未收到结论。",
			"review-invalid": "审查回合没有给出约定的 JSON 结论（重试一次仍未通过）。",
		};
		const en: Record<string, string> = {
			timeout: `The previous execution round timed out before finishing the work${detailEn}. Please split it into smaller steps.`,
			canceled: `The execution was aborted manually${detailEn}; the goal loop is paused (it will not dispatch again by itself).`,
			error: `The previous execution round hit an error${detailEn}. Please investigate before continuing.`,
			"exec-gone":
				"The executor conversation is gone (dismissed or the server restarted); its memory is lost and the loop is paused (it will not dispatch again by itself).",
			"review-timeout": "The review round timed out without a verdict.",
			"review-gone": "The reviewer conversation is unavailable; no verdict was received.",
			"review-invalid": "The review round did not produce the required JSON verdict (still missing after one retry).",
		};
		return pick(this.lang(), zh[kind] ?? kind, en[kind] ?? kind, `goal.role.failure.${kind}`);
	}
}
