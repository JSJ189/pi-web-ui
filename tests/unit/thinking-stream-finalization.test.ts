// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ThinkingBlock } from "../../web/src/components/ThinkingBlock";
import { LanguageProvider } from "../../web/src/i18n";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let now: number;

beforeEach(() => {
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	frames = new Map();
	frameId = 0;
	now = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function render(thinking: string, streaming: boolean) {
	act(() => {
		root.render(
			createElement(LanguageProvider, null, createElement(ThinkingBlock, { thinking, streaming, wrap: false })),
		);
	});
}

function flushFrames() {
	for (let i = 0; frames.size && i < 300; i++) {
		const pending = [...frames.values()];
		frames.clear();
		now += 25;
		act(() => pending.forEach((callback) => callback(now)));
	}
	expect(frames.size).toBe(0);
}

function expectFinished() {
	expect(container.querySelector(".thinking.ok")).not.toBeNull();
	expect(container.querySelector(".thinking.run, .spin, .stream-cursor")).toBeNull();
}

it("settles a completed thinking block when its final text is shorter than the displayed text", () => {
	render("Review the changes.   ", true);
	flushFrames();
	expect(container.querySelector(".thinking.run")).not.toBeNull();
	render("Review the changes.", false);
	flushFrames();
	expectFinished();
	expect(container.querySelector(".thinking-summary-text")?.textContent).toContain("Review the changes.");
});

it("settles a thinking block whose final snapshot clears the text", () => {
	render("Temporary reasoning", true);
	flushFrames();
	render("", false);
	flushFrames();
	expectFinished();
});

it("drains buffered thinking text and settles without remounting", () => {
	render("Checking the final response before running the next tool.", true);
	expect(frames.size).toBeGreaterThan(0);
	render("Checking the final response before running the next tool.", false);
	flushFrames();
	expectFinished();
});
