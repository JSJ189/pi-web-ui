// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorktreeBanner } from "../../web/src/components/WorktreeBanner";
import type { WorktreeInfo } from "../../server/protocol";
vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
let root: Root;
let container: HTMLDivElement;
const refresh = vi.fn();
const info: WorktreeInfo = {
	isLinkedWorktree: false,
	currentPath: "/repo",
	mainPath: "/repo",
	mainBranch: "main",
	linkedWorktrees: [
		{ path: "/repo/wt", branch: "feature", isMain: false, isCurrent: false, isDirty: false, uncommittedCount: 0 },
	],
};
function render(value = info) {
	act(() =>
		root.render(
			React.createElement(WorktreeBanner, {
				worktree: value,
				onRefresh: refresh,
				onSwitch: () => {},
				onRemove: () => {},
			}),
		),
	);
}
beforeEach(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	localStorage.clear();
	refresh.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});
it("keeps dismissal across file changes and remounts, but reminds for a new worktree", () => {
	render();
	act(() => (container.querySelector(".worktree-banner-close") as HTMLButtonElement).click());
	expect(container.textContent).toBe("");
	const changed = { ...info, linkedWorktrees: info.linkedWorktrees.map((w) => ({ ...w, isDirty: true })) };
	render(changed);
	expect(container.textContent).toBe("");
	act(() => root.unmount());
	root = createRoot(container);
	render(changed);
	expect(container.textContent).toBe("");
	render({ ...info, linkedWorktrees: [...info.linkedWorktrees, { ...info.linkedWorktrees[0], path: "/repo/new" }] });
	expect(container.querySelector(".worktree-banner")).not.toBeNull();
});
it("refreshes on mount, focus and interval, and cleans up after unmount", () => {
	render();
	expect(refresh).toHaveBeenCalledTimes(1);
	act(() => window.dispatchEvent(new Event("focus")));
	act(() => vi.advanceTimersByTime(30_000));
	expect(refresh).toHaveBeenCalledTimes(3);
	act(() => root.unmount());
	root = createRoot(container);
	window.dispatchEvent(new Event("focus"));
	vi.advanceTimersByTime(30_000);
	expect(refresh).toHaveBeenCalledTimes(3);
});
it("can switch between linked and main states without changing hook order", () => {
	render();
	render({ ...info, isLinkedWorktree: true, currentPath: "/repo/wt" });
	expect(container.querySelector(".linked")).not.toBeNull();
	render();
	expect(container.querySelector(".notice")).not.toBeNull();
	render({ ...info, linkedWorktrees: [] });
	expect(container.textContent).toBe("");
});
