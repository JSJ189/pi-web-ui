import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceDesktop, desktopAssetRoot } from "../../server/device-center/desktop.js";
import {
	createDesktopSetup,
	DESKTOP_INSTALL_ARGS,
	DESKTOP_SETUP_LIMITS,
	probeDesktopVnc,
} from "../../server/device-center/desktop-setup.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "desktop-setup-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
async function fixture() {
	const app = express();
	const dataDir = directory();
	const installer = vi.fn(async () => {});
	const desktop = createDeviceDesktop({
		app,
		dataDir,
		installer,
		authorize: (req) => req.headers.authorization === "Bearer test",
		env: { PI_DEVICE_DESKTOP: "0" },
	});
	const server = createServer(app);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	cleanups.push(
		() =>
			new Promise<void>((done) => {
				desktop.close();
				server.close(() => done());
			}),
	);
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(origin + "/api/device-desktop/setup/" + path, {
			method: "POST",
			headers: { authorization: "Bearer test", origin, "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	return { origin, post, dataDir, installer };
}
describe("desktop setup security and lifecycle", () => {
	it("locates the package root for both published entrypoint layouts", () => {
		const root = directory();
		for (const dir of ["core", "lib"]) {
			mkdirSync(join(root, dir));
			writeFileSync(join(root, dir, "rfb.js"), "export default class RFB {}");
		}
		for (const dir of ["core", "lib"]) expect(desktopAssetRoot(root, () => join(root, dir, "rfb.js"))).toBe(root);
		rmSync(join(root, "core"), { recursive: true });
		expect(desktopAssetRoot(root, () => join(root, "lib/rfb.js"))).toBeUndefined();
	});
	it("requires explicit matching Origin and authorization on both mutations", async () => {
		const f = await fixture();
		for (const route of ["enable", "install"]) {
			for (const headers of [
				{ origin: "" },
				{ origin: "null" },
				{ origin: "https://evil.example" },
				{ authorization: "" },
			] as Record<string, string>[]) {
				expect((await f.post(route, { enabled: true }, headers)).status).toBe(403);
			}
		}
		expect(f.installer).not.toHaveBeenCalled();
		expect((await f.post("enable", { enabled: true, host: "evil.example" })).status).toBe(400);
		expect((await f.post("enable", { enabled: "true" })).status).toBe(400);
		expect((await f.post("enable", { enabled: true })).status).toBe(200);
		expect(JSON.parse(readFileSync(join(f.dataDir, "desktop-settings.json"), "utf8"))).toEqual({ enabled: true });
		expect(createDesktopSetup({ dataDir: f.dataDir, environmentEnabled: false }).enabled).toBe(true);
		expect((await f.post("enable", { enabled: false })).status).toBe(200);
		expect(createDesktopSetup({ dataDir: f.dataDir, environmentEnabled: false }).enabled).toBe(false);
		expect(createDesktopSetup({ dataDir: f.dataDir, environmentEnabled: true }).enabled).toBe(true);
	});
	it("installs only into the dedicated cache and exposes bounded generic status", async () => {
		const f = await fixture();
		expect((await f.post("install", {})).status).toBe(202);
		await vi.waitFor(() => expect(f.installer).toHaveBeenCalledOnce());
		expect(f.installer.mock.calls[0]).toEqual([join(f.dataDir, "desktop-runtime"), expect.any(AbortSignal)]);
		const response = await fetch(f.origin + "/api/device-desktop/setup/status", {
			headers: { authorization: "Bearer test" },
		});
		expect(await response.json()).toMatchObject({
			enabled: false,
			installation: { state: "succeeded" },
			vncReachable: expect.any(Boolean),
		});
		expect(DESKTOP_INSTALL_ARGS).toEqual([
			"install",
			"--no-save",
			"--package-lock=false",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"@novnc/novnc@1.7.0",
		]);
	});
	it("keeps the single-task lock until cancellation actually settles", async () => {
		let release!: () => void;
		let signal!: AbortSignal;
		const installer = vi.fn(async (_dir: string, input: AbortSignal) => {
			signal = input;
			await new Promise<void>((done) => {
				release = done;
			});
		});
		const dataDir = directory();
		const setup = createDesktopSetup({ dataDir, environmentEnabled: false, installer, installMs: 10 });
		expect(setup.install()).toBe(true);
		expect(setup.install()).toBe(false);
		await vi.waitFor(() => expect(signal?.aborted).toBe(true));
		const another = createDesktopSetup({ dataDir, environmentEnabled: false, installer });
		expect(another.install()).toBe(false);
		setup.close();
		expect(setup.installation.state).toBe("running");
		release();
		await vi.waitFor(() => expect(setup.installation.state).toBe("failed"));
		expect(setup.installation.log.length).toBeLessThanOrEqual(DESKTOP_SETUP_LIMITS.logBytes);
	});
	it("aborts on server close and never publishes credential-bearing errors", async () => {
		const dataDir = directory();
		let signal!: AbortSignal;
		const setup = createDesktopSetup({
			dataDir,
			environmentEnabled: false,
			installer: async (_dir, input) => {
				signal = input;
				await new Promise<void>((_done, reject) =>
					input.addEventListener("abort", () => reject(new Error("https://user:secret@registry.invalid")), {
						once: true,
					}),
				);
			},
		});
		setup.install();
		await vi.waitFor(() => expect(signal).toBeDefined());
		setup.close();
		expect(signal.aborted).toBe(true);
		await vi.waitFor(() => expect(setup.installation.state).toBe("failed"));
		expect(setup.installation.log).not.toContain("secret");
	});
	it("probes only validated loopback endpoints", async () => {
		expect(await probeDesktopVnc("192.168.1.1", 5900)).toBe(false);
		const server = createTcpServer((socket) => socket.destroy());
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		expect(await probeDesktopVnc("127.0.0.1", port)).toBe(true);
		await new Promise<void>((done) => server.close(() => done()));
		expect(await probeDesktopVnc("127.0.0.1", port)).toBe(false);
	});
});
