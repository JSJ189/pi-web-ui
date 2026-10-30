import { describe, expect, it } from "vitest";
import {
	createSubagentTask,
	isSubagentTaskPending,
	requestSubagentCompletion,
	restartSubagentTask,
} from "../../server/subagent-task.js";

describe("manual task settlement", () => {
	it("falls back to the final idle output without an explicit complete", () => {
		expect(isSubagentTaskPending(createSubagentTask("manual"), { streaming: false })).toBe(false);
	});

	it.each(["activeChildren", "pendingQuestions", "pendingCommunications"] as const)(
		"waits for %s even after complete",
		(dependency) => {
			const task = requestSubagentCompletion(createSubagentTask("manual"), "Summary");
			expect(isSubagentTaskPending(task, { streaming: false, [dependency]: true })).toBe(true);
			expect(isSubagentTaskPending(task, { streaming: false })).toBe(false);
			expect(isSubagentTaskPending(task, { streaming: true })).toBe(true);
		},
	);

	it.each([true, false] as const)("keeps legacy %s per-turn semantics", (mode) => {
		expect(isSubagentTaskPending(createSubagentTask(mode), { streaming: false, activeChildren: true })).toBe(false);
	});

	it("allows failure settlement with live dependencies", () => {
		const task = createSubagentTask("manual");
		expect(isSubagentTaskPending(task, { streaming: false, activeChildren: true, error: "failed" })).toBe(false);
		expect(isSubagentTaskPending(task, { streaming: false, pendingQuestions: true, canceled: true })).toBe(false);
	});

	it("rejects a stale completion after a new task and preserves the old intent until restart", () => {
		const original = createSubagentTask("manual");
		const requested = requestSubagentCompletion(original, " Finished ", original.generation);
		expect(requested).toMatchObject({ summary: "Finished", completionRequested: true, generation: 0 });
		expect(original.completionRequested).toBe(false);
		const next = restartSubagentTask(requested);
		expect(next).toEqual({ mode: "manual", completionRequested: false, generation: 1 });
		expect(requestSubagentCompletion(next, "stale", requested.generation)).toBe(next);
	});
});
