import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicFile from "../../server/atomic-file.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSecrets, SETTINGS_SECRETS_KEY } from "../../server/plugin-secrets.js";
import { PluginStorage } from "../../server/plugin-facilities.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "plugin-secret-commit-"));
	dirs.push(dir);
	return { dir, a: new PluginSecrets(dir, dir), b: new PluginSecrets(dir, dir) };
}
describe("secret commit failures", () => {
	it("failed secret writes never change the file or cross-instance reads", () => {
		const { dir, a, b } = fixture();
		a.set("token", "old");
		const file = join(dir, "secrets.bin");
		const original = readFileSync(file, "utf8");
		const fail = vi.spyOn(atomicFile, "writeJsonAtomicSync").mockImplementation(() => {
			throw new Error("injected write failure");
		});
		try {
			expect(() => a.set("token", "new")).toThrow("injected write failure");
			expect(() => a.delete("token")).toThrow("injected write failure");
			expect(a.get("token")).toBe("old");
			expect(b.get("token")).toBe("old");
			expect(readFileSync(file, "utf8")).toBe(original);
		} finally {
			fail.mockRestore();
		}
	});
	it("reserved metadata is hidden and survives public storage mutation and clear", () => {
		const { dir, a } = fixture();
		a.commitSettings({ name: "old" }, { "setting:key": "value" });
		const storage = new PluginStorage(join(dir, "storage.json"));
		expect(storage.get(SETTINGS_SECRETS_KEY)).toBeUndefined();
		expect(storage.has(SETTINGS_SECRETS_KEY)).toBe(false);
		expect(storage.keys()).not.toContain(SETTINGS_SECRETS_KEY);
		expect(storage.all()).not.toHaveProperty(SETTINGS_SECRETS_KEY);
		expect(() => storage.set(SETTINGS_SECRETS_KEY, {})).toThrow();
		expect(() => storage.delete(SETTINGS_SECRETS_KEY)).toThrow();
		storage.set("other", 1);
		storage.clear(false);
		expect(a.get("setting:key")).toBe("value");
	});
	it("legacy values remain readable, migrated values survive a corrupt unrelated legacy file", () => {
		const { dir, a, b } = fixture();
		a.set("legacy", "old");
		const file = join(dir, "secrets.bin");
		const raw = JSON.parse(readFileSync(file, "utf8"));
		raw.items["setting:key"] = raw.items.legacy;
		writeFileSync(file, JSON.stringify(raw));
		expect(b.get("setting:key")).toBe("old");
		a.commitSettings({}, { "setting:key": "new" });
		writeFileSync(file, "broken");
		expect(b.get("setting:key")).toBe("new");
		expect(b.getAll()).toEqual({ "setting:key": "new" });
		a.commitSettings({}, {});
		expect(b.get("setting:key")).toBe("new");
	});
	it("failed set/delete throws and never publishes candidate values across instances", () => {
		const { dir, a, b } = fixture();
		a.set("token", "before");
		expect(b.get("token")).toBe("before");
		const file = join(dir, "secrets.bin");
		const old = readFileSync(file, "utf8");
		rmSync(file);
		mkdirSync(file);
		expect(() => a.set("token", "after")).toThrow();
		expect(() => a.delete("token")).toThrow();
		rmSync(file, { recursive: true });
		writeFileSync(file, old);
		expect(a.get("token")).toBe("before");
		expect(b.get("token")).toBe("before");
		a.delete("token");
		expect(b.get("token")).toBeUndefined();
	});
	it("a failed atomic replace retains committed settings and encrypted secrets", () => {
		const { dir, a, b } = fixture();
		a.commitSettings({ name: "old" }, { "setting:key": "old-secret" });
		const file = join(dir, "storage.json");
		const old = readFileSync(file, "utf8");
		expect(old).not.toContain("old-secret");
		rmSync(file);
		mkdirSync(file);
		expect(() => a.commitSettings({ name: "new" }, { "setting:key": "new-secret" })).toThrow();
		rmSync(file, { recursive: true });
		writeFileSync(file, old);
		expect(a.get("setting:key")).toBe("old-secret");
		expect(b.get("setting:key")).toBe("old-secret");
		a.delete("setting:key");
		expect(b.has("setting:key")).toBe(false);
	});
});
