import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({ starts: 0 }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		existsSync: (path: any) => String(path).includes(`${join("office", "artifacts")}`) || fs.existsSync(path),
	};
});
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	spawn: () => {
		mocks.starts++;
		const child = new EventEmitter() as any;
		child.kill = () => {
			child.emit("exit", 0);
			return true;
		};
		return child;
	},
}));

const cleanup: Array<() => void> = [];
afterEach(() => {
	cleanup
		.splice(0)
		.reverse()
		.forEach((fn) => fn());
	vi.unstubAllGlobals();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "office-session-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	let nextUnit = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: any) => {
			const url = String(input);
			if (url.endsWith("/content")) return new Response("exported");
			let result = {};
			if (url.includes("/upload?")) result = { FileId: "upload" };
			else if (url.endsWith("/import")) result = { taskID: `import-${++nextUnit}` };
			else if (url.includes("/exchange/") && url.endsWith("/export") && !url.includes("/task/"))
				result = { taskID: "export" };
			else if (url.includes("/task/import")) result = { status: "done", import: { unitID: `unit-${nextUnit}` } };
			else if (url.endsWith("/task/export")) result = { status: "done", export: { fileID: "download" } };
			return Response.json(result);
		}),
	);
	const routes = new Map<string, Function>();
	const plugin = (await import("../../plugins/office/index.mjs")).default;
	const dispose = await plugin.activate({
		cwd: root,
		log() {},
		route(method: string, path: string, fn: Function) {
			routes.set(`${method} ${path}`, fn);
		},
		registerTool() {},
	});
	cleanup.push(dispose);
	async function request(method: string, path: string, data: any) {
		let status = 200;
		let body: any;
		const response = {
			status(code: number) {
				status = code;
				return this;
			},
			json(value: any) {
				body = value;
				return this;
			},
		};
		await routes.get(`${method} ${path}`)!({ query: data, body: data }, response);
		return { status, body };
	}
	return { root, request };
}

describe("Office document sessions", () => {
	it("isolates same-directory documents and coalesces concurrent gateway launch and import", async () => {
		const { root, request } = await fixture();
		writeFileSync(join(root, "a.xlsx"), "one");
		writeFileSync(join(root, "b.xlsx"), "two");
		const starts = mocks.starts;
		const [a, again, b] = await Promise.all([
			request("GET", "/open", { path: "a.xlsx" }),
			request("GET", "/open", { path: "a.xlsx" }),
			request("GET", "/open", { path: "b.xlsx" }),
		]);
		expect(a.status).toBe(200);
		expect(a.body.fileKey).toBe(again.body.fileKey);
		expect(a.body.fileKey).not.toBe(b.body.fileKey);
		expect(mocks.starts - starts).toBe(1);
	});
	it("rejects external modifications, preserves destination, and permits exclusive Save As", async () => {
		const { root, request } = await fixture();
		const source = join(root, "book.xlsx");
		writeFileSync(source, "original");
		await request("GET", "/open", { path: "book.xlsx" });
		writeFileSync(source, "external edit");
		expect((await request("POST", "/save", { path: "book.xlsx" })).status).toBe(409);
		expect(readFileSync(source, "utf8")).toBe("external edit");
		expect((await request("POST", "/save", { path: "book.xlsx", targetPath: "copy.xlsx" })).status).toBe(200);
		expect(readFileSync(join(root, "copy.xlsx"), "utf8")).toBe("exported");
		expect((await request("POST", "/save", { path: "book.xlsx", targetPath: "copy.xlsx" })).status).toBe(409);
	});
	it("supports repeated saves and reload after an external change", async () => {
		const { root, request } = await fixture();
		writeFileSync(join(root, "book.xlsx"), "original");
		await request("GET", "/open", { path: "book.xlsx" });
		expect((await request("POST", "/save", { path: "book.xlsx" })).status).toBe(200);
		expect((await request("POST", "/save", { path: "book.xlsx" })).status).toBe(200);
		writeFileSync(join(root, "book.xlsx"), "updated elsewhere");
		expect((await request("GET", "/open", { path: "book.xlsx", reload: "1" })).status).toBe(200);
		expect((await request("POST", "/save", { path: "book.xlsx" })).status).toBe(200);
	});
});
