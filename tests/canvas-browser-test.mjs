import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, openSync, rmSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const chrome = CHROME_PATH;
if (!chrome) {
	console.log("SKIP: Chrome unavailable");
	process.exit(0);
}
await ensureBuild(root);
const dataDir = mkdtempSync(join(tmpdir(), "canvas-browser-test-"));
const log = openSync(join(dataDir, "server.log"), "a");
const port = 8978;
const server = spawn(process.execPath, ["dist/server/index.js", "--port", String(port), "--data-dir", dataDir], {
	cwd: root,
	env: {
		...process.env,
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_PLUGIN_CATALOG_URL: "off",
		PI_WEB_SDK: "bundled",
	},
	stdio: ["ignore", log, log],
	windowsHide: true,
});
let browser;
mkdirSync(join(root, ".artifacts/canvas"), { recursive: true });
try {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (attempt === 99) throw new Error("Canvas test server did not start");
	}
	browser = await chromium.launch({ executablePath: chrome, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.getByRole("tab", { name: "画布协同", exact: true }).click();
	await page.waitForTimeout(2000);
	if (!(await page.locator(".canvas-node-title-input").first().isVisible()))
		await page.getByRole("tab", { name: "画布协同", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".canvas-toolbar select")?.value === "default");
	await page.locator(".canvas-node-title-input").first().waitFor();
	assert.equal(await page.locator(".canvas-node-card").count(), 4);
	await page.locator(".canvas-node-title-input").first().fill("浏览器保存验收");
	await page.locator(".canvas-node-title-input").first().blur();
	await page.keyboard.press("Control+s");
	await page.getByRole("status").filter({ hasText: "保存成功" }).waitFor();
	assert.equal(await page.evaluate(() => localStorage.getItem("pi-web-ui.canvas.draft.default")), null);
	await page.getByRole("button", { name: "串行模板 ▾", exact: true }).click();
	const menu = page.locator(".canvas-dropdown-menu");
	await menu.waitFor();
	assert.equal(await menu.evaluate((el) => el.parentElement.tagName), "BODY");
	await page.keyboard.press("Escape");
	const result = await page.evaluate(async () => {
		const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
		const n = (id, role, config) => ({
			id,
			title: id,
			role,
			x: 100,
			y: 100,
			width: 300,
			engine: "pi",
			model: "",
			cwd: ".",
			useWorktree: false,
			status: "idle",
			config,
		});
		const e = (id, sourceNodeId, targetNodeId, type = "handoff") => ({ id, sourceNodeId, targetNodeId, type });
		const graph = {
			id: "browser_local_branch",
			name: "零 token 条件汇聚",
			nodes: [
				n("input", "trigger", { payload: "yes" }),
				n("judge", "condition", { condition: "yes" }),
				n("yes", "transform", { mode: "template", template: "selected {{input}}" }),
				n("no", "transform"),
				n("join", "merge"),
				n("end", "end"),
			],
			edges: [
				e("a", "input", "judge"),
				e("b", "judge", "yes", "condition_true"),
				e("c", "judge", "no", "condition_false"),
				e("d", "yes", "join"),
				e("e", "no", "join"),
				e("f", "join", "end"),
			],
			viewport: { x: 0, y: 0, zoom: 1 },
			status: "idle",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error("Local canvas run timeout"));
			}, 15000);
			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "hello", clientId: "canvas-browser-contract" }));
				ws.send(JSON.stringify({ type: "canvas_save", graph, baseRev: 0, requestId: "save-probe" }));
			};
			ws.onmessage = ({ data }) => {
				const msg = JSON.parse(data);
				if (msg.type === "canvas_error") {
					clearTimeout(timer);
					ws.close();
					reject(new Error(msg.message));
				}
				if (msg.type === "canvas_graph_state" && msg.requestId === "save-probe")
					ws.send(JSON.stringify({ type: "canvas_run_all", graphId: graph.id }));
				if (msg.type === "canvas_graph_state" && msg.graph.id === graph.id && msg.graph.status === "completed") {
					clearTimeout(timer);
					ws.close();
					resolve(msg.graph);
				}
			};
		});
	});
	assert.equal(result.nodes.find((n) => n.id === "no").status, "skipped");
	assert.equal(result.nodes.find((n) => n.id === "join").status, "done");
	assert.equal(await page.locator(".canvas-toolbar select").inputValue(), "default");
	await page.screenshot({ path: join(root, ".artifacts/canvas/canvas-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator(".canvas-toolbar").waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.getByRole("button", { name: "串行模板 ▾", exact: true }).click();
	await menu.waitFor();
	const box = await menu.boundingBox();
	assert(box.x >= 0 && box.x + box.width <= 391);
	await page.screenshot({ path: join(root, ".artifacts/canvas/canvas-mobile.png") });
	assert.deepEqual(errors, []);
	console.log(
		"PASS canvas browser: acknowledged save, draft cleanup, portal menus, conditional convergence, cross-graph isolation, 390px layout, no page errors",
	);
} catch (error) {
	if (browser) {
		const page = browser.contexts()[0]?.pages()[0];
		if (page) {
			console.log((await page.locator("body").innerText()).slice(0, 3000));
			await page.screenshot({ path: join(root, ".artifacts/canvas/canvas-browser-failure.png") });
		}
	}
	throw error;
} finally {
	await browser?.close();
	server.kill();
	await new Promise((resolve) => {
		if (server.exitCode !== null) return resolve();
		server.once("exit", resolve);
		setTimeout(resolve, 3000);
	});
	closeSync(log);
	rmSync(dataDir, { recursive: true, force: true });
}
