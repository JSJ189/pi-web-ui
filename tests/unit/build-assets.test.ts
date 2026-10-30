import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { retainBuildAssets } from "../../web/build-assets";

describe("build asset retention", () => {
	it("keeps the previous lazy chunk and prunes generations older than that", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-web-assets-"));
		const outDir = join(root, "dist");
		try {
			writeFileSync(join(root, "index.html"), '<script type="module" src="/entry.js"></script>');
			writeFileSync(join(root, "entry.js"), 'window.openPanel = () => import("./panel.js");');
			const generations: string[][] = [];
			for (let generation = 0; generation < 3; generation++) {
				writeFileSync(join(root, "panel.js"), `export const value = ${generation};`);
				await build({
					root,
					configFile: false,
					logLevel: "silent",
					plugins: [retainBuildAssets(outDir)],
					build: { outDir, emptyOutDir: false },
				});
				generations.push(JSON.parse(readFileSync(join(outDir, ".build-assets.json"), "utf8")));
				if (generation > 0) {
					for (const asset of generations[generation - 1]) expect(existsSync(join(outDir, "assets", asset))).toBe(true);
				}
			}
			const retained = new Set([...generations[1], ...generations[2]]);
			expect(new Set(readdirSync(join(outDir, "assets")))).toEqual(retained);
			expect(generations[0].some((asset) => !retained.has(asset))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
