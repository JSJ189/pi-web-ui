/** true/false preserve per-turn notifications; manual waits for task dependencies. */
export type SubagentNotifyMode = boolean | "manual";

export interface SubagentTaskState {
	mode: SubagentNotifyMode;
	completionRequested: boolean;
	summary?: string;
	generation: number;
}

export interface SubagentTaskActivity {
	streaming: boolean;
	activeChildren?: boolean;
	pendingQuestions?: boolean;
	pendingCommunications?: boolean;
	error?: boolean | string;
	canceled?: boolean;
}

export function createSubagentTask(mode: SubagentNotifyMode = true): SubagentTaskState {
	return { mode, completionRequested: false, generation: 0 };
}

/** Only a NEW task/reset advances generation. Child replies and automatic wakes retain intent. */
export function restartSubagentTask(task: SubagentTaskState): SubagentTaskState {
	return { mode: task.mode, completionRequested: false, generation: task.generation + 1 };
}

/** Record intent only. The host must recheck live dependencies and idle state before closing. */
export function requestSubagentCompletion(
	task: SubagentTaskState,
	summary: string,
	generation = task.generation,
): SubagentTaskState {
	if (generation !== task.generation) return task;
	return { ...task, completionRequested: true, summary: summary.trim() };
}

/**
 * Pure snapshot predicate, never a completion side effect. The host resolves dependencies
 * across owners immediately before settlement. complete cannot close a streaming task or
 * bypass children/questions/communications. Manual idle without dependencies falls back to
 * the final assistant summary, even without complete. Error/cancel bypass dependency waits;
 * the host must notify these failures even in manual mode. Notifications are generation-bound.
 */
export function isSubagentTaskPending(task: SubagentTaskState, activity: SubagentTaskActivity): boolean {
	if (activity.error || activity.canceled) return false;
	if (activity.streaming) return true;
	return (
		task.mode === "manual" && !!(activity.activeChildren || activity.pendingQuestions || activity.pendingCommunications)
	);
}
