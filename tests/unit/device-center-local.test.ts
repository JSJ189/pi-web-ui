import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalDeviceCenter, normalizeHubUrl } from "../../server/device-center/local.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("local device enrollment", () => {
	it("accepts public HTTP(S) hubs and rejects URL credentials, fragments or paths", () => {
		expect(normalizeHubUrl("https://console.example.com/")).toBe("https://console.example.com");
		expect(normalizeHubUrl("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790");
		expect(normalizeHubUrl("http://82.156.246.55:8790/")).toBe("http://82.156.246.55:8790");
		expect(normalizeHubUrl("http://example.com")).toBe("http://example.com");
		for (const value of [
			"ws://82.156.246.55:8790",
			"http://example.com/#fragment",
			"http://user:password@example.com",
			"https://user@example.com",
			"https://example.com/path",
			"https://example.com/?token=x",
			"file:///tmp/a",
		])
			expect(() => normalizeHubUrl(value)).toThrow();
	});
	it("pairs without exposing credentials and persists execution permission before reconnect", async () => {
		const dir = await mkdtemp(join(tmpdir(), "device-local-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const remote = express();
		remote.use(express.json());
		remote.post("/api/pair/start", (_req, res) =>
			res.json({ code: "12345678", pollToken: "poll-secret", expiresAt: Date.now() + 60000 }),
		);
		remote.post("/api/pair/poll", (_req, res) =>
			res.json({ deviceId: "device-a", credential: "device-secret", uiCredential: "ui-secret" }),
		);
		const hub = await listen(createServer(remote));
		const app = express();
		app.use(express.json());
		const allowed: boolean[] = [];
		const local = await installLocalDeviceCenter({
			app,
			dataDir: dir,
			connect: (cfg) => {
				allowed.push(cfg.allowExecution);
				return { close() {}, isConnected: () => true };
			},
		});
		cleanup.push(() => local.close());
		const base = await listen(createServer(app));
		const legacy = await fetch(`${base}/devices`, { redirect: "manual" });
		expect(legacy.status).toBe(302);
		expect(legacy.headers.get("location")).toBe("./?view=devices");
		const post = (path: string, body: unknown, origin = base) =>
			fetch(`${base}/api/device-center/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: origin },
				body: JSON.stringify(body),
			});
		expect((await post("pair", { hubUrl: hub, name: "Windows" }, "https://evil.example")).status).toBe(403);
		expect((await post("pair", { hubUrl: hub, name: "Windows" })).status).toBe(200);
		const paired = await (await post("poll", {})).json();
		expect(paired).toEqual({ paired: true });
		const status = await (await fetch(`${base}/api/device-center/status`)).text();
		expect(status).not.toContain("device-secret");
		expect(status).not.toContain("poll-secret");
		expect(status).not.toContain("ui-secret");
		expect(allowed).toEqual([false]);
		expect(JSON.parse(await readFile(join(dir, "device-center.json"), "utf8")).uiCredential).toBe("ui-secret");
		expect((await post("execution", { allowExecution: true })).status).toBe(200);
		expect(allowed).toEqual([false, true]);
		expect(JSON.parse(await readFile(join(dir, "device-center.json"), "utf8")).allowExecution).toBe(true);
		expect((await post("disconnect", {})).status).toBe(200);
		expect(JSON.parse(await readFile(join(dir, "device-center.json"), "utf8"))).toBeNull();
	});
});
