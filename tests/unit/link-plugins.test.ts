import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkPlugin, unlinkPlugin } from "../../scripts/link-plugins.mjs";

describe("scripts/link-plugins", () => {
	let testDir: string;
	let repoDir: string;
	let targetDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-link-test-"));
		repoDir = join(testDir, "repo-plugins");
		targetDir = join(testDir, "user-plugins");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(targetDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("links plugin from repoDir to targetDir and preserves source", () => {
		const pluginSrc = join(repoDir, "my-plugin");
		mkdirSync(pluginSrc);
		writeFileSync(join(pluginSrc, "manifest.json"), JSON.stringify({ id: "my-plugin", version: "1.0.0" }));

		// Link
		const ok = linkPlugin("my-plugin", { repoDir, targetDir });
		expect(ok).toBe(true);

		const dest = join(targetDir, "my-plugin");
		expect(existsSync(dest)).toBe(true);
		expect(lstatSync(dest).isSymbolicLink()).toBe(true);

		// Read through link
		const readManifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
		expect(readManifest.version).toBe("1.0.0");

		// Modify source and verify immediate reflection
		writeFileSync(join(pluginSrc, "manifest.json"), JSON.stringify({ id: "my-plugin", version: "1.0.1" }));
		const updated = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
		expect(updated.version).toBe("1.0.1");

		// Unlink
		const unlinked = unlinkPlugin("my-plugin", { repoDir, targetDir });
		expect(unlinked).toBe(true);
		expect(lstatSync(dest).isSymbolicLink()).toBe(false);
	});
});
