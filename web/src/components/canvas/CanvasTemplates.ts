import type { CanvasGraph, CanvasNodeRole } from "../../types";
import { autoLayout } from "./canvas-p0";

export interface SquadTemplate {
	id: string;
	title: string;
	desc: string;
	createGraph: () => CanvasGraph;
}
function sequential(name: string, steps: { title: string; role: CanvasNodeRole; instruction?: string }[]): CanvasGraph {
	const now = Date.now();
	const id = `graph_${now}_${Math.random().toString(36).slice(2, 8)}`;
	const nodes: CanvasGraph["nodes"] = steps.map((s, i) => ({
		...s,
		id: `${id}_n${i}`,
		x: 80,
		y: 80,
		width: 300,
		engine: "pi",
		model: "",
		cwd: ".",
		useWorktree: false,
		status: "idle",
	}));
	const edges: CanvasGraph["edges"] = nodes.slice(1).map((n, i) => ({
		id: `${id}_e${i}`,
		sourceNodeId: nodes[i].id,
		targetNodeId: n.id,
		type: nodes[i].role === "human" ? "approve" : "handoff",
		sourcePort: nodes[i].role === "human" ? "approve" : "result",
		targetPort: "contract",
	}));
	return {
		id,
		name,
		nodes: autoLayout(nodes, edges),
		edges,
		viewport: { x: 60, y: 60, zoom: 1 },
		status: "idle",
		executionMode: "real",
		createdAt: now,
		updatedAt: now,
	};
}
export const SQUAD_TEMPLATES: SquadTemplate[] = [
	{
		id: "pstack_rigorous",
		title: "Pstack 串行工程与人工验收",
		desc: "串行规划、实现、测试与审查；技能指令依赖当前模型与工具，人工确认最终结果。",
		createGraph: () =>
			sequential("Pstack 串行工程", [
				{ title: "规划", role: "pstack", instruction: "明确需求、依赖与可验证验收标准，不假设隔离工作区。" },
				{ title: "实现", role: "pstack", instruction: "依据上游计划在共享目录实现，保留其他改动，报告证据。" },
				{ title: "测试", role: "pstack", instruction: "执行相关测试，提供真实结果及未验证范围。" },
				{ title: "审查", role: "pstack", instruction: "核对实现和测试证据，明确缺项，交人工验收。" },
				{ title: "人工验收", role: "human" },
			]),
	},
	{
		id: "sequential-delivery",
		title: "串行研发与人工验收",
		desc: "同一工作目录依次规划、实现、测试、审查，人工批准后结束。",
		createGraph: () =>
			sequential("串行研发与人工验收", [
				{ title: "任务输入", role: "trigger" },
				{
					title: "规划",
					role: "planner",
					instruction: "明确需求、影响范围和验收标准。所有步骤在共享工作目录中串行执行。",
				},
				{ title: "实现", role: "coder", instruction: "依据{{上游摘要}}完成实现，保留他人改动，报告修改与限制。" },
				{
					title: "测试",
					role: "tester",
					instruction: "依据任务与上游交付执行必要测试，报告命令、真实结果与未覆盖范围。失败时明确记录，不声称通过。",
				},
				{
					title: "审查",
					role: "reviewer",
					instruction: "检查实际修改与测试证据，指出未满足验收标准的内容，提交人工决定。",
				},
				{ title: "人工验收", role: "human" },
				{ title: "交付汇总", role: "end" },
			]),
	},
	{
		id: "research-qa",
		title: "调研与 QA 验收",
		desc: "串行调研、整理、证据核验，最终由人工验收；无自动隔离或集成承诺。",
		createGraph: () =>
			sequential("调研与 QA 验收", [
				{ title: "任务输入", role: "trigger" },
				{ title: "调研", role: "researcher", instruction: "收集可核验资料，区分证据、推断与未知。" },
				{ title: "整理报告", role: "writer", instruction: "根据{{上游摘要}}整理报告，保留来源与不确定性。" },
				{ title: "QA 核验", role: "reviewer", instruction: "逐项核对来源与需求，列出错误、缺项和未验证部分。" },
				{ title: "人工验收", role: "human" },
				{ title: "最终交付", role: "end" },
			]),
	},
];
