import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientStateStore } from "../../server/client-state.js";
import { sanitizePresetSettings } from "../../server/preset-share.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";

const roots: string[] = [];
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pi-question-settings-"));
	roots.push(dir);
	const store = new ClientStateStore(join(dir, "client-state.json"));
	const host = {
		clientId: "question-settings",
		stateStore: store,
		emit: () => {},
		flushSnapshot: () => {},
		isDisposed: () => false,
		getSession: () => {
			throw new Error("no session");
		},
		cwd: () => dir,
		agentDir: () => dir,
		isStreaming: () => false,
		reloadSession: async () => {},
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
	} as unknown as SettingsHost;
	return { store, host, service: new SettingsService(host, { list: () => [] } as unknown as SubagentTemplatesStore) };
}
describe("question queue settings", () => {
	it("defaults to current-conversation popups and a four-minute child deadline", () => {
		const { service } = setup();
		expect(service.current.questionPresentation).toBe("queue");
		expect(service.current.toolApprovalPresentation).toBe("all");
		expect(service.current.questionTimeoutSeconds).toBe(240);
	});
	it("persists manual mode and explicit unlimited waiting", async () => {
		const { service, host } = setup();
		await service.set({ questionPresentation: "manual", questionTimeoutSeconds: 0 });
		const restored = new SettingsService(host, { list: () => [] } as unknown as SubagentTemplatesStore);
		expect(restored.current.questionPresentation).toBe("manual");
		expect(restored.current.questionTimeoutSeconds).toBe(0);
	});
	it("persists approval reminders independently and rejects invalid modes", async () => {
		const { service, host } = setup();
		for (const mode of ["queue", "manual", "all"] as const) {
			await service.set({ toolApprovalPresentation: mode, questionPresentation: "manual" });
			const restored = new SettingsService(host, { list: () => [] } as unknown as SubagentTemplatesStore);
			expect(restored.current.toolApprovalPresentation).toBe(mode);
			expect(restored.current.questionPresentation).toBe("manual");
		}
		await expect(service.set({ toolApprovalPresentation: "invalid" as any })).rejects.toThrow();
		expect(service.current.toolApprovalPresentation).toBe("all");
	});
	it("rejects invalid deadlines without changing the current setting", async () => {
		const { service } = setup();
		for (const n of [-1, NaN, Infinity, 1.5, 86401])
			await expect(service.set({ questionTimeoutSeconds: n })).rejects.toThrow();
		expect(service.current.questionTimeoutSeconds).toBe(240);
	});
	it("validates imported queue preferences and preserves omitted fields", () => {
		expect(sanitizePresetSettings({ questionPresentation: "all", questionTimeoutSeconds: 0 }).settings).toMatchObject({
			questionPresentation: "all",
			questionTimeoutSeconds: 0,
		});
		for (const value of [-1, 1.5, 86401, "240"])
			expect(sanitizePresetSettings({ questionTimeoutSeconds: value }).rejected).toContain("questionTimeoutSeconds");
		expect(sanitizePresetSettings({ questionPresentation: "surprise" }).rejected).toContain("questionPresentation");
		expect(sanitizePresetSettings({}).settings).not.toHaveProperty("questionTimeoutSeconds");
		for (const mode of ["queue", "all", "manual"])
			expect(sanitizePresetSettings({ toolApprovalPresentation: mode }).settings.toolApprovalPresentation).toBe(mode);
		expect(sanitizePresetSettings({ toolApprovalPresentation: "invalid" }).rejected).toContain(
			"toolApprovalPresentation",
		);
		expect(sanitizePresetSettings({}).settings).not.toHaveProperty("toolApprovalPresentation");
	});
});
