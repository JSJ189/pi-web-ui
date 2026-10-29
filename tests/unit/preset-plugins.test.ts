import { describe, expect, it } from "vitest";
import {
	clearsPresetField,
	pendingPresetPluginJob,
	presetPluginDependency,
	presetPluginStatus,
} from "../../web/src/preset-plugins";
import type { UiPluginCatalogEntry, UiPluginInfo } from "../../web/src/types";
import type { PluginJobState } from "../../web/src/use-chat";

describe("preset plugin dependencies", () => {
	it("projects metadata without secrets and normalizes portable sources", () => {
		const plugin = {
			id: "demo",
			name: "Demo",
			version: "1",
			source: "https://github.com/team/repo/plugins/demo#main",
			settingsValues: { secret: "token" },
		};
		expect(presetPluginDependency(plugin, [])).toEqual({
			id: "demo",
			name: "Demo",
			version: "1",
			source: "team/repo/plugins/demo#main",
		});
	});
	it("falls back to the catalog only when installed source is absent", () => {
		const catalog = [{ id: "demo", source: "team/repo" }] as UiPluginCatalogEntry[];
		expect(presetPluginDependency({ id: "demo" }, catalog)?.source).toBe("team/repo");
		for (const source of [
			"C:\\private",
			"/private/plugin",
			"file:///private",
			"https://user:secret@github.com/team/repo",
		]) {
			expect(presetPluginDependency({ id: "demo", source }, catalog)).toBeUndefined();
		}
	});
	it("keeps missing, disabled and version differences independent", () => {
		const installed = [{ id: "demo", version: "2" }] as UiPluginInfo[];
		expect(presetPluginStatus({ id: "demo", version: "1" }, installed, ["demo"])).toMatchObject({
			missing: false,
			disabled: true,
			versionMismatch: true,
		});
		expect(presetPluginStatus({ id: "other" }, installed)).toMatchObject({
			missing: true,
			disabled: false,
			versionMismatch: false,
		});
	});
	it("finds in-flight jobs across callers, without blocking retries of failed jobs", () => {
		const job = { pluginId: "demo", phase: "log" } as PluginJobState;
		expect(pendingPresetPluginJob("demo", { another: job })).toBe(job);
		expect(pendingPresetPluginJob("demo", { another: { ...job, phase: "done", ok: false } })).toBeUndefined();
	});
	it("flags empty collections as clears, including unrendered values", () => {
		expect(clearsPresetField([])).toBe(true);
		expect(clearsPresetField({})).toBe(true);
		for (const value of [undefined, null, false, "", ["a"], { a: 1 }]) expect(clearsPresetField(value)).toBe(false);
	});
});
