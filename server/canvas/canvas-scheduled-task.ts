import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SchedulerTask, SchedulerExecutorResult } from "../scheduler-tasks.js";
import type { CanvasOrchestrator } from "./canvas-orchestrator.js";
import { isSafeGraphId, loadCanvasGraph } from "./canvas-store.js";
import { assertCanvasGraph } from "./canvas-validation.js";

/** Scheduling must never recreate a deleted default graph. */
export function loadScheduledCanvas(dataDir: string, graphId: string) {
	if (!isSafeGraphId(graphId)) throw new Error("Invalid canvas graph id");
	if (!existsSync(join(dataDir, "canvas", `${graphId}.json`))) throw new Error(`Canvas graph not found: ${graphId}`);
	const graph = loadCanvasGraph(dataDir, graphId);
	assertCanvasGraph(graph);
	if (graph.id !== graphId) throw new Error("Canvas graph id mismatch");
	return graph;
}

export function validateScheduledCanvas(dataDir: string, task: SchedulerTask): void {
	if (task.target === "canvas") loadScheduledCanvas(dataDir, task.graphId ?? "");
}

/** Await the existing orchestrator and report its actual outcome, including approval pauses. */
export async function executeScheduledCanvas(
	dataDir: string,
	orchestrator: Pick<CanvasOrchestrator, "runAll">,
	task: SchedulerTask,
): Promise<SchedulerExecutorResult> {
	const graphId = task.graphId ?? "";
	let runId: string | undefined;
	try {
		const graph = loadScheduledCanvas(dataDir, graphId);
		await orchestrator.runAll(graph, task.prompt || undefined, task.cwd);
		runId = graph.run?.id;
		if (!runId) throw new Error("Canvas run did not start");
		// Read back authoritative state to detect deletion, cancellation, or replacement during execution.
		const current = loadScheduledCanvas(dataDir, graphId);
		if (current.run?.id !== runId) throw new Error("Canvas run was replaced before completion");
		return {
			ok: current.status === "completed",
			graphId,
			runId,
			...(current.status === "completed" ? {} : { error: current.run?.error || `Canvas run ${current.status}` }),
		};
	} catch (error) {
		return { ok: false, graphId, ...(runId ? { runId } : {}), error: (error as Error).message };
	}
}
