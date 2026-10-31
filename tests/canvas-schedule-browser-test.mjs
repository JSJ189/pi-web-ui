import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { CHROME_PATH } from "./lib/chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!CHROME_PATH) {
	console.log("SKIP: Chrome unavailable");
	process.exit(0);
}
const dataDir = mkdtempSync(join(tmpdir(), "canvas-mention-"));
mkdirSync(join(dataDir, "canvas"), { recursive: true });
writeFileSync(
	join(dataDir, "canvas", "scheduled-check.json"),
	JSON.stringify({
		id: "scheduled-check",
		name: "定时画布验收",
		nodes: [
			{
				id: "transform",
				title: "零模型转换",
				role: "transform",
				x: 0,
				y: 0,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				status: "idle",
				config: { mode: "template", template: "processed {{input}}" },
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		status: "idle",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	}),
);
const log = openSync(join(dataDir, "server.log"), "a");
const port = 8984;
const backend = spawn(
	process.execPath,
	["--import", "tsx", "server/index.ts", "--port", String(port), "--data-dir", dataDir],
	{
		cwd: root,
		env: {
			...process.env,
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_PORT: String(port),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_ALLOW_ORIGINS: "http://127.0.0.1:8985",
			PI_WEB_PLUGIN_CATALOG_URL: "off",
			PI_WEB_SDK: "bundled",
		},
		stdio: ["ignore", log, log],
		windowsHide: true,
	},
);
let vite;
let browser;
try {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (attempt === 99) throw new Error(`Backend did not start: ${dataDir}`);
	}
	const target = `http://127.0.0.1:${port}`;
	vite = await createServer({
		configFile: join(root, "web/vite.config.ts"),
		server: {
			host: "127.0.0.1",
			port: 8985,
			strictPort: true,
			proxy: {
				"/api": target,
				"/themes": target,
				"/plugins": target,
				"/plugins-api": target,
				"/plugins-shared": target,
				"/ws": { target: `ws://127.0.0.1:${port}`, ws: true },
			},
		},
	});
	await vite.listen();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("http://127.0.0.1:8985");
	await page.locator("textarea").first().waitFor();
	await page.waitForTimeout(2000);
	await page
		.getByRole("button", { name: /设置|Settings/ })
		.first()
		.click();
	await page.locator(".settings-cmd-input").fill("定时任务");
	await page.locator('[data-tab="scheduler"]').click();
	await page.getByRole("button", { name: /新建任务|New task/ }).click();
	await page.getByRole("combobox", { name: "任务目标", exact: true }).selectOption("canvas");
	await page.getByRole("combobox", { name: "画布工程", exact: true }).selectOption("scheduled-check");
	await page.getByPlaceholder("如：每日依赖与代码健康检查…").fill("每日画布验收");
	mkdirSync(join(root, ".artifacts/canvas"), { recursive: true });
	await page.screenshot({ path: join(root, ".artifacts/canvas/scheduler-canvas.png") });
	await page.getByRole("button", { name: "保存任务", exact: true }).last().click();
	const item = page.locator(".scheduler-item").filter({ hasText: "每日画布验收" });
	await item.waitFor();
	await item.getByRole("button", { name: "立即运行", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".scheduler-item")?.textContent?.includes("成功"));
	await page.screenshot({ path: join(root, ".artifacts/canvas/scheduler-canvas-result.png") });
	assert.deepEqual(errors, []);
	console.log("PASS: scheduler saves and runs a canvas workflow without model calls");
} finally {
	await browser?.close();
	await vite?.close();
	backend.kill();
	await new Promise((resolve) => {
		if (backend.exitCode !== null) resolve();
		else backend.once("exit", resolve);
	});
	closeSync(log);
	rmSync(dataDir, { recursive: true, force: true });
}
