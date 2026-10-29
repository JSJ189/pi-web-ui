import { describe, expect, it } from "vitest";
import { questionNavLayout } from "../../web/src/question-nav";

describe("question navigation layout", () => {
	it("keeps short histories centered with their original spacing", () => {
		expect(questionNavLayout(3, 600, 1)).toEqual({ indices: [0, 1, 2], gap: 27, many: false });
	});

	it("bounds long histories at every available height and retains the active question", () => {
		for (const height of [0, 2, 3, 10, 80, 320, 600, 900]) {
			for (const count of [1, 40, 100, 1000]) {
				for (const active of [0, Math.floor(count / 2), count - 1]) {
					const { indices, gap } = questionNavLayout(count, height, active);
					const used = indices.length * 3 + Math.max(0, indices.length - 1) * gap;
					expect(used).toBeLessThanOrEqual(height + 0.000001);
					expect(new Set(indices).size).toBe(indices.length);
					expect(indices).toEqual([...indices].sort((a, b) => a - b));
					if (indices.length) expect(indices).toContain(active);
				}
			}
		}
	});

	it("provides the full list when ticks are dense or sampled", () => {
		expect(questionNavLayout(40, 600, 15).many).toBe(true);
		expect(questionNavLayout(1000, 320, 555).many).toBe(true);
		expect(questionNavLayout(1000, 320, 555).indices.length).toBeLessThan(1000);
	});

	it("handles no active question, empty histories and a temporarily hidden rail", () => {
		expect(questionNavLayout(0, 600, -1).indices).toEqual([]);
		expect(questionNavLayout(100, 0, 50).indices).toEqual([]);
		const { indices } = questionNavLayout(100, 80, -1);
		expect(indices[0]).toBe(0);
		expect(indices.at(-1)).toBe(99);
	});
});
