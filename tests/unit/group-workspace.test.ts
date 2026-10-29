// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupWorkspace } from "../../web/src/components/GroupWorkspace";

vi.mock("../../web/src/i18n", () => ({
	useI18n: () => ({ locale: "zh" }),
	isZhLocale: () => true,
	useT: () => (key: string) => key,
}));
vi.mock("../../web/src/auth-token", () => ({ withToken: (url: string) => url }));
vi.mock("../../web/src/use-floating-panel", () => ({
	useFloatingPanel: () => ({ panelRef: { current: null }, style: { position: "fixed" } }),
}));
vi.mock("../../web/src/components/ProjectPicker", () => ({
	ProjectPicker: ({ onSelectDirectory, mode }: { onSelectDirectory: (path: string) => void; mode: string }) =>
		createElement(
			"button",
			{ type: "button", onClick: () => onSelectDirectory("/Users/me/selected project"), "data-mode": mode },
			"选定测试目录",
		),
}));
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
let root: Root | undefined;
let host: HTMLDivElement;
async function render(roomId = "one", active = true) {
	if (!root) {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	}
	await act(async () => root!.render(createElement(GroupWorkspace, { roomId, active })));
}
async function click(text: string) {
	const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
		item.textContent?.includes(text),
	);
	expect(button, text).toBeTruthy();
	await act(async () => button!.click());
}
async function input(path: string) {
	const element = document.querySelector("input")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, path);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function submit() {
	await act(async () => {
		document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
describe("group local workspace", () => {
	it("selects a directory through the shared picker and saves it without switching projects", async () => {
		const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
			response(
				init.method === "POST"
					? { binding: { roomId: "one", root: "/Users/me/selected project", revision: 1 } }
					: { defaultRoot: "/Users/me" },
			),
		);
		vi.stubGlobal("fetch", fetcher);
		await render();
		await click("本机项目");
		expect(document.querySelector(".universal-path-picker-root")).toBeTruthy();
		await act(async () => document.querySelector<HTMLButtonElement>(".universal-path-browse-btn")!.click());
		expect(document.querySelector('[data-mode="folder"]')).toBeTruthy();
		await click("选定测试目录");
		expect(document.querySelector("input")!.value).toBe("/Users/me/selected project");
		expect(document.querySelector("form")).toBeTruthy();
		await submit();
		expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toEqual({
			roomId: "one",
			path: "/Users/me/selected project",
		});
	});
	it("requires explicit default selection and announces a device-local POST", async () => {
		const defaultRoot = "C:\\projects\\default";
		const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
			response(
				init.method === "POST" ? { binding: { roomId: "one", root: defaultRoot, revision: 1 } } : { defaultRoot },
			),
		);
		vi.stubGlobal("fetch", fetcher);
		const changed = vi.fn();
		window.addEventListener("pi-web-ui:group-workspace-changed", changed);
		try {
			await render();
			await click("本机项目");
			expect(document.body.textContent).toContain("选择本机项目后此设备才能执行本群任务");
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0][0]).toContain("/api/device-center/workspaces?roomId=one");
			await click("使用服务默认项目");
			const [url, init] = fetcher.mock.calls[1];
			expect(url).toContain("/api/device-center/workspaces");
			expect(init.credentials).toBe("same-origin");
			expect(JSON.parse(init.body as string)).toEqual({ roomId: "one", path: defaultRoot });
			expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ roomId: "one" });
			expect(document.querySelector("input")!.value).toBe(defaultRoot);
		} finally {
			window.removeEventListener("pi-web-ui:group-workspace-changed", changed);
		}
	});
	it("preserves an edited Mac path across refresh and visibly reports busy 409", async () => {
		const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
			init.method === "POST"
				? response({ error: "busy" }, 409)
				: response({ defaultRoot: "/srv/default", binding: { roomId: "one", root: "/old", revision: 1 } }),
		);
		vi.stubGlobal("fetch", fetcher);
		await render();
		await click("本机项目");
		await input("/Users/me/project with spaces");
		await click("刷新");
		expect(document.querySelector("input")!.value).toBe("/Users/me/project with spaces");
		await submit();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("请在任务结束后再修改");
		expect(document.querySelector("input")!.value).toBe("/Users/me/project with spaces");
		expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body as string).path).toBe("/Users/me/project with spaces");
	});
	it("cancels old room reads and ignores late responses", async () => {
		let resolve!: (value: Response) => void;
		const fetcher = vi.fn((url: string) =>
			url.endsWith("=one")
				? new Promise<Response>((done) => {
						resolve = done;
					})
				: Promise.resolve(response({ defaultRoot: "/two", binding: { roomId: "two", root: "/two", revision: 1 } })),
		);
		vi.stubGlobal("fetch", fetcher);
		await render("one");
		await render("two");
		expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
		await act(async () =>
			resolve(response({ defaultRoot: "/one", binding: { roomId: "one", root: "/one", revision: 1 } })),
		);
		expect(host.textContent).toContain("/two");
		expect(host.textContent).not.toContain("/one");
	});
	it("cancels room saves without publishing their stale success", async () => {
		let resolve!: (value: Response) => void;
		const fetcher = vi.fn((_url: string, init: RequestInit) =>
			init.method === "POST"
				? new Promise<Response>((done) => {
						resolve = done;
					})
				: Promise.resolve(response({ defaultRoot: "/default" })),
		);
		vi.stubGlobal("fetch", fetcher);
		const dispatch = vi.spyOn(window, "dispatchEvent");
		await render();
		await click("本机项目");
		await input("/one");
		await submit();
		const signal = fetcher.mock.calls.at(-1)![1].signal!;
		await render("two");
		expect(signal.aborted).toBe(true);
		await act(async () => resolve(response({ binding: { roomId: "one", root: "/one", revision: 1 } })));
		expect(dispatch.mock.calls.filter(([event]) => event.type === "pi-web-ui:group-workspace-changed")).toHaveLength(0);
		expect(host.textContent).not.toContain("/one");
	});
	it("does not request an inactive room and surfaces API failures", async () => {
		const fetcher = vi.fn(async () => response({ error: "Not a member" }, 403));
		vi.stubGlobal("fetch", fetcher);
		await render("one", false);
		expect(fetcher).not.toHaveBeenCalled();
		await render();
		await click("本机项目");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Not a member");
	});
});
