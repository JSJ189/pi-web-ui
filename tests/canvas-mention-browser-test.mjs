import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
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
	const input = page.locator("textarea").first();
	await input.waitFor();
	await input.fill("@画布");
	const hit = page.locator(".slash-item").filter({ hasText: "开发 · 测试 · 人工验收" });
	await hit.waitFor();
	mkdirSync(join(root, ".artifacts/canvas"), { recursive: true });
	await page.screenshot({ path: join(root, ".artifacts/canvas/mention-menu.png") });
	await hit.click();
	const chip = page.locator(".attach-chip.canvas");
	await chip.waitFor();
	assert.match(await chip.innerText(), /开发 · 测试 · 人工验收/);
	assert.match(await input.inputValue(), /@开发 · 测试 · 人工验收/);
	await page.screenshot({ path: join(root, ".artifacts/canvas/mention-selected.png") });
	assert.deepEqual(errors, []);
	console.log("PASS: @画布 lists saved workflows and selects a canvas reference without running it");
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
