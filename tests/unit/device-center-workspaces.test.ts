import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import express from "express";
import { createServer, type Server } from "node:http";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { createDeviceWorkspaces } from "../../server/device-center/workspaces.js";

const cleanup: string[] = [];
const close: (() => Promise<void>)[] = [];
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	close.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
	for (const fn of close.splice(0).reverse()) await fn();
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(scope = "hub-a/device-a") {
	const base = await mkdtemp(join(tmpdir(), "device-workspaces-"));
	cleanup.push(base);
	const dataDir = join(base, "data");
	const root = join(base, "project");
	const other = join(base, "other");
	await mkdir(root);
	await mkdir(other);
	const options = { dataDir, defaultRoot: root, scope };
	const registry = await createDeviceWorkspaces(options);
	return {
		base,
		root,
		other,
		options,
		registry,
		file: join(dataDir, "device-workspaces", `${createHash("sha256").update(scope).digest("hex")}.json`),
	};
}
describe("device group project bindings", () => {
	it("requires explicit binding and reloads committed revisions without exposing mutable state", async () => {
		const { registry, options, root, file } = await fixture();
		expect(registry.defaultRoot).toBe(root);
		expect(registry.get("room")).toBeUndefined();
		await expect(registry.acquire("room")).rejects.toMatchObject({ status: 409, code: "WORKSPACE_NOT_BOUND" });
		const binding = await registry.set({ roomId: "room", path: root });
		expect(binding.revision).toMatch(/^[a-f0-9-]{36}$/);
		binding.root = "tampered";
		registry.list()[0].revision = "tampered";
		expect((await createDeviceWorkspaces(options)).get("room")).toEqual(registry.get("room"));
		if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
		await registry.remove("room");
		expect((await createDeviceWorkspaces(options)).list()).toEqual([]);
	});
	it("pins all leases until their idempotent release, serializing acquire with writes", async () => {
		const { registry, root, other } = await fixture();
		const pending = registry.set({ roomId: "room", path: root });
		const leasePromise = registry.acquire("room");
		const binding = await pending;
		const lease = await leasePromise;
		const second = await registry.acquire("room");
		expect(lease).toMatchObject({ root: binding.root, revision: binding.revision });
		await expect(registry.set({ roomId: "room", path: other })).rejects.toMatchObject({
			status: 409,
			code: "WORKSPACE_BUSY",
		});
		lease.release();
		lease.release();
		await expect(registry.remove("room")).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
		await registry.set({ roomId: "other", path: other });
		second.release();
		const replacement = await registry.set({ roomId: "room", path: other });
		expect(replacement.revision).not.toBe(binding.revision);
		await registry.remove("room");
	});
	it("isolates hub/device scopes sharing a data directory", async () => {
		const { registry, options, root, other } = await fixture();
		await registry.set({ roomId: "same-room", path: root });
		const second = await createDeviceWorkspaces({ ...options, scope: "hub-b/device-a" });
		expect(second.get("same-room")).toBeUndefined();
		await second.set({ roomId: "same-room", path: other });
		expect((await createDeviceWorkspaces(options)).get("same-room")?.root).toBe(root);
	});
	it("keeps published bindings unchanged after write failure and recovers the queue", async () => {
		const { registry, root, other, file } = await fixture();
		const old = await registry.set({ roomId: "room", path: root });
		const saved = await readFile(file, "utf8");
		await rm(file);
		await mkdir(file);
		await expect(registry.set({ roomId: "room", path: other })).rejects.toMatchObject({
			code: "WORKSPACE_SAVE_FAILED",
		});
		await expect(registry.remove("room")).rejects.toMatchObject({ code: "WORKSPACE_SAVE_FAILED" });
		expect(registry.get("room")).toEqual(old);
		await rm(file, { recursive: true });
		await writeFile(file, saved);
		await registry.set({ roomId: "room", path: other });
		expect(registry.get("room")?.root).toBe(other);
	});
	it("rejects missing, file, relative, home, volume, data ancestor and linked roots", async () => {
		const { registry, root, base } = await fixture();
		const file = join(root, "file");
		await writeFile(file, "text");
		for (const path of [join(base, "missing"), file, ".", homedir(), parse(root).root, base]) {
			await expect(registry.set({ roomId: "room", path })).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
		}
		const link = join(base, "link");
		await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
		await mkdir(join(root, "child"));
		await expect(registry.set({ roomId: "room", path: link })).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
		await expect(registry.set({ roomId: "room", path: join(link, "child") })).rejects.toMatchObject({
			code: "WORKSPACE_INVALID",
		});
		await registry.set({ roomId: "room", path: root });
		await rm(root, { recursive: true });
		await expect(registry.acquire("room")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
	});
	it("exposes local bindings only after membership verification without reconnecting", async () => {
		const { options, root, other, registry } = await fixture();
		const hub = express();
		let auth = "";
		hub.get("/api/device-user/rooms/:id", (req, res) => {
			auth = req.headers.authorization ?? "";
			res.status(req.params.id === "member" ? 200 : 404).json({ room: { id: req.params.id } });
		});
		const hubUrl = await listen(createServer(hub));
		await writeFile(
			join(options.dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl,
				name: "local",
				deviceId: "device",
				credential: "agent-secret",
				uiCredential: "ui-secret",
				allowExecution: true,
			}),
		);
		const app = express();
		app.use(express.json());
		let connections = 0;
		const local = await installLocalDeviceCenter({
			app,
			dataDir: options.dataDir,
			connect() {
				connections++;
				return { close() {} };
			},
			workspaceRegistry: async (config) => {
				expect(config).toEqual({ hubUrl, deviceId: "device" });
				return registry;
			},
		});
		close.push(() => local.close());
		const base = await listen(createServer(app));
		const post = (suffix: string, body: unknown, origin = base) =>
			fetch(`${base}/api/device-center/${suffix}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: origin },
				body: JSON.stringify(body),
			});
		expect(await (await fetch(`${base}/api/device-center/workspaces`)).json()).toEqual({
			bindings: [],
			defaultRoot: root,
		});
		expect((await post("workspaces", { roomId: "member", path: root }, "https://evil.example")).status).toBe(403);
		expect((await post("workspaces", { roomId: "outsider", path: root })).status).toBe(404);
		expect(registry.get("outsider")).toBeUndefined();
		const response = await post("workspaces", { roomId: "member", path: root });
		expect(response.status).toBe(200);
		expect(auth).toBe("Bearer ui-secret");
		const binding = (await response.json()).binding;
		expect(await (await fetch(`${base}/api/device-center/workspaces?roomId=member`)).json()).toEqual({
			binding,
			defaultRoot: root,
		});
		const lease = await registry.acquire("member");
		expect((await post("workspaces", { roomId: "member", path: other })).status).toBe(409);
		expect((await post("workspaces/remove", { roomId: "member" })).status).toBe(409);
		lease.release();
		expect((await post("workspaces", { roomId: "member", path: other })).status).toBe(200);
		expect((await post("workspaces/remove", { roomId: "member" })).status).toBe(200);
		expect(registry.get("member")).toBeUndefined();
		expect(connections).toBe(1);
		const rejected = await (await post("workspaces", { roomId: "outsider", path: root })).text();
		expect(rejected).not.toContain("ui-secret");
	});
	it("does not publish a queued binding cancelled before commit", async () => {
		const { registry, root } = await fixture();
		const controller = new AbortController();
		const pending = registry.set({ roomId: "room", path: root, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
		expect(registry.get("room")).toBeUndefined();
	});
	it("fails closed on corrupt persisted state", async () => {
		const { options, file } = await fixture();
		await writeFile(file, "{broken");
		await expect(createDeviceWorkspaces(options)).rejects.toThrow();
	});
});
