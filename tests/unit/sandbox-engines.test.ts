import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SandboxManager } from "../../server/sandbox-service.js";
import { assertEngineWorkspaceSupported } from "../../server/sandbox-engines.js";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import { DshRuntime } from "../../server/dsh/dsh-client.js";
import { UniversalSession } from "../../server/universal/universal-session.js";

describe("sandbox engine admission and execution", () => {
	let root: string, manager: SandboxManager, sandboxPath: string;
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "sandbox-engines-"));
		manager = new SandboxManager(root);
		sandboxPath = (await manager.create({})).sandbox.path;
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each(["dsh", "claude", "codex", "durable", "mock"])(
		"rejects %s in managed sandboxes but permits normal projects",
		(engine) => {
			expect(() => assertEngineWorkspaceSupported(manager, root, engine)).not.toThrow();
			expect(() => assertEngineWorkspaceSupported(manager, sandboxPath, engine)).toThrow("does not support");
			expect(() => assertEngineWorkspaceSupported(manager, join(sandboxPath, "nested"), engine)).toThrow();
		},
	);

	it("does not downgrade unknown or missing managed identity to a normal project", () => {
		const orphan = join(root, "sandboxes", "orphan");
		mkdirSync(orphan);
		expect(() => assertEngineWorkspaceSupported(manager, orphan, "dsh")).toThrow();
		rmSync(join(root, "sandboxes", "registry.json"));
		expect(() => assertEngineWorkspaceSupported(manager, sandboxPath, "claude")).toThrow();
	});

	it.each(["claude", "codex", "durable"])(
		"rejects %s attachment in a sandbox before driver initialization",
		(engine) => {
			expect(
				() =>
					new UniversalSession({
						clientId: "test",
						cwd: sandboxPath,
						dataDir: root,
						engine,
						send: vi.fn(),
						store: {} as any,
						driver: { id: engine } as any,
						driverFactory: vi.fn(),
					}),
			).toThrow("does not support");
		},
	);

	it("blocks universal prompt, restore, cwd switching and subagent execution before driver calls", async () => {
		const driver = { resumeSession: vi.fn(), setCwd: vi.fn(), sendPrompt: vi.fn() };
		const session = Object.assign(Object.create(UniversalSession.prototype), {
			sandboxes: manager,
			cwd: sandboxPath,
			engine: "claude",
			activeConvId: "active",
			conversations: new Map([["active", { id: "active" }]]),
			driver,
		});
		await expect(session.prompt("run")).rejects.toThrow("does not support");
		await expect(session.switchConversation("old")).rejects.toThrow("does not support");
		await expect(session.spawnSubagent("run", "general", sandboxPath)).rejects.toThrow("does not support");
		session.cwd = root;
		await expect(session.setCwd(sandboxPath)).rejects.toThrow("does not support");
		expect(session.cwd).toBe(root);
		for (const fn of Object.values(driver)) expect(fn).not.toHaveBeenCalled();
	});

	it("DSH workspace and history restore reject before runtime admission", async () => {
		const runtime = { restart: vi.fn() };
		const session = Object.assign(Object.create(DshClientSession.prototype), {
			sandboxes: manager,
			cwd: sandboxPath,
			runtime,
			convs: new Map(),
		});
		await expect(session.setCwd(sandboxPath)).rejects.toThrow("does not support");
		await expect(session.switchSession("old")).rejects.toThrow("does not support");
		await expect(session.switchConversation("old")).rejects.toThrow("does not support");
		expect(runtime.restart).not.toHaveBeenCalled();
	});

	it("DSH start admission runs before spawning, including restart", async () => {
		const runtime = new DshRuntime({
			cwd: sandboxPath,
			beforeStart: (cwd) => assertEngineWorkspaceSupported(manager, cwd, "dsh"),
		});
		expect(() => runtime.start()).toThrow("does not support");
		await expect(runtime.restart()).rejects.toThrow("does not support");
		expect(runtime.alive).toBe(false);
	});

	function bridge(cwd: string, execute = vi.fn().mockResolvedValue("ok")) {
		const runtime = { cwd, toolsCallResult: vi.fn().mockResolvedValue(undefined) };
		const session = Object.assign(Object.create(DshClientSession.prototype), {
			sandboxes: manager,
			runtime,
			bridgeCancellation: new AbortController(),
			getLang: () => "en",
			pluginToolsProvider: () => [{ name: "write", description: "write", parameters: {}, execute }],
		});
		return { session, execute, runtime };
	}

	it("DSH plugin bridge refuses out-of-jail writes and unknown managed identities before execute", async () => {
		const { session, execute, runtime } = bridge(sandboxPath);
		await session.handleToolCallRequest({
			id: "one",
			name: "write",
			args: { path: join(root, "outside"), content: "bad" },
		});
		expect(execute).not.toHaveBeenCalled();
		expect(runtime.toolsCallResult).toHaveBeenLastCalledWith("one", expect.any(String), true);
		rmSync(join(root, "sandboxes", "registry.json"));
		await session.handleToolCallRequest({ id: "two", name: "write", args: { path: "inside" } });
		expect(execute).not.toHaveBeenCalled();
	});

	it("DSH cancellation reaches the running plugin and prevents a late success response", async () => {
		let signal!: AbortSignal;
		let finish!: (v: string) => void;
		const execute = vi.fn((_id, _args, received) => {
			signal = received;
			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		});
		const { session, runtime } = bridge(root, execute);
		const running = session.handleToolCallRequest({ id: "one", name: "write", args: { path: "a" } });
		expect(execute).toHaveBeenCalledOnce();
		session.cancelBridgedTools();
		expect(signal.aborted).toBe(true);
		finish("late");
		await running;
		expect(runtime.toolsCallResult).not.toHaveBeenCalled();
	});

	it("DSH refuses a plugin impersonating a trusted file tool even for an inside path", async () => {
		const { session, execute, runtime } = bridge(sandboxPath);
		await session.handleToolCallRequest({ id: "one", name: "write", args: { path: join(sandboxPath, "inside") } });
		expect(execute).not.toHaveBeenCalled();
		expect(runtime.toolsCallResult).toHaveBeenLastCalledWith("one", expect.stringContaining("Untrusted"), true);
		await expect(manager.reset(sandboxPath)).resolves.toBeDefined();
	});

	it.each([DshClientSession, UniversalSession])(
		"reset fails while another owner holds an execution lease",
		async (Session) => {
			const send = vi.fn();
			const session = Object.assign(Object.create(Session.prototype), {
				sandboxes: manager,
				cwd: root,
				emit: send,
				emitNotice: send,
				engine: "claude",
			});
			const release = manager.acquireExecution(sandboxPath);
			try {
				await session.resetSandbox(sandboxPath);
				expect(send).toHaveBeenCalled();
				expect(JSON.stringify(send.mock.calls)).toContain("stop execution before mutation");
			} finally {
				release();
			}
		},
	);
});
