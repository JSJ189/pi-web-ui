/**
 * pm2-manager 插件单测 —— 走真实源码（纯函数 + 假宿主），零端口、零 token、零子进程。
 *
 * 覆盖：
 *   - manifest：id/apiVersion 2/permissions（ui+tools+http）/`view:false`（没有独立面板）+
 *     `ui["tasks.panel"]` 一条 kind=view（内嵌进宿主「后台任务」面板，经 parseUiContributions 解析）。
 *   - 纯函数区（内联在 index.mjs 里）裸后台启动识别：nohup / disown / setsid / start /b / Start-Process / 尾部 &，
 *     以及三类必须放行的写法（已经在用 pm2、`#bg-ok` 逃生门、纯等待类 `sleep 30 &`）。
 *   - pm2 入口候选与 jlist 解析（含 ANSI 噪声与坏输入）。
 *   - 展示格式化（字节/时长/状态行/工具行）。
 *   - index.mjs activate：注册 `pm2` 工具（提示词纯英文且三处不重复）、注册裸启动闸门
 *     （deny 指路 pm2 / guardMode=off 放行）、挂上五个 HTTP 路由。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import { parseUiContributions } from "../../server/plugins.js";
import pm2Plugin, {
	detectDetachedLaunch,
	ESCAPE_MARK,
	formatAppLine,
	formatAppStatus,
	formatBytes,
	formatUptime,
	isWaitOnlyCommand,
	parsePm2List,
	parsePm2ListOutput,
	pm2EntryCandidates,
	stripAnsi,
} from "../../plugins/pm2-manager/index.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "pm2-manager");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

// ──────────────────────────────────────────────────────────── manifest

describe("pm2-manager manifest", () => {
	it("声明 apiVersion 2 / 三项权限 / 无独立面板（内嵌进后台任务面板）", () => {
		expect(manifest.id).toBe("pm2-manager");
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.view).toBe(false);
		expect(manifest.ui.topbar).toBeUndefined();
		for (const need of ["ui", "tools", "http"]) expect(manifest.permissions).toContain(need);
		expect(manifest.settings.map((s: { key: string }) => s.key)).toEqual(["guardMode", "pm2Bin"]);
	});

	it("ui 经服务端解析出唯一的 tasks.panel 视图条目（内嵌渲染）", () => {
		const parsed = parseUiContributions(manifest.ui) as { items: any[]; arrange: any[] };
		expect(parsed.items).toHaveLength(1);
		const item = parsed.items[0];
		expect(item.slot).toBe("tasks.panel");
		expect(item.kind).toBe("view");
		expect(item.view).toBe("plugin:pm2-manager");
		expect(item.label).toBeTruthy();
		expect(item.labelEn).toBeTruthy();
	});
});

// ──────────────────────────────────────────────────────────── 裸后台启动识别

describe("pm2-manager 裸后台启动识别", () => {
	it("拦下所有脱离管理面的写法", () => {
		for (const cmd of [
			"nohup npm run dev > /tmp/out.log 2>&1",
			"node server.js &",
			"npm run dev > /dev/null 2>&1 &",
			"setsid python -m http.server 8080",
			"disown -a",
			"start /b node app.js",
			"Start-Process node -ArgumentList 'server.js'",
		]) {
			const hit = detectDetachedLaunch(cmd);
			expect(hit, `应拦下：${cmd}`).not.toBeNull();
			expect(hit!.reason).toBeTruthy();
			expect(hit!.reasonEn).toBeTruthy();
		}
	});

	it("放行 pm2 托管、#bg-ok 逃生门与纯等待类命令", () => {
		for (const cmd of [
			"pm2 start server.js --name api",
			"npx pm2 list",
			"pnpm exec pm2 restart api",
			"nohup npm run dev & #bg-ok",
			"sleep 30 &",
			"sleep 2 && wait",
			"npm run build",
			'node -e "setTimeout(()=>{},1)" 2>&1',
			"npm ci",
		]) {
			expect(detectDetachedLaunch(cmd), `应放行：${cmd}`).toBeNull();
		}
	});

	it("只是「提到」这些词的命令不拦（命令位置匹配，不是子串匹配）", () => {
		for (const cmd of [
			`grep -rn nohup docs/`,
			`powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*nohup-probe*' }"`,
			`git log --grep=disown -n 5`,
			`rg setsid server/`,
		]) {
			expect(detectDetachedLaunch(cmd), `应放行：${cmd}`).toBeNull();
		}
	});

	it("命令位置的这些词照拦（含 && 段与前缀 sudo/env）", () => {
		for (const cmd of [
			`nohup node server.js`,
			`cd /srv && nohup node server.js > out.log 2>&1`,
			`sudo nohup node server.js`,
			`env nohup node server.js`,
			`setsid node server.js`,
			`disown -a`,
		]) {
			expect(detectDetachedLaunch(cmd), `应拦下：${cmd}`).not.toBeNull();
		}
	});

	it("空/非字符串输入安全放行", () => {
		expect(detectDetachedLaunch("")).toBeNull();
		expect(detectDetachedLaunch("   ")).toBeNull();
		expect(detectDetachedLaunch(undefined as unknown as string)).toBeNull();
		expect(detectDetachedLaunch({} as unknown as string)).toBeNull();
	});

	it("isWaitOnlyCommand 只认等待类命令", () => {
		expect(isWaitOnlyCommand("sleep 30 &")).toBe(true);
		expect(isWaitOnlyCommand("sleep 5; wait")).toBe(true);
		expect(isWaitOnlyCommand("echo hi &")).toBe(true);
		expect(isWaitOnlyCommand("npm run dev &")).toBe(false);
		expect(isWaitOnlyCommand("sleep 5 && npm run dev")).toBe(false);
	});

	it("逃生门标记是稳定常量（README/提示词里引用的同一份）", () => {
		expect(ESCAPE_MARK).toBe("#bg-ok");
	});
});

// ──────────────────────────────────────────────────────────── pm2 入口与解析

describe("pm2-manager pm2 入口候选与 jlist", () => {
	it("环境变量优先，其次 node 前缀布局，且去重", () => {
		const list = pm2EntryCandidates({
			execPath: "/usr/local/bin/node",
			env: { PI_WEB_PM2: "/opt/pm2/bin/pm2" },
		});
		expect(list[0]).toEqual({ bin: "/opt/pm2/bin/pm2", source: "env:PI_WEB_PM2" });
		expect(list.some((c) => c.bin === join("/usr/local/bin", "node_modules", "pm2", "bin", "pm2"))).toBe(true);
		const bins = list.map((c) => c.bin);
		expect(new Set(bins).size).toBe(bins.length);
	});

	it("无 execPath / 无 env 时返回空数组（不抛错）", () => {
		expect(pm2EntryCandidates()).toEqual([]);
		expect(pm2EntryCandidates({ execPath: "", env: {} })).toEqual([]);
	});

	const jlist = [
		{
			name: "api",
			pid: 4242,
			monit: { cpu: 12, memory: 188743680 },
			pm2_env: {
				status: "online",
				restart_time: 3,
				pm_uptime: 1_700_000_000_000,
				pm_exec_path: "/srv/api/server.js",
				pm_cwd: "/srv/api",
				exec_mode: "fork",
			},
		},
		{ name: "worker", pid: 0, monit: {}, pm2_env: { status: "stopped" } },
		{ nope: true },
	];

	it("jlist 归一化：缺字段回落，无名条目丢弃", () => {
		const apps = parsePm2List(jlist);
		expect(apps).toHaveLength(2);
		expect(apps[0]).toMatchObject({ name: "api", status: "online", cpu: 12, restarts: 3, mode: "fork" });
		expect(apps[1]).toMatchObject({ name: "worker", status: "stopped", cpu: 0, memory: 0, restarts: 0 });
	});

	it("jlist 输出解析容忍 ANSI 与前置噪声，坏输入回空数组", () => {
		const noisy = `\u001B[32m[PM2]\u001B[39m dumping\n${JSON.stringify(jlist)}`;
		expect(parsePm2ListOutput(noisy).map((a) => a.name)).toEqual(["api", "worker"]);
		expect(parsePm2ListOutput("not json at all")).toEqual([]);
		expect(parsePm2ListOutput("")).toEqual([]);
		expect(parsePm2List(null)).toEqual([]);
		expect(stripAnsi("\u001B[31mred\u001B[39m")).toBe("red");
	});

	it("格式化：字节/时长/状态行/工具行", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(188743680)).toBe("180 MB");
		const now = 1_700_000_000_000 + 3 * 3600_000 + 12 * 60_000;
		expect(formatUptime(1_700_000_000_000, now)).toBe("3h12m");
		expect(formatUptime(now + 1000, now)).toBe("—");
		const status = formatAppStatus(
			{ status: "online", cpu: 12, memory: 188743680, restarts: 3, startedAt: 1_700_000_000_000 },
			now,
		);
		expect(status).toContain("online");
		expect(status).toContain("CPU 12%");
		expect(status).toContain("↻3");
		expect(formatAppStatus({ status: "stopped", restarts: 0 })).toBe("stopped");
		const line = formatAppLine(
			{
				name: "api",
				status: "online",
				pid: 42,
				cpu: 1,
				memory: 1024,
				restarts: 0,
				startedAt: now - 5000,
				script: "/srv/a.js",
			},
			now,
		);
		expect(line).toContain("api [online]");
		expect(line).toContain("script=/srv/a.js");
	});
});

// ──────────────────────────────────────────────────────────── activate（假宿主）

describe("pm2-manager activate", () => {
	function activate(settings: Record<string, unknown> = {}) {
		const host = createMockHost({ settings });
		const deactivate = pm2Plugin.activate(host as any);
		cleanups.push(() => deactivate?.());
		return host;
	}

	it("注册 pm2 工具：提示词三处齐备、纯英文、长度合规", () => {
		const host = activate();
		const tools = host.mock.agentTools;
		expect(tools.map((t: any) => t.name)).toEqual(["pm2"]);
		const tool = tools[0] as any;
		expect(tool.description.length).toBeLessThanOrEqual(600);
		expect(/[\u4e00-\u9fff]/.test(tool.description)).toBe(false);
		expect(tool.promptSnippet.length).toBeLessThanOrEqual(80);
		expect(tool.promptSnippet.startsWith("pm2")).toBe(false);
		expect(tool.promptGuidelines.length).toBeGreaterThan(0);
		for (const g of tool.promptGuidelines) {
			expect(g.length).toBeLessThanOrEqual(200);
			expect(/[\u4e00-\u9fff]/.test(g)).toBe(false);
		}
		expect(tool.parameters.properties.action.enum).toContain("start");
	});

	it("闸门默认拒绝裸后台启动，并指路 pm2", async () => {
		const host = activate({ guardMode: "deny" });
		const guard = async (command: string, toolName = "bash") =>
			(await host.mock.emitAsync("onToolPre", { toolName, params: { command } }))[0] as any;
		const deny = await guard("npm run dev &");
		expect(deny?.decision).toBe("deny");
		expect(deny.reason).toContain("pm2");
		expect(deny.reasonEn).toBeTruthy();
		expect(await guard("pm2 list")).toBeNull();
		expect(await guard("npm run build")).toBeNull();
		expect(await guard("x &", "read")).toBeNull();
	});

	it("guardMode=off 时完全不拦", async () => {
		const host = activate({ guardMode: "off" });
		const out = await host.mock.emitAsync("onToolPre", { toolName: "bash", params: { command: "nohup node a.js &" } });
		expect(out[0]).toBeNull();
	});

	it("不给每个应用注册宿主后台任务（面板里已内嵌同一份表，注册会列两遍）", () => {
		const host = activate();
		expect(host.calls.some((c) => c.method === "registerBackgroundTask")).toBe(false);
	});

	it("挂上三个 HTTP 路由（遗留实例扫描已交给宿主面板，不再自带）", () => {
		const host = activate();
		const keys = (host.mock.routes as Array<{ method: string; path: string }>)
			.map((r) => `${r.method} ${r.path}`)
			.sort();
		expect(keys).toEqual(["GET /status", "POST /action", "POST /install"]);
	});

	it("停用后注销工具与闸门（不留悬挂项）", async () => {
		const host = createMockHost({ settings: {} });
		const deactivate = pm2Plugin.activate(host as any);
		expect(host.mock.agentTools).toHaveLength(1);
		deactivate?.();
		expect(host.mock.agentTools).toHaveLength(0);
		expect(host.mock.routes).toHaveLength(0);
		const out = await host.mock.emitAsync("onToolPre", { toolName: "bash", params: { command: "npm run dev &" } });
		expect(out).toEqual([]);
	});
});
