import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpProjectRuntimeRegistry } from "../../server/mcp-project-runtime.js";
import type { PluginAgentTool } from "../../server/plugins.js";

const summary = { servers: 1, tools: 1, kept: 0, started: 1, stopped: 0, failed: 0 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "mcp-project-"));
	const a = join(dir, "a"),
		b = join(dir, "b"),
		agentDir = join(dir, "agent");
	for (const cwd of [a, b]) mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir);
	return { dir, a, b, agentDir };
}
function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("project-owned MCP runtimes", () => {
	it("isolates real bridges, applies shared global edits to all projects, and refreshes existing tool consumers", async () => {
		const { dir, a, b, agentDir } = setup();
		const fixture = resolve("tests/fixtures/mcp-echo-server.mjs");
		const spec = { command: process.execPath, args: [fixture] };
		const config = (cwd: string, servers: object) => writeFileSync(join(cwd, "mcp.json"), JSON.stringify({ servers }));
		config(join(a, ".pi"), { only_a: spec });
		config(join(b, ".pi"), { only_b: spec });
		const seen = new Map<string, string[]>();
		const registry = new McpProjectRuntimeRegistry({
			dataDir: dir,
			agentDir,
			onToolsChanged: (cwd) =>
				seen.set(
					cwd,
					registry.getTools(cwd).map((t) => t.label ?? ""),
				),
		});
		cleanups.push(async () => {
			await registry.dispose();
			rmSync(dir, { recursive: true, force: true });
		});
		const [ba, bb] = await Promise.all([registry.prepare(a), registry.prepare(b)]);
		expect(ba).not.toBe(bb);
		expect(registry.getBridge(join(a, "."))).toBe(ba);
		expect(registry.getTools(a).every((t) => (t.label ?? "").startsWith("only_a ·"))).toBe(true);
		expect(registry.getTools(a).length).toBeGreaterThan(0);
		expect(registry.getTools(b).every((t) => (t.label ?? "").startsWith("only_b ·"))).toBe(true);
		config(agentDir, { shared: spec });
		await registry.reload(a, "global");
		for (const cwd of [a, b]) expect(seen.get(cwd)?.some((n) => n.startsWith("shared ·"))).toBe(true);
		config(join(a, ".pi"), {});
		await registry.reload(a);
		expect(registry.getTools(a).some((t) => (t.label ?? "").startsWith("only_a ·"))).toBe(false);
		expect(registry.getTools(b).some((t) => (t.label ?? "").startsWith("only_b ·"))).toBe(true);
	}, 30000);

	it("reclaims only unreferenced idle projects, retaining conversations and in-flight creation leases", async () => {
		const { dir, a, b, agentDir } = setup();
		let now = 0;
		const used = new Set([a]);
		const bridges = new Map<
			string,
			{
				load: () => Promise<void>;
				reload: () => Promise<typeof summary>;
				dispose: ReturnType<typeof vi.fn>;
				getTools: () => [];
			}
		>();
		const registry = new McpProjectRuntimeRegistry({
			dataDir: dir,
			agentDir,
			now: () => now,
			idleTimeoutMs: 100,
			isProjectInUse: (cwd) => used.has(cwd),
			createBridge: (cwd) => {
				const bridge = { load: async () => {}, reload: async () => summary, dispose: vi.fn(), getTools: (): [] => [] };
				bridges.set(cwd, bridge);
				return bridge;
			},
		});
		cleanups.push(async () => {
			await registry.dispose();
			rmSync(dir, { recursive: true, force: true });
		});
		await registry.prepare(a);
		await registry.prepare(b);
		const release = registry.retain(b);
		now = 200;
		await registry.collectIdle();
		expect(bridges.get(a)!.dispose).not.toHaveBeenCalled();
		expect(bridges.get(b)!.dispose).not.toHaveBeenCalled();
		release();
		now = 250;
		await registry.collectIdle();
		expect(bridges.get(b)!.dispose).not.toHaveBeenCalled();
		now = 301;
		await registry.collectIdle();
		expect(bridges.get(b)!.dispose).toHaveBeenCalled();
		used.clear();
		await registry.collectIdle();
		expect(bridges.get(a)!.dispose).toHaveBeenCalled();
	});

	it("watcher-driven publication does not extend idle access even when consumers read tools", async () => {
		const { dir, a, agentDir } = setup();
		let now = 0;
		const bridge = { load: async () => {}, reload: vi.fn(async () => summary), dispose: vi.fn(), getTools: () => [] };
		const registry = new McpProjectRuntimeRegistry({
			dataDir: dir,
			agentDir,
			now: () => now,
			idleTimeoutMs: 100,
			isProjectInUse: () => false,
			createBridge: () => bridge,
			onToolsChanged: (cwd) => {
				registry.getTools(cwd);
				registry.getBridge(cwd);
			},
		});
		cleanups.push(async () => {
			await registry.dispose();
			rmSync(dir, { recursive: true, force: true });
		});
		await registry.prepare(a);
		now = 200;
		writeFileSync(join(a, ".pi", "mcp.json"), JSON.stringify({ servers: { changed: { command: "unused" } } }));
		await vi.waitFor(() => expect(bridge.reload).toHaveBeenCalled(), { timeout: 4000 });
		await registry.collectIdle();
		expect(bridge.dispose).toHaveBeenCalled();
	});

	it("deduplicates preparation and prevents stale initialization from publishing after eviction", async () => {
		const { dir, a, agentDir } = setup();
		const gate = deferred();
		const bridges: {
			load: ReturnType<typeof vi.fn>;
			reload: ReturnType<typeof vi.fn>;
			dispose: ReturnType<typeof vi.fn>;
			getTools: () => PluginAgentTool[];
		}[] = [];
		const changed = vi.fn();
		const registry = new McpProjectRuntimeRegistry({
			dataDir: dir,
			agentDir,
			onToolsChanged: changed,
			createBridge: (_cwd, notify) => {
				const bridge = {
					load: vi.fn(async () => {
						if (!bridges.indexOf(bridge)) await gate.promise;
						notify();
					}),
					reload: vi.fn(async () => summary),
					dispose: vi.fn(),
					getTools: () => [],
				};
				bridges.push(bridge);
				return bridge;
			},
		});
		cleanups.push(async () => {
			gate.release();
			await registry.dispose();
			rmSync(dir, { recursive: true, force: true });
		});
		const first = registry.prepare(a);
		const second = registry.prepare(a);
		const outcomes = Promise.allSettled([first, second]);
		await Promise.resolve();
		expect(bridges).toHaveLength(1);
		const disposing = registry.disposeProject(a);
		await registry.prepare(a);
		changed.mockClear();
		gate.release();
		await disposing;
		expect((await outcomes).every((r) => r.status === "rejected")).toBe(true);
		expect(changed).not.toHaveBeenCalled();
		expect(bridges[0].dispose).toHaveBeenCalled();
		expect(bridges[1].dispose).not.toHaveBeenCalled();
		await registry.dispose();
		await expect(registry.prepare(a)).rejects.toThrow("closed");
		expect(registry.getTools(a)).toEqual([]);
	});

	it("queues explicit reload behind initial load and catches configuration edits during preparation", async () => {
		const { dir, a, agentDir } = setup();
		const gate = deferred();
		const bridge = {
			load: vi.fn(() => gate.promise),
			reload: vi.fn(async () => summary),
			dispose: vi.fn(),
			getTools: () => [],
		};
		const registry = new McpProjectRuntimeRegistry({ dataDir: dir, agentDir, createBridge: () => bridge });
		cleanups.push(async () => {
			gate.release();
			await registry.dispose();
			rmSync(dir, { recursive: true, force: true });
		});
		const ready = registry.prepare(a);
		await Promise.resolve();
		writeFileSync(join(a, ".pi", "mcp.json"), JSON.stringify({ servers: { new_server: { command: "unused" } } }));
		const reloaded = registry.reload(a);
		await Promise.resolve();
		expect(bridge.reload).not.toHaveBeenCalled();
		gate.release();
		await Promise.all([ready, reloaded]);
		await vi.waitFor(() => expect(bridge.reload.mock.calls.length).toBeGreaterThanOrEqual(2));
	});

	it("shutdown waits for an in-flight reload and suppresses late publication", async () => {
		const { dir, a, agentDir } = setup();
		const gate = deferred();
		const changed = vi.fn();
		const bridge = {
			load: vi.fn(async () => {}),
			reload: vi.fn(async () => {
				await gate.promise;
				return summary;
			}),
			dispose: vi.fn(),
			getTools: () => [],
		};
		const registry = new McpProjectRuntimeRegistry({
			dataDir: dir,
			agentDir,
			onToolsChanged: changed,
			createBridge: () => bridge,
		});
		cleanups.push(async () => {
			gate.release();
			await registry.dispose();
			rmSync(dir, { recursive: true, force: true });
		});
		await registry.prepare(a);
		const reload = registry.reload(a);
		await vi.waitFor(() => expect(bridge.reload).toHaveBeenCalled());
		changed.mockClear();
		let done = false;
		const stopping = registry.dispose().then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		gate.release();
		await Promise.all([reload, stopping]);
		expect(changed).not.toHaveBeenCalled();
		expect(bridge.dispose).toHaveBeenCalled();
	});
});
