import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PluginManager } from "../../server/plugins.js";

it("captures each HTTP workspace across awaits without leaking other clients' roots", async () => {
	const dir = mkdtempSync(join(tmpdir(), "plugin-http-workspace-"));
	const mgr = new PluginManager(dir, dir);
	try {
		const pluginDir = join(dir, "plugins", "workspace");
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({ name: "workspace", permissions: ["http"] }));
		writeFileSync(
			join(pluginDir, "index.mjs"),
			`export default { activate(host) {
			host.route("GET", "/check", async (req, res) => {
				const before = host.cwd;
				await req.gate;
				let denied = false;
				try { host.resolveInWorkspace(req.other); } catch { denied = true; }
				res.json({ before, after: host.cwd, file: host.resolveInWorkspace("doc.pptx"), extra: host.resolveInWorkspace(req.extra), denied });
			});
		} };`,
		);
		await mgr.ensureLoaded();
		const a = join(dir, "a"),
			b = join(dir, "b"),
			extraA = join(dir, "extra-a"),
			extraB = join(dir, "extra-b");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		function request(cwd: string, extra: string, other: string) {
			return new Promise<any>((resolve) => {
				mgr.handleHttp("workspace", "GET", "/check", { gate, extra, other } as any, { json: resolve } as any, {
					cwd,
					roots: [extra],
				});
			});
		}
		const first = request(a, extraA, extraB);
		const second = request(b, extraB, extraA);
		mgr.notifyCwd(join(dir, "third"));
		release();
		const replies = await Promise.all([first, second]);
		for (const [i, cwd] of [a, b].entries()) {
			expect(replies[i]).toEqual({
				before: cwd,
				after: cwd,
				file: join(cwd, "doc.pptx"),
				extra: [extraA, extraB][i],
				denied: true,
			});
		}
		expect(mgr.isInsideWorkspace(join(dir, "third", "file"))).toBe(true);
		expect(mgr.isInsideWorkspace(join(a, "file"))).toBe(false);
	} finally {
		mgr.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
