import { describe, expect, it } from "vitest";
import type { CanvasGraphSummary, SchedulerTaskView } from "../../web/src/types";
import { blankDraft, canSaveDraft, draftFromTask, taskInputFromDraft } from "../../web/src/components/SchedulerPanel";

const graphs = [{ id: "graph-1", name: "Daily workflow" }] as CanvasGraphSummary[];
const canvasDraft = () => ({ ...blankDraft("/project"), name: "Daily", target: "canvas" as const, graphId: "graph-1" });

function existingTask(overrides: Partial<SchedulerTaskView> = {}): SchedulerTaskView {
	return {
		id: "task-1",
		name: "Daily",
		description: "",
		cwd: "/project",
		kind: "cron",
		spec: "0 9 * * *",
		prompt: "",
		model: "provider/model",
		thinkingLevel: "high",
		enabled: true,
		catchUp: "skip",
		conversationId: "",
		sessionFile: "",
		oneShot: false,
		createdAt: 1,
		updatedAt: 1,
		nextFire: null,
		lastRun: null,
		history: [],
		running: false,
		...overrides,
	};
}

describe("scheduler panel targets", () => {
	it("preserves canvas targets and graph IDs when editing existing tasks", () => {
		const draft = draftFromTask(existingTask({ target: "canvas", graphId: "graph-1" }));
		const input = taskInputFromDraft(draft);
		expect(input).toMatchObject({ id: "task-1", target: "canvas", graphId: "graph-1", cwd: "/project", prompt: "" });
		expect(input).not.toHaveProperty("model");
		expect(input).not.toHaveProperty("thinkingLevel");
	});

	it("keeps legacy conversation tasks as conversations", () => {
		const draft = draftFromTask(existingTask({ prompt: "Inspect dependencies" }));
		expect(draft.target).toBe("conversation");
		expect(taskInputFromDraft(draft)).toMatchObject({
			target: "conversation",
			model: "provider/model",
			thinkingLevel: "high",
		});
		expect(canSaveDraft(draft, [], false)).toBe(true);
		expect(canSaveDraft({ ...draft, prompt: "  " }, [], false)).toBe(false);
	});

	it("accepts blank canvas input but requires a loaded, valid graph and run base", () => {
		const draft = canvasDraft();
		expect(canSaveDraft(draft, graphs, false)).toBe(true);
		expect(canSaveDraft(draft, graphs, true)).toBe(false);
		expect(canSaveDraft(draft, [], false)).toBe(false);
		expect(canSaveDraft({ ...draft, graphId: "" }, graphs, false)).toBe(false);
		expect(canSaveDraft({ ...draft, cwd: " " }, graphs, false)).toBe(false);
	});

	it("retains an unavailable graph ID for display while refusing to save it", () => {
		const draft = draftFromTask(existingTask({ target: "canvas", graphId: "deleted-graph" }));
		expect(draft.graphId).toBe("deleted-graph");
		expect(canSaveDraft(draft, graphs, false)).toBe(false);
	});

	it("drops the canvas graph when switching to a conversation and restores conversation overrides", () => {
		const draft = {
			...canvasDraft(),
			target: "conversation" as const,
			prompt: "Inspect",
			model: "p/m",
			thinkingLevel: "low",
		};
		expect(taskInputFromDraft(draft)).toMatchObject({ target: "conversation", model: "p/m", thinkingLevel: "low" });
		expect(taskInputFromDraft(draft)).not.toHaveProperty("graphId");
	});
});
