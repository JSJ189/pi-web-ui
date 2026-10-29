import { describe, expect, it } from "vitest";
import { normalizePresetPlugins, portablePresetPluginSource } from "../../server/preset-plugin-dependencies.js";
import {
	buildShareDoc,
	exportPresetVia,
	importPresetVia,
	parseShareDoc,
	type PresetSharePort,
} from "../../server/preset-share.js";
import type { SettingsPreset } from "../../server/client-state.js";
import type { ServerMessage } from "../../server/protocol.js";

function setup(applyPreset: PresetSharePort["applyPreset"] = async () => {}) {
	const saved: SettingsPreset[] = [];
	const sent: ServerMessage[] = [];
	const port: PresetSharePort = {
		lang: () => "en",
		appVersion: () => "test",
		presets: () => saved,
		currentSettings: () => ({ promptTemplate: "{{tools}}", secret: "must-not-export" }),
		upsertPreset: (preset) => {
			saved.push(preset);
		},
		applyPreset,
		pushSettings: () => {},
		emit: (message) => {
			sent.push(message);
		},
	};
	return { port, saved, sent };
}
const plugins = [{ id: "notes", source: "owner/repo/plugins/notes#v1", version: "1.0.0", name: "Notes" }];
const json = () => JSON.stringify(buildShareDoc("A", { promptTemplate: "{{tools}}" }, { plugins }));

describe("portable preset plugin requirements", () => {
	it("keeps portable GitHub sources and refuses local paths, credentials and unsupported URLs", () => {
		expect(portablePresetPluginSource("https://github.com/owner/repo/plugins/notes#main")).toBe(
			"owner/repo/plugins/notes#main",
		);
		for (const value of [
			"C:/private/plugin",
			"/home/user/plugin",
			"../plugin",
			"https://user:secret@github.com/a/b",
			"https://example.com/a/b",
			"a/b/../c",
			"a/b#../main",
			"a/b?token=secret",
			"a/b#main#other",
			"a/b\nflag",
		]) {
			expect(portablePresetPluginSource(value)).toBeUndefined();
		}
	});
	it("allowlists metadata, deduplicates and bounds entries without exporting credentials", () => {
		const result = normalizePresetPlugins([
			{ ...plugins[0], settingsValues: { token: "secret" }, permissions: ["fs"] },
			plugins[0],
			{ id: "../../bad" },
			{ id: "local", source: "C:/private/plugin" },
		]);
		expect(result).toEqual([plugins[0], { id: "local" }]);
		expect(normalizePresetPlugins(Array.from({ length: 50 }, (_, i) => ({ id: `p${i}` })))).toHaveLength(32);
	});
	it("previews dependencies without saving or running an installation", async () => {
		const { port, saved, sent } = setup();
		await importPresetVia(port, { type: "preset_import", json: json(), dryRun: true });
		expect(saved).toEqual([]);
		expect(sent[0]).toMatchObject({ type: "preset_import_result", ok: true, preview: { plugins } });
	});
	it("preserves dependencies across save and re-export while allowlisting settings", async () => {
		const { port, saved, sent } = setup();
		await importPresetVia(port, { type: "preset_import", json: json(), name: "Renamed" });
		expect(saved[0]).toMatchObject({ name: "Renamed", plugins });
		exportPresetVia(port, { type: "preset_export", name: "Renamed" });
		const exported = sent.find((m) => m.type === "preset_export_result");
		if (exported?.type !== "preset_export_result") throw new Error("Missing export");
		const doc = JSON.parse(exported.json!);
		expect(doc.plugins).toEqual(plugins);
		expect(doc.settings).not.toHaveProperty("plugins");
		exportPresetVia(port, { type: "preset_export", source: "current", plugins });
		const current = sent.at(-1);
		if (current?.type !== "preset_export_result") throw new Error("Missing export");
		expect(JSON.parse(current.json!).settings).not.toHaveProperty("secret");
	});
	it("reports saved-but-not-applied when applying throws, after preserving the preset", async () => {
		const { port, saved, sent } = setup(async () => {
			throw new Error("runtime reload failed");
		});
		await importPresetVia(port, { type: "preset_import", json: json(), apply: true });
		expect(saved).toHaveLength(1);
		expect(sent.find((m) => m.type === "preset_import_result")).toMatchObject({
			ok: true,
			applied: false,
			applyError: "runtime reload failed",
		});
	});
	it("waits for application before acknowledging completion", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { port, sent } = setup(() => waiting);
		const pending = importPresetVia(port, { type: "preset_import", json: json(), apply: true });
		expect(sent.some((m) => m.type === "preset_import_result")).toBe(false);
		release();
		await pending;
		expect(sent[0]).toMatchObject({ type: "preset_import_result", ok: true, applied: true });
	});
	it("reports persistence failures without applying or claiming a saved preset", async () => {
		let applied = false;
		const { port, sent } = setup(async () => {
			applied = true;
		});
		port.upsertPreset = () => {
			throw new Error("disk full");
		};
		await importPresetVia(port, { type: "preset_import", json: json(), apply: true });
		expect(sent[0]).toMatchObject({ type: "preset_import_result", ok: false, error: "disk full" });
		expect(applied).toBe(false);
	});

	it("reports deferred runtime application without claiming it is already active", async () => {
		const { port, sent } = setup();
		port.isApplyPending = () => true;
		await importPresetVia(port, { type: "preset_import", json: json(), apply: true });
		expect(sent[0]).toMatchObject({ type: "preset_import_result", ok: true, applied: false, applyDeferred: true });
	});

	it("explicit empty requirements remove inherited dependencies on export", () => {
		const { port, saved, sent } = setup();
		saved.push({ name: "A", promptTemplate: "x", plugins });
		exportPresetVia(port, { type: "preset_export", name: "A", plugins: [] });
		const msg = sent[0];
		if (msg.type !== "preset_export_result") throw new Error("Missing export");
		expect(JSON.parse(msg.json!)).not.toHaveProperty("plugins");
		expect(parseShareDoc(json()).ok).toBe(true);
	});
});
