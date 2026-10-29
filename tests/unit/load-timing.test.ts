import { describe, expect, it, vi } from "vitest";
import { startLoadTiming } from "../../server/load-timing.js";

describe("opt-in history load timing", () => {
	it("does no clock or reporting work when disabled", () => {
		const now = vi.fn(() => 0),
			report = vi.fn();
		const timing = startLoadTiming(false, now, report);
		timing.mark("repair");
		timing.finish("loaded");
		expect(now).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});
	it("records stage durations, total and outcome once without identifiers", () => {
		let clock = 10;
		const report = vi.fn();
		const timing = startLoadTiming(true, () => clock, report);
		clock = 13;
		timing.mark("repair");
		clock = 18;
		timing.mark("sdk-open");
		clock = 20;
		timing.finish("loaded");
		timing.mark("ignored");
		timing.finish("error");
		expect(report.mock.calls).toEqual([
			[
				{
					event: "history-open",
					outcome: "loaded",
					totalMs: 10,
					stages: [
						{ stage: "repair", ms: 3 },
						{ stage: "sdk-open", ms: 5 },
					],
				},
			],
		]);
	});
	it("does not propagate reporting failures", () => {
		const timing = startLoadTiming(
			true,
			() => 0,
			() => {
				throw new Error("logger unavailable");
			},
		);
		expect(() => timing.finish("error")).not.toThrow();
	});
});
