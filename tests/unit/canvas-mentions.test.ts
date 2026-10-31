import { describe, expect, it, vi } from "vitest";
import { CANVAS_LIST_EVENT, mapCanvasHits, searchCanvasMentions } from "../../web/src/canvas-mentions";
import { mergeAtHits } from "../../web/src/at-mention";

const graphs = [
	{ id: "release", name: "发布检查", nodeCount: 2, edgeCount: 1, updatedAt: 1 },
	{ id: "review", name: "Code Review", nodeCount: 1, edgeCount: 0, updatedAt: 2 },
];

describe("canvas mentions", () => {
	it("lists workflows by trigger and searches name/id without embedding graph contents", () => {
		for (const query of ["", "画布", "canvas", "workflow"])
			expect(mapCanvasHits(graphs, query, "画布")).toHaveLength(2);
		const hits = mapCanvasHits(graphs, "RELEASE", "画布");
		expect(hits).toHaveLength(1);
		expect(hits[0].attachments).toEqual([{ path: "release", name: "发布检查", mode: "canvas" }]);
		expect(mapCanvasHits(graphs, "发布", "画布")).toEqual(hits);
		expect(mapCanvasHits(graphs, "absent", "画布")).toEqual([]);
		expect(mapCanvasHits(graphs, "", "画布", 0)).toEqual([]);
	});
	it("keeps canvas selectable within the shared menu cap and preserves explicit skill priority", () => {
		const canvases = mapCanvasHits(graphs, "", "Canvas");
		const skill = { providerId: "host:skills", providerLabel: "Skills", title: "review" };
		expect(mergeAtHits({ canvases, skills: [skill] }, "", 1)).toEqual([canvases[0]]);
		expect(mergeAtHits({ canvases, skills: [skill] }, "skill:review", 1)).toEqual([skill]);
	});
	it("subscribes before requesting, then removes the response listener", async () => {
		const target = new EventTarget();
		vi.stubGlobal("window", target);
		const remove = vi.spyOn(target, "removeEventListener");
		try {
			const result = await searchCanvasMentions(() => {
				const event = new Event(CANVAS_LIST_EVENT);
				Object.assign(event, { detail: { type: "canvas_list_result", graphs } });
				target.dispatchEvent(event);
				return true;
			});
			expect(result).toEqual(graphs);
			expect(remove).toHaveBeenCalledOnce();
			expect(await searchCanvasMentions(() => false)).toEqual([]);
			expect(await searchCanvasMentions(() => true, 1)).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
