import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
vi.mock("../../plugins/office/remote-canvas.mjs", () => ({
	buildRemoteCanvas: vi.fn(async () => ({ srcdoc: "<html></html>", channel: "test-channel" })),
	createCanvasTransport: vi.fn(() => ({
		request: vi.fn(async (message: any) => ({ echoed: message.op })),
		dispose: vi.fn(),
	})),
}));
import { registerRemoteCanvas } from "../../plugins/office/remote-service.mjs";
import { createCanvasTransport } from "../../plugins/office/remote-canvas.mjs";

function fixture() {
	const routes = new Map<string, Function>();
	const controller = new AbortController();
	const prepare = vi.fn(async () => ({ fileKey: "document", unitId: "unit" }));
	registerRemoteCanvas(
		{
			route(method: string, path: string, handler: Function) {
				routes.set(`${method} ${path}`, handler);
			},
		},
		{
			prepare,
			viewerRoot: "/viewer",
			getOrigin: () => "http://127.0.0.1:9999",
			signal: controller.signal,
			touch() {},
			maxSessions: 1,
		},
	);
	async function request(path: string, body: any) {
		let status = 200;
		let result: any;
		const res = {
			status(value: number) {
				status = value;
				return this;
			},
			json(value: any) {
				result = value;
			},
		};
		await routes.get(`POST ${path}`)!({ body }, res);
		return { status, result };
	}
	return { request, controller, prepare, routes };
}
describe("Office remote canvas sessions", () => {
	it("cancels upstream work when the browser closes its response", async () => {
		const f = fixture();
		try {
			const created = await f.request("/canvas-create", { path: "book.xlsx" });
			const transport = vi.mocked(createCanvasTransport).mock.results.at(-1)!.value;
			let observed: AbortSignal | undefined;
			(transport.request as any).mockImplementationOnce((_message: any, { signal }: any) => {
				observed = signal;
				return new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
				);
			});
			const req = Object.assign(new EventEmitter(), {
				body: { token: created.result.token, message: { op: "ws-poll" } },
			});
			const res = Object.assign(new EventEmitter(), {
				destroyed: false,
				json: vi.fn(),
				status() {
					return this;
				},
			});
			const pending = f.routes.get("POST /canvas-rpc")!(req, res);
			expect(observed?.aborted).toBe(false);
			res.destroyed = true;
			res.emit("close");
			await pending;
			expect(observed?.aborted).toBe(true);
			expect(res.json).not.toHaveBeenCalled();
			expect(res.listenerCount("close")).toBe(0);
		} finally {
			f.controller.abort();
		}
	});
	it("requires explicit document paths and unpredictable scoped session tokens", async () => {
		const f = fixture();
		try {
			expect((await f.request("/canvas-create", {})).status).toBe(400);
			expect(f.prepare).not.toHaveBeenCalled();
			const created = await f.request("/canvas-create", { path: "book.xlsx" });
			expect(created.result.token).toMatch(/^[a-f0-9]{64}$/);
			expect((await f.request("/canvas-rpc", { token: "document", message: {} })).status).toBe(403);
			expect((await f.request("/canvas-rpc", { token: "a".repeat(64), message: {} })).status).toBe(410);
			expect(
				(await f.request("/canvas-rpc", { token: created.result.token, message: { op: "fetch" } })).result.result,
			).toEqual({ echoed: "fetch" });
		} finally {
			f.controller.abort();
		}
	});
	it("limits active sessions, releases explicitly, and disposes on lifecycle cancellation", async () => {
		const f = fixture();
		try {
			const first = await f.request("/canvas-create", { path: "one.xlsx" });
			expect((await f.request("/canvas-create", { path: "two.xlsx" })).status).toBe(429);
			await f.request("/canvas-close", { token: first.result.token });
			expect((await f.request("/canvas-rpc", { token: first.result.token, message: {} })).status).toBe(410);
			expect((await f.request("/canvas-create", { path: "two.xlsx" })).status).toBe(200);
			f.controller.abort();
			const transport = vi.mocked(createCanvasTransport).mock.results.at(-1)!.value;
			expect(transport.dispose).toHaveBeenCalled();
			expect((await f.request("/canvas-create", { path: "three.xlsx" })).result.ok).toBe(false);
		} finally {
			f.controller.abort();
		}
	});
});
