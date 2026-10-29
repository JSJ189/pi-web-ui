import { afterEach, describe, expect, it, vi } from "vitest";
import {
	emitTuiOverlayRender,
	resetTuiOverlayRender,
	subscribeTuiOverlayRender,
} from "../../web/src/tui-overlay-bridge";

afterEach(() => resetTuiOverlayRender());

describe("TUI lazy-loading handoff", () => {
	it("replays pending ANSI in order and streams subsequent frames", () => {
		resetTuiOverlayRender(1);
		emitTuiOverlayRender(1, "first");
		emitTuiOverlayRender(1, "second");
		const listener = vi.fn();
		const unsubscribe = subscribeTuiOverlayRender(listener);
		try {
			emitTuiOverlayRender(1, "third");
			expect(listener.mock.calls).toEqual([
				[1, "first"],
				[1, "second"],
				[1, "third"],
			]);
		} finally {
			unsubscribe();
		}
	});
	it("discards closed and superseded overlay output", () => {
		resetTuiOverlayRender(1);
		emitTuiOverlayRender(1, "old");
		resetTuiOverlayRender(2);
		emitTuiOverlayRender(1, "late");
		emitTuiOverlayRender(2, "current");
		const listener = vi.fn();
		const unsubscribe = subscribeTuiOverlayRender(listener);
		unsubscribe();
		expect(listener.mock.calls).toEqual([[2, "current"]]);
		resetTuiOverlayRender();
		emitTuiOverlayRender(2, "closed");
		const afterClose = vi.fn();
		subscribeTuiOverlayRender(afterClose)();
		expect(afterClose).not.toHaveBeenCalled();
	});
	it("bounds pending output and resumes with complete frames", () => {
		resetTuiOverlayRender(1);
		emitTuiOverlayRender(1, "x".repeat(1024 * 1024));
		emitTuiOverlayRender(1, "screen");
		const listener = vi.fn();
		subscribeTuiOverlayRender(listener)();
		expect(listener.mock.calls).toEqual([[1, "screen"]]);
	});
});
