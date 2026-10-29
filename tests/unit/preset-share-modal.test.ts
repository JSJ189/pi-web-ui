// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresetShareModal } from "../../web/src/components/PresetShareModal";

const send = vi.hoisted(() => vi.fn());
vi.mock("../../web/src/app-globals", () => ({ appSend: send }));
vi.mock("../../web/src/i18n", () => ({
	useT: () => (key: string, args?: Record<string, unknown>) => key + (args ? JSON.stringify(args) : ""),
	useI18n: () => ({ locale: "en" }),
	isZhLocale: () => false,
}));
vi.mock("../../web/src/components/Modal", () => ({ Modal: ({ children }: { children: React.ReactNode }) => children }));
let root: Root;
let host: HTMLDivElement;
function setup(extra: Record<string, unknown> = {}) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const props = {
		presets: [],
		plugins: [],
		pluginCatalog: [],
		pluginJobs: {},
		disabledPlugins: [],
		presetExport: null,
		presetImport: null,
		presetCatalog: null,
		presetShare: null,
		onClose: vi.fn(),
		...extra,
	};
	const render = (patch: Record<string, unknown> = {}) => {
		Object.assign(props, patch);
		act(() => root.render(createElement(PresetShareModal, props as any)));
	};
	render();
	return render;
}
function click(label: string) {
	const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
	expect(button, label).toBeTruthy();
	act(() => button!.click());
}
function input(selector: string, value: string) {
	const el = host.querySelector(selector) as HTMLInputElement;
	act(() => {
		Object.getOwnPropertyDescriptor(
			el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
			"value",
		)!.set!.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function preview(requestId: string, plugins: unknown[] = []) {
	return {
		requestId,
		ok: true,
		dryRun: true,
		receivedAt: 1,
		preview: {
			name: "Original",
			description: "",
			author: "",
			tags: [],
			fields: ["disabledSkills", "promptTemplate"],
			ignored: [],
			rejected: [],
			summary: { skills: 0, agentTools: 0 },
			settings: { disabledSkills: [], promptTemplate: "template" },
			plugins,
		},
	};
}
afterEach(() => {
	act(() => root?.unmount());
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	send.mockClear();
});

describe("preset share modal", () => {
	it("invalidates preview after input edits and ignores old receipts across requests", () => {
		const render = setup({ initialTab: "import" });
		input("textarea", "{}");
		click("preview");
		const first = send.mock.calls.at(-1)![0].requestId;
		render({ presetImport: preview(first) });
		input("textarea", '{"name":"new"}');
		expect(host.querySelector('input[aria-label="presetImportName"]')).toBeNull();
		click("preview");
		const second = send.mock.calls.at(-1)![0].requestId;
		render({ presetImport: { ...preview(first), receivedAt: 2 } });
		expect(host.querySelector('input[aria-label="presetImportName"]')).toBeNull();
		render({ presetImport: { ...preview(second), receivedAt: 2 } });
		expect(host.querySelector('input[aria-label="presetImportName"]')).toBeTruthy();
	});
	it("restores saved dependencies for re-sharing, including plugins not installed locally", () => {
		setup({
			initialPreset: "Saved",
			presets: [{ name: "Saved", plugins: [{ id: "remote", source: "team/repo", version: "1" }] }],
		});
		click("presetExportJson");
		expect(send.mock.calls.at(-1)![0].plugins).toEqual([{ id: "remote", source: "team/repo", version: "1" }]);
	});
	it("defaults to no dependencies and exports only explicitly selected portable metadata", () => {
		setup({
			plugins: [
				{ id: "demo", name: "Demo", source: "team/repo", settingsValues: { secret: "hidden" } },
				{ id: "local", name: "Local", source: "C:\\private" },
			],
		});
		const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect(checks[0].checked).toBe(false);
		expect(checks[1].disabled).toBe(true);
		act(() => checks[0].click());
		click("presetExportJson");
		const message = send.mock.calls.map((c) => c[0]).find((m) => m.type === "preset_export");
		expect(message.plugins).toEqual([{ id: "demo", name: "Demo", source: "team/repo" }]);
	});
	it("ignores stale shares and requires a click to copy or open a share result", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const render = setup({ presetShare: { requestId: "old", ok: true, url: "https://example.com", receivedAt: 1 } });
		expect(host.textContent).not.toContain("presetShareCreated");
		click("presetShareSubmit");
		const requestId = send.mock.calls.at(-1)![0].requestId;
		render({ presetShare: { requestId, ok: true, method: "gh", url: "https://example.com", receivedAt: 2 } });
		expect(open).not.toHaveBeenCalled();
		expect(host.textContent).toContain("presetShareCreated");
	});
	it("renames imports, warns about clears and templates, and separates save from apply failure", () => {
		const render = setup({ initialTab: "import" });
		input("textarea", "{}");
		click("preview");
		const requestId = send.mock.calls.at(-1)![0].requestId;
		render({ presetImport: preview(requestId) });
		expect(host.textContent).toContain("presetImportClears");
		expect(host.textContent).toContain("presetImportTemplateWarning");
		input('input[aria-label="presetImportName"]', "Renamed");
		click("presetImportConfirm");
		const message = send.mock.calls.at(-1)![0];
		expect(message.name).toBe("Renamed");
		render({
			presetImport: {
				...preview(message.requestId),
				dryRun: false,
				receivedAt: 2,
				applied: false,
				applyError: "failed",
			},
		});
		expect(host.textContent).toContain("presetImportSaved");
		expect(host.textContent).toContain("presetImportApplyFailed");
		expect(host.textContent).not.toContain("presetImportApplied");
	});
	it("installs missing plugins once, shows failure and retries without updating installed dependencies", () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const render = setup({
			initialTab: "import",
			plugins: [{ id: "installed", version: "2" }],
			disabledPlugins: ["installed"],
		});
		input("textarea", "{}");
		click("preview");
		const requestId = send.mock.calls.at(-1)![0].requestId;
		render({
			presetImport: preview(requestId, [
				{ id: "missing", source: "team/repo" },
				{ id: "installed", version: "1", source: "team/repo" },
			]),
		});
		expect(host.textContent).toContain("presetPluginsDisabled");
		expect(host.textContent).toContain("presetPluginsVersion");
		click("presetPluginsInstall");
		const message = send.mock.calls.at(-1)![0];
		expect(message).toMatchObject({ type: "plugin_job", action: "install", id: "missing", source: "team/repo" });
		expect(send.mock.calls.filter((c) => c[0].type === "plugin_job")).toHaveLength(1);
		render({
			pluginJobs: {
				[message.jobId]: {
					jobId: message.jobId,
					pluginId: "missing",
					phase: "done",
					ok: false,
					error: "network",
					lines: [],
				},
			},
		});
		expect(host.textContent).toContain("network");
		click("presetPluginsRetry");
		expect(send.mock.calls.filter((c) => c[0].type === "plugin_job")).toHaveLength(2);
		const retry = send.mock.calls.at(-1)![0];
		render({
			pluginJobs: { [retry.jobId]: { jobId: retry.jobId, pluginId: "missing", phase: "done", ok: true, lines: [] } },
		});
		expect(host.textContent).toContain("presetPluginsInstalledCode");
		click("presetPluginsInstall");
		expect(send.mock.calls.filter((c) => c[0].type === "plugin_job")).toHaveLength(2);
	});
	it("does not install when trust confirmation is declined", () => {
		vi.spyOn(window, "confirm").mockReturnValue(false);
		const render = setup({ initialTab: "import" });
		input("textarea", "{}");
		click("preview");
		const requestId = send.mock.calls.at(-1)![0].requestId;
		render({ presetImport: preview(requestId, [{ id: "missing", source: "team/repo" }]) });
		click("presetPluginsInstall");
		expect(send.mock.calls.filter((c) => c[0].type === "plugin_job")).toHaveLength(0);
	});
});
