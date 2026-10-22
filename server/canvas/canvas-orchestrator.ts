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
import { resolve, sep } from "node:path";
import type { CanvasEngineId, CanvasGraph, CanvasNode, ServerMessage } from "../protocol.js";
import { saveCanvasGraph, loadCanvasGraph, isSafeGraphId } from "./canvas-store.js";
import { isInsideGitRepo, normalizeWirePath } from "../worktree-service.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type CanvasEventBroadcaster = (msg: ServerMessage) => void;
export type EngineServiceGetter = (engine: CanvasEngineId) => any;

interface ActiveNodeExecution {
	graphId: string;
	nodeId: string;
	abortController?: AbortController;
	timeoutId?: ReturnType<typeof setTimeout>;
}

export class CanvasOrchestrator {
	private readonly dataDir: string;
	private readonly baseCwd: string;
	private readonly engineGetter?: EngineServiceGetter;
	private broadcaster: CanvasEventBroadcaster | null = null;
	private readonly activeExecutions = new Map<string, ActiveNodeExecution>();
	private readonly runningGraphs = new Map<string, CanvasGraph>();

	constructor(baseCwd: string, dataDir: string, engineGetter?: EngineServiceGetter) {
		this.baseCwd = baseCwd;
		this.dataDir = dataDir;
		this.engineGetter = engineGetter;
	}

	setBroadcaster(broadcaster: CanvasEventBroadcaster): void {
		this.broadcaster = broadcaster;
	}

	private broadcast(msg: ServerMessage): void {
		this.broadcaster?.(msg);
	}

	/** 确保该节点所需的真实工作目录（支持 Worktree 隔离） */
	async resolveNodeCwd(node: CanvasNode): Promise<string> {
		// 标识与路径白名单：node.id 用于 worktree 目录名与 git 分支名，node.cwd 必须落在工作区内。
		if (!isSafeGraphId(node.id)) throw new Error(`Invalid canvas node id: ${JSON.stringify(node.id)}`);
		const base = resolve(this.baseCwd);
		const targetDir = node.cwd ? resolve(base, node.cwd) : base;
		const basePrefix = base.endsWith(sep) ? base : base + sep;
		if (targetDir !== base && !targetDir.startsWith(basePrefix)) {
			throw new Error(`canvas node.cwd 越出工作区: ${JSON.stringify(node.cwd)}`);
		}
		if (!node.useWorktree) {
			if (!existsSync(targetDir)) {
				mkdirSync(targetDir, { recursive: true });
			}
			return targetDir;
		}

		// 启用 Git Worktree 隔离机制
		const isGit = await isInsideGitRepo(this.baseCwd);
		if (!isGit) {
			// 如果不是 git 仓库，回落到普通子目录
			return targetDir;
		}

		const worktreeDir = resolve(this.baseCwd, ".worktrees", `canvas-${node.id}`);
		if (!existsSync(worktreeDir)) {
			mkdirSync(resolve(this.baseCwd, ".worktrees"), { recursive: true });
			try {
				await exec("git", ["worktree", "add", "-B", `canvas/${node.id}`, normalizeWirePath(worktreeDir), "HEAD"], {
					cwd: this.baseCwd,
					windowsHide: true,
				});
			} catch {
				// 若创建 worktree 失败（例如已存在锁），回退普通目录
				return targetDir;
			}
		}
		return worktreeDir;
	}

	/** 启动单个节点 */
	async runNode(graph: CanvasGraph, nodeId: string, initialPrompt?: string): Promise<void> {
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return;

		this.runningGraphs.set(graph.id, graph);
		const execKey = `${graph.id}:${nodeId}`;
		if (this.activeExecutions.has(execKey)) {
			// 已在运行中
			return;
		}

		const controller = new AbortController();
		this.activeExecutions.set(execKey, {
			graphId: graph.id,
			nodeId,
			abortController: controller,
		});

		node.status = "running";
		node.error = undefined;
		node.currentAction = `[${node.engine.toUpperCase()}] 正在分配独立环境与工作目录...`;
		saveCanvasGraph(this.dataDir, graph);

		this.broadcast({
			type: "canvas_node_event",
			graphId: graph.id,
			nodeId,
			event: "started",
			currentAction: node.currentAction,
		});

		try {
			const resolvedCwd = await this.resolveNodeCwd(node);
			if (controller.signal.aborted) return;

			node.currentAction = `[${node.engine.toUpperCase()}] 启动 ${node.model} 执行中 (${node.role})...`;
			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "action",
				currentAction: node.currentAction,
			});

			// 组装前置契约提示词（若上游边有 handoff 产物）
			const incomingEdges = graph.edges.filter((e) => e.targetNodeId === nodeId);
			let contractContext = "";
			for (const edge of incomingEdges) {
				if (edge.lastHandoffSummary) {
					contractContext += `\n【来自上游节点任务契约】:\n${edge.lastHandoffSummary}\n`;
				}
			}

			const prompt = initialPrompt || `${node.systemPromptOverride || "按照你的角色职责进行开发"}\n${contractContext}`;

			let outputSummary = "";

			// 双模调度：真实引擎执行 (Real Engine) vs 拓扑演练演示 (Simulation)
			if (graph.executionMode === "simulate" || !this.engineGetter) {
				await this.simulateNodeExecution(node, resolvedCwd, prompt, controller.signal, (action) => {
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
				outputSummary = await this.executeRealEngineNode(
					graph,
					node,
					resolvedCwd,
					prompt,
					controller.signal,
					(action) => {
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
			}

			if (controller.signal.aborted) return;

			// 节点完成
			node.status = "done";
			node.currentAction = `已完成 (${node.engine.toUpperCase()})`;
			node.lastOutputSummary = outputSummary;
			this.activeExecutions.delete(execKey);
			saveCanvasGraph(this.dataDir, graph);

			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "done",
				summary: node.lastOutputSummary,
			});

			// 触发下游交接或审查
			await this.handleDownstreamEdges(graph, node);
		} catch (err: unknown) {
			if (controller.signal.aborted) return;
			const msg = (err as Error).message || String(err);
			node.status = "error";
			node.error = msg;
			node.currentAction = `执行出错: ${msg}`;
			this.activeExecutions.delete(execKey);
			saveCanvasGraph(this.dataDir, graph);

			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "error",
				error: msg,
			});
		}
	}

	/** 运行全图（从所有入度为 0 的根节点，或者未完成节点并发拉起） */
	async runAll(graph: CanvasGraph, initialPrompt?: string): Promise<void> {
		this.runningGraphs.set(graph.id, graph);
		graph.status = "running";
		saveCanvasGraph(this.dataDir, graph);

		// 找到没有入边或当前状态为 idle/error 的起点节点
		const targetNodes = new Set(graph.nodes.map((n) => n.id));
		for (const edge of graph.edges) {
			targetNodes.delete(edge.targetNodeId);
		}

		let startNodes = graph.nodes.filter((n) => targetNodes.has(n.id));
		if (startNodes.length === 0) {
			startNodes = graph.nodes.filter((n) => n.status === "idle" || n.status === "error");
		}
		if (startNodes.length === 0 && graph.nodes.length > 0) {
			startNodes = [graph.nodes[0]];
		}

		await Promise.all(startNodes.map((n) => this.runNode(graph, n.id, initialPrompt)));
	}

	/** 处理节点完成后的下游连线流转 */
	private async handleDownstreamEdges(graph: CanvasGraph, completedNode: CanvasNode): Promise<void> {
		const outEdges = graph.edges.filter((e) => e.sourceNodeId === completedNode.id);
		for (const edge of outEdges) {
			edge.lastHandoffSummary = completedNode.lastOutputSummary;

			if (edge.type === "review") {
				// 审查回路：检查是否超出最大驳回重试次数
				const maxRetries = edge.maxLoopRetries ?? 3;
				const current = edge.currentLoopCount ?? 0;
				if (current >= maxRetries) {
					// 达到熔断上限，暂停并等待人工介入
					completedNode.status = "waiting_approval";
					completedNode.currentAction = `已达审查重试上限 (${maxRetries} 次)，暂停等待人工仲裁确认`;
					saveCanvasGraph(this.dataDir, graph);
					this.broadcast({
						type: "canvas_node_event",
						graphId: graph.id,
						nodeId: completedNode.id,
						event: "paused",
						currentAction: completedNode.currentAction,
					});
					continue;
				}
			}

			// 触发下游目标节点
			const targetNode = graph.nodes.find((n) => n.id === edge.targetNodeId);
			if (targetNode && targetNode.status !== "running") {
				void this.runNode(graph, targetNode.id);
			}
		}

		// 检查图上所有节点是否都已经到达完成状态
		const allDone = graph.nodes.every((n) => n.status === "done");
		if (allDone) {
			graph.status = "completed";
			saveCanvasGraph(this.dataDir, graph);
		}
	}

	/** 停止单个节点 */
	stopNode(graphId: string, nodeId: string): void {
		const execKey = `${graphId}:${nodeId}`;
		const execution = this.activeExecutions.get(execKey);
		if (execution) {
			execution.abortController?.abort();
			this.activeExecutions.delete(execKey);
		}

		const graph = this.runningGraphs.get(graphId);
		if (graph) {
			const node = graph.nodes.find((n) => n.id === nodeId);
			if (node) {
				node.status = "idle";
				node.currentAction = "已手动中止";
				saveCanvasGraph(this.dataDir, graph);
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
		for (const [key, execution] of this.activeExecutions.entries()) {
			if (execution.graphId === graphId) {
				execution.abortController?.abort();
				this.activeExecutions.delete(key);
			}
		}
		const graph = this.runningGraphs.get(graphId);
		if (graph) {
			graph.status = "idle";
			for (const node of graph.nodes) {
				if (node.status === "running") {
					node.status = "idle";
					node.currentAction = "已手动中止";
				}
			}
			saveCanvasGraph(this.dataDir, graph);
		}
	}

	/** 向节点插话干预 (Steer) */
	steerNode(graphId: string, nodeId: string, message: string): void {
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
		saveCanvasGraph(this.dataDir, graph);

		this.broadcast({
			type: "canvas_node_event",
			graphId,
			nodeId,
			event: "action",
			currentAction: node.currentAction,
		});
	}

	/** 重置全图节点状态为 idle */
	resetStatus(graph: CanvasGraph): void {
		this.stopAll(graph.id);
		graph.status = "idle";
		for (const node of graph.nodes) {
			node.status = "idle";
			node.error = undefined;
			node.currentAction = undefined;
			node.lastOutputSummary = undefined;
		}
		for (const edge of graph.edges) {
			edge.currentLoopCount = 0;
			edge.lastHandoffSummary = undefined;
		}
		saveCanvasGraph(this.dataDir, graph);
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

		const cs = await engineSvc.attach(clientId, (msg: ServerMessage) => {
			if (signal.aborted) return;
			if (msg.type === "message_delta") {
				const delta = (msg as any).delta || "";
				collectedText += delta;
				if (collectedText.length % 50 === 0) {
					onAction(`[${node.engine.toUpperCase()}] 正在生成: ${collectedText.slice(-30).replace(/\n/g, " ")}...`);
				}
			} else if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
				const messages = (msg as any).state?.messages || (msg as any).appended || [];
				for (const m of messages) {
					if (m.toolName) {
						onAction(`[${node.engine.toUpperCase()}] 正在调用工具: ${m.toolName}`);
					}
				}
			}
		});

		try {
			if (cs.cwd !== resolvedCwd) {
				await cs.setCwd(resolvedCwd);
			}

			// 真实应用模型切换（若模型不存在或 Key 无效，真实报错）
			if (node.model && typeof (cs as any).switchModelOrThrow === "function") {
				try {
					await (cs as any).switchModelOrThrow(node.model);
				} catch (err) {
					throw new Error(`模型未配置或不可用 [${node.model}]: ${(err as Error).message}`);
				}
			}

			// 真实应用思考强度
			if (node.thinkingLevel && typeof (cs as any).setThinking === "function") {
				try {
					(cs as any).setThinking(node.thinkingLevel);
				} catch {}
			}

			onAction(`[${node.engine.toUpperCase()}] 开始执行任务...`);

			await cs.prompt(prompt);

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
				let lastErr: string | undefined;

				if (typeof (cs as any).readConversationForPlugins === "function") {
					const snap = (cs as any).readConversationForPlugins();
					isStreaming = snap?.isStreaming === true;
					lastErr = snap?.lastError;
				}

				if (lastErr) {
					throw new Error(lastErr);
				}

				if (!isStreaming && Date.now() - startTime > 3000) {
					break;
				}

				if (Date.now() - startTime > maxWaitMs) {
					await cs.abort().catch(() => {});
					throw new Error("任务执行超时 (15分钟)");
				}
			}

			// 真实检测代码变更统计
			let diffSummary = "";
			try {
				const { stdout: diffStat } = await exec("git", ["diff", "--stat"], {
					cwd: resolvedCwd,
					timeout: 5000,
					windowsHide: true,
				});
				if (diffStat.trim()) {
					diffSummary = `\n【代码变更统计】:\n${diffStat.trim()}`;
				}
			} catch {}

			return collectedText.trim()
				? `${collectedText.slice(-300)}${diffSummary}`
				: `[${node.title}] 交付完成${diffSummary || "（未产生文件修改）"}`;
		} finally {
			engineSvc.detach(clientId, () => {});
		}
	}
}
