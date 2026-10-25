import { describe, expect, it } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

describe("插件宿主平台原语单测 (PluginHost Primitives)", () => {
	it("resolveInWorkspace() 正确放行工作区内路径并拦截跨界访问（抛出 403）", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-test-host-primitives-"));
		try {
			const host = createMockHost({ cwd: tempDir });

			// 1. 工作区内合法路径与根路径
			const validRel = "src/index.ts";
			const validAbs = host.resolveInWorkspace(validRel);
			expect(validAbs).toBe(resolve(tempDir, validRel));

			const rootAbs = host.resolveInWorkspace(".");
			expect(rootAbs).toBe(resolve(tempDir));

			// 2. 路径遍历逃逸（如 ../../secret）必须抛出 403 异常
			expect(() => {
				host.resolveInWorkspace("../../secret.txt");
			}).toThrowError(/工作区/);

			try {
				host.resolveInWorkspace("../../secret.txt");
				expect.unreachable();
			} catch (err: any) {
				expect(err.statusCode).toBe(403);
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("真实 PluginManager 宿主：resolveInWorkspace 支持多根工作区且越界 403", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-real-host-test-"));
		const extraRoot = join(tempDir, "extra-root");
		mkdirSync(extraRoot, { recursive: true });

		let capturedHost: PluginHost | null = null;
		const pdir = join(tempDir, "plugins", "test-jail");
		mkdirSync(pdir, { recursive: true });
		writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: "test-jail" }));
		writeFileSync(join(pdir, "index.mjs"), `export default { activate(h) { globalThis.__testHost = h; } };`);

		const mgr = new PluginManager(tempDir, tempDir);
		try {
			// 注入多根工作区
			mgr.notifyWorkspaceRoots([extraRoot]);
			await mgr.ensureLoaded();
			capturedHost = (globalThis as any).__testHost;
			expect(capturedHost).toBeDefined();

			// 主工作区路径
			const mainFile = capturedHost!.resolveInWorkspace("hello.txt");
			expect(mainFile).toBe(resolve(tempDir, "hello.txt"));

			// 额外根工作区路径（多根工作区原生支持）
			const extraFile = capturedHost!.resolveInWorkspace(join(extraRoot, "extra.txt"));
			expect(extraFile).toBe(resolve(extraRoot, "extra.txt"));

			// 越界路径抛 403
			expect(() => {
				capturedHost!.resolveInWorkspace(resolve(tempDir, "../escape.txt"));
			}).toThrowError(/工作区/);

			try {
				capturedHost!.resolveInWorkspace(resolve(tempDir, "../escape.txt"));
				expect.unreachable();
			} catch (e: any) {
				expect(e.statusCode).toBe(403);
			}
		} finally {
			delete (globalThis as any).__testHost;
			mgr.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("host.fetch() 记录调用并正常发起请求", async () => {
		const host = createMockHost();
		let called = false;
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async (url: any) => {
				called = true;
				return new Response(JSON.stringify({ ok: true }));
			}) as any;

			const res = await host.fetch("https://example.com/api");
			expect(called).toBe(true);
			expect(res.ok).toBe(true);
			expect(host.calls.some((c) => c.method === "fetch")).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
