/**
 * canvas-orchestrator.ts — 多引擎、多模型、多目录画布协作调度器。
 *
 * 核心功能：
 * 1. 管理运行中的 CanvasGraph 拓扑生命周期；
 * 2. 调度四大引擎（Pi / DSH / Claude Code / Durable）的并发会话；
 * 3. 隔离各节点的工作目录（相对子目录，或自动启用 Git Worktree 物理隔离）；
 * 4. 沿连线执行契约化数据流转（Handoff）；
 * 5. 审查回路与防死循环熔断保护（Review Loop Breaker）。
 */

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isRemoteWorkspaceUri } from "../remote-ssh-service.js";
import type {
	CanvasEngineId,
	CanvasGraph,
	CanvasNode,
	CanvasNodeLogEntry,
	CanvasNodeLogKind,
	ServerMessage,
	UiMessage,
} from "../protocol.js";
import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import {
	saveCanvasRuntimeState,
	loadCanvasGraph,
	saveCanvasGraph,
	isSafeGraphId,
	deleteCanvasGraph,
	markInterruptedCanvasRuns,
} from "./canvas-store.js";
import { prepareCanvasWorkspace, captureCanvasWorkspaceArtifact, type CanvasWorkspace } from "./canvas-workspace.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PSTACK_SKILLS_MAP } from "./pstack-skills-data.js";
import { discoverDiskSkills, readSkillInstruction } from "../skill-discovery.js";
import { randomUUID } from "node:crypto";
import {
	CanvasExecutionQueue,
	canvasCondition,
	canvasReadiness,
	isCanvasBackedge,
	validateCanvasTopology,
} from "./canvas-scheduler.js";

const exec = promisify(execFile);

export type CanvasEventBroadcaster = (msg: ServerMessage) => void;
export type EngineServiceGetter = (engine: CanvasEngineId) => any;

interface ActiveNodeExecution {
	graphId: string;
	nodeId: string;
	abortController?: AbortController;
	timeoutId?: ReturnType<typeof setTimeout>;
	session?: any;
}

export class CanvasOrchestrator {
	private readonly dataDir: string;
	/** 每个节点的对话实录：key=`${graphId}:${nodeId}`，内存常驻 + 落盘持久化（canvas/logs/）。上限 300 条防爆内存。 */
	private readonly nodeLogs = new Map<string, CanvasNodeLogEntry[]>();
	/** 复用当前对话流：sink 里收到的标准 UiMessage 按节点缓存，前端抽屉直接复用 Message 组件渲染。 */
	private readonly nodeMessages = new Map<string, UiMessage[]>();
	private logSeq = 0;
	private readonly baseCwd: string;
	/** 运行期项目基准（graphId -> 目录）：相对 cwd 相对它解析；缺省=服务启动目录。
	 *  谁先启动这次运行谁定：UI 按钮=点击者当前项目，AI 工具=所有者对话 cwd。 */
	private readonly runBaseByGraph = new Map<string, string>();
	private readonly engineGetter?: EngineServiceGetter;
	private broadcaster: CanvasEventBroadcaster | null = null;
	private readonly activeExecutions = new Map<string, ActiveNodeExecution>();
	private readonly runningGraphs = new Map<string, CanvasGraph>();
	private readonly graphGenerations = new Map<string, number>();
	private readonly nodeGenerations = new Map<string, number>();
	private readonly executionQueue = new CanvasExecutionQueue(4);
	private static readonly sharedWorkspaceQueue = new CanvasExecutionQueue(1);
	/** Immutable rejection inputs survive resetting the producer and its forward region. */
	private readonly feedbackArtifacts = new Map<string, NonNullable<CanvasNode["artifact"]>["workspace"]>();
	private readonly runDeadlines = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(baseCwd: string, dataDir: string, engineGetter?: EngineServiceGetter) {
		this.baseCwd = baseCwd;
		this.dataDir = dataDir;
		this.engineGetter = engineGetter;
		markInterruptedCanvasRuns(dataDir);
	}

	setBroadcaster(broadcaster: CanvasEventBroadcaster): void {
		this.broadcaster = broadcaster;
	}

	private broadcast(msg: ServerMessage): void {
		try {
			this.broadcaster?.(msg);
		} catch {
			// 背压/断连导致广播失败不得污染调度主路径（故障注入 S3 命中）
		}
	}

	/** Reload after the store merges runtime fields so stale execution topology never reaches clients. */
	private broadcastCanvasRuntime(graph: CanvasGraph): void {
		try {
			this.broadcast({ type: "canvas_graph_state", graph: loadCanvasGraph(this.dataDir, graph.id) });
		} catch {
			// Deletion wins over late runtime publication.
		}
	}

	private logKey(graphId: string, nodeId: string): string {
		return `${graphId}:${nodeId}`;
	}

	/** 读取节点对话实录（内存命中优先，否则尝试从落盘恢复） */
	getNodeLog(graphId: string, nodeId: string): CanvasNodeLogEntry[] {
		const key = this.logKey(graphId, nodeId);
		const mem = this.nodeLogs.get(key);
		if (mem) return [...mem];
		try {
			const file = pathJoin(this.dataDir, "canvas", "logs", `${graphId}__${nodeId}.json`);
			if (fsExistsSync(file)) {
				const arr = JSON.parse(readFileSync(file, "utf8")) as CanvasNodeLogEntry[];
				if (Array.isArray(arr)) {
					const capped = arr.slice(-300);
					this.nodeLogs.set(key, capped);
					return [...capped];
				}
			}
		} catch {
			// 读盘失败回落空日志
		}
		return [];
	}

	/** 读取节点复用的对话流消息（与主对话同构的 UiMessage[]，上限 200 条） */
	getNodeMessages(graphId: string, nodeId: string): UiMessage[] {
		const mem = this.nodeMessages.get(this.logKey(graphId, nodeId));
		return mem ? [...mem] : [];
	}

	/** 清空节点对话实录（内存 + 落盘） */
	clearNodeLog(graphId: string, nodeId: string): void {
		const key = this.logKey(graphId, nodeId);
		this.nodeLogs.delete(key);
		this.nodeMessages.delete(key);
		try {
			const file = pathJoin(this.dataDir, "canvas", "logs", `${graphId}__${nodeId}.json`);
			if (fsExistsSync(file)) unlinkSync(file);
		} catch {
			// 忽略清理失败
		}
	}

	/** 追加一条对话实录并广播 + 节流落盘 */
	private appendLog(graphId: string, nodeId: string, kind: CanvasNodeLogKind, text: string, toolName?: string): void {
		if (!isSafeGraphId(graphId) || !isSafeGraphId(nodeId)) return;
		const clean = (text ?? "").slice(0, 2000) || "(空)";
		const entry: CanvasNodeLogEntry = {
			id: `log_${Date.now()}_${(this.logSeq += 1)}`,
			ts: Date.now(),
			kind,
			text: clean,
			...(toolName ? { toolName: toolName.slice(0, 80) } : {}),
		};
		const key = this.logKey(graphId, nodeId);
		const list = this.nodeLogs.get(key) ?? [];
		list.push(entry);
		while (list.length > 300) list.shift();
		this.nodeLogs.set(key, list);
		const generation = this.graphGenerations.get(graphId) ?? 0;
		this.broadcast({ type: "canvas_node_log", graphId, nodeId, entry });
		if ((this.graphGenerations.get(graphId) ?? 0) !== generation) return;
		// 每 10 条落盘一次，避免高频 IO
		if (list.length % 10 === 0 || kind === "error" || kind === "done") {
			try {
				const dir = pathJoin(this.dataDir, "canvas", "logs");
				if (!fsExistsSync(dir)) fsMkdirSync(dir, { recursive: true });
				writeFileSync(pathJoin(dir, `${graphId}__${nodeId}.json`), JSON.stringify(list.slice(-300)));
			} catch {
				// 落盘失败不影响主流程
			}
		}
	}

	/** 缓存并转播复用的对话流消息（直接透传主对话同构 UiMessage，前端复用 Message 组件渲染） */
	private pushNodeMessages(graphId: string, nodeId: string, incoming: UiMessage[]): void {
		if (!Array.isArray(incoming) || incoming.length === 0) return;
		const key = this.logKey(graphId, nodeId);
		const list = this.nodeMessages.get(key) ?? [];
		// 按 id 去重追加，保持 200 条上限
		const seen = new Set(list.map((m) => m.id));
		for (const m of incoming) {
			if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
			seen.add(m.id);
			list.push(m);
		}
		while (list.length > 200) list.shift();
		this.nodeMessages.set(key, list);
		this.broadcast({
			type: "canvas_node_messages",
			graphId,
			nodeId,
			appended: incoming.slice(-20),
			streaming: true,
		});
	}

	/** 确保该节点所需的真实工作目录（支持 Worktree 隔离） */
	/** 有效运行基准：显式 runBase（本地绝对路径或远程 SSH URI）优先，否则服务启动目录 */
	private pickRunBase(runBase?: string): string {
		const r = (runBase ?? "").trim();
		if (r && (isRemoteWorkspaceUri(r) || isAbsolute(r))) return isRemoteWorkspaceUri(r) ? r : resolve(r);
		return resolve(this.baseCwd);
	}

	async resolveNodeCwd(node: CanvasNode, runBase?: string): Promise<string> {
		if (!isSafeGraphId(node.id)) throw new Error(`Invalid canvas node id: ${node.id}`);
		if (node.useWorktree)
			return (
				await prepareCanvasWorkspace({
					baseCwd: this.pickRunBase(runBase),
					dataDir: this.dataDir,
					graphId: "standalone",
					runId: randomUUID(),
					nodeId: node.id,
					cwd: node.cwd,
					useWorktree: true,
				})
			).cwd;
		const raw = (node.cwd ?? "").trim();
		if (isRemoteWorkspaceUri(raw)) return raw;
		const base = this.pickRunBase(runBase);
		if (isRemoteWorkspaceUri(base))
			return !raw || raw === "." ? base : `${base.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`;
		const cwd = !raw ? base : isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
		if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
		return cwd;
	}

	private armRunDeadline(graph: CanvasGraph): void {
		const previous = this.runDeadlines.get(graph.id);
		if (previous) clearTimeout(previous);
		const runId = graph.run!.id;
		const timer = setTimeout(
			() => {
				this.runDeadlines.delete(graph.id);
				if (
					graph.run?.id !== runId ||
					!graph.nodes.some((n) => n.status === "running" || n.status === "waiting_approval")
				)
					return;
				this.stopAll(graph.id);
				graph.status = "error";
				graph.run.error = "Canvas run exceeded 30 minute deadline";
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcastCanvasRuntime(graph);
			},
			30 * 60 * 1000,
		);
		timer.unref();
		this.runDeadlines.set(graph.id, timer);
	}

	/** Invalidate executions before deleting persistence. */
	deleteGraph(graphId: string): boolean {
		if (!isSafeGraphId(graphId)) return false;
		this.graphGenerations.set(graphId, (this.graphGenerations.get(graphId) ?? 0) + 1);
		for (const [key, execution] of this.activeExecutions) {
			if (execution.graphId !== graphId) continue;
			this.activeExecutions.delete(key);
			execution.abortController?.abort();
		}
		clearTimeout(this.runDeadlines.get(graphId));
		this.runDeadlines.delete(graphId);
		for (const key of this.feedbackArtifacts.keys())
			if (key.startsWith(`${graphId}:`)) this.feedbackArtifacts.delete(key);
		this.runningGraphs.delete(graphId);
		this.runBaseByGraph.delete(graphId);
		for (const key of this.nodeLogs.keys()) if (key.startsWith(`${graphId}:`)) this.nodeLogs.delete(key);
		for (const key of this.nodeMessages.keys()) if (key.startsWith(`${graphId}:`)) this.nodeMessages.delete(key);
		return deleteCanvasGraph(this.dataDir, graphId);
	}

	/** 启动单个节点 */
	async runNode(
		graph: CanvasGraph,
		nodeId: string,
		initialPrompt?: string,
		runBase?: string,
		scheduled = false,
	): Promise<void> {
		if (!fsExistsSync(pathJoin(this.dataDir, "canvas", `${graph.id}.json`))) return;
		const execKey = `${graph.id}:${nodeId}`;
		if (this.activeExecutions.has(execKey)) throw new Error(`Canvas node already running: ${nodeId}`);
		if (!scheduled && ["running", "waiting_approval"].includes(this.runningGraphs.get(graph.id)?.status ?? ""))
			throw new Error("Canvas graph already running");
		// A separately loaded run_node must not replace an active graph object.
		if ([...this.activeExecutions.values()].some((execution) => execution.graphId === graph.id)) {
			graph = this.runningGraphs.get(graph.id) ?? graph;
		}
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return;
		this.runningGraphs.set(graph.id, graph);
		const generation = this.graphGenerations.get(graph.id) ?? 0;
		const nodeGeneration = (this.nodeGenerations.get(execKey) ?? 0) + 1;
		this.nodeGenerations.set(execKey, nodeGeneration);
		const lifecycleCurrent = () =>
			(this.graphGenerations.get(graph.id) ?? 0) === generation && this.nodeGenerations.get(execKey) === nodeGeneration;
		const controller = new AbortController();
		const execution: ActiveNodeExecution = {
			graphId: graph.id,
			nodeId,
			abortController: controller,
		};
		this.activeExecutions.set(execKey, execution);
		const isCurrent = () =>
			lifecycleCurrent() && !controller.signal.aborted && this.activeExecutions.get(execKey) === execution;

		if (!scheduled || !graph.run) {
			for (const key of this.feedbackArtifacts.keys())
				if (key.startsWith(`${graph.id}:`)) this.feedbackArtifacts.delete(key);
			graph.run = { id: randomUUID(), graphRev: graph.rev ?? 0, startedAt: Date.now(), scope: "node", nodeId };
		}
		graph.status = "running";
		if (!scheduled) this.armRunDeadline(graph);
		node.runId = graph.run!.id;
		node.attempt = (node.attempt ?? 0) + 1;
		node.artifact = undefined;
		node.lastOutputSummary = undefined;
		if (!scheduled) {
			const scope = new Set(this.runNodes(graph).map((n) => n.id));
			for (const target of this.runNodes(graph))
				if (target !== node) {
					target.status = "idle";
					target.error = undefined;
					target.artifact = undefined;
					target.lastOutputSummary = undefined;
					target.aiVerdict = undefined;
					target.runId = graph.run!.id;
					target.attempt = 0;
				}
			for (const edge of graph.edges) {
				edge.active = scope.has(edge.sourceNodeId) ? undefined : false;
				edge.runId = graph.run!.id;
				edge.lastHandoffSummary = undefined;
				edge.currentLoopCount = 0;
			}
		}
		node.aiVerdict = undefined;
		node.actualEngine = undefined;
		node.actualModel = undefined;
		node.status = "running";
		node.error = undefined;
		node.currentAction = `[${node.engine.toUpperCase()}] 正在分配独立环境与工作目录...`;
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		this.appendLog(
			graph.id,
			nodeId,
			"system",
			`启动节点「${node.title}」(${node.engine}/${node.model})，工作目录: ${node.cwd || "."}（基准: ${this.pickRunBase(runBase ?? this.runBaseByGraph.get(graph.id))}）`,
		);

		this.broadcast({
			type: "canvas_node_event",
			graphId: graph.id,
			nodeId,
			event: "started",
			currentAction: node.currentAction,
		});

		let releaseSlot = () => {};
		let releaseCwd = () => {};
		const releaseCapacity = () => {
			releaseSlot();
			releaseCwd();
		};
		try {
			releaseSlot = await this.executionQueue.acquire(controller.signal);
			if (["cron", "webhook", "memory", "loop"].includes(node.role))
				throw new Error(`Unsupported canvas executor: ${node.role}`);
			if ((runBase ?? "").trim()) this.runBaseByGraph.set(graph.id, runBase as string);
			const upstreamArtifacts = graph.edges
				.filter((e) => e.targetNodeId === node.id && e.active === true)
				.flatMap((e) => {
					const artifact = graph.nodes.find((n) => n.id === e.sourceNodeId)?.artifact;
					const feedback = this.feedbackArtifacts.get(`${graph.id}:${graph.run?.id}:${e.id}`);
					return feedback
						? [feedback]
						: artifact && artifact.runId === graph.run?.id && artifact.workspace
							? [artifact.workspace]
							: [];
				});
			if (!node.useWorktree && upstreamArtifacts.length === 0) {
				releaseCwd = await CanvasOrchestrator.sharedWorkspaceQueue.acquire(controller.signal);
			}
			const workspace: CanvasWorkspace = await prepareCanvasWorkspace({
				baseCwd: this.pickRunBase(runBase ?? this.runBaseByGraph.get(graph.id)),
				dataDir: this.dataDir,
				graphId: graph.id,
				runId: graph.run!.id,
				nodeId: node.id + "-" + node.attempt,
				cwd: node.cwd,
				useWorktree: node.useWorktree,
				upstreamArtifacts,
				signal: controller.signal,
			});
			const resolvedCwd = workspace.cwd;
			if (!isCurrent()) return;
			const captureControlArtifact = async () => {
				const workspaceArtifact = workspace.isolated
					? await captureCanvasWorkspaceArtifact(workspace, { signal: controller.signal })
					: undefined;
				if (!isCurrent()) return;
				node.artifact = {
					runId: graph.run!.id,
					attempt: node.attempt!,
					summary: node.lastOutputSummary ?? "",
					text: node.lastOutputSummary,
					cwd: resolvedCwd,
					createdAt: Date.now(),
					workspace: workspaceArtifact,
				};
			};

			const roleDetail =
				node.role === "pstack"
					? `pstack: ${String(node.config?.skill || "poteto-mode")}`
					: node.role === "skill"
						? `skill: ${String(node.config?.skillName || node.config?.skill || "soul")}`
						: node.role;
			node.currentAction = `[${node.engine.toUpperCase()}] 启动 ${node.model} 执行中 (${roleDetail})...`;
			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "action",
				currentAction: node.currentAction,
			});

			// 组装前置契约提示词（若上游边有 handoff 产物）
			const incomingEdges = graph.edges.filter((e) => e.targetNodeId === nodeId && e.active !== false);
			let contractContext = "";
			for (const edge of incomingEdges) {
				if (edge.lastHandoffSummary) {
					const PORT_ZH: Record<string, string> = {
						contract: "任务契约",
						instruction: "AI指令",
						system: "角色规约",
						config: "控制参数",
					};
					const srcTitle = graph.nodes.find((n) => n.id === edge.sourceNodeId)?.title || edge.sourceNodeId;
					const portSuffix =
						edge.targetPort && edge.targetPort !== "contract"
							? ` → ${PORT_ZH[edge.targetPort] || edge.targetPort}`
							: "";
					contractContext += `\n【来自「${srcTitle}」的定向输入${portSuffix}】:\n${edge.lastHandoffSummary}\n`;
				}
			}

			// 指令优先级：本次手动输入 > 节点持久化 instruction（AI 可输入） > systemPromptOverride > 直接使用输入 > 默认。
			// instruction 支持 {{input}} / {{上游摘要}} / {{upstream}} / {{contract}} 变量引用上游契约产物；
			// 留空或只写输入变量 = 直接使用输入（不再追加通用兜底，避免输入被复制两遍）。
			const rawInstruction =
				initialPrompt?.trim() || node.instruction?.trim() || node.systemPromptOverride?.trim() || "";
			let expandedInstruction = rawInstruction;
			if (contractContext) {
				expandedInstruction = expandedInstruction.replace(
					/\{\{\s*(上游摘要|upstream|contract|input)\s*\}\}/gi,
					contractContext,
				);
			}
			const isInputOnly =
				contractContext.trim().length > 0 &&
				(!expandedInstruction.trim() || expandedInstruction.trim() === contractContext.trim());
			const cfgEntries = Object.entries(node.config ?? {}).filter((entry) => entry[1] !== undefined && entry[1] !== "");
			let configContext = "";
			if (!isCanvasPassthroughRole(node.role) && node.role !== "transform" && cfgEntries.length > 0) {
				configContext = `\n【本节点专属参数】:\n${cfgEntries.map((entry) => `${entry[0]}=${String(entry[1])}`).join("；")}\n`;
			}
			let prompt = isInputOnly
				? `${contractContext}${configContext ? `\n${configContext}` : ""}`
				: `${expandedInstruction || "按照你的角色职责进行开发"}\n${configContext}${contractContext}`;

			if (
				!contractContext.trim() &&
				!initialPrompt?.trim() &&
				!node.instruction?.trim() &&
				!isCanvasPassthroughRole(node.role)
			) {
				prompt += `\n\n【首节点启动指引】: 当前为流水线首节点。请结合当前工作区代码库现状，排查梳理项目架构规范与待实现的核心任务，输出明确的分工契约交由下游节点接力执行。`;
			}

			if (node.role === "pstack") {
				const skillKey = String(node.config?.skill ?? "poteto-mode").trim();
				const item = PSTACK_SKILLS_MAP[skillKey] || PSTACK_SKILLS_MAP["poteto-mode"];
				const skillTitle = item ? `${item.icon} ${item.nameZh} (${item.id})` : skillKey;
				const skillDoc = item?.content ? item.content.slice(0, 4500) : "";
				prompt = `【Pstack 严谨工程专项工作依据 · ${skillTitle}】\n${skillDoc}\n\n【Pstack 执行守则】\n1. 深入优先、拒绝 AI 废话（Unslop）：严禁生成无实质意义的虚浮描述和表面修补代码；\n2. 拿实证说话：完成修改后必须提供可复现的验证依据（测试输出、运行诊断或精确行为证据）；\n3. 遵循所选 Skill（${skillKey}）的全部非妥协原则（Non-negotiables）开展本节点任务。\n\n【本节点任务与上下文】\n${prompt}`;
			} else if (node.role === "skill") {
				const targetSkillName = String(node.config?.skillName ?? node.config?.skill ?? "").trim();
				let skillInstruction = "";
				let foundSkillTitle = targetSkillName || "未指定技能";
				if (targetSkillName) {
					const diskSkills = discoverDiskSkills({
						cwd: resolvedCwd || this.baseCwd,
						dataDir: this.dataDir,
						scanAncestors: true,
					});
					const matched = diskSkills.find((s) => s.name.toLowerCase() === targetSkillName.toLowerCase());
					if (matched) {
						skillInstruction = readSkillInstruction(matched.filePath);
						foundSkillTitle = matched.name;
					} else {
						const pstackItem = PSTACK_SKILLS_MAP[targetSkillName.toLowerCase()];
						if (pstackItem) {
							skillInstruction = pstackItem.content;
							foundSkillTitle = `${pstackItem.icon} ${pstackItem.nameZh} (${pstackItem.id})`;
						}
					}
				}
				prompt = `【技能之魂 (Soul of Skill) · ${foundSkillTitle}】\n${skillInstruction ? `你当前以此 Skill 的规约与方法论作为你的核心灵魂与行动指南：\n${skillInstruction.slice(0, 4500)}` : `以「${foundSkillTitle}」技能要求为核心灵魂与行为准则。`}\n\n【执行契约】\n必须完全以该 Skill 的专业角色与标准推进工作，结合上游交付物严谨执行。\n\n【本节点任务与上下文】\n${prompt}`;
			}

			let outputSummary = "";

			// AI 条件裁决（config.aiJudge=true）：条件节点走一次轻量问答做语义判定，
			// 只能回“结论：通过/不通过”，下游按它分流；失败回落关键词。未开启还是零 token 透传。
			const wantAiJudge =
				(node.role === "ai_judge" || (node.role === "condition" && node.config?.aiJudge === true)) &&
				graph.executionMode !== "simulate";
			let judgeModel: string = node.model;
			if (wantAiJudge) {
				const condRef = String(node.config?.condition ?? "").trim() || "上游产物符合预期";
				const instructionAsk = (node.instruction ?? "").trim().slice(0, 500);
				const judgeAsk =
					typeof node.config?.judge === "string" && node.config.judge.trim()
						? String(node.config.judge).trim().slice(0, 500)
						: instructionAsk || `判断上游产物是否满足【${condRef}】`;
				const upstreamBlock = contractContext.trim()
					? `上游产物摘要：\n${contractContext.slice(0, 4000)}\n问题：${judgeAsk}（以上游产物为依据）`
					: `无上游产物，直接回答问题：${judgeAsk}`;
				prompt = `你是流水线分支裁判。只做二选一语义判断，不干别的活，不调用任何工具。\n${upstreamBlock}\n要求：最后一行必须 exactly 输出“结论：通过”或“结论：不通过”，前面可附一行理由。`;
				judgeModel =
					typeof node.config?.judgeModel === "string" && node.config.judgeModel.trim()
						? node.config.judgeModel.trim().slice(0, 120)
						: node.model;
				this.appendLog(
					graph.id,
					nodeId,
					"system",
					`AI 裁决启动（${node.engine}/${judgeModel}）：${judgeAsk.slice(0, 200)}`,
				);
			} else if (!isCanvasPassthroughRole(node.role) && node.role !== "transform") {
				prompt += `\n\n【流水线自动化执行安全公约】:
1. 自治推进：这是无人值守的自动化协同流水线，严禁停留在向用户提问或等待人工决策阶段；遇分支情况请按最佳工程实践自主裁决并推进；
2. 避免前台阻塞：如需启动服务或验证测试，严禁启动阻塞终端的前台长进程；遇到端口占用（如 3000/3001 等）先检测并释放，验证完成后务必确保退出并清理所有后台子进程；
3. 交付明确：完成时请提供清晰的修改摘要、接口契约与当前状态，供下游节点或审查门禁接力。`;
			}
			this.appendLog(graph.id, nodeId, "prompt", prompt.slice(0, 2000));
			// 纯透传控制节点（条件/循环/人工/汇聚/记忆/结束）：不启动 LLM 会话，直接透传摘要。人工审批节点停留在 waiting_approval 等待抽屉批准，不自动向下游流转。
			if (node.role === "transform") {
				const transformed = executeTransformNode(graph, node);
				node.status = "done";
				node.currentAction = "格式转换完成（本地执行）";
				node.lastOutputSummary = transformed;
				await captureControlArtifact();
				if (!isCurrent()) return;
				this.appendLog(graph.id, nodeId, "done", transformed.slice(0, 2000));
				if (!isCurrent()) return;
				releaseCapacity();
				this.activeExecutions.delete(execKey);
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcastCanvasRuntime(graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId: graph.id,
					nodeId,
					event: "done",
					currentAction: node.currentAction,
					summary: node.lastOutputSummary,
				});
				await this.handleDownstreamEdges(
					graph,
					node,
					undefined,
					() => lifecycleCurrent() && !controller.signal.aborted,
				);
				return;
			}
			if (!wantAiJudge && isCanvasPassthroughRole(node.role)) {
				const passthroughSummary = buildPassthroughSummary(node, contractContext, initialPrompt);
				if (node.role === "human") {
					node.status = "waiting_approval";
					node.currentAction =
						(node.config?.approvalHint ? String(node.config.approvalHint) + " —— " : "") + "等待人工在抽屉中批准/驳回";
					node.lastOutputSummary = passthroughSummary;
					await captureControlArtifact();
					if (!isCurrent()) return;
					this.appendLog(graph.id, nodeId, "system", "人工审批节点已就绪，等待批准");
					if (!isCurrent()) return;
					releaseCapacity();
					this.activeExecutions.delete(execKey);
					this.settleGraph(graph);
					saveCanvasRuntimeState(this.dataDir, graph);
					this.broadcastCanvasRuntime(graph);
					this.broadcast({
						type: "canvas_node_event",
						graphId: graph.id,
						nodeId,
						event: "paused",
						currentAction: node.currentAction,
						summary: node.lastOutputSummary,
					});
					return;
				}
				node.status = "done";
				node.currentAction = `控制节点直通 (${node.role})`;
				node.lastOutputSummary = passthroughSummary;
				await captureControlArtifact();
				if (!isCurrent()) return;
				this.appendLog(graph.id, nodeId, "done", passthroughSummary.slice(0, 2000));
				if (!isCurrent()) return;
				releaseCapacity();
				this.activeExecutions.delete(execKey);
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcastCanvasRuntime(graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId: graph.id,
					nodeId,
					event: "done",
					currentAction: node.currentAction,
					summary: node.lastOutputSummary,
				});
				await this.handleDownstreamEdges(
					graph,
					node,
					undefined,
					() => lifecycleCurrent() && !controller.signal.aborted,
				);
				return;
			}

			// 双模调度：真实引擎执行 (Real Engine) vs 拓扑演练演示 (Simulation)
			if (graph.executionMode === "simulate") {
				await this.simulateNodeExecution(node, resolvedCwd, prompt, controller.signal, (action) => {
					if (!isCurrent()) return;
					node.currentAction = action;
					this.broadcast({
						type: "canvas_node_event",
						graphId: graph.id,
						nodeId,
						event: "action",
						currentAction: action,
					});
				});
				outputSummary = `[${node.title}] 演练完成，工作目录：${node.cwd || "."}`;
			} else {
				const savedModel = node.model;
				if (wantAiJudge && judgeModel !== node.model) node.model = judgeModel;
				try {
					outputSummary = await this.executeRealEngineNode(
						graph,
						node,
						resolvedCwd,
						prompt,
						controller.signal,
						(action) => {
							if (!isCurrent()) return;
							node.currentAction = action;
							this.broadcast({
								type: "canvas_node_event",
								graphId: graph.id,
								nodeId,
								event: "action",
								currentAction: action,
							});
						},
					);
				} finally {
					node.model = savedModel;
				}
			}

			if (!isCurrent()) return;

			const workspaceArtifact = workspace.isolated
				? await captureCanvasWorkspaceArtifact(workspace, { signal: controller.signal })
				: undefined;
			if (!isCurrent()) return;
			node.artifact = {
				runId: graph.run!.id,
				attempt: node.attempt!,
				summary: outputSummary,
				text: outputSummary,
				cwd: workspace.cwd,
				createdAt: Date.now(),
				workspace: workspaceArtifact,
			};
			// 节点完成
			node.status = "done";
			node.currentAction = `已完成 (${node.engine.toUpperCase()})`;
			node.lastOutputSummary = outputSummary;
			if (wantAiJudge) {
				const hits = [
					...outputSummary.matchAll(/结论\s*[：:]\s*(通过|不通过|成立|不成立|是|否|真|假|true|false|yes|no)/gi),
				];
				const last = hits.length > 0 ? String(hits[hits.length - 1][1]).toLowerCase() : "";
				node.aiVerdict = last ? ["通过", "成立", "是", "真", "true", "yes"].includes(last) : undefined;
				if (node.aiVerdict === undefined) throw new Error("AI judge returned no explicit decision");
				this.appendLog(
					graph.id,
					nodeId,
					"system",
					node.aiVerdict === undefined
						? "AI 裁决未给出有效结论（默认走不成立边）。"
						: `AI 裁决结论：${node.aiVerdict ? "通过" : "不通过"}（独立判定，未混入关键词）。`,
				);
			}
			this.appendLog(graph.id, nodeId, "done", outputSummary.slice(0, 2000));
			if (!isCurrent()) return;
			releaseCapacity();
			this.activeExecutions.delete(execKey);
			saveCanvasRuntimeState(this.dataDir, graph);
			this.broadcastCanvasRuntime(graph);

			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "done",
				currentAction: node.currentAction,
				summary: node.lastOutputSummary,
			});

			// 触发下游交接或审查
			await this.handleDownstreamEdges(graph, node, undefined, () => lifecycleCurrent() && !controller.signal.aborted);
		} catch (err: unknown) {
			if (!lifecycleCurrent() || controller.signal.aborted) return;
			const msg = (err as Error).message || String(err);
			node.status = "error";
			node.error = msg;
			node.currentAction = `执行出错: ${msg}`;
			this.appendLog(graph.id, node.id, "error", msg.slice(0, 2000));
			if (!lifecycleCurrent() || controller.signal.aborted) return;
			releaseCapacity();
			this.activeExecutions.delete(execKey);
			this.settleGraph(graph);
			saveCanvasRuntimeState(this.dataDir, graph);
			this.broadcastCanvasRuntime(graph);

			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "error",
				currentAction: node.currentAction,
				error: msg,
			});
		} finally {
			releaseCapacity();
		}
	}

	/** Start a fresh run; active and approval-paused runs must be resolved first. */
	async runAll(graph: CanvasGraph, initialPrompt?: string, runBase?: string): Promise<void> {
		if (!fsExistsSync(pathJoin(this.dataDir, "canvas", `${graph.id}.json`))) return;
		const current = this.runningGraphs.get(graph.id);
		if (current && ["running", "waiting_approval"].includes(current.status))
			throw new Error("Canvas graph already running");
		if ([...this.activeExecutions.values()].some((e) => e.graphId === graph.id))
			throw new Error("Canvas graph already running");
		validateCanvasTopology(graph);
		for (const key of this.feedbackArtifacts.keys())
			if (key.startsWith(`${graph.id}:`)) this.feedbackArtifacts.delete(key);
		this.graphGenerations.set(graph.id, (this.graphGenerations.get(graph.id) ?? 0) + 1);
		graph.run = { id: randomUUID(), graphRev: graph.rev ?? 0, startedAt: Date.now(), scope: "all" };
		graph.status = "running";
		for (const node of graph.nodes) {
			node.status = "idle";
			node.error = undefined;
			node.currentAction = undefined;
			node.lastOutputSummary = undefined;
			node.artifact = undefined;
			node.aiVerdict = undefined;
			node.runId = graph.run!.id;
			node.attempt = 0;
			node.actualEngine = undefined;
			node.actualModel = undefined;
		}
		for (const edge of graph.edges) {
			edge.active = undefined;
			edge.runId = graph.run!.id;
			edge.lastHandoffSummary = undefined;
			edge.currentLoopCount = 0;
		}
		this.runningGraphs.set(graph.id, graph);
		this.armRunDeadline(graph);
		if ((runBase ?? "").trim()) this.runBaseByGraph.set(graph.id, runBase!);
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		const roots = graph.nodes.filter((n) => !graph.edges.some((e) => e.targetNodeId === n.id && !isCanvasBackedge(e)));
		const generation = this.graphGenerations.get(graph.id);
		await Promise.all(roots.map((n) => this.runNode(graph, n.id, initialPrompt, runBase, true)));
		if (this.graphGenerations.get(graph.id) !== generation || this.runningGraphs.get(graph.id) !== graph) return;
		this.settleGraph(graph);
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
	}

	/** A node run owns the reachable subgraph, including explicitly requested rework. */
	private runNodes(graph: CanvasGraph): CanvasNode[] {
		if (graph.run?.scope !== "node" || !graph.run.nodeId) return graph.nodes;
		const ids = new Set<string>();
		const visit = (id: string) => {
			if (ids.has(id)) return;
			ids.add(id);
			for (const edge of graph.edges) if (edge.sourceNodeId === id) visit(edge.targetNodeId);
		};
		visit(graph.run.nodeId);
		return graph.nodes.filter((n) => ids.has(n.id));
	}

	private settleGraph(graph: CanvasGraph): void {
		const scoped = this.runNodes(graph);
		if (scoped.some((n) => n.status === "error")) graph.status = "error";
		else if (scoped.some((n) => n.status === "waiting_approval")) graph.status = "waiting_approval";
		else if (scoped.some((n) => n.status === "running")) graph.status = "running";
		else if (scoped.every((n) => n.status === "done" || n.status === "skipped")) graph.status = "completed";
		else graph.status = "blocked";
		if (
			graph.run &&
			["completed", "error", "blocked"].includes(graph.status) &&
			!scoped.some((n) => n.status === "running" || n.status === "waiting_approval")
		) {
			clearTimeout(this.runDeadlines.get(graph.id));
			this.runDeadlines.delete(graph.id);
			graph.run.finishedAt = Date.now();
			graph.run.error = scoped.find((n) => n.error)?.error;
		}
	}

	private async handleDownstreamEdges(
		graph: CanvasGraph,
		completedNode: CanvasNode,
		via?: "approve" | "reject",
		lifecycleCurrent: () => boolean = () => true,
	): Promise<void> {
		const generation = this.graphGenerations.get(graph.id) ?? 0;
		const isCurrent = () =>
			lifecycleCurrent() &&
			(this.graphGenerations.get(graph.id) ?? 0) === generation &&
			this.runningGraphs.get(graph.id) === graph &&
			fsExistsSync(pathJoin(this.dataDir, "canvas", `${graph.id}.json`));
		if (!isCurrent()) return;
		completedNode.artifact = {
			...completedNode.artifact,
			runId: graph.run?.id ?? "",
			attempt: completedNode.attempt ?? 1,
			summary: completedNode.lastOutputSummary ?? "",
			text: completedNode.lastOutputSummary,
			cwd: completedNode.artifact?.cwd ?? completedNode.cwd,
			createdAt: completedNode.artifact?.createdAt ?? Date.now(),
		};
		const conditional = completedNode.role === "condition" || completedNode.role === "ai_judge";
		const hit = conditional ? canvasCondition(completedNode, graph) : undefined;
		const decision = via ?? (conditional ? (hit ? "approve" : "reject") : undefined);
		const rework: CanvasNode[] = [];
		for (const edge of graph.edges.filter((e) => e.sourceNodeId === completedNode.id)) {
			const back = isCanvasBackedge(edge);
			const selected = back
				? decision === "reject"
				: via !== "reject" &&
					(edge.type === "approve"
						? via === "approve" || (conditional && hit === true)
						: edge.type === "condition_true"
							? hit === true
							: edge.type === "condition_false"
								? hit === false
								: true);
			edge.runId = graph.run?.id;
			edge.active = selected;
			edge.lastHandoffSummary = selected ? completedNode.artifact.text : undefined;
			if (selected)
				this.appendLog(
					graph.id,
					edge.targetNodeId,
					"handoff",
					`收到来自「${completedNode.title}」的交接：${edge.lastHandoffSummary ?? ""}`,
				);
			if (!selected || !back) continue;
			if ((edge.currentLoopCount ?? 0) >= (edge.maxLoopRetries ?? 3)) {
				completedNode.status = "waiting_approval";
				completedNode.currentAction = "已达审查重试上限，等待人工仲裁";
				continue;
			}
			const feedbackKey = `${graph.id}:${graph.run?.id}:${edge.id}`;
			if (completedNode.artifact.workspace) this.feedbackArtifacts.set(feedbackKey, completedNode.artifact.workspace);
			else this.feedbackArtifacts.delete(feedbackKey);
			edge.currentLoopCount = (edge.currentLoopCount ?? 0) + 1;
			const target = graph.nodes.find((n) => n.id === edge.targetNodeId);
			if (target && !rework.includes(target)) rework.push(target);
		}
		if (via === "reject" && rework.length === 0 && completedNode.status !== "waiting_approval") {
			completedNode.status = "waiting_approval";
			completedNode.currentAction = "Rejection requires a configured rework edge";
		}
		// Reset the forward rework region, retaining the feedback contract and retry counts.
		const reset = (id: string, seen = new Set<string>()) => {
			if (seen.has(id)) return;
			seen.add(id);
			const node = graph.nodes.find((n) => n.id === id)!;
			if (this.activeExecutions.has(graph.id + ":" + id)) this.stopNode(graph.id, id);
			node.status = "idle";
			node.error = undefined;
			node.artifact = undefined;
			node.lastOutputSummary = undefined;
			node.aiVerdict = undefined;
			for (const edge of graph.edges.filter((e) => e.sourceNodeId === id && !isCanvasBackedge(e))) {
				edge.active = undefined;
				edge.lastHandoffSummary = undefined;
				reset(edge.targetNodeId, seen);
			}
		};
		for (const target of rework) reset(target.id);
		const scheduled: Promise<void>[] = [];
		for (const target of rework) {
			if (!isCurrent()) return;
			scheduled.push(this.runNode(graph, target.id, undefined, this.runBaseByGraph.get(graph.id), true));
		}
		// Resolve skipped branches to a fixed point before scheduling joins.
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of this.runNodes(graph))
				if (node.status === "idle" && canvasReadiness(graph, node) === "skip") {
					node.status = "skipped";
					changed = true;
					for (const edge of graph.edges.filter((e) => e.sourceNodeId === node.id && !isCanvasBackedge(e))) {
						edge.active = false;
						edge.lastHandoffSummary = undefined;
					}
				}
		}
		for (const node of this.runNodes(graph)) {
			if (!isCurrent()) return;
			if (
				node.status === "idle" &&
				graph.edges.some((e) => e.targetNodeId === node.id && !isCanvasBackedge(e) && e.active === true) &&
				canvasReadiness(graph, node) === "ready"
			)
				scheduled.push(this.runNode(graph, node.id, undefined, this.runBaseByGraph.get(graph.id), true));
		}
		this.settleGraph(graph);
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		await Promise.all(scheduled);
		if (!isCurrent()) return;
		this.settleGraph(graph);
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
	}

	/** 停止单个节点 */
	stopNode(graphId: string, nodeId: string): void {
		const execKey = `${graphId}:${nodeId}`;
		this.nodeGenerations.set(execKey, (this.nodeGenerations.get(execKey) ?? 0) + 1);
		const execution = this.activeExecutions.get(execKey);
		if (execution) {
			execution.abortController?.abort();
			this.activeExecutions.delete(execKey);
		}

		const graph = this.runningGraphs.get(graphId);
		if (graph) {
			const node = graph.nodes.find((n) => n.id === nodeId);
			if (node) {
				node.status = "cancelled";
				node.currentAction = "已手动中止";
				this.settleGraph(graph);
				this.appendLog(graphId, nodeId, "system", "已手动中止当前任务");
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcastCanvasRuntime(graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId,
					nodeId,
					event: "paused",
					currentAction: node.currentAction,
				});
			}
		}
	}

	/** 停止全图所有正在运行的节点 */
	stopAll(graphId: string): void {
		clearTimeout(this.runDeadlines.get(graphId));
		this.runDeadlines.delete(graphId);
		this.graphGenerations.set(graphId, (this.graphGenerations.get(graphId) ?? 0) + 1);
		this.runBaseByGraph.delete(graphId);
		for (const [key, execution] of this.activeExecutions.entries()) {
			if (execution.graphId === graphId) {
				execution.abortController?.abort();
				this.activeExecutions.delete(key);
			}
		}
		const graph = this.runningGraphs.get(graphId);
		if (graph) {
			graph.status = "paused";
			if (graph.run) graph.run.finishedAt = Date.now();
			for (const node of graph.nodes) {
				if (["running", "idle", "waiting_approval"].includes(node.status)) {
					node.status = "cancelled";
					node.currentAction = "已手动中止";
				}
			}
			saveCanvasRuntimeState(this.dataDir, graph);
			this.broadcastCanvasRuntime(graph);
		}
	}

	/** 审查门禁裁决（#707）：批准/驳回落盘持久化并广播；执行中的节点同步收到审查意见 */
	reviewNode(graphId: string, nodeId: string, decision: "approve" | "reject", comment?: string): CanvasGraph | null {
		if (!isSafeGraphId(graphId)) return null;
		let graph = this.runningGraphs.get(graphId);
		if (!graph) {
			try {
				graph = loadCanvasGraph(this.dataDir, graphId);
			} catch {
				return null;
			}
		}
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return null;
		if (node.status !== "waiting_approval") return null;
		const cleanComment = (comment ?? "").trim();
		node.lastOutputSummary = `${node.lastOutputSummary ?? ""}\n${decision === "reject" ? "Rework requested" : "Approved"}: ${cleanComment}`;
		graph.status = "running";
		if (decision === "approve") {
			node.status = "done";
			node.currentAction = cleanComment ? `人工审查批准合流：${cleanComment}` : "人工审查批准合流";
		} else {
			node.status = "done";
			node.currentAction = cleanComment ? `人工驳回：${cleanComment}` : "人工驳回：需补充完善测试与注释";
		}
		graph.updatedAt = Date.now();
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		this.runningGraphs.set(graphId, graph);
		this.appendLog(
			graphId,
			nodeId,
			"review",
			`${decision === "approve" ? "人工审查批准合流" : "人工驳回"}${cleanComment ? `：${cleanComment}` : ""}`,
		);
		// 执行中的节点同步收到审查意见（复用节点事件通道，currentAction 即裁决正文）
		if (this.activeExecutions.has(`${graphId}:${nodeId}`)) {
			this.broadcast({
				type: "canvas_node_event",
				graphId,
				nodeId,
				event: decision === "approve" ? "done" : "paused",
				currentAction: node.currentAction,
				summary: node.lastOutputSummary,
			});
		}
		void this.handleDownstreamEdges(graph, node, decision).catch((error: unknown) => {
			node.status = "error";
			node.error = String(error);
			this.settleGraph(graph);
			saveCanvasRuntimeState(this.dataDir, graph);
			this.broadcastCanvasRuntime(graph);
		});
		return graph;
	}

	/** 向节点插话干预 (Steer) */
	async steerNode(graphId: string, nodeId: string, message: string): Promise<void> {
		let graph = this.runningGraphs.get(graphId);
		if (!graph) {
			try {
				graph = loadCanvasGraph(this.dataDir, graphId);
				this.runningGraphs.set(graphId, graph);
			} catch {
				return;
			}
		}
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return;

		node.currentAction = `[收到人工插话指导]: ${message.slice(0, 40)}`;
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		this.appendLog(graphId, nodeId, "steer", message.slice(0, 2000));

		this.broadcast({
			type: "canvas_node_event",
			graphId,
			nodeId,
			event: "action",
			currentAction: node.currentAction,
		});

		// 真正投递给底层会话（若节点正在执行）
		const execKey = `${graphId}:${nodeId}`;
		const execution = this.activeExecutions.get(execKey);
		if (execution?.session && typeof execution.session.prompt === "function") {
			try {
				await execution.session.prompt(message);
				if (execution.abortController?.signal.aborted || this.activeExecutions.get(execKey) !== execution) return;
				this.appendLog(graphId, nodeId, "system", "已将插话实时投递进正在运行的智能体会话。");
			} catch (err: unknown) {
				if (execution.abortController?.signal.aborted || this.activeExecutions.get(execKey) !== execution) return;
				const errMsg = err instanceof Error ? err.message : String(err);
				this.appendLog(graphId, nodeId, "error", `插话投递底层会话失败: ${errMsg}`);
			}
		} else if (node.status !== "running") {
			const cleanMsg = message.trim();
			if (cleanMsg) {
				node.instruction = node.instruction ? `${node.instruction}\n\n[人工指导补充]: ${cleanMsg}` : cleanMsg;
				saveCanvasGraph(this.dataDir, graph);
				this.appendLog(graphId, nodeId, "system", "节点未在运行，指导意见已暂存为该节点下一次执行指令。");
			}
		}
	}

	/** 重置全图节点状态为 idle */
	resetStatus(graph: CanvasGraph): void {
		this.stopAll(graph.id);
		graph.status = "idle";
		for (const node of graph.nodes) {
			node.status = "idle";
			node.aiVerdict = undefined;
			node.error = undefined;
			node.currentAction = undefined;
			node.lastOutputSummary = undefined;
		}
		for (const edge of graph.edges) {
			edge.currentLoopCount = 0;
			edge.lastHandoffSummary = undefined;
		}
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
	}

	/** 节点执行过程模拟与调度心跳（具备取消信号响应） */
	private async simulateNodeExecution(
		node: CanvasNode,
		_cwd: string,
		_prompt: string,
		signal: AbortSignal,
		onAction: (act: string) => void,
	): Promise<void> {
		const steps = [
			`[${node.engine.toUpperCase()}] 分析任务上下文与关联代码库...`,
			`[${node.engine.toUpperCase()}] 规划模块变更方案与接口契约...`,
			`[${node.engine.toUpperCase()}] 写入并应用变更...`,
			`[${node.engine.toUpperCase()}] 验证输出结果与测试检查...`,
		];

		for (const step of steps) {
			if (signal.aborted) return;
			onAction(step);
			const stepDelay = process.env.NODE_ENV === "test" || process.env.VITEST ? 20 : 600;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, stepDelay);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("Aborted"));
					},
					{ once: true },
				);
			});
		}
	}

	/** 真实智能体引擎执行通道（接入真实的会话、模型调用与代码修改） */
	private async executeRealEngineNode(
		graph: CanvasGraph,
		node: CanvasNode,
		resolvedCwd: string,
		prompt: string,
		signal: AbortSignal,
		onAction: (act: string) => void,
	): Promise<string> {
		if (!this.engineGetter) {
			throw new Error("引擎服务提供者未注入");
		}
		const engineSvc = this.engineGetter(node.engine);
		if (!engineSvc) {
			throw new Error(`找不到智能体引擎：${node.engine}`);
		}

		const clientId = `canvas:${graph.id}:${node.id}`;
		let collectedText = "";

		onAction(`[${node.engine.toUpperCase()}] 正在接入真实引擎运行时...`);

		// sink 具名持有：finally 必须用同一引用 detach，否则旧闭包永久残留串台（#698）
		// 复用当前对话流：snapshot/appended 的标准 UiMessage 直接缓存 + 转播，抽屉复用 Message 组件渲染；
		// 工具调用与文本增量同时记一条轻量协同事件，保证调用/错误清晰可见。
		const seenToolIds = new Set<string>();
		// 本轮运行期间从直播帧里看到的 errorMessage（与快照索引无关，压缩/翻页也不会丢）。
		// 只收「本轮新增」的消息：attach / 首帧可能是带全量 history 的 snapshot，
		// 否则该节点上一次留下的旧报错会被当成本轮失败（换模型后仍报旧错）。
		let sinkError: string | undefined;
		const baselineMsgIds = new Set<string>();
		let captureErrors = false;
		const sink = (msg: ServerMessage) => {
			if (signal.aborted) return;
			if (msg.type === "message_delta") {
				const delta = (msg as any).delta || "";
				collectedText += delta;
				if (collectedText.length % 50 === 0) {
					onAction(`[${node.engine.toUpperCase()}] 正在生成: ${collectedText.slice(-30).replace(/\n/g, " ")}...`);
				}
			} else if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
				const messages = ((msg as any).state?.messages || (msg as any).appended || []) as UiMessage[];
				if (messages.length > 0) this.pushNodeMessages(graph.id, node.id, messages);
				for (const m of messages) {
					if (signal.aborted) return;
					if (m.toolName) {
						const tid = m.toolCallId || `${m.toolName}:${m.id}`;
						if (!seenToolIds.has(tid)) {
							seenToolIds.add(tid);
							this.appendLog(
								graph.id,
								node.id,
								"tool",
								m.isError
									? `工具 ${m.toolName} 报错${m.errorMessage ? `：${m.errorMessage.slice(0, 500)}` : ""}`
									: `正在调用工具： ${m.toolName}`,
								m.toolName,
							);
						}
						onAction(`[${node.engine.toUpperCase()}] 正在调用工具: ${m.toolName}`);
					} else if (m.errorMessage) {
						if (captureErrors && !baselineMsgIds.has(m.id)) sinkError = m.errorMessage;
						if (!baselineMsgIds.has(m.id)) {
							this.appendLog(graph.id, node.id, "error", m.errorMessage.slice(0, 2000));
						}
					}
				}
			}
		};

		const execKey = `${graph.id}:${node.id}`;
		const execution = this.activeExecutions.get(execKey);
		const cs = await engineSvc.attach(clientId, sink);
		const checkCurrent = () => {
			if (signal.aborted || this.activeExecutions.get(execKey) !== execution) throw new Error("任务已被手动中止");
		};
		if (!signal.aborted && this.activeExecutions.get(execKey) === execution && execution) {
			execution.session = cs;
		}

		try {
			checkCurrent();
			if (cs.cwd !== resolvedCwd) {
				await cs.setCwd(resolvedCwd);
			}

			checkCurrent();

			// 真实应用模型切换（若模型不存在或 Key 无效，真实报错）
			// 归一化双前缀：历史存量可能是 opencode-go/opencode-go/xxx，压成 opencode-go/xxx 再切换。
			if (node.model) {
				if (typeof cs.switchModelOrThrow !== "function") throw new Error(`Engine cannot select model: ${node.model}`);
				await cs.switchModelOrThrow(normalizeCanvasModelId(node.model));
			}
			node.actualEngine = node.engine;
			node.actualModel = node.model;
			checkCurrent();

			// 真实应用思考强度
			if (node.thinkingLevel && typeof (cs as any).setThinking === "function") {
				try {
					(cs as any).setThinking(node.thinkingLevel);
				} catch {}
			}

			onAction(`[${node.engine.toUpperCase()}] 开始执行任务...`);

			// 本轮起点快照：报错检测只看本次运行新增的消息，
			// 避免把该节点历史运行留下的旧报错当成本轮失败。
			const preRunMsgs = canvasSnapshotMessages(cs);
			for (const m of preRunMsgs) baselineMsgIds.add(m.id);
			const baselineMsgCount = preRunMsgs.length;
			captureErrors = true;

			const abortSession = () => {
				void Promise.resolve()
					.then(() => cs.abort())
					.catch(() => {});
			};
			signal.addEventListener("abort", abortSession, { once: true });
			try {
				checkCurrent();
				await cs.prompt(prompt);
			} finally {
				signal.removeEventListener("abort", abortSession);
			}
			checkCurrent();

			// 等待执行完成（带超时和取消监听）
			const startTime = Date.now();
			const maxWaitMs = 15 * 60 * 1000;

			while (!signal.aborted) {
				await new Promise((r) => setTimeout(r, 1200));
				if (signal.aborted) {
					await cs.abort().catch(() => {});
					throw new Error("任务已被手动中止");
				}

				let isStreaming = false;
				let turnError: string | undefined;

				if (typeof (cs as any).readConversationForPlugins === "function") {
					const snap = (cs as any).readConversationForPlugins();
					isStreaming = snap?.isStreaming === true;
					// 注意：PluginConversationSnapshot 并无 `lastError` 字段（旧写法恒为 undefined），
					// 于是 API 报错（如 403 RegionError）被当成执行成功、节点照样标 done。
					// 与定时任务桥（agent-service-daemon）同口径：读尾部 assistant 消息的 errorMessage；
					// 自动重试中的失败消息会被服务端隐藏，中止回合不算报错。
					turnError =
						tailAssistantError(canvasSnapshotMessages(cs).slice(baselineMsgCount)) ??
						(sinkError && !CANVAS_ABORT_MESSAGES.test(sinkError.trim()) ? sinkError : undefined);
				}

				if (turnError) {
					throw new Error(`引擎执行失败：${turnError}`);
				}

				if (!isStreaming && Date.now() - startTime > 3000) {
					break;
				}

				if (Date.now() - startTime > maxWaitMs) {
					await cs.abort().catch(() => {});
					throw new Error("任务执行超时 (15分钟)");
				}
			}

			checkCurrent();

			// 真实检测代码变更统计（仅本地项目支持本地 git diff）
			let diffSummary = "";
			try {
				if (!isRemoteWorkspaceUri(resolvedCwd)) {
					const { stdout: diffStat } = await exec("git", ["diff", "--stat"], {
						cwd: resolvedCwd,
						timeout: 5000,
						windowsHide: true,
					});
					if (diffStat.trim()) {
						diffSummary = `\n【代码变更统计】:\n${diffStat.trim()}`;
					}
				}
			} catch {}

			// 交付正文：优先用流式增量累积，其次取本轮新增的 assistant 正文。
			// （部分引擎/重连路径只走 snapshot 增量、没有 message_delta，collectedText 会是空的，
			//  旧逻辑于是把下游交接内容写成「交付完成（未产生文件修改）」的占位文案）
			const replyText = (
				collectedText.trim() || extractRunReplyText(canvasSnapshotMessages(cs).slice(baselineMsgCount))
			).trim();
			if (replyText) return `${replyText}${diffSummary}`;
			return `[${node.title}] 交付完成${diffSummary || "（未产生文件修改）"}`;
		} finally {
			if (execution) {
				execution.session = undefined;
			}
			engineSvc.detach(clientId, sink);
		}
	}
}

/** 读一次会话快照里的消息列表（快照失败/引擎不支持时返回空数组，不抛出）。 */
function canvasSnapshotMessages(cs: unknown): UiMessage[] {
	const reader = (cs as { readConversationForPlugins?: () => { messages?: UiMessage[] } | null } | null)
		?.readConversationForPlugins;
	if (typeof reader !== "function") return [];
	try {
		const snap = reader.call(cs);
		return (snap?.messages ?? []) as UiMessage[];
	} catch {
		return [];
	}
}

/** SDK 主动中止的精确文案（与 web/src/aborted-turn.ts 同口径，中止不是真实报错） */
const CANVAS_ABORT_MESSAGES = /^(This operation was aborted|Request aborted|任务已被手动中止)$/;

/** 末尾 assistant 回合若是真实报错，返回其 errorMessage；正常收尾或中止返回 undefined。 */
function tailAssistantError(msgs: UiMessage[]): string | undefined {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role !== "assistant") continue;
		if (m.stopReason === "aborted") return undefined;
		const err = (m.errorMessage ?? "").trim();
		if (!err) return undefined;
		return CANVAS_ABORT_MESSAGES.test(err) ? undefined : err;
	}
	return undefined;
}

/** 从本轮新增消息里取最后一条 assistant 正文（text 块拼接），作为交付摘要兜底。 */
function extractRunReplyText(msgs: UiMessage[]): string {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role !== "assistant" || m.stopReason === "aborted") continue;
		const text = (m.content ?? [])
			.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/** 纯透传控制节点集合（与前端 CanvasTypes.PASSTHROUGH_ROLES 保持一致） */
const CANVAS_PASSTHROUGH_ROLES: ReadonlySet<string> = new Set([
	"condition",
	"loop",
	"human",
	"merge",
	"memory",
	"end",
	"trigger",
	"cron",
	"webhook",
]);

function isCanvasPassthroughRole(role: string): boolean {
	return CANVAS_PASSTHROUGH_ROLES.has(role);
}

/** 格式转换节点：本地确定性执行，无需 LLM。text2json / json2text / template。 */
function executeTransformNode(graph: CanvasGraph, node: CanvasNode): string {
	const cfg = (node as { config?: Record<string, string | number | boolean | undefined> }).config ?? {};
	const mode = String(cfg["mode"] ?? "text2json");
	const rawInput = graph.edges
		.filter((e) => e.targetNodeId === node.id)
		.map((e) => e.lastHandoffSummary ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
	const fallbackInput = rawInput || String(cfg["input"] ?? "");
	try {
		if (mode === "json2text") {
			if (!fallbackInput) return "【格式转换 " + node.title + "】输入为空，无输出";
			try {
				const v = JSON.parse(fallbackInput) as unknown;
				if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
				if (v !== null && typeof v === "object") {
					const vals = Object.values(v as Record<string, unknown>);
					if (vals.every((x) => typeof x === "string" || typeof x === "number")) return vals.join("\n");
					return JSON.stringify(v, null, 2);
				}
				return String(v);
			} catch {
				return fallbackInput;
			}
		}
		if (mode === "template") {
			const tpl = String(cfg["template"] ?? "{{input}}");
			return tpl.split("{{input}}").join(fallbackInput).split("{{上游摘要}}").join(fallbackInput);
		}
		if (!fallbackInput) return "【格式转换 " + node.title + "】输入为空，无输出";
		try {
			return JSON.stringify(JSON.parse(fallbackInput), null, 2);
		} catch {
			return JSON.stringify({ text: fallbackInput }, null, 2);
		}
	} catch (err) {
		return "【格式转换 " + node.title + "】转换失败：" + (err as Error).message;
	}
}

/** 归一化画布模型 ID：历史存量可能是 provider/provider/xxx，压成 provider/xxx */
function normalizeCanvasModelId(raw: string): string {
	const t = (raw ?? "").trim();
	const slash = t.indexOf("/");
	if (slash <= 0) return t;
	const provider = t.slice(0, slash);
	let rest = t.slice(slash + 1);
	const prefix = `${provider}/`;
	while (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
	return `${provider}/${rest}`;
}

function buildPassthroughSummary(node: CanvasNode, contractContext: string, initialPrompt?: string): string {
	const cfg = (node as { config?: Record<string, string | number | boolean> }).config ?? {};
	const cfgText = Object.entries(cfg)
		.map(([k, v]) => `${k}=${String(v)}`)
		.slice(0, 8)
		.join("；");
	const contract = contractContext ? contractContext : "（无上游输入，直接透传）";
	switch (node.role) {
		case "condition":
			return `【条件分支 ${node.title}】判定配置：${cfgText || "未配置表达式，默认走 true 边"}\n透传上游产物：\n${contract}`;
		case "loop":
			return `【循环控制 ${node.title}】循环配置：${cfgText || "默认最多 3 次（熔断保护）"}\n透传上游产物：\n${contract}`;
		case "human":
			return `【人工审批 ${node.title}】${cfgText ? `审批提示：${cfgText}` : ""}\n待人工在抽屉中批准/驳回。上游产物：\n${contract}`;
		case "trigger": {
			const popup = (initialPrompt ?? "").trim();
			const payload = popup || String(cfg["payload"] ?? "").trim() || String(node.instruction ?? "").trim();
			const extra = contractContext || "";
			if (payload)
				return (
					"【手动触发 · 业务需求输入 " +
					node.title +
					"】任务内容：\n" +
					payload +
					(extra ? "\n上游输入：\n" + extra : "")
				);
			return (
				"【手动触发 · 业务需求输入 " + node.title + "】" + (extra ? "上游输入：\n" + extra : "（无载荷，直接启动）")
			);
		}
		case "cron":
			return (
				"【定时触发 " +
				node.title +
				"】计划：" +
				(cfgText || "未配置 Cron（默认手动拉起）") +
				"\n透传上游产物：\n" +
				contract
			);
		case "webhook":
			return (
				"【Webhook 触发 " + node.title + "】接入配置：" + (cfgText || "未配置 path") + "\n透传上游产物：\n" + contract
			);
		case "merge":
			return `【汇聚合并 ${node.title}】已汇总上游分支产物：\n${contract}`;
		case "memory":
			return `【记忆读写 ${node.title}】记忆键：${cfgText || "default"}\n快照：\n${contract}`;
		case "end":
			return `【流水线结束 ${node.title}】最终交付汇总：\n${contract}`;
		default:
			return `【控制节点 ${node.title}】透传：\n${contract}`;
	}
}
