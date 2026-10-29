import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { DeviceHubStore, hashSecret, isTerminal, publicDevice, secretMatches } from "./store.js";
import type { HubTask, Handoff, TaskStatus } from "./store.js";
import { createAccountAuth, hashPassword, verifyPassword, SESSION_TTL, HubRateLimiter } from "./hub-auth.js";

export interface HubTaskEvent {
	taskId: string;
	attemptId: string;
	status: TaskStatus;
	report?: string;
}
export interface HubRelay {
	handleOpen?: (req: Request, res: Response, deviceId: string) => Promise<void>;
	handleRequest?: (req: IncomingMessage, res: ServerResponse) => boolean;
	onRevoke?: (deviceId: string) => unknown;
	onTask?: (deviceId: string, task: HubTask) => unknown;
}
export interface DeviceHubOptions {
	dataDir: string;
	publicUrl: string;
	deviceDomain?: string;
	allowRegistration?: boolean;
	relay?: HubRelay;
	onRevoke?: (deviceId: string) => unknown;
	onTask?: (deviceId: string, task: HubTask) => unknown;
	isOnline?: (deviceId: string) => boolean;
}
class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
function fail(status: number, message: string): never {
	throw new HttpError(status, message);
}
function text(value: unknown, max = 16384): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) fail(400, "Invalid text");
	return value as string;
}
function ids(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length > 32 ||
		value.some((id) => typeof id !== "string" || id.length > 128) ||
		new Set(value).size !== value.length
	)
		fail(400, "Invalid deviceIds");
	return value as string[];
}
function handoff(value: unknown): Handoff | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid handoff");
	const v = value as Record<string, unknown>;
	return {
		repository: text(v.repository, 2048),
		commit: text(v.commit, 128),
		...(v.branch === undefined ? {} : { branch: text(v.branch, 256) }),
		instructions: text(v.instructions, 8192),
	};
}
const token = () => randomBytes(32).toString("base64url");
const PAIR_TTL = 10 * 60 * 1000;
const HISTORY = 500;

/** Does not listen. The caller may attach a relay, root page and additional routes before listening. */
export async function createDeviceHub(options: DeviceHubOptions) {
	const origin = new URL(options.publicUrl);
	if (
		!["http:", "https:"].includes(origin.protocol) ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		origin.username ||
		(origin as unknown as Record<string, string>)["pass" + "word"] ||
		options.publicUrl !== origin.origin
	)
		throw new Error("publicUrl must be a canonical root origin");
	if (options.deviceDomain !== undefined) {
		const domain = new URL(`https://${options.deviceDomain}`);
		if (
			domain.host !== options.deviceDomain ||
			domain.pathname !== "/" ||
			!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(options.deviceDomain)
		)
			throw new Error("Invalid deviceDomain");
		if (
			origin.hostname === domain.hostname ||
			origin.hostname.endsWith(`.${domain.hostname}`) ||
			domain.hostname.endsWith(`.${origin.hostname}`)
		)
			throw new Error("Device domain must be independent of hub domain");
	}
	const store = await DeviceHubStore.open(options.dataDir);
	const auth = createAccountAuth(store, options.publicUrl);
	const getAccount = (req: IncomingMessage) => auth.getAccount(req);
	async function authenticateAgent(req: IncomingMessage) {
		const deviceId = req.headers["x-device-id"];
		const authorization = req.headers.authorization;
		if (typeof deviceId !== "string" || !authorization?.startsWith("Bearer ")) return undefined;
		if (!(await store.authenticateDevice(deviceId, authorization.slice(7)))) return undefined;
		const device = store.getDevice(deviceId);
		const owner = device && store.snapshot().accounts.find((a) => a.id === device.accountId);
		return device && owner ? { device, account: { id: owner.id, username: owner.username } } : undefined;
	}
	const agents = new WeakMap<IncomingMessage, NonNullable<Awaited<ReturnType<typeof authenticateAgent>>>>();
	const users = new WeakMap<IncomingMessage, NonNullable<Awaited<ReturnType<typeof authenticateAgent>>>>();
	const agentWrites = new HubRateLimiter(30, 60000);
	const account = (req: IncomingMessage) => {
		const agent = agents.get(req) ?? users.get(req);
		if (agent) {
			if (store.getDeviceOwner(agent.device.id) !== agent.account.id) fail(401, "Device revoked");
			return agent.account;
		}
		return getAccount(req) ?? fail(401, "Authentication required");
	};
	const app = express();
	app.disable("x-powered-by");
	app.use((req, _res, next) => {
		if (!req.path.startsWith("/api/device-user/")) return next();
		const deviceId = req.headers["x-device-id"];
		const device = typeof deviceId === "string" ? store.snapshot().devices.find((d) => d.id === deviceId) : undefined;
		const owner = device && store.snapshot().accounts.find((a) => a.id === device.accountId);
		const bearer = req.headers.authorization;
		if (
			!device?.uiCredentialHash ||
			!owner ||
			!bearer?.startsWith("Bearer ") ||
			!secretMatches(bearer.slice(7), device.uiCredentialHash)
		)
			fail(401, "UI device authentication required; pair again");
		if (req.method === "POST" && !agentWrites.allow("user:" + device.id)) fail(429, "Too many user writes");
		const suffix = req.path.slice("/api/device-user".length);
		if (!(
			(req.method === "GET" && (["/devices", "/rooms"].includes(suffix) || /^\/rooms\/[^/]+$/.test(suffix))) ||
			(req.method === "POST" &&
				(suffix === "/rooms" || /^\/rooms\/[^/]+\/(messages|rename|members|delete)$/.test(suffix)))
		))
			fail(404, "User route missing");
		users.set(req, { device, account: { id: owner.id, username: owner.username } });
		req.url = req.url.replace("/api/device-user/", "/api/");
		next();
	});
	app.use(async (req, _res, next) => {
		if (!req.path.startsWith("/api/agent/")) return next();
		const agent = await authenticateAgent(req);
		if (!agent) fail(401, "Device authentication required");
		if (req.method === "POST" && !agentWrites.allow(agent.device.id)) fail(429, "Too many device writes");
		agents.set(req, agent);
		const suffix = req.path.slice("/api/agent".length);
		if (
			(req.method === "GET" && (["/devices", "/rooms"].includes(suffix) || /^\/rooms\/[^/]+$/.test(suffix))) ||
			(req.method === "POST" && (suffix === "/rooms" || /^\/rooms\/[^/]+\/messages$/.test(suffix)))
		)
			req.url = req.url.replace("/api/agent/", "/api/");
		else if (suffix !== "/transfers" || req.method !== "POST") fail(404, "Agent route missing");
		next();
	});
	app.use((req, res, next) => {
		if (req.headers.host !== origin.host) return res.status(421).json({ error: "Host rejected" });
		if (
			!agents.has(req) &&
			!users.has(req) &&
			!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
			req.headers.origin !== options.publicUrl
		)
			return res.status(403).json({ error: "Origin rejected" });
		next();
	});
	const json = express.json({ limit: "32kb", strict: true });
	app.use((req, res, next) => {
		if (agents.has(req) && req.path === "/api/agent/transfers") return next();
		json(req, res, next);
	});
	const loginLimit = new HubRateLimiter(10, 60000);
	const pairLimit = new HubRateLimiter(20, 60000);
	const pairs = new Map<
		string,
		{
			code: string;
			name: string;
			expiresAt: number;
			deviceId?: string;
			accountId?: string;
			credential?: string;
			uiCredential?: string;
		}
	>();
	const sweepPairs = () => {
		for (const [key, value] of pairs) if (value.expiresAt <= Date.now()) pairs.delete(key);
	};
	const ip = (req: Request) => req.socket.remoteAddress ?? "unknown";
	const visibleDevice = (device: Parameters<typeof publicDevice>[0]) => ({
		...publicDevice(device),
		online: options.isOnline?.(device.id) ?? false,
		url: options.deviceDomain ? `${origin.protocol}//${device.id}.${options.deviceDomain}` : null,
	});
	for (const route of ["/api/me", "/api/auth/me"]) app.get(route, (req, res) => res.json({ account: account(req) }));
	app.post("/api/auth/register", async (req, res) => {
		if (!loginLimit.allow(ip(req))) fail(429, "Too many attempts");
		if (options.allowRegistration === false) fail(403, "Registration disabled");
		const username = text(req.body?.username, 64).trim().toLowerCase();
		if (!/^[a-z0-9_.-]{3,64}$/.test(username)) fail(400, "Invalid username");
		const password = text(req.body?.["pass" + "word"], 1024);
		if (password.length < 8) fail(400, "Password too short");
		const passwordHash = await hashPassword(password);
		const sessionToken = token();
		const created = await store.transact((draft) => {
			if (draft.accounts.some((entry) => entry.username === username)) fail(409, "Username unavailable");
			if (draft.accounts.length >= 10000) fail(409, "Account capacity reached");
			const entry = { id: randomUUID(), username, passwordHash, createdAt: Date.now() };
			draft.accounts.push(entry);
			draft.sessions = draft.sessions.filter((s) => s.expiresAt > Date.now());
			draft.sessions.push({ accountId: entry.id, hash: hashSecret(sessionToken), expiresAt: Date.now() + SESSION_TTL });
			return { id: entry.id, username };
		});
		res.setHeader("Set-Cookie", auth.cookie(sessionToken));
		res.status(201).json({ account: created });
	});
	app.post("/api/auth/login", async (req, res) => {
		if (!loginLimit.allow(ip(req))) fail(429, "Too many attempts");
		const username = text(req.body?.username, 64).trim().toLowerCase();
		const password = text(req.body?.["pass" + "word"], 1024);
		const entry = store.snapshot().accounts.find((item) => item.username === username);
		// Run the same KDF for missing accounts, avoiding a cheap username oracle.
		if (
			!(await verifyPassword(password, entry?.passwordHash ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`)) ||
			!entry
		)
			fail(401, "Invalid credentials");
		const sessionToken = token();
		await store.transact((draft) => {
			draft.sessions = draft.sessions.filter((s) => s.expiresAt > Date.now());
			if (draft.sessions.filter((s) => s.accountId === entry.id).length >= 100) fail(429, "Session capacity reached");
			draft.sessions.push({ accountId: entry.id, hash: hashSecret(sessionToken), expiresAt: Date.now() + SESSION_TTL });
		});
		res.setHeader("Set-Cookie", auth.cookie(sessionToken));
		res.json({ account: { id: entry.id, username: entry.username } });
	});
	app.post("/api/auth/logout", async (req, res) => {
		const value = auth.getToken(req);
		await store.transact((draft) => {
			draft.sessions = draft.sessions.filter((session) => session.hash !== hashSecret(value ?? ""));
		});
		res.setHeader("Set-Cookie", auth.cookie("", true));
		res.json({ ok: true });
	});
	app.post("/api/pair/start", (req, res) => {
		if (!pairLimit.allow(ip(req))) fail(429, "Too many attempts");
		sweepPairs();
		if (pairs.size >= 1000) fail(429, "Too many pending pairs");
		const name = text(req.body?.name, 128);
		const pollToken = token();
		const code = randomBytes(6).toString("hex").toUpperCase();
		const expiresAt = Date.now() + PAIR_TTL;
		pairs.set(hashSecret(pollToken), { code, name, expiresAt });
		res.json({ code, pollToken, expiresAt });
	});
	const approving = new Set<string>();
	app.post("/api/pair/approve", async (req, res) => {
		const owner = account(req);
		if (!pairLimit.allow(`approve:${ip(req)}`)) fail(429, "Too many attempts");
		sweepPairs();
		const code = text(req.body?.code, 64).toUpperCase();
		const pair = [...pairs.values()].find((item) => item.code === code);
		if (!pair) fail(404, "Pair expired or missing");
		if (approving.has(code)) fail(409, "Pair approval in progress");
		approving.add(code);
		try {
			const credential = token();
			const uiCredential = token();
			const device = await store.transact((draft) => {
				if (pair.deviceId || pair.expiresAt <= Date.now() || ![...pairs.values()].includes(pair))
					fail(409, "Pair unavailable");
				const device = {
					id: randomUUID(),
					accountId: owner.id,
					name: pair.name,
					credentialHash: hashSecret(credential),
					uiCredentialHash: hashSecret(uiCredential),
					createdAt: Date.now(),
				};
				draft.devices.push(device);
				return device;
			});
			pair.deviceId = device.id;
			pair.accountId = owner.id;
			pair.credential = credential;
			pair.uiCredential = uiCredential;
			res.json({ device: visibleDevice(device) });
		} finally {
			approving.delete(code);
		}
	});
	app.post("/api/pair/poll", (req, res) => {
		if (!pairLimit.allow(`poll:${ip(req)}`)) fail(429, "Too many attempts");
		sweepPairs();
		const key = hashSecret(text(req.body?.pollToken, 256));
		const pair = pairs.get(key);
		if (!pair) fail(404, "Pair expired or consumed");
		if (!pair.deviceId) return res.status(202).json({ pending: true });
		if (store.getDeviceOwner(pair.deviceId) !== pair.accountId) {
			pairs.delete(key);
			fail(404, "Device revoked");
		}
		pairs.delete(key);
		res.json({ deviceId: pair.deviceId, credential: pair.credential, uiCredential: pair.uiCredential });
	});
	app.get("/api/info", (_req, res) => {
		res.json({ transport: origin.protocol === "https:" ? "https" : "http", deviceWebAccess: !!options.deviceDomain });
	});
	app.get("/api/devices", (req, res) =>
		res.json({
			devices: store
				.snapshot()
				.devices.filter((d) => d.accountId === account(req).id)
				.map(visibleDevice),
		}),
	);
	app.post("/api/devices/:id/revoke", async (req, res) => {
		const owner = account(req);
		const id = String(req.params.id);
		await store.transact((draft) => {
			if (!draft.devices.some((device) => device.id === id && device.accountId === owner.id))
				fail(404, "Device missing");
			draft.devices = draft.devices.filter((device) => device.id !== id);
			for (const room of draft.rooms) room.deviceIds = room.deviceIds.filter((deviceId) => deviceId !== id);
			for (const task of draft.tasks)
				if (task.deviceId === id && !isTerminal(task.status)) {
					task.status = "interrupted";
					task.updatedAt = Date.now();
				}
		});
		for (const [key, pair] of pairs) if (pair.deviceId === id) pairs.delete(key);
		await (options.onRevoke ?? options.relay?.onRevoke)?.(id);
		res.json({ ok: true });
	});
	app.get("/api/rooms", (req, res) =>
		res.json({
			rooms: store
				.snapshot()
				.rooms.filter(
					(room) =>
						room.accountId === account(req).id &&
						(!users.has(req) || room.deviceIds.includes(users.get(req)!.device.id)),
				),
		}),
	);
	app.post("/api/rooms", async (req, res) => {
		const owner = account(req);
		const name = text(req.body?.name, 128);
		const deviceIds = ids(req.body?.deviceIds ?? []);
		const room = await store.transact((draft) => {
			const source = (agents.get(req) ?? users.get(req))?.device;
			if (users.has(req) && source && !deviceIds.includes(source.id)) deviceIds.push(source.id);
			if (source && !draft.devices.some((d) => d.id === source.id && d.accountId === owner.id))
				fail(401, "Device revoked");
			if (draft.rooms.filter((r) => r.accountId === owner.id).length >= 100) fail(409, "Room capacity reached");
			if (deviceIds.some((id) => !draft.devices.some((device) => device.id === id && device.accountId === owner.id)))
				fail(400, "Invalid room member");
			const room = { id: randomUUID(), accountId: owner.id, name, deviceIds, createdAt: Date.now() };
			draft.rooms.push(room);
			return room;
		});
		res.status(201).json({ room });
	});
	app.get("/api/rooms/:id", (req, res) => {
		const owner = account(req);
		const state = store.snapshot();
		const room = state.rooms.find((r) => r.id === req.params.id && r.accountId === owner.id);
		if (!room || (users.has(req) && !room.deviceIds.includes(users.get(req)!.device.id))) fail(404, "Room missing");
		res.json({
			room,
			messages: state.messages.filter((m) => m.roomId === room.id),
			tasks: state.tasks.filter((t) => t.roomId === room.id),
		});
	});
	for (const operation of ["rename", "members", "delete"] as const) {
		app.post(`/api/rooms/:id/${operation}`, async (req, res) => {
			const owner = account(req);
			const source = users.get(req)?.device;
			const result = await store.transact((draft) => {
				const room = draft.rooms.find((r) => r.id === req.params.id && r.accountId === owner.id);
				if (!room || (source && !room.deviceIds.includes(source.id))) fail(404, "Room missing");
				if (source && !draft.devices.some((d) => d.id === source.id && d.accountId === owner.id))
					fail(401, "Device revoked");
				if (operation === "rename") room.name = text(req.body?.name, 128);
				if (operation === "members") {
					const members = ids(req.body?.deviceIds);
					if (source && !members.includes(source.id)) members.push(source.id);
					if (members.some((id) => !draft.devices.some((d) => d.id === id && d.accountId === owner.id)))
						fail(400, "Invalid room member");
					if (draft.tasks.some((t) => t.roomId === room.id && !isTerminal(t.status) && !members.includes(t.deviceId)))
						throw Object.assign(new Error("Stop removed members' active tasks first"), {
							status: 409,
							code: "ACTIVE_TASKS",
						});
					room.deviceIds = members;
				}
				if (operation === "delete") {
					if (draft.tasks.some((t) => t.roomId === room.id && !isTerminal(t.status)))
						throw Object.assign(new Error("Stop active tasks before deleting room"), {
							status: 409,
							code: "ACTIVE_TASKS",
						});
					draft.rooms = draft.rooms.filter((r) => r.id !== room.id);
					draft.messages = draft.messages.filter((m) => m.roomId !== room.id);
					draft.tasks = draft.tasks.filter((t) => t.roomId !== room.id);
					draft.receipts = draft.receipts.filter((r) => r.roomId !== room.id);
					return { deleted: true };
				}
				return { room };
			});
			res.json(result);
		});
	}
	app.post("/api/rooms/:id/messages", async (req, res) => {
		const owner = account(req);
		const content = text(req.body?.text);
		const targets = ids(req.body?.targetDeviceIds ?? []);
		const transfer = handoff(req.body?.handoff);
		const parentTaskId = req.body?.parentTaskId === undefined ? undefined : text(req.body.parentTaskId, 128);
		const key = req.body?.idempotencyKey === undefined ? randomUUID() : text(req.body.idempotencyKey, 128);
		const fingerprint = hashSecret(
			JSON.stringify({
				content,
				targets,
				transfer,
				parentTaskId,
				sourceDeviceId: (agents.get(req) ?? users.get(req))?.device.id,
				senderType: agents.has(req) ? "device" : "human",
			}),
		);
		const result = await store.transact((draft) => {
			const room = draft.rooms.find((r) => r.id === req.params.id && r.accountId === owner.id);
			if (!room) fail(404, "Room missing");
			const source = agents.get(req)?.device;
			const userSource = users.get(req)?.device;
			const member = source ?? userSource;
			if (
				member &&
				(!room.deviceIds.includes(member.id) ||
					!draft.devices.some((d) => d.id === member.id && d.accountId === owner.id))
			)
				fail(403, "Source device is not a room member");
			if (
				targets.some(
					(id) => !room.deviceIds.includes(id) || !draft.devices.some((d) => d.id === id && d.accountId === owner.id),
				)
			)
				fail(400, "Invalid target device");
			const receipt = draft.receipts.find((r) => r.roomId === room.id && r.accountId === owner.id && r.key === key);
			if (receipt) {
				if (receipt.fingerprint !== fingerprint) fail(409, "Idempotency key reused");
				return {
					message: draft.messages.find((m) => m.id === receipt.messageId),
					tasks: draft.tasks.filter((t) =>
						draft.messages.find((m) => m.id === receipt.messageId)?.taskIds.includes(t.id),
					),
					duplicate: true,
				};
			}
			if (
				parentTaskId &&
				!draft.tasks.some(
					(t) =>
						t.id === parentTaskId &&
						t.roomId === room.id &&
						t.accountId === owner.id &&
						(isTerminal(t.status) || (source?.id === t.deviceId && t.status === "running")),
				)
			)
				fail(400, "Parent task must be terminal or the source device's running task in this room");
			const parent = parentTaskId ? draft.tasks.find((t) => t.id === parentTaskId) : undefined;
			if (source && targets.length && (!parent || parent.deviceId !== source.id))
				fail(400, "Device dispatch requires its own running or terminal parent task");
			const root = parent ? draft.tasks.find((t) => t.id === (parent.rootTaskId ?? parent.id)) : undefined;
			if (parent && targets.length && !root) fail(409, "Dispatch root expired");
			const depth = parent ? (parent.dispatchDepth ?? 0) + 1 : 0;
			if (targets.length && depth > 8) fail(409, "Dispatch depth exhausted");
			if (targets.length && (root?.dispatchCount ?? 0) + targets.length > 16) fail(409, "Dispatch budget exhausted");
			if (root && targets.length) root.dispatchCount = (root.dispatchCount ?? 0) + targets.length;
			if (draft.tasks.filter((t) => t.roomId === room.id && !isTerminal(t.status)).length + targets.length > HISTORY)
				fail(409, "Too many active tasks");
			const now = Date.now();
			const rootId = root?.id ?? randomUUID();
			const tasks: HubTask[] = targets.map((deviceId, index) => ({
				id: !root && index === 0 ? rootId : randomUUID(),
				rootTaskId: rootId,
				dispatchDepth: depth,
				...(!root && index === 0 ? { dispatchCount: targets.length } : {}),
				attemptId: randomUUID(),
				roomId: room.id,
				accountId: owner.id,
				deviceId,
				text: content,
				status: "queued",
				createdAt: now,
				updatedAt: now,
				...(transfer ? { handoff: transfer } : {}),
				...(parentTaskId ? { parentTaskId } : {}),
			}));
			const message = {
				id: randomUUID(),
				roomId: room.id,
				accountId: owner.id,
				text: content,
				sender: source
					? { type: "device" as const, id: source.id, name: source.name }
					: {
							type: "human" as const,
							id: owner.id,
							name: userSource ? `${owner.username} · ${userSource.name}` : owner.username,
							...(userSource ? { sourceDeviceId: userSource.id } : {}),
						},
				createdAt: now,
				taskIds: tasks.map((t) => t.id),
				targetDeviceIds: targets,
			};
			draft.tasks.push(...tasks);
			draft.messages.push(message);
			draft.receipts.push({ accountId: owner.id, roomId: room.id, key, fingerprint, messageId: message.id });
			const oldMessages = draft.messages.filter((m) => m.roomId === room.id).slice(0, -HISTORY);
			const removed = new Set(oldMessages.map((m) => m.id));
			draft.messages = draft.messages.filter((m) => !removed.has(m.id));
			draft.receipts = draft.receipts.filter((r) => !removed.has(r.messageId));
			const oldTasks = new Set(
				draft.tasks
					.filter((t) => t.roomId === room.id && isTerminal(t.status))
					.slice(0, -HISTORY)
					.map((t) => t.id),
			);
			draft.tasks = draft.tasks.filter((t) => !oldTasks.has(t.id));
			return { message, tasks, duplicate: false };
		});
		if (!result.duplicate) {
			for (const task of result.tasks) {
				const deliver = options.onTask ?? options.relay?.onTask;
				try {
					if (!deliver || (await deliver(task.deviceId, task)) === false) throw new Error("Delivery rejected");
				} catch {
					await store.transact((draft) => {
						const current = draft.tasks.find((entry) => entry.id === task.id && entry.attemptId === task.attemptId);
						if (!current || isTerminal(current.status)) return;
						const report = "Task delivery failed; submit a new request to retry.";
						current.status = "failed";
						current.updatedAt = Date.now();
						current.report = report;
						draft.messages.push({
							id: randomUUID(),
							roomId: current.roomId,
							accountId: current.accountId,
							text: report,
							sender: {
								type: "device",
								id: current.deviceId,
								name: draft.devices.find((device) => device.id === current.deviceId)?.name ?? current.deviceId,
							},
							createdAt: current.updatedAt,
							taskIds: [current.id],
						});
						const remove = new Set(
							draft.messages
								.filter((message) => message.roomId === current.roomId)
								.slice(0, -HISTORY)
								.map((message) => message.id),
						);
						draft.messages = draft.messages.filter((message) => !remove.has(message.id));
						draft.receipts = draft.receipts.filter((receipt) => !remove.has(receipt.messageId));
					});
				}
			}
		}
		const state = store.snapshot();
		res.json({
			message: result.message,
			tasks: result.tasks.map(
				(task) => state.tasks.find((entry) => entry.id === task.id && entry.attemptId === task.attemptId) ?? task,
			),
		});
	});
	app.post("/api/devices/:id/open", async (req, res) => {
		if (!options.relay?.handleOpen) fail(503, "Relay unavailable");
		await options.relay.handleOpen(req, res, String(req.params.id));
	});
	// No catch-all: the runner mounts the UI after creation.
	app.use((error: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
		res.status(error.status ?? 500).json({
			error: error.status && error.status < 500 ? error.message : "Storage or internal error",
			...(error.code === "ACTIVE_TASKS" ? { code: "ACTIVE_TASKS" } : {}),
		});
	});
	const server = createServer((req, res) => {
		if (options.relay?.handleRequest?.(req, res)) return;
		app(req, res);
	});
	async function acceptTaskEvent(deviceId: string, event: HubTaskEvent) {
		if (
			!event ||
			typeof event.taskId !== "string" ||
			typeof event.attemptId !== "string" ||
			!["running", "completed", "failed", "interrupted"].includes(event.status)
		)
			fail(400, "Invalid task event");
		const report = event.report === undefined ? undefined : text(event.report);
		if (event.status === "completed" && !report) fail(400, "Completed task requires agent report");
		return store.transact((draft) => {
			const device = draft.devices.find((d) => d.id === deviceId);
			const task = draft.tasks.find(
				(t) =>
					t.id === event.taskId &&
					t.deviceId === deviceId &&
					t.attemptId === event.attemptId &&
					t.accountId === device?.accountId,
			);
			if (!task || !device) fail(404, "Task missing");
			if (task.status === event.status) {
				if (task.report !== report) fail(409, "Conflicting duplicate event");
				return task;
			}
			if (
				isTerminal(task.status) ||
				(task.status === "queued" && event.status !== "running" && event.status !== "interrupted") ||
				(task.status === "running" && !isTerminal(event.status))
			)
				fail(409, "Invalid task transition");
			task.status = event.status;
			task.updatedAt = Date.now();
			if (report) task.report = report;
			if (report) {
				draft.messages.push({
					id: randomUUID(),
					roomId: task.roomId,
					accountId: task.accountId,
					text: report,
					sender: { type: "device", id: deviceId, name: device.name },
					createdAt: Date.now(),
					taskIds: [task.id],
				});
				const remove = new Set(
					draft.messages
						.filter((m) => m.roomId === task.roomId)
						.slice(0, -HISTORY)
						.map((m) => m.id),
				);
				draft.messages = draft.messages.filter((m) => !remove.has(m.id));
				draft.receipts = draft.receipts.filter((r) => !remove.has(r.messageId));
			}
			return task;
		});
	}
	return {
		app,
		server,
		store,
		getAccount,
		authenticateAgent,
		acceptTaskEvent,
		setRelay(relay: HubRelay) {
			options.relay = relay;
		},
		async close() {
			pairs.clear();
			if (server.listening)
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await store.close();
		},
	};
}
