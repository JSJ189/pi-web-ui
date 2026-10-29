import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../tests/lib/chrome.mjs";

const base = mkdtempSync(join(tmpdir(), "pi-loading-"));
const work = join(base, "work"),
	agent = join(base, "agent"),
	data = join(base, "data");
mkdirSync(work);
mkdirSync(join(agent, "sessions"), { recursive: true });
writeFileSync(join(agent, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9/v1",
				apiKey: "mock",
				models: [{ id: "mock", name: "Mock" }],
			},
		},
	}),
);
const cases = [
	{ name: "short", count: 20, branches: 0 },
	{ name: "long", count: 3000, branches: 0 },
	{ name: "branched", count: 1500, branches: 80 },
];
for (const test of cases) {
	const lines = [{ type: "session", version: 3, id: test.name, timestamp: "2026-01-01T00:00:00.000Z", cwd: work }];
	for (let i = 0; i < test.count; i++)
		lines.push({
			type: "message",
			id: `m${i}`,
			parentId: i ? `m${i - 1}` : null,
			timestamp: new Date(1767225600000 + i * 1000).toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: `BENCH_${test.name} message ${i} ` + "Sample text. ".repeat(60) }],
				timestamp: 1767225600000 + i * 1000,
			},
		});
	for (let i = 0; i < test.branches; i++)
		lines.push({
			type: "custom",
			id: `branch${i}`,
			parentId: `m${test.count - 2}`,
			customType: "benchmark",
			timestamp: "2026-01-01T00:00:00.000Z",
			data: {},
		});
	writeFileSync(join(agent, "sessions", `${test.name}.jsonl`), lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
}
const port = 23000 + Math.floor(Math.random() * 5000);
const logs = [];
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: data,
		PI_WEB_CWD: work,
		PI_CODING_AGENT_DIR: agent,
		PI_CODING_AGENT_SESSION_DIR: join(agent, "sessions"),
		PI_WEB_TOKEN: "",
		PI_WEB_LOAD_TIMING: "1",
		PI_WEB_PLUGIN_CATALOG_URL: "off",
		PI_WEB_SDK: "bundled",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (x) => logs.push(String(x)));
server.stderr.on("data", (x) => logs.push(String(x)));
let browser;
try {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	await context.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "en");
	});
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	const completions = [];
	page.on("websocket", (socket) =>
		socket.on("framereceived", (frame) => {
			try {
				const msg = JSON.parse(String(frame.payload));
				if (msg.type === "transition_progress" && msg.kind === "session" && msg.phase === "done")
					completions.push(performance.now());
			} catch {}
		}),
	);
	const navStart = performance.now();
	await page.goto(`http://127.0.0.1:${port}`);
	await page.waitForSelector(".panel-sessions .session-item", { timeout: 60000 });
	const initialMs = performance.now() - navStart;
	const results = [];
	for (const test of cases) {
		const row = page
			.locator(".panel-sessions .session-item")
			.filter({ hasText: `BENCH_${test.name}` })
			.first();
		await row.waitFor({ timeout: 30000 });
		await page.evaluate((name) => {
			window.__load = { name, start: performance.now(), visible: null, ready: null };
			const sample = () => {
				const b = window.__load;
				const text = document.querySelector(".messages")?.textContent || "";
				if (b.visible === null && text.includes(`BENCH_${b.name}`)) b.visible = performance.now() - b.start;
			};
			window.__loadObserver = new MutationObserver(sample);
			window.__loadObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
		}, test.name);
		const start = performance.now();
		await row.click();
		await page.waitForFunction(
			(name) => {
				const m = document.querySelector(".messages")?.textContent || "";
				return m.includes(`BENCH_${name}`);
			},
			test.name,
			{ timeout: 60000 },
		);
		const visibleMs = await page.evaluate(() => window.__load.visible ?? performance.now() - window.__load.start);
		const deadline = performance.now() + 60000;
		while (!completions.some((time) => time >= start)) {
			if (performance.now() > deadline) throw new Error("No session completion event");
			await new Promise((r) => setTimeout(r, 10));
		}
		const readyMs = completions.find((time) => time >= start) - start;
		await page.evaluate(() => window.__loadObserver.disconnect());
		results.push({ ...test, visibleMs: Math.round(visibleMs), readyMs: Math.round(readyMs) });
		console.log("CASE", JSON.stringify(results.at(-1)));
	}
	const report = {
		kind: "isolated Chrome history loading",
		limitations: [
			"One local run per synthetic case; OS file cache not cleared",
			"Synthetic user text only; no tool images or model calls",
			"Current web/dist frontend with current source backend",
			"Ready means server session transition done event received; excludes paint after that event",
		],
		initialHistoryListMs: Math.round(initialMs),
		results,
		serverTimings: logs
			.join("")
			.split("\n")
			.filter((x) => x.includes("[load-timing]")),
		pageErrors: errors,
	};
	mkdirSync("artifacts", { recursive: true });
	writeFileSync("artifacts/history-loading-results.json", JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} catch (e) {
	console.error(logs.join("").slice(-6000));
	throw e;
} finally {
	await browser?.close();
	server.kill();
	await new Promise((r) => server.once("exit", r));
	rmSync(base, { recursive: true, force: true });
}
