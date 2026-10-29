import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const faults = vi.hoisted(() => ({ command: false, sync: false, recovery: false }));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: (...args: any[]) => {
			if (!faults.command) return (actual.execFile as any)(...args);
			const callback = args.at(-1);
			if (faults.recovery) {
				const backup = args[2].env.PI_SAVE_BACKUP;
				void import("node:fs/promises").then(async (fs) => {
					await fs.writeFile(backup, "recovery");
					callback(new Error("Injected metadata failure"));
				});
			} else callback(new Error("Injected metadata failure"));
		},
	};
});
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (faults.sync)
				handle.sync = async () => {
					throw new Error("Injected fsync failure");
				};
			return handle;
		},
	};
});
import { saveFilePreservingMetadata } from "../../server/file-save.js";

const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-save-fault-"));
	roots.push(root);
	const dest = join(root, "a.txt");
	await writeFile(dest, "original");
	return { root, dest };
}
afterEach(async () => {
	faults.command = faults.sync = faults.recovery = false;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("save failure preservation", () => {
	it.each(["command", "sync"] as const)(
		"keeps original content and cleans only current staging on %s failure",
		async (fault) => {
			const { root, dest } = await fixture();
			const earlier = join(root, ".pi-save-earlier");
			await mkdir(earlier);
			await writeFile(join(earlier, "original"), "earlier recovery");
			faults[fault] = true;
			await expect(saveFilePreservingMetadata(dest, "replacement")).rejects.toThrow("Injected");
			expect(await readFile(dest, "utf8")).toBe("original");
			expect((await readdir(root)).sort()).toEqual([".pi-save-earlier", "a.txt"]);
			expect(await readFile(join(earlier, "original"), "utf8")).toBe("earlier recovery");
		},
	);
	it.skipIf(process.platform !== "win32")(
		"reports and retains native replacement recovery data on failure",
		async () => {
			const { root, dest } = await fixture();
			faults.command = faults.recovery = true;
			await expect(saveFilePreservingMetadata(dest, "replacement")).rejects.toThrow("recovery file retained at");
			const stage = (await readdir(root)).find((n) => n.startsWith(".pi-save-"))!;
			expect(await readFile(join(root, stage, "original"), "utf8")).toBe("recovery");
			expect(await readFile(dest, "utf8")).toBe("original");
			faults.command = faults.recovery = false;
			await saveFilePreservingMetadata(dest, "later save");
			expect(await readFile(join(root, stage, "original"), "utf8")).toBe("recovery");
		},
	);
});
