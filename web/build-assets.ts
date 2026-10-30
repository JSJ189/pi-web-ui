import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** Keep one previous generation so open pages can still import their lazy chunks. */
export function retainBuildAssets(outDir: string): Plugin {
	const assetsDir = join(outDir, "assets");
	const manifest = join(outDir, ".build-assets.json");
	let previous: string[] = [];
	let current: string[] = [];
	return {
		name: "retain-build-assets",
		apply: "build",
		buildStart() {
			// Older installations have no manifest: retain their existing assets once.
			previous = existsSync(manifest)
				? (JSON.parse(readFileSync(manifest, "utf8")) as string[])
				: existsSync(assetsDir)
					? readdirSync(assetsDir)
					: [];
		},
		generateBundle(_options, bundle) {
			current = Object.keys(bundle)
				.filter((name) => name.startsWith("assets/"))
				.map((name) => name.slice(7));
		},
		writeBundle() {
			const keep = new Set([...previous, ...current]);
			for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
				if (entry.isFile() && !keep.has(entry.name)) unlinkSync(join(assetsDir, entry.name));
			}
			writeFileSync(manifest, JSON.stringify(current));
		},
	};
}
