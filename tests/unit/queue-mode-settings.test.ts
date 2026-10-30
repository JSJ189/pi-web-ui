import { afterEach, describe, expect, it, vi } from "vitest";
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
	const dir = mkdtempSync(join(tmpdir(), "pi-queue-modes-"));
	roots.push(dir);
	const path = join(dir, "client-state.json");
	const store = new ClientStateStore(path);
	const host = {
		clientId: "queue-modes",
		stateStore: store,
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		isDisposed: () => false,
		getSession: () => {
			throw new Error("no session");
		},
		cwd: () => dir,
		agentDir: () => dir,
		isStreaming: () => false,
		reloadSession: vi.fn(),
		applyRetryOverrides: vi.fn(),
		applyQueueModes: vi.fn(),
		applyCompactionOverrides: vi.fn(),
		applyToolGating: vi.fn(),
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
	} as unknown as SettingsHost;
	const service = new SettingsService(host, { list: () => [] } as unknown as SubagentTemplatesStore);
	return { path, store, host, service };
}

describe("message queue mode settings", () => {
	it("defaults both modes to all and persists independent updates across a disk reload", async () => {
		const { path, host, service } = setup();
		expect(service.current).toMatchObject({ steeringMode: "all", followUpMode: "all" });
		await service.set({ steeringMode: "one-at-a-time" });
		expect(host.applyQueueModes).toHaveBeenCalledTimes(1);
		expect(new ClientStateStore(path).getSettings("other-client")).toMatchObject({
			steeringMode: "one-at-a-time",
			followUpMode: "all",
		});
		await service.set({ followUpMode: "one-at-a-time" });
		await service.set({ steeringMode: "all" });
		expect(new ClientStateStore(path).getSettings("other-client")).toMatchObject({
			steeringMode: "all",
			followUpMode: "one-at-a-time",
		});
	});
	it("rejects invalid wire updates atomically without replaying runtime modes", async () => {
		const { service, host } = setup();
		for (const value of ["one", "", null, 1, true]) {
			await expect(service.set({ steeringMode: "one-at-a-time", followUpMode: value } as any)).rejects.toThrow(
				"Invalid followUpMode",
			);
		}
		expect(service.current).toMatchObject({ steeringMode: "all", followUpMode: "all" });
		expect(host.applyQueueModes).not.toHaveBeenCalled();
	});
	it("normalizes malformed persisted settings and leaves omitted preset fields absent", () => {
		const { path, store } = setup();
		store.saveSettings("queue-modes", { steeringMode: "bad", followUpMode: false } as any);
		expect(new ClientStateStore(path).getSettings("queue-modes")).toMatchObject({
			steeringMode: "all",
			followUpMode: "all",
		});
		store.savePresets("queue-modes", [{ name: "partial", steeringMode: "one-at-a-time" }]);
		const [preset] = new ClientStateStore(path).getPresets("queue-modes");
		expect(preset.steeringMode).toBe("one-at-a-time");
		expect(preset).not.toHaveProperty("followUpMode");
	});
	it("strictly validates portable presets without filling absent queue fields", () => {
		expect(sanitizePresetSettings({ steeringMode: "all", followUpMode: "one-at-a-time" }).settings).toMatchObject({
			steeringMode: "all",
			followUpMode: "one-at-a-time",
		});
		for (const value of ["one", "", null, 1, true]) {
			expect(sanitizePresetSettings({ steeringMode: value, followUpMode: value }).rejected).toEqual(
				expect.arrayContaining(["steeringMode", "followUpMode"]),
			);
		}
		expect(sanitizePresetSettings({}).settings).not.toHaveProperty("steeringMode");
		expect(sanitizePresetSettings({ steeringMode: "all" }).settings).not.toHaveProperty("followUpMode");
	});
	it("replays queue modes when another client changes shared settings", async () => {
		const { service, host, store } = setup();
		service.subscribeSharedSettings();
		store.saveSettings("another-client", { followUpMode: "one-at-a-time" });
		await vi.waitFor(() => expect(host.applyQueueModes).toHaveBeenCalledTimes(1));
		expect(service.current.followUpMode).toBe("one-at-a-time");
		service.dispose();
	});
});
