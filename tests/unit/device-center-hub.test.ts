import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { DeviceHubStore } from "../../server/device-center/store.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
	publicUrl = "https://hub.test",
	deviceDomain: string | undefined = "devices.test",
	extra: Partial<Parameters<typeof createDeviceHub>[0]> = {},
) {
	const dataDir = await mkdtemp(join(tmpdir(), "device-hub-test-"));
	cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
	const onTask = vi.fn();
	const onRevoke = vi.fn();
	const hub = await createDeviceHub({
		dataDir,
		publicUrl,
		deviceDomain: deviceDomain || undefined,
		onTask,
		onRevoke,
		...extra,
	});
	await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => hub.close());
	const address = hub.server.address() as { port: number };
	async function request(path: string, body?: unknown, cookie = "", extra: Record<string, string> = {}) {
		const response = await new Promise<{ status: number; body: any; cookie: string; headers: unknown }>(
			(resolve, reject) => {
				const outgoing = httpRequest(
					`http://127.0.0.1:${address.port}${path}`,
					{
						method: body === undefined ? "GET" : "POST",
						headers: {
							Host: new URL(publicUrl).host,
							Origin: publicUrl,
							"Content-Type": "application/json",
							Cookie: cookie,
							...extra,
						},
					},
					(incoming) => {
						let data = "";
						incoming.setEncoding("utf8");
						incoming.on("data", (chunk) => {
							data += chunk;
						});
						incoming.on("end", () => {
							try {
								resolve({
									status: incoming.statusCode!,
									body: JSON.parse(data),
									cookie: incoming.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
									headers: incoming.headers,
								});
							} catch (error) {
								reject(error);
							}
						});
					},
				);
				outgoing.on("error", reject);
				outgoing.end(body === undefined ? undefined : JSON.stringify(body));
			},
		);
		return response;
	}
	async function register(username = "alice") {
		const result = await request("/api/auth/register", { username, password: "a-test-password" });
		expect(result.status).toBe(201);
		return result.cookie;
	}
	async function pair(cookie: string, name = "Windows") {
		const start = await request("/api/pair/start", { name });
		expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(200);
		const result = await request("/api/pair/poll", { pollToken: start.body.pollToken });
		expect(result.status).toBe(200);
		return { ...result.body, start: start.body } as {
			deviceId: string;
			credential: string;
			start: { code: string; pollToken: string };
		};
	}
	return { hub, request, register, pair, dataDir, onTask, onRevoke };
}

describe("device center hub", () => {
	it("provides a stable path for every owned device without requiring an alias", async () => {
		const assign = vi.fn(async () => ({}));
		const f = await fixture("https://hub.test", "devices.test", {
			portals: { assign, getOrigin: () => undefined, getAlias: () => undefined } as any,
		});
		const owner = await f.register("device-owner");
		const other = await f.register("other-owner");
		const first = await f.pair(owner, "Mac");
		const second = await f.pair(owner, "Linux");
		f.hub.setRelay({
			handleAliasOpen: async (_req, res, id) => {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ opened: id }));
			},
		});
		for (const device of [first, second]) {
			const opened = await f.request(`/device/${device.deviceId}`, undefined, owner);
			expect(opened.status).toBe(200);
			expect(opened.body.opened).toBe(device.deviceId);
			expect(assign).toHaveBeenCalledWith(device.deviceId, expect.any(String));
		}
		expect((await f.request(`/device/${first.deviceId}`, undefined, other)).status).toBe(404);
	});
	it("supports public IP HTTP accounts, pairing and tasks without device web access", async () => {
		const { request, register, pair, onTask } = await fixture("http://82.156.246.55:8790", "");
		expect((await request("/api/info")).body).toEqual({ transport: "http", deviceWebAccess: false });
		expect((await request("/api/info", undefined, "", { Host: "evil.test" })).status).toBe(421);
		const cookie = await register();
		expect(cookie).toMatch(/^device_hub=/);
		expect((await request("/api/auth/login", { username: "alice", password: "a-test-password" })).status).toBe(200);
		const device = await pair(cookie);
		expect((await request("/api/devices", undefined, cookie)).body.devices[0].url).toBeNull();
		expect((await request("/api/rooms", { name: "bad" }, cookie, { Origin: "http://evil.test" })).status).toBe(403);
		const room = await request("/api/rooms", { name: "public HTTP", deviceIds: [device.deviceId] }, cookie);
		expect(room.status).toBe(201);
		const message = await request(
			`/api/rooms/${room.body.room.id}/messages`,
			{ text: "test", targetDeviceIds: [device.deviceId], requestId: "http-ip-task" },
			cookie,
		);
		expect(message.status).toBe(200);
		expect(onTask).toHaveBeenCalled();
	});
	it("isolates accounts, checks Origin, authenticates salted passwords and clears sessions", async () => {
		const { hub, request, register, pair, dataDir } = await fixture();
		const alice = await register();
		const bob = await register("bob");
		expect((await request("/api/me", undefined, alice)).body.account.username).toBe("alice");
		expect((await request("/api/me")).status).toBe(401);
		expect((await request("/api/auth/login", { username: "alice", password: "wrong" })).status).toBe(401);
		expect((await request("/api/auth/login", { username: "alice", password: "a-test-password" })).status).toBe(200);
		expect((await request("/api/rooms", { name: "bad" }, alice, { Origin: "https://evil.test" })).status).toBe(403);
		const device = await pair(alice);
		expect((await request("/api/devices", undefined, bob)).body.devices).toEqual([]);
		expect((await request("/api/rooms", { name: "stolen", deviceIds: [device.deviceId] }, bob)).status).toBe(400);
		expect(await hub.store.authenticateDevice(device.deviceId, device.credential)).toBe(true);
		const raw = await readFile(join(dataDir, "device-hub.json"), "utf8");
		expect(raw).not.toContain(device.credential);
		expect(raw).not.toContain("a-test-password");
		expect(hub.store.snapshot().accounts[0].passwordHash).toMatch(/^scrypt:/);
		expect((await request("/api/auth/logout", {}, alice)).status).toBe(200);
		expect((await request("/api/me", undefined, alice)).status).toBe(401);
	});
	it("expires pair grants, consumes them once and revokes credentials and callbacks", async () => {
		const { hub, request, register, pair, onRevoke } = await fixture();
		const cookie = await register();
		const start = await request("/api/pair/start", { name: "Mac" });
		expect((await request("/api/pair/poll", { pollToken: start.body.pollToken })).status).toBe(202);
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60000);
		expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(404);
		clock.mockRestore();
		const device = await pair(cookie);
		expect((await request("/api/pair/poll", { pollToken: device.start.pollToken })).status).toBe(404);
		expect((await request(`/api/devices/${device.deviceId}/revoke`, {}, cookie)).status).toBe(200);
		expect(await hub.store.authenticateDevice(device.deviceId, device.credential)).toBe(false);
		expect(onRevoke).toHaveBeenCalledWith(device.deviceId);
	});
	it("dispatches only explicit room targets, enforces attempts and transitions, persists trusted reports", async () => {
		const { hub, request, register, pair, onTask, dataDir } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const room = (await request("/api/rooms", { name: "Win Mac Linux", deviceIds: [device.deviceId] }, cookie)).body
			.room;
		const path = `/api/rooms/${room.id}/messages`;
		await request(path, { text: "@Windows hello", sender: "fake" }, cookie);
		expect(onTask).not.toHaveBeenCalled();
		const payload = {
			text: "test on Mac",
			targetDeviceIds: [device.deviceId],
			idempotencyKey: "work-1",
			handoff: { repository: "https://github.com/test/repo", commit: "abcdef", instructions: "Run the real test" },
		};
		const result = await request(path, payload, cookie);
		const task = result.body.tasks[0];
		expect(result.status).toBe(200);
		expect((await request(path, payload, cookie)).body.tasks[0].id).toBe(task.id);
		expect(onTask).toHaveBeenCalledTimes(1);
		expect((await request(path, { ...payload, text: "different" }, cookie)).status).toBe(409);
		expect((await request(path, { text: "follow", parentTaskId: task.id }, cookie)).status).toBe(400);
		await expect(
			hub.acceptTaskEvent(device.deviceId, { taskId: task.id, attemptId: "wrong", status: "running" }),
		).rejects.toThrow("Task missing");
		await expect(
			hub.acceptTaskEvent(device.deviceId, {
				taskId: task.id,
				attemptId: task.attemptId,
				status: "completed",
				report: "fake",
			}),
		).rejects.toThrow("Invalid task transition");
		const running = { taskId: task.id, attemptId: task.attemptId, status: "running" as const };
		await hub.acceptTaskEvent(device.deviceId, running);
		await hub.acceptTaskEvent(device.deviceId, running);
		await expect(hub.acceptTaskEvent(device.deviceId, { ...running, status: "completed" })).rejects.toThrow(
			"requires agent report",
		);
		const completed = { ...running, status: "completed" as const, report: "Actual agent test output: 7 tests passed." };
		await hub.acceptTaskEvent(device.deviceId, completed);
		await hub.acceptTaskEvent(device.deviceId, completed);
		expect(onTask).toHaveBeenCalledTimes(1);
		const state = (await request(`/api/rooms/${room.id}`, undefined, cookie)).body;
		expect(state.messages.at(-1).sender).toEqual({ type: "device", id: device.deviceId, name: "Windows" });
		expect(state.tasks[0].report).toBe(completed.report);
		expect(
			(await request(path, { text: "Linux next", parentTaskId: task.id, targetDeviceIds: [device.deviceId] }, cookie))
				.status,
		).toBe(200);
		const task2 = hub.store.snapshot().tasks[1];
		await hub.acceptTaskEvent(device.deviceId, { taskId: task2.id, attemptId: task2.attemptId, status: "running" });
		const reopened = await DeviceHubStore.open(dataDir);
		expect(reopened.snapshot().tasks[1].status).toBe("interrupted");
		await reopened.close();
	});
	it("does not publish failed writes; concurrent transactions remain serial and recover", async () => {
		const { hub, register, request } = await fixture();
		const cookie = await register();
		const before = hub.store.snapshot();
		const persist = vi.spyOn(hub.store, "persist").mockRejectedValueOnce(new Error("disk full"));
		expect((await request("/api/rooms", { name: "lost", deviceIds: [] }, cookie)).status).toBe(500);
		expect(hub.store.snapshot()).toEqual(before);
		persist.mockRestore();
		await Promise.all([request("/api/rooms", { name: "one" }, cookie), request("/api/rooms", { name: "two" }, cookie)]);
		expect(hub.store.snapshot().rooms.map((r) => r.name)).toEqual(["one", "two"]);
	});
	it("authenticates agent routes without cookie fallback and records trusted device sender", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const headers = {
			Authorization: `Bearer ${device.credential}`,
			"X-Device-Id": device.deviceId,
			Origin: "https://elsewhere.test",
		};
		expect((await request("/api/agent/devices", undefined, cookie)).status).toBe(401);
		expect((await request("/api/agent/devices", undefined, "", headers)).status).toBe(200);
		const room = (
			await request(
				"/api/agent/rooms",
				{ name: "Agent", deviceIds: [device.deviceId], accountId: "forged" },
				"",
				headers,
			)
		).body.room;
		const result = await request(
			`/api/agent/rooms/${room.id}/messages`,
			{ text: "actual device", sender: { name: "forged" } },
			"",
			headers,
		);
		expect(result.status).toBe(200);
		expect(result.body.message.sender).toEqual({ type: "device", id: device.deviceId, name: "Windows" });
		await request(`/api/devices/${device.deviceId}/revoke`, {}, cookie);
		expect((await request("/api/agent/devices", undefined, "", headers)).status).toBe(401);
		expect(hub.store.getDeviceOwner(device.deviceId)).toBeUndefined();
	});
	it("bounds device handoff chains by trusted parent, persistent root budget and depth", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const other = await pair(cookie, "Mac");
		const room = (await request("/api/rooms", { name: "chain", deviceIds: [device.deviceId, other.deviceId] }, cookie))
			.body.room;
		const headers = { Authorization: `Bearer ${device.credential}`, "X-Device-Id": device.deviceId };
		const path = `/api/agent/rooms/${room.id}/messages`;
		expect((await request(`/api/agent/rooms/${room.id}`, undefined, "", headers)).status).toBe(200);
		expect((await request(path, { text: "no root", targetDeviceIds: [other.deviceId] }, "", headers)).status).toBe(400);
		const root = (
			await request(`/api/rooms/${room.id}/messages`, { text: "start", targetDeviceIds: [device.deviceId] }, cookie)
		).body.tasks[0];
		expect(
			(
				await request(
					path,
					{ text: "queued parent", targetDeviceIds: [other.deviceId], parentTaskId: root.id },
					"",
					headers,
				)
			).status,
		).toBe(400);
		await hub.acceptTaskEvent(device.deviceId, { taskId: root.id, attemptId: root.attemptId, status: "running" });
		const dispatched = await request(
			path,
			{ text: "handoff now", targetDeviceIds: [other.deviceId], parentTaskId: root.id },
			"",
			headers,
		);
		expect(dispatched.status).toBe(200);
		expect(dispatched.body.tasks[0]).toMatchObject({ rootTaskId: root.id, dispatchDepth: 1 });
		const otherHeaders = { Authorization: `Bearer ${other.credential}`, "X-Device-Id": other.deviceId };
		expect(
			(
				await request(
					path,
					{ text: "forged parent", targetDeviceIds: [device.deviceId], parentTaskId: root.id },
					"",
					otherHeaders,
				)
			).status,
		).toBe(400);
		await hub.store.transact((draft) => {
			draft.tasks.find((t) => t.id === root.id)!.dispatchCount = 16;
		});
		expect(
			(await request(path, { text: "budget", targetDeviceIds: [other.deviceId], parentTaskId: root.id }, "", headers))
				.status,
		).toBe(409);
		await hub.store.transact((draft) => {
			const t = draft.tasks.find((t) => t.id === root.id)!;
			t.dispatchCount = 2;
			t.dispatchDepth = 8;
		});
		expect(
			(await request(path, { text: "depth", targetDeviceIds: [other.deviceId], parentTaskId: root.id }, "", headers))
				.status,
		).toBe(409);
	});
	it("does not publish when atomic rename fails and recovers the transaction queue", async () => {
		const { hub, register, request } = await fixture();
		const cookie = await register();
		const before = hub.store.snapshot();
		await rm(hub.store.path);
		await mkdir(hub.store.path);
		expect((await request("/api/rooms", { name: "rename fails" }, cookie)).status).toBe(500);
		expect(hub.store.snapshot()).toEqual(before);
		await rm(hub.store.path, { recursive: true });
		expect((await request("/api/rooms", { name: "recovered" }, cookie)).status).toBe(201);
	});
	it("approves concurrent pair requests at most once and exposes the relay open route", async () => {
		const { hub, register, request } = await fixture();
		const cookie = await register();
		const start = await request("/api/pair/start", { name: "Mac" });
		const replies = await Promise.all([
			request("/api/pair/approve", { code: start.body.code }, cookie),
			request("/api/pair/approve", { code: start.body.code }, cookie),
		]);
		expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(hub.store.snapshot().devices).toHaveLength(1);
		const handleOpen = vi.fn(async (_req, res) => {
			res.json({ url: "https://device.test", expiresAt: 1 });
		});
		hub.setRelay({ handleOpen });
		const id = hub.store.snapshot().devices[0].id;
		expect((await request(`/api/devices/${id}/open`, {}, cookie)).body.url).toBe("https://device.test");
		expect(handleOpen).toHaveBeenCalledTimes(1);
	});
	it("limits login attempts and JSON payload size", async () => {
		const { request } = await fixture();
		for (let i = 0; i < 10; i++) await request("/api/auth/login", { username: "missing", password: "wrong-password" });
		expect((await request("/api/auth/login", { username: "missing", password: "wrong-password" })).status).toBe(429);
		expect((await request("/api/pair/start", { name: "x".repeat(33000) })).status).toBe(413);
	});
});
