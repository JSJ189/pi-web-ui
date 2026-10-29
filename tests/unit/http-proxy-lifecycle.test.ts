import { createServer, request, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { proxyHttp } from "../../server/http-proxy.js";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

async function listen(handler: RequestListener) {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return (server.address() as AddressInfo).port;
}

async function fixture(handler: RequestListener, pluginId = "test", parseJson = false) {
	const upstreamPort = await listen(handler);
	const app = express();
	if (parseJson) app.use(express.json());
	app.use((req, res) => proxyHttp({ prefix: "/proxy", host: "127.0.0.1", port: upstreamPort, pluginId }, req, res));
	return await listen(app);
}

function get(port: number, path = "/proxy/", headers: Record<string, string> = {}) {
	const req = request({ host: "127.0.0.1", port, path, headers, agent: false });
	const response = once(req, "response");
	req.end();
	return response.then(([res]) => res as import("node:http").IncomingMessage);
}

async function contents(res: import("node:http").IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of res) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString();
}

describe("plugin HTTP proxy lifecycle (real HTTP peers)", () => {
	it("cancels an SSE upstream when the downstream disconnects after a complete GET request", async () => {
		let closed!: () => void;
		const upstreamClosed = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const port = await fixture((_req, res) => {
			res.on("close", closed);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: ready\n\n");
		});
		const res = await get(port);
		await once(res, "data");
		res.destroy();
		await upstreamClosed;
	});

	it("cancels an in-progress upload when the client aborts", async () => {
		let started!: () => void;
		let aborted!: () => void;
		const received = new Promise<void>((resolve) => {
			started = resolve;
		});
		const upstreamAborted = new Promise<void>((resolve) => {
			aborted = resolve;
		});
		const port = await fixture((req) => {
			req.once("data", started);
			req.on("aborted", aborted);
			req.on("error", () => {});
		});
		const req = request({ host: "127.0.0.1", port, method: "POST", path: "/proxy/upload", agent: false });
		req.on("error", () => {});
		req.write("partial upload");
		await received;
		req.destroy();
		await upstreamAborted;
	});

	it("delivers a delayed complete response without treating request completion as cancellation", async () => {
		const payload = "complete response ".repeat(10000);
		let completed = false;
		const port = await fixture((_req, res) => {
			res.on("finish", () => {
				completed = true;
			});
			res.writeHead(201, { "content-length": Buffer.byteLength(payload), "x-upstream": "kept" });
			res.write(payload.slice(0, 20));
			setImmediate(() => res.end(payload.slice(20)));
		});
		const res = await get(port);
		expect(await contents(res)).toBe(payload);
		expect(res.complete).toBe(true);
		expect(res.statusCode).toBe(201);
		expect(res.headers["x-upstream"]).toBe("kept");
		expect(completed).toBe(true);
	});

	it("aborts the downstream rather than reporting success when an upstream response is truncated", async () => {
		let cut!: () => void;
		const port = await fixture((_req, res) => {
			res.writeHead(200, { "content-length": 100 });
			res.write("partial");
			cut = () => res.destroy();
		});
		const res = await get(port);
		const firstChunk = once(res, "data");
		const result = contents(res).then(
			() => "completed",
			() => "aborted",
		);
		await firstChunk;
		cut();
		expect(await result).toBe("aborted");
		expect(res.complete).toBe(false);
	});

	it("returns 502 when the upstream fails before sending headers", async () => {
		const port = await fixture((req) => req.socket.destroy());
		const res = await get(port);
		expect(res.statusCode).toBe(502);
		expect(await contents(res)).toBe("proxy target unreachable");
	});

	it("keeps parsed body, query, Range, prefix and live-preview credential filtering rules", async () => {
		const port = await fixture(
			async (req, res) => {
				res.setHeader("set-cookie", "upstream=value");
				res.end(JSON.stringify({ path: req.url, headers: req.headers, body: await contents(req) }));
			},
			"live-preview",
			true,
		);
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/proxy/nested?q=1",
			method: "POST",
			agent: false,
			headers: {
				"content-type": "application/json",
				cookie: "secret",
				authorization: "Bearer secret",
				"x-pi-token": "secret",
				range: "bytes=0-9",
			},
		});
		const response = once(req, "response");
		req.end('{"value": 1}');
		const [res] = await response;
		const echoed = JSON.parse(await contents(res));
		expect(echoed.path).toBe("/nested?q=1");
		expect(echoed.body).toBe('{"value":1}');
		expect(echoed.headers["content-length"]).toBe("11");
		expect(echoed.headers["x-pi-proxy-prefix"]).toBe("/proxy");
		expect(echoed.headers.range).toBe("bytes=0-9");
		for (const key of ["cookie", "authorization", "x-pi-token"]) expect(echoed.headers[key]).toBeUndefined();
		expect(res.headers["set-cookie"]).toEqual(["upstream=value"]);
	});

	it("redirects a bare live-preview prefix while preserving its query", async () => {
		let calls = 0;
		const port = await fixture((_req, res) => {
			calls++;
			res.end();
		}, "live-preview");
		const res = await get(port, "/proxy?q=1");
		await contents(res);
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe("/proxy/?q=1");
		expect(calls).toBe(0);
	});
});
