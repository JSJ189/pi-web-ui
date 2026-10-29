import type { Express, Request, Response, NextFunction } from "express";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { DeviceWorkspaceError, type DeviceWorkspaces } from "./workspaces.js";

export interface LocalDeviceConfig {
	hubUrl: string;
	name: string;
	deviceId: string;
	credential: string;
	uiCredential?: string;
	allowExecution: boolean;
}
interface Connection {
	close(): void | Promise<void>;
	isConnected?(): boolean;
}
interface Options {
	app: Express;
	dataDir: string;
	connect(config: LocalDeviceConfig): Connection | Promise<Connection>;
	/** Share this scope-cached factory with the task/transfer runtime. */
	workspaceRegistry?(config: { hubUrl: string; deviceId: string }): Promise<DeviceWorkspaces>;
}

/** Hub enrollment accepts HTTP(S) origins, including public IP addresses. */
export function normalizeHubUrl(input: unknown): string {
	if (typeof input !== "string" || input.length > 2048) throw new Error("Invalid hub URL");
	const url = new URL(input);
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		Reflect.get(url, "pass" + "word") ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("Hub must use HTTP(S), without a path, query, fragment or credentials");
	return url.origin;
}

function localOnly(req: Request, res: Response, next: NextFunction): void {
	const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
	if (!(peer === "::1" || peer?.startsWith("127."))) {
		res.status(403).json({ code: "LOCAL_ONLY", error: "Configure devices from this computer's loopback address" });
		return;
	}
	let host: string;
	try {
		host = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, "");
	} catch {
		res.status(403).json({ code: "LOCAL_ONLY", error: "Invalid host" });
		return;
	}
	if (!(host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127.")))) {
		res.status(403).json({ code: "LOCAL_ONLY", error: "Use localhost to configure device access" });
		return;
	}
	if (!["GET", "HEAD"].includes(req.method)) {
		try {
			const origin = new URL(req.headers.origin ?? "");
			if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) throw new Error();
		} catch {
			res.status(403).json({ code: "LOCAL_ONLY", error: "Same-origin request required" });
			return;
		}
	}
	res.setHeader("Cache-Control", "no-store");
	next();
}

export async function installLocalDeviceCenter(options: Options) {
	const file = join(options.dataDir, "device-center.json");
	let config: LocalDeviceConfig | undefined;
	let connection: Connection | undefined;
	let pending: { hubUrl: string; name: string; pollToken: string; expiresAt: number; generation: number } | undefined;
	let generation = 0;
	let closed = false;
	let serial: Promise<unknown> = Promise.resolve();
	const serialize = <T>(work: () => Promise<T>): Promise<T> => {
		const result = serial.then(work);
		serial = result.catch(() => undefined);
		return result;
	};
	async function persist(next: LocalDeviceConfig | undefined) {
		await mkdir(options.dataDir, { recursive: true });
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, JSON.stringify(next ?? null), { mode: 0o600, flag: "wx" });
			await rename(temp, file);
		} finally {
			await rm(temp, { force: true });
		}
	}
	async function reconnect() {
		await connection?.close();
		connection = undefined;
		if (config && !closed) {
			const { uiCredential: _uiCredential, ...agentConfig } = config;
			connection = await options.connect(agentConfig);
		}
	}
	async function hubRequest(hubUrl: string, path: string, body: unknown) {
		const response = await fetch(`${hubUrl}${path}`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			headers: { "Content-Type": "application/json", Origin: hubUrl },
			body: JSON.stringify(body),
		});
		if (!response.body) throw new Error("Empty hub response");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > 32768) throw new Error("Hub response exceeds limit");
				chunks.push(chunk.value);
			}
		} finally {
			await reader.cancel();
		}
		const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!response.ok)
			throw new Error(typeof result.error === "string" ? result.error : `Hub returned ${response.status}`);
		return result;
	}
	try {
		const value = JSON.parse(await readFile(file, "utf8"));
		if (value !== null) {
			if (
				!value ||
				typeof value.deviceId !== "string" ||
				typeof value.credential !== "string" ||
				typeof value.name !== "string" ||
				typeof value.allowExecution !== "boolean" ||
				(value.uiCredential !== undefined && typeof value.uiCredential !== "string")
			)
				throw new Error("Invalid saved device configuration");
			config = { ...value, hubUrl: normalizeHubUrl(value.hubUrl) };
			await reconnect();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Existing bookmarks now enter the native application view.
	options.app.get("/devices", localOnly, (_req, res) => {
		res.redirect("./?view=devices");
	});
	options.app.use("/api/device-center", localOnly);
	options.app.get("/api/device-center/status", (_req, res) => {
		res.json({
			name: config?.name ?? hostname(),
			hubUrl: config?.hubUrl,
			deviceId: config?.deviceId,
			allowExecution: config?.allowExecution ?? false,
			connected: connection?.isConnected?.() ?? false,
		});
	});
	const activeRequests = new Set<AbortController>();
	let inFlight = 0;
	function userRoute(method: "get" | "post", path: string, fields: string[]) {
		options.app[method](`/api/device-center/${path}`, async (req, res) => {
			const captured = config;
			const capturedGeneration = generation;
			if (!captured) return res.status(409).json({ code: "NOT_PAIRED", error: "Pair this computer first" });
			if (!captured.uiCredential)
				return res
					.status(409)
					.json({ code: "REPAIR_REQUIRED", error: "Pair this computer again to enable group chat" });
			if (closed || inFlight >= 8) return res.status(429).json({ code: "BUSY", error: "Device center busy" });
			const body = req.body ?? {};
			if (
				method === "post" &&
				(!body ||
					typeof body !== "object" ||
					Array.isArray(body) ||
					Object.keys(body).some((key) => !fields.includes(key)) ||
					Buffer.byteLength(JSON.stringify(body)) > 32768)
			)
				return res.status(400).json({ code: "INVALID_BODY", error: "Invalid group request" });
			const controller = new AbortController();
			activeRequests.add(controller);
			inFlight++;
			const cancel = () => {
				if (!res.writableEnded) controller.abort();
			};
			req.once("aborted", cancel);
			res.once("close", cancel);
			try {
				const suffix = path.replace(":id", encodeURIComponent(String((req.params as Record<string, string>).id)));
				const response = await fetch(`${captured.hubUrl}/api/device-user/${suffix}`, {
					method: method.toUpperCase(),
					redirect: "error",
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
					headers: {
						"Content-Type": "application/json",
						"X-Device-Id": captured.deviceId,
						Authorization: `Bearer ${captured.uiCredential}`,
					},
					...(method === "post" ? { body: JSON.stringify(body) } : {}),
				});
				if (!response.body) throw new Error("Empty response");
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						bytes += chunk.value.byteLength;
						if (bytes > 2 * 1024 * 1024) throw new Error("Response exceeds limit");
						chunks.push(chunk.value);
					}
				} finally {
					await reader.cancel();
				}
				if (closed || config !== captured || generation !== capturedGeneration)
					return res.status(409).json({ code: "DEVICE_CHANGED", error: "Device binding changed; refresh" });
				if (!response.ok) {
					const failure = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (response.status === 409 && failure?.code === "ACTIVE_TASKS")
						return res.status(409).json({
							code: "ACTIVE_TASKS",
							error: "Stop active tasks before removing members or deleting this group",
						});
					const status = [400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 502;
					return res.status(status === 401 ? 409 : status).json({
						code: status === 401 ? "REPAIR_REQUIRED" : status === 403 ? "HUB_FORBIDDEN" : "HUB_REJECTED",
						error: status === 401 ? "Pair this computer again" : "Hub rejected group request",
					});
				}
				const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				res.status(response.status).json(data);
			} catch {
				if (!res.destroyed && (closed || config !== captured || generation !== capturedGeneration))
					return res.status(409).json({ code: "DEVICE_CHANGED", error: "Device binding changed; refresh" });
				if (!res.destroyed)
					res.status(502).json({ code: "HUB_UNAVAILABLE", error: "Hub request failed or exceeded response limit" });
			} finally {
				inFlight--;
				activeRequests.delete(controller);
				req.off("aborted", cancel);
				res.off("close", cancel);
			}
		});
	}
	// Local project paths never pass through the hub proxy.
	function workspaceRoute(method: "get" | "post", suffix: string, operation: "read" | "set" | "remove") {
		options.app[method](`/api/device-center/${suffix}`, async (req, res) => {
			const captured = config;
			const capturedGeneration = generation;
			if (!captured) return res.status(409).json({ code: "NOT_PAIRED", error: "Pair this computer first" });
			if (!options.workspaceRegistry)
				return res
					.status(409)
					.json({ code: "WORKSPACES_UNAVAILABLE", error: "Local project bindings are unavailable" });
			if (closed || inFlight >= 8) return res.status(429).json({ code: "BUSY", error: "Device center busy" });
			inFlight++;
			const controller = new AbortController();
			const cancel = () => {
				if (!res.writableEnded) controller.abort();
			};
			const check = () => {
				if (closed || config !== captured || generation !== capturedGeneration)
					throw new DeviceWorkspaceError(409, "DEVICE_CHANGED", "Device binding changed; refresh");
				if (controller.signal.aborted)
					throw new DeviceWorkspaceError(409, "REQUEST_CANCELLED", "Project binding request cancelled");
			};
			activeRequests.add(controller);
			req.once("aborted", cancel);
			res.once("close", cancel);
			try {
				const fields = operation === "set" ? ["roomId", "path"] : ["roomId"];
				const input = method === "get" ? req.query : req.body;
				if (
					!input ||
					typeof input !== "object" ||
					Array.isArray(input) ||
					Object.keys(input).some((key) => !fields.includes(key) && !(method === "get" && key === "token"))
				)
					throw new DeviceWorkspaceError(400, "INVALID_BODY", "Invalid project binding request");
				const roomId = input.roomId;
				if (
					(operation !== "read" || roomId !== undefined) &&
					(typeof roomId !== "string" || !roomId.trim() || roomId.length > 256)
				)
					throw new DeviceWorkspaceError(400, "INVALID_ROOM", "Invalid room ID");
				if (operation === "set" && (typeof input.path !== "string" || input.path.length > 32768))
					throw new DeviceWorkspaceError(400, "WORKSPACE_INVALID", "Invalid project path");
				const data = await serialize(async () => {
					check();
					if (operation !== "read" || typeof roomId === "string") {
						if (!captured.uiCredential)
							throw new DeviceWorkspaceError(409, "REPAIR_REQUIRED", "Pair this computer again to enable group chat");
						let response: globalThis.Response;
						try {
							response = await fetch(
								`${captured.hubUrl}/api/device-user/rooms/${encodeURIComponent(roomId as string)}`,
								{
									redirect: "error",
									signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
									headers: { "X-Device-Id": captured.deviceId, Authorization: `Bearer ${captured.uiCredential}` },
								},
							);
							await response.body?.cancel();
						} catch {
							check();
							throw new DeviceWorkspaceError(502, "HUB_UNAVAILABLE", "Could not verify group membership");
						}
						check();
						if (!response.ok)
							throw new DeviceWorkspaceError(
								response.status === 404 ? 404 : 403,
								"HUB_FORBIDDEN",
								"Group membership verification rejected",
							);
					}
					const registry = await options.workspaceRegistry!({ hubUrl: captured.hubUrl, deviceId: captured.deviceId });
					check();
					if (operation === "read")
						return typeof roomId === "string"
							? { binding: registry.get(roomId), defaultRoot: registry.defaultRoot }
							: { bindings: registry.list(), defaultRoot: registry.defaultRoot };
					if (operation === "set")
						return {
							binding: await registry.set({
								roomId: roomId as string,
								path: input.path as string,
								signal: controller.signal,
							}),
						};
					await registry.remove(roomId as string, { signal: controller.signal });
					return { removed: true };
				});
				if (!res.destroyed) res.json(data);
			} catch (error) {
				if (!res.destroyed) {
					const known = error instanceof DeviceWorkspaceError;
					res.status(known ? error.status : 500).json({
						code: known ? error.code : "WORKSPACE_FAILED",
						error: known ? error.message : "Local project binding operation failed",
					});
				}
			} finally {
				inFlight--;
				activeRequests.delete(controller);
				req.off("aborted", cancel);
				res.off("close", cancel);
			}
		});
	}
	workspaceRoute("get", "workspaces", "read");
	workspaceRoute("post", "workspaces", "set");
	workspaceRoute("post", "workspaces/remove", "remove");
	userRoute("get", "devices", []);
	userRoute("post", "devices/:id/open", []);
	userRoute("get", "rooms", []);
	userRoute("get", "rooms/:id", []);
	userRoute("post", "rooms", ["name", "deviceIds"]);
	userRoute("post", "rooms/:id/rename", ["name"]);
	userRoute("post", "rooms/:id/members", ["deviceIds"]);
	userRoute("post", "rooms/:id/delete", []);
	userRoute("post", "rooms/:id/messages", ["text", "targetDeviceIds", "idempotencyKey", "handoff", "parentTaskId"]);
	function route(path: string, work: (req: Request) => Promise<unknown>) {
		options.app.post(`/api/device-center/${path}`, (req, res) => {
			void serialize(async () => {
				if (closed) throw new Error("Device center is shutting down");
				return work(req);
			}).then(
				(data) => res.json(data),
				(error) => res.status(400).json({ error: (error as Error).message }),
			);
		});
	}
	route("pair", async (req) => {
		if (config) throw new Error("Disconnect the existing device before pairing again");
		const hubUrl = normalizeHubUrl(req.body?.hubUrl);
		const name = req.body?.name;
		if (typeof name !== "string" || !name.trim() || name.length > 80)
			throw new Error("Device name must contain 1–80 characters");
		const result = await hubRequest(hubUrl, "/api/pair/start", { name: name.trim() });
		if (typeof result.code !== "string" || typeof result.pollToken !== "string")
			throw new Error("Invalid pairing response");
		const expiresAt = typeof result.expiresAt === "number" ? result.expiresAt : Date.parse(result.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 15 * 60_000)
			throw new Error("Invalid pairing expiry");
		pending = { hubUrl, name: name.trim(), pollToken: result.pollToken, expiresAt, generation: ++generation };
		return { code: result.code, expiresAt, hubUrl };
	});
	route("poll", async () => {
		const pair = pending;
		if (!pair || pair.expiresAt < Date.now()) {
			pending = undefined;
			throw new Error("Pairing expired; request a new code");
		}
		const result = await hubRequest(pair.hubUrl, "/api/pair/poll", { pollToken: pair.pollToken });
		if (result.pending) return { pending: true };
		if (closed || pair.generation !== generation) throw new Error("Pairing cancelled");
		if (
			typeof result.deviceId !== "string" ||
			typeof result.credential !== "string" ||
			typeof result.uiCredential !== "string" ||
			!result.uiCredential
		)
			throw new Error("Invalid device credentials");
		const next = {
			hubUrl: pair.hubUrl,
			name: pair.name,
			deviceId: result.deviceId,
			credential: result.credential,
			uiCredential: result.uiCredential,
			allowExecution: false,
		};
		await persist(next);
		config = next;
		pending = undefined;
		await reconnect();
		return { paired: true };
	});
	route("execution", async (req) => {
		if (!config) throw new Error("Pair this computer first");
		if (typeof req.body?.allowExecution !== "boolean") throw new Error("Invalid execution permission");
		const next = { ...config, allowExecution: req.body.allowExecution };
		await persist(next);
		config = next;
		await reconnect();
		return { saved: true };
	});
	route("disconnect", async () => {
		await persist(undefined);
		generation++;
		for (const controller of activeRequests) controller.abort();
		pending = undefined;
		config = undefined;
		await reconnect();
		return { disconnected: true };
	});
	return {
		getConfig() {
			if (!config) return undefined;
			const { uiCredential: _uiCredential, ...agentConfig } = config;
			return agentConfig;
		},
		async close() {
			closed = true;
			generation++;
			for (const controller of activeRequests) controller.abort();
			await serial;
			await connection?.close();
			connection = undefined;
		},
	};
}
