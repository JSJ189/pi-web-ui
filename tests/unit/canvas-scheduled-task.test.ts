import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDefaultCanvasGraph,
	loadCanvasGraph,
	saveCanvasGraph,
	saveCanvasRuntimeState,
	deleteCanvasGraph,
} from "../../server/canvas/canvas-store.js";
import {
	executeScheduledCanvas,
	loadScheduledCanvas,
	validateScheduledCanvas,
} from "../../server/canvas/canvas-scheduled-task.js";
import { SchedulerStore, normalizeSchedulerInput } from "../../server/scheduler-tasks.js";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "scheduled-canvas-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const task = () =>
	normalizeSchedulerInput({
		target: "canvas",
		graphId: "flow",
		name: "Daily flow",
		kind: "interval",
		spec: 60000,
		prompt: "requirements",
		cwd: dir,
	});
function saveFlow() {
	const graph = createDefaultCanvasGraph("flow");
	graph.nodes = [graph.nodes[0]];
	graph.nodes[0].role = "transform";
	graph.nodes[0].config = { mode: "template", template: "processed {{input}}" };
	graph.edges = [];
	saveCanvasGraph(dir, graph);
	return graph;
}

describe("scheduled canvas executor", () => {
	it("fires a due timer through the store and persists canvas run history", async () => {
		saveFlow();
		vi.useFakeTimers();
		const orchestrator = new CanvasOrchestrator(dir, dir, () => {
			throw new Error("must not call a model");
		});
		const store = new SchedulerStore(dir, {
			executor: (scheduled) => executeScheduledCanvas(dir, orchestrator, scheduled),
			validateTask: (scheduled) => validateScheduledCanvas(dir, scheduled),
		});
		try {
			const scheduled = store.upsert(task());
			store.start();
			await vi.advanceTimersByTimeAsync(60001);
			const result = store.list().find((entry) => entry.id === scheduled.id);
			expect(result?.lastRun).toMatchObject({ ok: true, graphId: "flow" });
			expect(result?.lastRun?.runId).toBeTruthy();
			expect(result?.lastRun?.manual).toBeUndefined();
		} finally {
			store.stop();
			vi.useRealTimers();
		}
	});
	it("runs a persisted deterministic workflow without model calls and records its run identity", async () => {
		saveFlow();
		const orchestrator = new CanvasOrchestrator(dir, dir, () => {
			throw new Error("must not call a model");
		});
		const result = await executeScheduledCanvas(dir, orchestrator, task());
		expect(result).toMatchObject({ ok: true, graphId: "flow" });
		expect(result.runId).toBeTruthy();
		expect(loadCanvasGraph(dir, "flow").status).toBe("completed");
	});
	it("validates references without recreating deleted default graphs or accepting path traversal", () => {
		expect(() => loadScheduledCanvas(dir, "default")).toThrow("not found");
		expect(() => loadScheduledCanvas(dir, "../flow")).toThrow("Invalid");
		expect(() => validateScheduledCanvas(dir, task())).toThrow("not found");
	});
	it("reports approval pauses and forwards the saved prompt and project root", async () => {
		saveFlow();
		const runAll = vi.fn(async (graph) => {
			graph.run = { id: "approval-run", graphRev: graph.rev ?? 0, startedAt: 1, scope: "all" };
			graph.status = "waiting_approval";
			saveCanvasRuntimeState(dir, graph);
		});
		const result = await executeScheduledCanvas(dir, { runAll }, task());
		expect(runAll).toHaveBeenCalledWith(expect.objectContaining({ id: "flow" }), "requirements", dir);
		expect(result).toMatchObject({
			ok: false,
			graphId: "flow",
			runId: "approval-run",
			error: "Canvas run waiting_approval",
		});
	});
	it("records deletion during execution as failure rather than resurrecting the graph", async () => {
		saveFlow();
		const result = await executeScheduledCanvas(
			dir,
			{
				runAll: async (graph) => {
					graph.run = { id: "deleted-run", graphRev: 0, startedAt: 1, scope: "all" };
					deleteCanvasGraph(dir, graph.id);
				},
			},
			task(),
		);
		expect(result).toMatchObject({ ok: false, graphId: "flow", runId: "deleted-run" });
		expect(result.error).toContain("not found");
	});
	it("propagates the orchestrator overlap refusal without claiming an existing run", async () => {
		saveFlow();
		const result = await executeScheduledCanvas(
			dir,
			{
				runAll: async () => {
					throw new Error("Canvas graph already running");
				},
			},
			task(),
		);
		expect(result).toMatchObject({ ok: false, error: "Canvas graph already running" });
		expect(result.runId).toBeUndefined();
	});
});
