/**
 * canvas-orchestrator.test.ts — 画布协作调度器与存储单元测试。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDefaultCanvasGraph,
	listCanvasGraphs,
	loadCanvasGraph,
	saveCanvasGraph,
	deleteCanvasGraph,
} from "../../server/canvas/canvas-store.js";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("Canvas Store & Default Squad", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-test-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("应创建包含四大引擎的默认战队", () => {
		const def = createDefaultCanvasGraph();
		expect(def.nodes.length).toBe(4);
		expect(def.edges.length).toBe(4);

		const engines = new Set(def.nodes.map((n) => n.engine));
		expect(engines.has("pi")).toBe(true);
		expect(engines.has("dsh")).toBe(true);
		expect(engines.has("claude")).toBe(true);
		expect(engines.has("durable")).toBe(true);

		// 前后端节点开启了 Worktree 物理隔离
		const fe = def.nodes.find((n) => n.id === "node_fe");
		expect(fe?.useWorktree).toBe(true);
		expect(fe?.cwd).toBe("web");
	});

	it("支持画布保存、读取、列表与删除", () => {
		const def = createDefaultCanvasGraph("test_graph");
		saveCanvasGraph(tempDir, def);

		const loaded = loadCanvasGraph(tempDir, "test_graph");
		expect(loaded.id).toBe("test_graph");
		expect(loaded.nodes.length).toBe(4);

		const list = listCanvasGraphs(tempDir);
		expect(list.some((g) => g.id === "test_graph")).toBe(true);

		const deleted = deleteCanvasGraph(tempDir, "test_graph");
		expect(deleted).toBe(true);

		const listAfter = listCanvasGraphs(tempDir);
		expect(listAfter.some((g) => g.id === "test_graph")).toBe(false);
	});
});

describe("Canvas Orchestrator", () => {
	let tempDir: string;
	let orchestrator: CanvasOrchestrator;
	const events: ServerMessage[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-orch-"));
		orchestrator = new CanvasOrchestrator(tempDir, tempDir);
		events.length = 0;
		orchestrator.setBroadcaster((msg) => events.push(msg));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("支持单节点启动与完成事件通知", async () => {
		const graph = createDefaultCanvasGraph("orch_test");
		saveCanvasGraph(tempDir, graph);

		const feNode = graph.nodes.find((n) => n.id === "node_fe")!;
		// 在测试环境下取消 worktree 以加速纯目录测试
		feNode.useWorktree = false;

		await orchestrator.runNode(graph, "node_fe");

		// 检查状态变更为 done
		expect(feNode.status).toBe("done");
		expect(events.some((e) => e.type === "canvas_node_event" && e.event === "started")).toBe(true);
		expect(events.some((e) => e.type === "canvas_node_event" && e.event === "done")).toBe(true);
	});

	it("支持运行中实时插话干预 (Steer)", () => {
		const graph = createDefaultCanvasGraph("steer_test");
		saveCanvasGraph(tempDir, graph);

		orchestrator.steerNode(graph.id, "node_architect", "注意必须支持移动端触控");

		const updated = loadCanvasGraph(tempDir, graph.id);
		const arch = updated.nodes.find((n) => n.id === "node_architect");
		expect(arch?.currentAction).toContain("收到人工插话指导");
		expect(arch?.currentAction).toContain("必须支持移动端触控");
	});

	it("审查回路防死循环熔断保护 (Review Loop Breaker)", async () => {
		const graph = createDefaultCanvasGraph("review_test");
		// 构造一个达到重试上限的 review 连线
		graph.edges = [
			{
				id: "edge_review_1",
				sourceNodeId: "node_qa",
				targetNodeId: "node_fe",
				type: "review",
				maxLoopRetries: 3,
				currentLoopCount: 3, // 已达 3 次
			},
		];
		saveCanvasGraph(tempDir, graph);

		const qaNode = graph.nodes.find((n) => n.id === "node_qa")!;
		qaNode.useWorktree = false;

		await orchestrator.runNode(graph, "node_qa");

		// 达到上限应触发 waiting_approval 暂停等待人工
		expect(qaNode.status).toBe("waiting_approval");
		expect(qaNode.currentAction).toContain("已达审查重试上限");
	});

	it("审查门禁真动作：批准/驳回落盘持久化并广播（issue #707）", () => {
		const graph = createDefaultCanvasGraph("review_gate_test");
		saveCanvasGraph(tempDir, graph);

		const approved = orchestrator.reviewNode(graph.id, "node_fe", "approve");
		expect(approved?.nodes.find((n) => n.id === "node_fe")?.status).toBe("done");
		expect(loadCanvasGraph(tempDir, graph.id).nodes.find((n) => n.id === "node_fe")?.status).toBe("done");
		// 非执行中节点不广播节点事件（广播由 dispatch 统一发 graph_state）
		expect(events.length).toBe(0);

		const rejected = orchestrator.reviewNode(graph.id, "node_architect", "reject", "缺测试");
		const arch = rejected?.nodes.find((n) => n.id === "node_architect");
		expect(arch?.status).toBe("waiting_approval");
		expect(arch?.currentAction).toContain("缺测试");
		expect(loadCanvasGraph(tempDir, graph.id).nodes.find((n) => n.id === "node_architect")?.currentAction).toContain(
			"缺测试",
		);

		expect(orchestrator.reviewNode(graph.id, "node_missing", "approve")).toBeNull();
		expect(orchestrator.reviewNode("../evil", "node_fe", "approve")).toBeNull();
	});

	it("支持复位状态 (resetStatus)", () => {
		const graph = createDefaultCanvasGraph("reset_test");
		graph.nodes[0].status = "done";
		graph.nodes[1].status = "error";
		saveCanvasGraph(tempDir, graph);

		orchestrator.resetStatus(graph);

		expect(graph.nodes[0].status).toBe("idle");
		expect(graph.nodes[1].status).toBe("idle");
	});
});
