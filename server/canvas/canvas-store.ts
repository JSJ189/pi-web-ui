/**
 * canvas-store.ts — 画布协作工程持久化与模板管理器。
 *
 * 画布工程存放在 <dataDir>/canvas/<graphId>.json 中。
 * 提供画布的增删改查、列表摘要、以及内置开箱即用模板。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "../atomic-file.js";
import type { CanvasGraph, CanvasGraphSummary } from "../protocol.js";

/** 创建系统出厂默认画布（全栈多引擎敏捷协同工程） */
export function createDefaultCanvasGraph(id = "default"): CanvasGraph {
	const now = Date.now();
	return {
		id,
		name: "全栈多引擎协同流水线",
		viewport: { x: 50, y: 50, zoom: 1 },
		status: "idle",
		createdAt: now,
		updatedAt: now,
		nodes: [
			{
				id: "node_architect",
				title: "架构总指挥 (Lead)",
				role: "architect",
				x: 80,
				y: 180,
				width: 300,
				engine: "pi",
				model: "anthropic/claude-3-7-sonnet",
				cwd: ".",
				useWorktree: false,
				systemPromptOverride:
					"你是团队首席架构师。负责拆解需求、明确模块边界与接口契约，向前后端开发派发清晰的任务卡。",
				status: "idle",
			},
			{
				id: "node_fe",
				title: "前端界面工程师",
				role: "coder",
				x: 480,
				y: 60,
				width: 300,
				engine: "dsh",
				model: "deepseek/deepseek-chat",
				cwd: "web",
				useWorktree: true,
				systemPromptOverride: "你是前端专家。使用 DSH 极速 Hashline 补丁引擎，根据契约编写 React/Vite 界面与交互。",
				status: "idle",
			},
			{
				id: "node_be",
				title: "后端与核心引擎",
				role: "coder",
				x: 480,
				y: 320,
				width: 300,
				engine: "claude",
				model: "deepseek/deepseek-chat",
				cwd: "server",
				useWorktree: true,
				systemPromptOverride:
					"你是后端服务专家。使用 Claude Code 引擎负责 Node/Express/WS 路由实现、数据持久化与核心逻辑处理。",
				status: "idle",
			},
			{
				id: "node_qa",
				title: "测试与自愈运维",
				role: "tester",
				x: 880,
				y: 180,
				width: 300,
				engine: "durable",
				model: "anthropic/claude-3-5-haiku",
				cwd: ".",
				useWorktree: false,
				systemPromptOverride:
					"你是测试与自愈运维专家。使用 Durable 引擎持久化运行单元测试、类型检查与端到端验证，发现 Bug 即时自愈纠错。",
				status: "idle",
			},
		],
		edges: [
			{
				id: "edge_arch_to_fe",
				sourceNodeId: "node_architect",
				targetNodeId: "node_fe",
				type: "handoff",
				label: "派发前端需求与 UI 契约",
			},
			{
				id: "edge_arch_to_be",
				sourceNodeId: "node_architect",
				targetNodeId: "node_be",
				type: "handoff",
				label: "派发后端路由与数据契约",
			},
			{
				id: "edge_fe_to_qa",
				sourceNodeId: "node_fe",
				targetNodeId: "node_qa",
				type: "handoff",
				label: "前端产物提交验证",
			},
			{
				id: "edge_be_to_qa",
				sourceNodeId: "node_be",
				targetNodeId: "node_qa",
				type: "handoff",
				label: "后端接口提交测试",
			},
		],
	};
}

/** 画布图/节点 id 白名单：抵挡路径穿越（../）与 git 分支参数注入载体。
 *  限制字符集与长度，杜绝 join 拼接逃逸、worktree 目录逃逸、git 分支名注入。 */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** id 是否可安全用作文件名片段 / worktree 目录名 / git 分支名。 */
export function isSafeGraphId(id: unknown): id is string {
	return typeof id === "string" && SAFE_ID_RE.test(id);
}

function assertSafeGraphId(id: string): void {
	if (!isSafeGraphId(id)) throw new Error(`Invalid canvas graph id: ${JSON.stringify(id)}`);
}

/** 确保画布存储目录存在 */
function ensureCanvasDir(dataDir: string): string {
	const dir = join(dataDir, "canvas");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/** 列出所有已保存的画布工程摘要 */
export function listCanvasGraphs(dataDir: string): CanvasGraphSummary[] {
	const dir = ensureCanvasDir(dataDir);
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	if (files.length === 0) {
		// 初始化默认画布
		const def = createDefaultCanvasGraph();
		saveCanvasGraph(dataDir, def);
		return [
			{
				id: def.id,
				name: def.name,
				nodeCount: def.nodes.length,
				edgeCount: def.edges.length,
				updatedAt: def.updatedAt,
			},
		];
	}

	const list: CanvasGraphSummary[] = [];
	for (const f of files) {
		try {
			const full = join(dir, f);
			const content = JSON.parse(readFileSync(full, "utf8")) as CanvasGraph;
			if (content && content.id) {
				list.push({
					id: content.id,
					name: content.name || content.id,
					nodeCount: content.nodes?.length ?? 0,
					edgeCount: content.edges?.length ?? 0,
					updatedAt: content.updatedAt ?? Date.now(),
				});
			}
		} catch {
			// 跳过损坏的文件
		}
	}
	return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 读取指定画布工程 */
export function loadCanvasGraph(dataDir: string, id: string): CanvasGraph {
	assertSafeGraphId(id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${id}.json`);
	if (!existsSync(path)) {
		if (id === "default") {
			const def = createDefaultCanvasGraph(id);
			saveCanvasGraph(dataDir, def);
			return def;
		}
		throw new Error(`Canvas graph not found: ${id}`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
}

/** 保存或更新画布工程 */
export function saveCanvasGraph(dataDir: string, graph: CanvasGraph): void {
	assertSafeGraphId(graph.id);
	const dir = ensureCanvasDir(dataDir);
	graph.updatedAt = Date.now();
	const path = join(dir, `${graph.id}.json`);
	writeJsonAtomicSync(path, graph);
}

/** 删除画布工程 */
export function deleteCanvasGraph(dataDir: string, id: string): boolean {
	assertSafeGraphId(id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${id}.json`);
	if (existsSync(path)) {
		unlinkSync(path);
		return true;
	}
	return false;
}
