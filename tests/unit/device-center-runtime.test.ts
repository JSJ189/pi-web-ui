import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import { createDeviceRuntime, type DeviceRuntimeWorkspaces } from "../../server/device-center/runtime.js";
import { createDeviceFileSync } from "../../server/device-center/file-sync.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-runtime-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const roots = [join(dir, "one"), join(dir, "two")];
	await Promise.all(roots.map((root) => mkdir(root)));
	const bindings = new Map(roots.map((root, i) => [`room${i}`, { root, revision: `rev${i}` }]));
	let held = 0;
	const workspaces: DeviceRuntimeWorkspaces = {
		get: (room) => bindings.get(room),
		async acquire(room) {
			const binding = bindings.get(room);
			if (!binding) throw new Error("Not bound");
			held++;
			return {
				...binding,
				release() {
					held--;
				},
			};
		},
	};
	const options = {
		config: { hubUrl: "http://127.0.0.1:8999", deviceId: "device", credential: "secret", allowExecution: true },
		localOrigin: "http://127.0.0.1:8989",
		dataDir: join(dir, "data"),
		workspaces,
	};
	return { dir, roots, bindings, options, held: () => held };
}
const task = (roomId: string, id = roomId) => ({ roomId, id, attemptId: `attempt-${id}`, text: "test" });
const signal = () => new AbortController().signal;

describe("room device runtime", () => {
	it("creates a room without an existing binding through the real service resolver path", async () => {
		const f = await fixture();
		const resolver = vi.fn().mockRejectedValue(new Error("No existing room binding"));
		const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "new-room" }), { status: 200 }));
		const service = createDeviceCollabService({
			getConfig: () => f.options.config,
			workspaceResolver: resolver,
			fetch: request,
		});
		expect(
			await service.execute("create_room", { name: "New group", targetDeviceId: "other" }, undefined, {
				cwd: f.roots[0],
				sessionId: "human",
			}),
		).toEqual({ id: "new-room" });
		expect(resolver).not.toHaveBeenCalled();
		expect(request).toHaveBeenCalledOnce();
		const denied = createDeviceCollabService({
			getConfig: () => ({ ...f.options.config, allowExecution: false }),
			workspaceResolver: resolver,
			fetch: request,
		});
		await expect(
			denied.execute("create_room", { name: "New group", targetDeviceId: "other" }, undefined, { cwd: f.roots[0] }),
		).rejects.toThrow("request failed");
		await expect(
			service.execute("create_room", { name: "New group", targetDeviceId: "other" }, undefined),
		).rejects.toThrow("request failed");
		expect(request).toHaveBeenCalledOnce();
	});
	it("creates each task executor in its explicit room root without restarting", async () => {
		const f = await fixture();
		const cwds: string[] = [];
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory(options) {
				cwds.push(options.cwd);
				return {
					async run() {
						return options.cwd;
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());
		await expect(runtime.onTask(task("missing"))).rejects.toThrow("配置项目");
		expect(await runtime.onTask(task("room0"))).toBe(f.roots[0]);
		expect(await runtime.onTask(task("room1"))).toBe(f.roots[1]);
		expect(cwds).toEqual(f.roots);
		expect(f.held()).toBe(0);
	});

	it("routes identical paths to separate roots, rejects cross-room IDs and invalidates changed bindings", async () => {
		const f = await fixture();
		const sourceRoot = join(f.dir, "source");
		await mkdir(sourceRoot);
		await writeFile(join(sourceRoot, "same.txt"), "payload");
		const source = createDeviceFileSync({ root: sourceRoot, dataDir: f.options.dataDir, allowReceive: true });
		cleanups.push(() => source.close());
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(() => runtime.close());
		const bundle = await source.prepare({ paths: ["same.txt"] });
		const stage = async (roomId: string) =>
			runtime.onCommand("transfer_stage", { roomId, bundle }, signal()) as Promise<{ id: string; revision: string }>;
		const first = await stage("room0");
		expect(first.id).toBeTruthy();
		expect(f.held()).toBe(0);
		await expect(
			runtime.onCommand("transfer_preview", { roomId: "room1", transferId: first.id }, signal()),
		).rejects.toThrow("unavailable");
		await expect(runtime.onCommand("transfer_preview", { transferId: first.id }, signal())).rejects.toThrow(
			"Room required",
		);
		for (const roomId of ["room0", "room1"]) {
			const staged = roomId === "room0" ? first : await stage(roomId);
			await runtime.onCommand(
				"transfer_apply",
				{ roomId, transferId: staged.id, revision: staged.revision, overwritePaths: [] },
				signal(),
			);
		}
		expect(await Promise.all(f.roots.map((root) => readFile(join(root, "same.txt"), "utf8")))).toEqual([
			"payload",
			"payload",
		]);
		const stale = await stage("room0");
		f.bindings.set("room0", { root: f.roots[1], revision: "replacement" });
		await expect(
			runtime.onCommand(
				"transfer_apply",
				{ roomId: "room0", transferId: stale.id, revision: stale.revision, overwritePaths: ["same.txt"] },
				signal(),
			),
		).rejects.toThrow("unavailable");
	});

	it("keeps the device busy and its lease until cancelled execution actually settles", async () => {
		const f = await fixture();
		let settle!: (value: string) => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let closes = 0;
		let runs = 0;
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory() {
				return {
					run() {
						if (++runs > 1) return Promise.resolve("new task");
						started();
						return new Promise((resolve) => {
							settle = resolve;
						});
					},
					close() {
						closes++;
					},
				};
			},
		});
		cleanups.push(() => runtime.close());
		const first = runtime.onTask(task("room0"));
		const rejected = expect(first).rejects.toThrow();
		await running;
		const disconnected = runtime.onDisconnect();
		await Promise.resolve();
		expect(closes).toBe(1);
		expect(f.held()).toBe(1);
		await expect(runtime.onTask(task("room1"))).rejects.toThrow("busy");
		settle("old completion");
		await rejected;
		await disconnected;
		expect(f.held()).toBe(0);
		expect(await runtime.onTask(task("room1"))).toBe("new task");
	});

	it("retains the lease and blocks new tasks when executor stop is uncertain", async () => {
		const f = await fixture();
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory() {
				return {
					async run() {
						return "done";
					},
					async close() {
						throw new Error("stop uncertain");
					},
				};
			},
		});
		await expect(runtime.onTask(task("room0"))).rejects.toThrow("stop uncertain");
		expect(f.held()).toBe(1);
		await expect(runtime.onTask(task("room1"))).rejects.toThrow("blocked");
		await expect(runtime.onDisconnect()).rejects.toThrow("stop uncertain");
		await expect(runtime.close()).rejects.toThrow("stop uncertain");
	});

	it("requires a matching task session for send_task and explicit execution permission for commands", async () => {
		const f = await fixture();
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(() => runtime.close());
		await expect(
			runtime.collabService.execute(
				"send_task",
				{ roomId: "room0", targetDeviceId: "other", prompt: "run" },
				undefined,
				{ cwd: f.roots[0], sessionId: "human" },
			),
		).rejects.toThrow("not bound");
		await expect(
			runtime.collabService.execute(
				"sync_files",
				{ roomId: "room1", targetDeviceId: "other", paths: ["file"] },
				undefined,
				{ cwd: f.roots[0], sessionId: "human" },
			),
		).rejects.toThrow("request failed");
		const denied = createDeviceRuntime({ ...f.options, config: { ...f.options.config, allowExecution: false } });
		cleanups.push(() => denied.close());
		await expect(
			denied.onCommand("transfer_preview", { roomId: "room0", transferId: "any" }, signal()),
		).rejects.toThrow("disabled");
	});
});
