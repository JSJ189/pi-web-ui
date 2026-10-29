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

/** Reliable first-run template: explicit input, implementation, verification, and human acceptance. */
export function createDefaultCanvasGraph(id = "default"): CanvasGraph {
	const now = Date.now();
	return {
		id,
		name: "开发 · 测试 · 人工验收",
		viewport: { x: 50, y: 50, zoom: 1 },
		status: "idle",
		createdAt: now,
		updatedAt: now,
		nodes: [
			{
				id: "node_architect",
				title: "需求与验收条件",
				role: "trigger",
				x: 80,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				config: { payload: "请填写任务目标、修改范围与验收条件，再运行流程。" },
				instruction: "将任务目标与验收条件交接下游。",
				status: "idle",
			},
			{
				id: "node_fe",
				title: "实现工程师",
				role: "coder",
				x: 480,
				y: 60,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				systemPromptOverride: "根据任务与验收条件实现最小必要改动，检查现有约定并提供文件、验证命令和结果。",
				instruction: "完成上游任务 {{上游摘要}}，交付可验证的实现与完整证据。",
				status: "idle",
			},
			{
				id: "node_be",
				title: "测试与代码审查",
				role: "tester",
				x: 880,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				systemPromptOverride: "审查实现，运行相关检查，明确记录通过、失败和未验证项。不得编造测试结果。",
				instruction: "验证上游产物 {{上游摘要}}，提供检查命令、结果和剩余风险交给人工验收。",
				status: "idle",
			},
			{
				id: "node_qa",
				title: "人工验收",
				role: "human",
				x: 1280,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				instruction: "检查实现与测试证据，批准完成或手动调整流程后重跑。",
				status: "idle",
			},
		],
		edges: [
			{
				id: "edge_arch_to_fe",
				sourceNodeId: "node_architect",
				targetNodeId: "node_fe",
				type: "handoff",
				label: "任务与验收条件",
			},
			{
				id: "edge_fe_to_be",
				sourceNodeId: "node_fe",
				targetNodeId: "node_be",
				type: "handoff",
				label: "实现与验证证据",
			},
			{
				id: "edge_be_to_qa",
				sourceNodeId: "node_be",
				targetNodeId: "node_qa",
				type: "handoff",
				label: "检查结果与待验收产物",
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

/** 保存或更新画布工程（全量拓扑写：rev +1） */
export function saveCanvasGraph(
	dataDir: string,
	graph: CanvasGraph,
	opts?: { expectedRev?: number },
): { conflict: boolean; graph: CanvasGraph } {
	assertSafeGraphId(graph.id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${graph.id}.json`);
	let diskRev = 0;
	let disk: CanvasGraph | undefined;
	if (existsSync(path)) {
		try {
			disk = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
			diskRev = disk.rev ?? 0;
		} catch {
			diskRev = 0;
		}
	}
	if (opts?.expectedRev !== undefined && opts.expectedRev !== diskRev) {
		return { conflict: true, graph: disk ?? graph };
	}
	if (disk) {
		// Topology saves never replace authoritative execution state with a browser's stale snapshot.
		graph.status = disk.status;
		graph.run = disk.run;
		const existingNodes = new Map(disk.nodes.map((node) => [node.id, node]));
		for (const node of graph.nodes) {
			const prior = existingNodes.get(node.id);
			if (!prior) continue;
			for (const field of RUNTIME_FIELDS) (node as unknown as Record<string, unknown>)[field] = prior[field];
		}
		const existingEdges = new Map(disk.edges.map((edge) => [edge.id, edge]));
		for (const edge of graph.edges) {
			const prior = existingEdges.get(edge.id);
			if (!prior) continue;
			for (const field of ["lastHandoffSummary", "currentLoopCount", "runId", "active"] as const)
				(edge as unknown as Record<string, unknown>)[field] = prior[field];
		}
	}
	graph.rev = diskRev + 1;
	graph.updatedAt = Date.now();
	writeJsonAtomicSync(path, graph);
	return { conflict: false, graph };
}

const RUNTIME_FIELDS = [
	"status",
	"currentAction",
	"lastOutputSummary",
	"error",
	"aiVerdict",
	"runId",
	"attempt",
	"artifact",
	"actualEngine",
	"actualModel",
] as const;

/** 运行态落盘：只合并运行字段，拓扑（nodes 增删/edges/坐标/指令）以磁盘版为准，防 stale 回滚（F1）。不推进 rev。 */
export function saveCanvasRuntimeState(dataDir: string, runtime: CanvasGraph): void {
	assertSafeGraphId(runtime.id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${runtime.id}.json`);
	// Runtime updates never create a graph: deletion is authoritative.
	if (!existsSync(path)) return;
	let disk: CanvasGraph;
	try {
		disk = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
	} catch {
		return;
	}
	const rt = new Map(runtime.nodes.map((n) => [n.id, n]));
	for (const n of disk.nodes) {
		const r = rt.get(n.id);
		if (!r) continue;
		for (const f of RUNTIME_FIELDS)
			(n as unknown as Record<string, unknown>)[f] = (r as unknown as Record<string, unknown>)[f];
	}
	const runtimeEdges = new Map(runtime.edges.map((e) => [e.id, e]));
	for (const edge of disk.edges) {
		const source = runtimeEdges.get(edge.id);
		if (!source) continue;
		for (const key of ["lastHandoffSummary", "currentLoopCount", "runId", "active"] as const) {
			(edge as unknown as Record<string, unknown>)[key] = source[key];
		}
	}
	disk.status = runtime.status;
	disk.run = runtime.run;
	disk.updatedAt = Date.now();
	writeJsonAtomicSync(path, disk);
	// 回填调用方，使广播带上最新 rev/拓扑
	runtime.rev = disk.rev;
}

/** Called once when the server starts; persisted runs cannot still own a live engine session. */
export function markInterruptedCanvasRuns(dataDir: string): void {
	const dir = ensureCanvasDir(dataDir);
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
		const path = join(dir, file);
		try {
			const graph = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
			const interrupted =
				graph.status === "running" ||
				graph.nodes?.some((node) => node.status === "running" || node.status === "queued");
			if (!interrupted) continue;
			graph.status = "paused";
			if (graph.run) {
				graph.run.error = "Server restarted; the previous run was interrupted. Restart the run to continue.";
				graph.run.finishedAt = Date.now();
			}
			for (const node of graph.nodes)
				if (node.status === "running" || node.status === "queued") {
					node.status = "paused";
					node.currentAction = "Server restarted; run interrupted";
				}
			writeJsonAtomicSync(path, graph);
		} catch (error) {
			console.error(`[canvas] Could not recover ${file}:`, error);
		}
	}
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
