import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { hashSecret } from "../../server/device-center/store.js";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "device-groups-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("device user group authority", () => {
	it("authorizes a device portal through paired UI credentials without a browser hub login", async () => {
		const hub = await createDeviceHub({ dataDir: await directory(), publicUrl: "http://127.0.0.1" });
		cleanup.push(() => hub.close());
		await hub.store.transact((state) => {
			state.accounts.push({ id: "owner", username: "owner", passwordHash: "unused", createdAt: 1 });
			for (const id of ["source", "target"])
				state.devices.push({
					id,
					accountId: "owner",
					name: id,
					createdAt: 1,
					credentialHash: hashSecret("agent-secret"),
					uiCredentialHash: hashSecret("ui-secret"),
				});
		});
		hub.setRelay({
			handleOpen: async (req, res, id) => {
				expect(hub.getRelayAccount(req)?.id).toBe("owner");
				expect(req.headers.origin).toBe("http://127.0.0.1");
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ url: `http://127.0.0.1:50002/__device/open?ticket=${id}` }));
			},
		});
		const base = await listen(hub.server);
		const result = await new Promise<number>((resolve, reject) => {
			const request = httpRequest(
				`${base}/api/device-user/devices/target/open`,
				{
					method: "POST",
					headers: {
						Host: "127.0.0.1",
						"X-Device-Id": "source",
						Authorization: "Bearer ui-secret",
						"Content-Type": "application/json",
					},
				},
				(response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode!));
				},
			);
			request.on("error", reject);
			request.end("{}");
		});
		expect(result).toBe(200);
	});
	it("settles rejected deliveries, continues later targets and preserves terminal or replaced attempts on retries", async () => {
		const dataDir = await directory();
		const hub = await createDeviceHub({ dataDir, publicUrl: "http://hub.test" });
		cleanup.push(() => hub.close());
		const base = await listen(hub.server);
		await hub.store.transact((state) => {
			state.accounts.push({ id: "a", username: "alice", passwordHash: "unused", createdAt: 1 });
			for (const id of ["source", "reject", "throw", "complete", "replace", "later"])
				state.devices.push({
					id,
					accountId: "a",
					name: id,
					credentialHash: hashSecret("agent"),
					uiCredentialHash: hashSecret("ui"),
					createdAt: 1,
				});
			state.rooms.push({
				id: "team",
				accountId: "a",
				name: "team",
				deviceIds: state.devices.map((device) => device.id),
				createdAt: 1,
			});
		});
		const delivered: string[] = [];
		hub.setRelay({
			onTask: async (deviceId, task) => {
				delivered.push(deviceId);
				if (deviceId === "reject") return false;
				if (deviceId === "throw") throw new Error("private transport failure");
				if (deviceId === "replace") {
					await hub.store.transact((state) => {
						state.tasks.find((entry) => entry.id === task.id)!.attemptId = "replacement";
					});
					throw new Error("stale attempt");
				}
				await hub.acceptTaskEvent(deviceId, { taskId: task.id, attemptId: task.attemptId, status: "running" });
				await hub.acceptTaskEvent(deviceId, {
					taskId: task.id,
					attemptId: task.attemptId,
					status: "completed",
					report: "done",
				});
				if (deviceId === "complete") throw new Error("late transport failure");
				return true;
			},
		});
		async function request(suffix: string, body: unknown) {
			return new Promise<{ status: number; data: any }>((resolve, reject) => {
				const outgoing = httpRequest(
					`${base}/api/device-user/rooms/team/${suffix}`,
					{
						method: "POST",
						headers: {
							Host: "hub.test",
							"Content-Type": "application/json",
							"X-Device-Id": "source",
							Authorization: "Bearer ui",
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
								resolve({ status: incoming.statusCode!, data: JSON.parse(data) });
							} catch (error) {
								reject(error);
							}
						});
					},
				);
				outgoing.on("error", reject);
				outgoing.end(JSON.stringify(body));
			});
		}
		const body = {
			text: "work",
			targetDeviceIds: ["reject", "throw", "complete", "replace", "later"],
			idempotencyKey: "delivery",
		};
		const response = await request("messages", body);
		expect(response.status).toBe(200);
		expect(delivered).toEqual(body.targetDeviceIds);
		expect(response.data.tasks.map((task: { status: string }) => task.status)).toEqual([
			"failed",
			"failed",
			"completed",
			"queued",
			"completed",
		]);
		const state = hub.store.snapshot();
		expect(state.messages.filter((message) => message.text.startsWith("Task delivery failed"))).toHaveLength(2);
		expect(JSON.stringify(state.messages)).not.toContain("private transport failure");
		const persisted = JSON.parse(await readFile(join(dataDir, "device-hub.json"), "utf8"));
		expect(persisted.tasks.filter((task: { status: string }) => task.status === "failed")).toHaveLength(2);
		const duplicate = await request("messages", body);
		expect(duplicate.status).toBe(200);
		expect(delivered).toHaveLength(5);
		expect(hub.store.snapshot().messages).toEqual(state.messages);
		await hub.store.transact((draft) => {
			const replacement = draft.tasks.find((task) => task.deviceId === "replace")!;
			replacement.status = "interrupted";
		});
		expect((await request("members", { deviceIds: ["source"] })).status).toBe(200);
		expect((await request("delete", {})).status).toBe(200);
	});
	it("separates human UI credentials, member visibility, account targets and agent parent budgets", async () => {
		const hub = await createDeviceHub({ dataDir: await directory(), publicUrl: "http://hub.test", onTask: () => true });
		cleanup.push(() => hub.close());
		const base = await listen(hub.server);
		await hub.store.transact((s) => {
			for (const id of ["a", "b"]) s.accounts.push({ id, username: id, passwordHash: "unused", createdAt: 1 });
			for (const [id, accountId] of [
				["one", "a"],
				["two", "a"],
				["other", "b"],
			])
				s.devices.push({
					id,
					accountId,
					name: id,
					credentialHash: hashSecret(`agent-${id}`),
					uiCredentialHash: hashSecret(`ui-${id}`),
					createdAt: 1,
				});
			s.rooms.push({ id: "private", accountId: "a", name: "private", deviceIds: ["two"], createdAt: 1 });
		});
		async function request(path: string, body?: unknown, secret = "ui-one", device = "one") {
			return new Promise<{ status: number; data: any }>((resolve, reject) => {
				const outgoing = httpRequest(
					`${base}/api/${path}`,
					{
						method: body === undefined ? "GET" : "POST",
						headers: {
							Host: "hub.test",
							"Content-Type": "application/json",
							"X-Device-Id": device,
							Authorization: `Bearer ${secret}`,
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
								resolve({ status: incoming.statusCode!, data: JSON.parse(data) });
							} catch (error) {
								reject(error);
							}
						});
					},
				);
				outgoing.on("error", reject);
				outgoing.end(body === undefined ? undefined : JSON.stringify(body));
			});
		}
		expect((await request("device-user/rooms", undefined, "agent-one")).status).toBe(401);
		expect((await request("agent/rooms", undefined, "ui-one")).status).toBe(401);
		const listing = await request("device-user/rooms");
		expect(listing).toEqual({ status: 200, data: { rooms: [] } });
		expect((await request("device-user/rooms/private")).status).toBe(404);
		expect((await request("device-user/rooms/private/messages", { text: "no" })).status).toBe(403);
		expect((await request("device-user/rooms", { name: "bad", deviceIds: ["other"] })).status).toBe(400);
		const created = await request("device-user/rooms", { name: "team", deviceIds: ["two"] });
		expect(created.status).toBe(201);
		expect(created.data.room.deviceIds).toEqual(["two", "one"]);
		const path = `rooms/${created.data.room.id}/messages`;
		const chat = await request(`device-user/${path}`, { text: "hello", targetDeviceIds: [] });
		expect(chat.data.tasks).toEqual([]);
		expect(chat.data.message.sender).toEqual({ type: "human", id: "a", name: "a · one", sourceDeviceId: "one" });
		const root = await request(`device-user/${path}`, {
			text: "do work",
			targetDeviceIds: ["two"],
			idempotencyKey: "root",
		});
		expect(root.status).toBe(200);
		expect(root.data.tasks[0]).toMatchObject({ deviceId: "two", dispatchDepth: 0, dispatchCount: 1 });
		expect((await request(`agent/${path}`, { text: "loop", targetDeviceIds: ["two"] }, "agent-one")).status).toBe(400);
		expect((await request(`device-user/${path}`, { text: "other", targetDeviceIds: ["other"] })).status).toBe(400);
		const devices = await request("device-user/devices");
		expect(devices.data.devices.map((d: { id: string }) => d.id)).toEqual(["one", "two"]);
		expect(JSON.stringify(devices.data)).not.toContain("Credential");
		const roomPath = `device-user/rooms/${created.data.room.id}`;
		expect((await request(`${roomPath}/rename`, { name: "renamed" })).data.room.name).toBe("renamed");
		expect((await request(`${roomPath}/delete`, {})).data.code).toBe("ACTIVE_TASKS");
		expect((await request(`${roomPath}/members`, { deviceIds: [] })).data.code).toBe("ACTIVE_TASKS");
		await hub.store.transact((s) => {
			for (const task of s.tasks) task.status = "completed";
		});
		expect((await request(`${roomPath}/members`, { deviceIds: [] })).data.room.deviceIds).toEqual(["one"]);
		expect((await request(`${roomPath}/delete`, {})).data).toEqual({ deleted: true });
		expect(hub.store.snapshot().messages.some((m) => m.roomId === created.data.room.id)).toBe(false);
		expect(hub.store.snapshot().tasks.some((t) => t.roomId === created.data.room.id)).toBe(false);
		await hub.store.transact((s) => {
			s.devices = s.devices.filter((d) => d.id !== "one");
		});
		expect((await request("device-user/rooms")).status).toBe(401);
	});
	it("bridges only fixed user routes without execution permission or secret leakage, and bounds remote responses", async () => {
		const remote = express();
		remote.use(express.json());
		const calls: { path: string; auth: string | undefined }[] = [];
		let arrived!: () => void;
		const waiting = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		let cancelled!: () => void;
		const remoteCancelled = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		remote.use((req, res) => {
			calls.push({ path: req.path, auth: req.headers.authorization });
			if (req.path.endsWith("/waiting")) {
				res.once("close", cancelled);
				arrived();
				return;
			}
			if (req.path.endsWith("/oversize")) return res.json({ text: "x".repeat(2 * 1024 * 1024) });
			if (req.path.endsWith("/failure"))
				return res.status(403).json({ error: "ui-secret device-secret upstream internals" });
			return res.status(req.method === "POST" ? 201 : 200).json({ rooms: [], room: { id: "team" } });
		});
		const hubUrl = await listen(createServer(remote));
		const dataDir = await directory();
		await writeFile(
			join(dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl,
				name: "one",
				deviceId: "one",
				credential: "device-secret",
				uiCredential: "ui-secret",
				allowExecution: false,
			}),
		);
		const app = express();
		app.use(express.json());
		const local = await installLocalDeviceCenter({
			app,
			dataDir,
			connect: (cfg) => {
				expect(cfg.uiCredential).toBeUndefined();
				return { close() {} };
			},
		});
		cleanup.push(() => local.close());
		expect(local.getConfig()).not.toHaveProperty("uiCredential");
		const base = await listen(createServer(app));
		async function request(path: string, body?: unknown, origin = base) {
			return fetch(`${base}/api/device-center/${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		}
		expect((await request("rooms")).status).toBe(200);
		expect((await request("rooms", { name: "team", deviceIds: [] })).status).toBe(201);
		expect(calls[0]).toEqual({ path: "/api/device-user/rooms", auth: "Bearer ui-secret" });
		expect((await request("rooms", { name: "team", endpoint: "http://evil.test" })).status).toBe(400);
		const forbidden = await request("rooms", { name: "team" }, "http://evil.test");
		expect(forbidden.status).toBe(403);
		expect((await forbidden.json()).code).toBe("LOCAL_ONLY");
		const failure = await request("rooms/failure");
		expect(failure.status).toBe(403);
		expect(await failure.text()).not.toContain("secret");
		expect((await request("rooms/oversize")).status).toBe(502);
		expect(await (await request("status")).text()).not.toContain("secret");
		const stale = request("rooms/waiting");
		await waiting;
		expect((await request("disconnect", {})).status).toBe(200);
		const staleResponse = await stale;
		expect(staleResponse.status).toBe(409);
		expect((await staleResponse.json()).code).toBe("DEVICE_CHANGED");
		await remoteCancelled;
	});
	it("requires old devices to re-pair while retaining their agent connection", async () => {
		const dataDir = await directory();
		await writeFile(
			join(dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl: "http://127.0.0.1:8901",
				name: "old",
				deviceId: "old",
				credential: "agent",
				allowExecution: false,
			}),
		);
		const app = express();
		let connected = false;
		const local = await installLocalDeviceCenter({
			app,
			dataDir,
			connect: () => {
				connected = true;
				return { close() {} };
			},
		});
		cleanup.push(() => local.close());
		const base = await listen(createServer(app));
		const response = await fetch(`${base}/api/device-center/rooms`);
		expect(connected).toBe(true);
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("REPAIR_REQUIRED");
	});
});
