// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement, lazy, useState } from "react";
import { createRoot } from "react-dom/client";
import { DeferredMount } from "../../web/src/components/DeferredMount";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
let root = createRoot(container);
afterEach(() => {
	act(() => root.unmount());
	container.replaceChildren();
	root = createRoot(container);
});

it("does not fetch a hidden view, then preserves its state across switches", async () => {
	const load = vi.fn(async () => ({
		default: function View() {
			const [count, setCount] = useState(0);
			return createElement("button", { onClick: () => setCount(count + 1) }, count);
		},
	}));
	const View = lazy(load);
	const render = async (active: boolean) => {
		await act(async () => {
			root.render(createElement(DeferredMount, { active, children: createElement(View) }));
		});
	};
	await render(false);
	expect(load).not.toHaveBeenCalled();
	expect(container.textContent).toBe("");
	await render(true);
	expect(load).toHaveBeenCalledTimes(1);
	act(() => container.querySelector("button")!.click());
	await render(false);
	await render(true);
	expect(container.textContent).toBe("1");
	expect(load).toHaveBeenCalledTimes(1);
});
