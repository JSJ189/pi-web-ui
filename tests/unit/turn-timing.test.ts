import { describe, expect, it } from "vitest";
import { startTurnTiming, finishTurnTiming } from "../../server/turn-timing.js";

describe("turn timing", () => {
	it("keeps the original clock through tools, steering and retries", () => {
		const conv = {};
		startTurnTiming(conv, 1000);
		startTurnTiming(conv, 5000);
		expect(conv).toEqual({ turnTiming: { startedAt: 1000 } });
		finishTurnTiming(conv, 9000);
		finishTurnTiming(conv, 12000);
		expect(conv).toEqual({ turnTiming: { startedAt: 1000, finishedAt: 9000 } });
	});

	it("resets only when a new run starts and isolates conversations", () => {
		const first = {};
		const second = {};
		startTurnTiming(first, 1000);
		finishTurnTiming(first, 2000);
		startTurnTiming(first, 3000);
		startTurnTiming(second, 4000);
		expect(first).toEqual({ turnTiming: { startedAt: 3000 } });
		expect(second).toEqual({ turnTiming: { startedAt: 4000 } });
	});

	it("ignores empty conversations and prevents negative durations", () => {
		const conv = {};
		finishTurnTiming(conv, 1000);
		expect(conv).toEqual({});
		startTurnTiming(conv, 2000);
		finishTurnTiming(conv, 1500);
		expect(conv).toEqual({ turnTiming: { startedAt: 2000, finishedAt: 2000 } });
	});
});
