import type { Express } from "express";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createConnection } from "node:net";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, relative, isAbsolute, extname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { getPkgRoot } from "../pkg-info.js";
import { desktopPage } from "./desktop-page.js";

export const DESKTOP_LIMITS = Object.freeze({
	frame: 1024 * 1024,
	queue: 4 * 1024 * 1024,
	connections: 4,
	connectMs: 10_000,
	idleMs: 30 * 60_000,
});
const ASSETS = "/api/device-desktop/novnc/";
const loopback = (host: string) => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host);

/** Independent local authorization. Connector must rewrite Host/Origin and inject local credentials. */
export function desktopLocalRequest(req: IncomingMessage): boolean {
	if (!loopback(req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "")) return false;
	try {
		const host = new URL(`http://${req.headers.host ?? ""}`);
		if (!loopback(host.hostname) || host.username || Reflect.get(host, "pass" + "word") || host.pathname !== "/")
			return false;
		if (req.headers.origin) {
			const origin = new URL(req.headers.origin);
			if (
				!["http:", "https:"].includes(origin.protocol) ||
				origin.host !== host.host ||
				!loopback(origin.hostname) ||
				origin.origin !== req.headers.origin
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Resolve only published core/vendor files, including every realpath component. */
export function resolveDesktopAsset(path: string, root = desktopAssetRoot()): string | undefined {
	if (
		!root ||
		!/^(core|vendor)\/[a-zA-Z0-9_./-]+\.(js|wasm)$/.test(path) ||
		path.split("/").some((p) => p === "." || p === "..")
	)
		return;
	try {
		const canonicalRoot = realpathSync(root);
		const allowed = realpathSync(resolve(canonicalRoot, path.split("/")[0]));
		const rootRelative = relative(canonicalRoot, allowed);
		if (!rootRelative || rootRelative.startsWith("..") || isAbsolute(rootRelative)) return;
		const file = realpathSync(resolve(root, path));
		const rel = relative(allowed, file);
		if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(file).isFile()) return;
		return file;
	} catch {
		return;
	}
}
function desktopAssetRoot(): string | undefined {
	try {
		const require = createRequire(resolve(getPkgRoot(), "package.json"));
		return realpathSync(resolve(dirname(require.resolve("@novnc/novnc")), ".."));
	} catch {
		return;
	}
}

export interface DeviceDesktopOptions {
	app: Express;
	/** Required even when the parent HTTP app has another authentication middleware. */
	authorize: (req: IncomingMessage) => boolean;
	env?: NodeJS.ProcessEnv;
}

/** Register before SPA fallback; call handleUpgrade before the parent's existing WS dispatcher. */
export function createDeviceDesktop({ app, authorize, env = process.env }: DeviceDesktopOptions) {
	const enabled = env.PI_DEVICE_DESKTOP === "1";
	const rawPort = env.PI_DEVICE_VNC_PORT ?? "5900";
	const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
	const host = env.PI_DEVICE_VNC_HOST ?? "127.0.0.1";
	const configured = port >= 1 && port <= 65535 && ["127.0.0.1", "::1"].includes(host);
	const assetsRoot = desktopAssetRoot();
	let closed = false;
	const bridges = new Set<() => void>();
	const wss = new WebSocketServer({ noServer: true, maxPayload: DESKTOP_LIMITS.frame, perMessageDeflate: false });
	const allowed = (req: IncomingMessage) => {
		try {
			return !closed && desktopLocalRequest(req) && authorize(req);
		} catch {
			return false;
		}
	};
	app.use((req, res, next) => {
		if (req.path !== "/desktop" && req.path !== "/api/device-desktop/status" && !req.path.startsWith(ASSETS))
			return next();
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		if (!allowed(req)) {
			res.status(403).end("Desktop authorization required");
			return;
		}
		if (req.method !== "GET") {
			res.status(405).end();
			return;
		}
		if (req.path === "/api/device-desktop/status") {
			res.json({
				os: process.platform,
				enabled,
				endpointConfigured: configured,
				assetsAvailable: !!assetsRoot,
				available: enabled && configured && !!assetsRoot,
				readOnlyEnforcement: "vnc-server",
				clientViewOnlyIsPermission: false,
			});
			return;
		}
		if (req.path === "/desktop") {
			res.setHeader(
				"Content-Security-Policy",
				"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
			);
			res.type("html").send(desktopPage());
			return;
		}
		if (!enabled) {
			res.status(503).end("Desktop disabled");
			return;
		}
		const file = resolveDesktopAsset(req.path.slice(ASSETS.length), assetsRoot);
		if (!file) {
			res.status(404).end();
			return;
		}
		res.type(extname(file) === ".wasm" ? "application/wasm" : "text/javascript").sendFile(file);
	});
	function bridge(ws: WebSocket) {
		const tcp = createConnection({ host, port });
		let ended = false;
		let connected = false;
		let lastActivity = Date.now();
		let alive = true;
		let queued = 0;
		const cleanup = () => {
			if (ended) return;
			ended = true;
			clearTimeout(connectTimer);
			clearInterval(heartbeat);
			bridges.delete(cleanup);
			tcp.destroy();
			ws.terminate();
		};
		bridges.add(cleanup);
		const connectTimer = setTimeout(cleanup, DESKTOP_LIMITS.connectMs);
		connectTimer.unref();
		const heartbeat = setInterval(() => {
			if (!alive || Date.now() - lastActivity > DESKTOP_LIMITS.idleMs) return cleanup();
			alive = false;
			if (ws.readyState === WebSocket.OPEN) ws.ping();
		}, 30_000);
		heartbeat.unref();
		ws.pause();
		tcp.once("connect", () => {
			connected = true;
			clearTimeout(connectTimer);
			if (!ended) ws.resume();
		});
		tcp.on("data", (data: Buffer) => {
			if (ended) return;
			lastActivity = Date.now();
			if (queued + data.length > DESKTOP_LIMITS.queue || ws.bufferedAmount + data.length > DESKTOP_LIMITS.queue)
				return cleanup();
			queued += data.length;
			// Bound individual raw RFB messages regardless of TCP chunk size.
			for (let offset = 0; offset < data.length; offset += 64 * 1024) {
				const chunk = data.subarray(offset, offset + 64 * 1024);
				ws.send(chunk, { binary: true }, (error) => {
					queued -= chunk.length;
					if (error) return cleanup();
					if (!ended && queued < 256 * 1024) tcp.resume();
				});
			}
			if (queued >= 512 * 1024) tcp.pause();
		});
		ws.on("message", (raw, binary) => {
			if (ended) return;
			if (!binary || !connected) return cleanup();
			const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
			if (data.length + tcp.writableLength > DESKTOP_LIMITS.queue) return cleanup();
			lastActivity = Date.now();
			if (!tcp.write(data)) ws.pause();
		});
		tcp.on("drain", () => {
			if (!ended && connected) ws.resume();
		});
		ws.on("pong", () => {
			alive = true;
		});
		ws.on("close", cleanup);
		ws.on("error", cleanup);
		tcp.on("error", cleanup);
		tcp.on("close", cleanup);
		tcp.on("end", cleanup);
	}
	return {
		handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
			let path: string;
			try {
				path = new URL(req.url ?? "/", "http://local").pathname;
			} catch {
				return false;
			}
			if (path !== "/desktop-ws") return false;
			const reject = (code: number, reason: string) => {
				socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			};
			if (!allowed(req)) reject(403, "Forbidden");
			else if (!enabled || !configured || !assetsRoot) reject(503, "Unavailable");
			else if (bridges.size >= DESKTOP_LIMITS.connections) reject(429, "Too Many Requests");
			else wss.handleUpgrade(req, socket, head, bridge);
			return true;
		},
		close() {
			if (closed) return;
			closed = true;
			for (const cleanup of bridges) cleanup();
			wss.close();
		},
	};
}
