import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../lib/chrome.mjs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
	createDeviceDesktop,
	desktopLocalRequest,
	resolveDesktopAsset,
	DESKTOP_LIMITS,
} from "../../server/device-center/desktop.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server | ReturnType<typeof createTcpServer>) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return (server.address() as { port: number }).port;
}
async function fixture(env: NodeJS.ProcessEnv = { PI_DEVICE_DESKTOP: "1" }) {
	const tcp = createTcpServer();
	const peers = new Set<Socket>();
	tcp.on("connection", (socket) => {
		peers.add(socket);
		socket.on("error", () => {}); // Setup TCP probes may close while the mock writes its RFB greeting.
		socket.on("close", () => peers.delete(socket));
	});
	const vncPort = await listen(tcp);
	const app = express();
	const dataDir = mkdtempSync(join(tmpdir(), "desktop-route-"));
	cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const desktop = createDeviceDesktop({
		dataDir,
		app,
		authorize: (req) => req.headers.authorization === "Bearer test",
		env: { PI_DEVICE_VNC_PORT: String(vncPort), ...env },
	});
	const parent = express();
	parent.use("/nested", app);
	parent.use(app);
	const http = createServer(parent);
	http.on("upgrade", (req, socket, head) => {
		if (req.url?.startsWith("/nested/")) req.url = req.url.slice("/nested".length);
		if (!desktop.handleUpgrade(req, socket, head)) socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
	});
	const port = await listen(http);
	cleanups.push(() => {
		desktop.close();
		for (const peer of peers) peer.destroy();
	});
	return { tcp, desktop, port, url: `http://127.0.0.1:${port}`, peers };
}
const headers = { authorization: "Bearer test" };
function wsClient(port: number, options: Record<string, string> = headers) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/desktop-ws`, { headers: options });
	ws.on("error", () => {});
	cleanups.push(() => ws.terminate());
	return ws;
}

describe("device desktop local bridge", () => {
	it.skipIf(!CHROME_PATH)(
		"loads noVNC modules under a proxy prefix and completes a real RFB handshake",
		async () => {
			const f = await fixture();
			f.tcp.on("connection", (socket) => {
				let state = 0;
				let pending = Buffer.alloc(0);
				socket.write("RFB 003.008\n");
				socket.on("data", (data) => {
					pending = Buffer.concat([pending, Buffer.from(data)]);
					for (;;) {
						const count = state === 0 ? 12 : 1;
						if (state > 2 || pending.length < count) return;
						pending = pending.subarray(count);
						if (state === 0) socket.write(Buffer.from([1, 1]));
						if (state === 1) socket.write(Buffer.alloc(4));
						if (state === 2) {
							const name = Buffer.from("Mock desktop");
							const init = Buffer.alloc(24 + name.length);
							init.writeUInt16BE(32, 0);
							init.writeUInt16BE(32, 2);
							Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
							init.writeUInt32BE(name.length, 20);
							name.copy(init, 24);
							socket.write(init);
						}
						state++;
					}
				});
			});
			const browser = await chromium.launch({
				executablePath: CHROME_PATH,
				headless: true,
				timeout: 5000,
				args: ["--no-sandbox"],
			});
			cleanups.push(() => browser.close());
			const page = await browser.newPage({ extraHTTPHeaders: headers, viewport: { width: 390, height: 740 } });
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("response", (response) => {
				if (response.status() >= 400) errors.push(response.url() + ":" + response.status());
			});
			await page.goto(f.url + "/nested/desktop", { timeout: 5000 });
			await page
				.locator("#connect")
				.click({ timeout: 3000 })
				.catch(async (error) => {
					throw new Error(
						String(error) +
							" status=" +
							(await page.locator("#status").textContent()) +
							" errors=" +
							JSON.stringify(errors),
					);
				});
			try {
				await page.waitForFunction(
					() => ["Connected", "已连接"].includes(document.getElementById("status")?.textContent ?? ""),
					undefined,
					{
						timeout: 5000,
					},
				);
			} catch (error) {
				throw new Error(
					String(error) +
						" status=" +
						(await page.locator("#status").textContent()) +
						" errors=" +
						JSON.stringify(errors),
				);
			}
			expect(await page.locator("#screen canvas").count()).toBe(1);
			if (process.env.PI_DEVICE_DESKTOP_SCREENSHOT) {
				mkdirSync("artifacts/device-center", { recursive: true });
				await page.screenshot({ path: "artifacts/device-center/desktop.png", fullPage: true });
			}
			expect(await page.locator("#cad").isDisabled()).toBe(true);
			await page.locator("#viewonly").uncheck();
			expect(await page.locator("#cad").isEnabled()).toBe(true);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.locator("#disconnect").click();
			expect(["Disconnected", "已断开"]).toContain(await page.locator("#status").textContent());
			expect(errors).toEqual([]);
		},
		15_000,
	);
	it("requires explicit enablement and independent authorization", async () => {
		const f = await fixture({ PI_DEVICE_DESKTOP: "0" });
		expect((await fetch(f.url + "/api/device-desktop/status")).status).toBe(403);
		const status = await (await fetch(f.url + "/api/device-desktop/status", { headers })).json();
		expect(status).toMatchObject({
			enabled: false,
			available: false,
			endpointConfigured: true,
			readOnlyEnforcement: "vnc-server",
		});
		const ws = wsClient(f.port);
		const response = once(ws, "unexpected-response");
		expect((await response)[1].statusCode).toBe(503);
		ws.terminate();
	});
	it("rejects LAN Host/Origin, missing authorization, invalid target configuration", async () => {
		const f = await fixture();
		for (const extra of [{}, { ...headers, origin: "https://evil.example" }, { ...headers, host: "192.168.0.4" }]) {
			const ws = wsClient(f.port, extra);
			const response = once(ws, "unexpected-response");
			expect((await response)[1].statusCode).toBe(403);
			ws.terminate();
		}
		const invalid = await fixture({ PI_DEVICE_VNC_HOST: "192.168.1.2", PI_DEVICE_VNC_PORT: "80" });
		expect(await (await fetch(invalid.url + "/api/device-desktop/status", { headers })).json()).toMatchObject({
			available: false,
			endpointConfigured: false,
		});
	});
	it("checks physical loopback and exact origin independent of proxy headers", () => {
		const req = (remoteAddress: string, host: string, origin?: string) =>
			({ socket: { remoteAddress }, headers: { host, origin } }) as any;
		expect(desktopLocalRequest(req("::ffff:127.0.0.1", "127.0.0.1:8787", "http://127.0.0.1:8787"))).toBe(true);
		expect(desktopLocalRequest(req("::1", "[::1]:8787", "http://[::1]:8787"))).toBe(true);
		expect(desktopLocalRequest(req("10.0.0.1", "localhost"))).toBe(false);
		expect(desktopLocalRequest(req("127.0.0.1", "localhost", "null"))).toBe(false);
		expect(desktopLocalRequest(req("127.0.0.1", "localhost:8787", "http://localhost:9999"))).toBe(false);
	});
	it("proxies raw binary RFB over real TCP and WebSocket and cleans both sides", async () => {
		const f = await fixture();
		const connection = once(f.tcp, "connection");
		const ws = wsClient(f.port);
		await once(ws, "open");
		const [peer] = await connection;
		const message = once(ws, "message");
		peer.write("RFB 003.008\n");
		const [data, binary] = await message;
		expect(binary).toBe(true);
		expect(data.toString()).toBe("RFB 003.008\n");
		const input = once(peer, "data");
		ws.send(Buffer.from("RFB 003.008\n"));
		expect((await input)[0].toString()).toBe("RFB 003.008\n");
		const closed = once(peer, "close");
		ws.close();
		await closed;
	});
	it("limits connections, rejects oversized messages and releases capacity", async () => {
		const f = await fixture();
		const sockets: WebSocket[] = [];
		for (let i = 0; i < DESKTOP_LIMITS.connections; i++) {
			const ws = wsClient(f.port);
			await once(ws, "open");
			sockets.push(ws);
		}
		const extra = wsClient(f.port);
		const response = once(extra, "unexpected-response");
		expect((await response)[1].statusCode).toBe(429);
		extra.terminate();
		const closed = once(sockets[0], "close");
		sockets[0].send(Buffer.alloc(DESKTOP_LIMITS.frame + 1));
		await closed;
		const replacement = wsClient(f.port);
		await once(replacement, "open");
		const stopped = once(replacement, "close");
		f.desktop.close();
		await stopped;
	});
	it("rejects text and propagates VNC EOF", async () => {
		const f = await fixture();
		const connection = once(f.tcp, "connection");
		const ws = wsClient(f.port);
		await once(ws, "open");
		const [peer] = await connection;
		const closed = once(ws, "close");
		peer.end();
		await closed;
		const ws2 = wsClient(f.port);
		await once(ws2, "open");
		const closed2 = once(ws2, "close");
		ws2.send("text");
		await closed2;
	});
	it("does not consume unrelated upgrade paths", async () => {
		const f = await fixture();
		const socket = {
			end() {
				throw new Error("must not touch");
			},
		} as any;
		expect(f.desktop.handleUpgrade({ url: "/other" } as any, socket, Buffer.alloc(0))).toBe(false);
	});
	it("serves actual local noVNC modules with confined paths and compatible page URLs", async () => {
		const f = await fixture();
		for (const path of ["core/rfb.js", "core/websock.js", "vendor/pako/lib/zlib/inflate.js"]) {
			expect(resolveDesktopAsset(path)).toBeTruthy();
			const response = await fetch(f.url + "/api/device-desktop/novnc/" + path, { headers });
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("javascript");
			expect((await response.text()).length).toBeGreaterThan(10);
		}
		for (const path of [
			"core/../../package.json",
			"package.json",
			"core/%2e%2e/package.json",
			"vendor/../../server/index.ts",
		])
			expect(resolveDesktopAsset(path)).toBeUndefined();
		const response = await fetch(f.url + "/desktop", { headers });
		const html = await response.text();
		expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
		expect(html).toContain("new URL(path, document.baseURI)");
		expect(html).toContain("Client view only is not an access permission");
		expect(html).not.toContain("https://");
		expect(html).not.toContain("innerHTML");
	});
	it("refuses asset symlinks escaping core/vendor", () => {
		const root = mkdtempSync(join(tmpdir(), "desktop-assets-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "core"));
		writeFileSync(join(root, "outside.js"), "secret");
		try {
			symlinkSync(join(root, "outside.js"), join(root, "core", "escape.js"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}
		expect(resolveDesktopAsset("core/escape.js", root)).toBeUndefined();
	});
});
