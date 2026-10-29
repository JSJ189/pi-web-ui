import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { DeviceHubStore } from "../../server/device-center/store.js";
import { installDeviceTransfers } from "../../server/device-center/transfers.js";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import type { createDeviceFileSync } from "../../server/device-center/file-sync.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-transfers-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const store = await DeviceHubStore.open(dir);
	await store.transact((s) => {
		s.accounts.push({ id: "a", username: "a", passwordHash: "hash", createdAt: 1 });
		for (const id of ["source", "target", "other"])
			s.devices.push({ id, accountId: "a", name: id, credentialHash: "hash", createdAt: 1 });
		s.rooms.push({ id: "room", accountId: "a", name: "r", deviceIds: ["source", "target", "other"], createdAt: 1 });
	});
	let caller = "source";
	const relay = {
		callDevice: vi.fn(async (_id: string, action: string) => {
			if (action === "transfer_stage")
				return {
					id: "local-secret",
					revision: "rev",
					files: [{ path: "x.txt", sha256: "hash", base64: "secret" }],
					base64: "secret",
				};
			return { id: "local-secret", revision: "rev", applied: ["x.txt"] };
		}),
	};
	async function start() {
		const app = express();
		await installDeviceTransfers({
			app,
			store,
			dataDir: dir,
			relay,
			authenticateAgent: async () => {
				const device = store.snapshot().devices.find((d) => d.id === caller);
				return device ? { device, account: { id: "a" } } : undefined;
			},
		});
		app.use(((error: { status?: number }, _req: unknown, res: express.Response, _next: unknown) =>
			res.status(error.status ?? 500).json({ error: "rejected" })) as express.ErrorRequestHandler);
		const server = await new Promise<Server>((resolve) => {
			const s = app.listen(0, "127.0.0.1", () => resolve(s));
		});
		cleanup.push(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		return async (body: object) =>
			fetch(`http://127.0.0.1:${address.port}/api/agent/transfers`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roomId: "room", targetDeviceId: "target", ...body }),
			});
	}
	return {
		store,
		relay,
		dir,
		start,
		caller: (id: string) => {
			caller = id;
		},
	};
}
describe("device transfer receipts", () => {
	it("persists only authorization metadata, returns opaque IDs and restores authorization", async () => {
		const f = await fixture();
		const post = await f.start();
		const response = await post({ action: "stage", bundle: { base64: "PAYLOAD" } });
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.transferId).not.toBe("local-secret");
		expect(JSON.stringify(result)).not.toContain("secret");
		const disk = await readFile(join(f.dir, "device-transfers.json"), "utf8");
		expect(disk).not.toContain("PAYLOAD");
		const restored = await f.start();
		expect((await restored({ action: "preview", transferId: result.transferId })).status).toBe(200);
		f.caller("other");
		expect((await restored({ action: "preview", transferId: result.transferId })).status).toBe(403);
		f.caller("source");
		await f.store.transact((s) => {
			s.rooms[0].deviceIds = ["source"];
		});
		expect((await restored({ action: "preview", transferId: result.transferId })).status).toBe(403);
	});
	it("requires explicit apply and consumes permission before uncertain relay side effects", async () => {
		const f = await fixture();
		const post = await f.start();
		const { transferId } = await (await post({ action: "stage", bundle: {} })).json();
		expect((await post({ action: "apply", transferId, revision: "rev" })).status).toBe(400);
		f.relay.callDevice.mockRejectedValueOnce(new Error("credential secret"));
		const failed = await post({ action: "apply", transferId, revision: "rev", overwritePaths: [] });
		expect(failed.status).toBe(502);
		expect(await failed.text()).not.toContain("secret");
		const restored = await f.start();
		expect((await restored({ action: "apply", transferId, revision: "rev", overwritePaths: [] })).status).toBe(409);
		expect(f.relay.callDevice).toHaveBeenCalledTimes(2);
	});
	it("rechecks membership after relay and passes cancellation to the device", async () => {
		const f = await fixture();
		const post = await f.start();
		f.relay.callDevice.mockImplementationOnce(async () => {
			await f.store.transact((s) => {
				s.rooms[0].deviceIds = ["source"];
			});
			return { id: "local", revision: "rev", applied: [] };
		});
		expect((await post({ action: "stage", bundle: {} })).status).toBe(403);
		const args = f.relay.callDevice.mock.calls[0] as unknown as [string, string, unknown, { signal: AbortSignal }];
		expect(args[3].signal).toBeInstanceOf(AbortSignal);
		await expect(readFile(join(f.dir, "device-transfers.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("rejects expired and foreign-room receipts", async () => {
		const f = await fixture();
		const post = await f.start();
		const { transferId } = await (await post({ action: "stage", bundle: {} })).json();
		expect((await post({ action: "preview", transferId, roomId: "different" })).status).toBe(403);
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 3600000);
		try {
			expect((await post({ action: "preview", transferId })).status).toBe(403);
		} finally {
			now.mockRestore();
		}
	});
});
describe("device collaboration service", () => {
	it("uses trusted parent, fixed root, credentials, cancellation and never retries", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "task" })));
		const service = createDeviceCollabService({
			root: process.cwd(),
			files: {} as ReturnType<typeof createDeviceFileSync>,
			getConfig: () => ({
				hubUrl: "http://localhost:9000",
				deviceId: "source",
				credential: "SECRET",
				allowExecution: true,
			}),
			getParentTask: () => "trusted",
			fetch: request,
		});
		const signal = new AbortController().signal;
		await service.execute(
			"send_task",
			{ roomId: "room", targetDeviceId: "target", prompt: "work", parentTaskId: "forged" },
			signal,
			{ cwd: process.cwd(), sessionId: "s" },
		);
		const init = request.mock.calls[0][1]!;
		expect(JSON.parse(init.body as string)).toMatchObject({ parentTaskId: "trusted", targetDeviceIds: ["target"] });
		expect(String(request.mock.calls[0][0])).toContain("/api/agent/rooms/room/messages");
		expect(init.signal).toBe(signal);
		expect(init.redirect).toBe("error");
		expect(init.headers).toMatchObject({ authorization: "Bearer SECRET", "X-Device-Id": "source" });
		await expect(service.execute("list_rooms", {}, signal, { cwd: join(process.cwd(), "other") })).rejects.toThrow(
			"Device collaboration request failed.",
		);
		request.mockRejectedValueOnce(new Error("SECRET"));
		await expect(service.execute("list_rooms", {}, signal, { cwd: process.cwd() })).rejects.toThrow(
			"Device collaboration request failed.",
		);
		expect(request).toHaveBeenCalledTimes(2);
	});
	it("blocks writes with execution disabled and strips bundle data from stage reports", async () => {
		let enabled = false;
		const prepare = vi.fn().mockResolvedValue({ files: [{ base64: "SECRET" }] });
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					transferId: "opaque",
					base64: "SECRET",
					files: [{ path: "x", sha256: "hash", base64: "SECRET" }],
				}),
			),
		);
		const service = createDeviceCollabService({
			root: process.cwd(),
			files: { prepare } as unknown as ReturnType<typeof createDeviceFileSync>,
			getConfig: () => ({
				hubUrl: "http://localhost:9000",
				deviceId: "source",
				credential: "SECRET",
				allowExecution: enabled,
			}),
			fetch: request,
		});
		const args = { roomId: "room", targetDeviceId: "target", paths: ["x"] };
		await expect(service.execute("sync_files", args, undefined, { cwd: process.cwd() })).rejects.toThrow();
		expect(prepare).not.toHaveBeenCalled();
		enabled = true;
		const result = await service.execute("sync_files", args, undefined, { cwd: process.cwd() });
		expect(result).toMatchObject({ transferId: "opaque", files: [{ path: "x", sha256: "hash" }] });
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});
});
