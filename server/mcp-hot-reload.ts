/**
 * `mcp.json` 热加载 —— 改完文件即生效，不必再重启 pi-web-ui。
 *
 * 为什么是「盯文件」而不是加协议消息 / 设置面板按钮：`mcp.json` 是用文本编辑器手改的
 * 外部文件（README 一直写着「改完要重启」），没有任何 UI 参与保存；监视文件是唯一不需要
 * 新增协议字段与多语言文案的形态（对照 `reload_models_config`：它有设置面板按钮，所以走协议）。
 *
 * 三条不变量（都有回归用例）：
 *  1. **内容没变就不动任何子进程**：指纹按「规范化后的服务器集合」算（服务器顺序无关、
 *     只看影响行为的字段）—— 编辑器保存、重排键、改缩进都不触发重启；
 *  2. **配置写坏不停掉在跑的服务器**：JSON 解析失败只记日志 + 提示一次，绝不碰现有实例
 *     （保存过程中的半写状态很常见）；
 *  3. **删掉文件 = 清空配置**：与「坏配置」区分开 —— 用户删掉 `mcp.json` 是有意关掉全部
 *     MCP 服务器，照常应用。
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { mcpServerSnapshot, parseMcpConfig, type McpReloadSummary, type McpServerSpec } from "./mcp-bridge.js";

/** 一次「文件 → 运行时」应用的结果。 */
export type McpReloadOutcome =
	| "reloaded" // 配置变了，已换入
	| "unchanged" // 与上次应用的内容一致，什么都没做
	| "invalid"; // 解析失败，保留在跑的服务器

export interface McpHotReloadDeps {
	dataDir: string;
	/** 应用新配置（`McpBridge.reload`）：每个服务器的启动失败由它自己消化，不该向这里抛。 */
	reload: () => Promise<McpReloadSummary>;
	/** 工具集合变化后推入已有会话（`service.applyPluginAgentTools`）——「工具列表热刷新」那一半。 */
	onToolsChanged?: () => void;
	/** 面向用户的通知条：坏配置与加载完成都要让人看见，不只是打在服务端日志里。 */
	onNotice?: (level: "info" | "warning", text: string, textEn: string) => void;
	log?: (...a: unknown[]) => void;
	/** 事件防抖（编辑器保存常触发多次）。 */
	debounceMs?: number;
	/** `fs.watch` 不可用时（目录不存在 / 网络盘 / 容器）的轮询间隔。 */
	pollIntervalMs?: number;
}

export interface McpHotReload {
	/** 读文件 → 比对指纹 → 必要时热替换。可直接调用（测试 / 手动重载）。 */
	apply(): Promise<McpReloadOutcome>;
	/** 播种指纹（启动时 `McpBridge.load()` 已按同一份文件启动过）并开始监视。 */
	start(): void;
	dispose(): void;
}

/** 规范化指纹：只含影响行为的字段、服务器顺序无关 —— 「内容变了吗」的判据。 */
function fingerprint(servers: Record<string, McpServerSpec>): string {
	const names = Object.keys(servers).sort();
	return JSON.stringify(names.map((n) => [n, mcpServerSnapshot(servers[n])]));
}

export function createMcpHotReload(deps: McpHotReloadDeps): McpHotReload {
	const file = join(deps.dataDir, "mcp.json");
	const log = deps.log ?? (() => {});
	const debounceMs = deps.debounceMs ?? 300;
	const pollIntervalMs = deps.pollIntervalMs ?? 2000;
	/** 上次应用到运行时的内容指纹；null = 还没播种。 */
	let applied: string | null = null;
	let debounce: NodeJS.Timeout | null = null;
	let poller: NodeJS.Timeout | null = null;
	let watcher: FSWatcher | null = null;

	/** 读一次磁盘：指纹 + 清单（`servers` 为 null = 坏配置/读失败）。文件不在按「没有服务器」算。 */
	function readOnce(): { fp: string; servers: Record<string, McpServerSpec> | null } {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch (err) {
			// 不变量 3 只覆盖「文件不在」：删掉 mcp.json = 关掉全部 MCP 服务器。
			// #497：EBUSY/EACCES 等临时读失败（OneDrive/杀毒独占、权限误改）既不是
			// 坏配置也不是删除意图——按坏配置口径走（servers: null → 保留在跑的
			// 服务器 + 一次性提示），否则会把在跑的 MCP 服务器全杀还报「成功 0 个」。
			const code = (err as NodeJS.ErrnoException | null)?.code;
			if (code === "ENOENT") return { fp: "empty", servers: {} };
			log(`[mcp] mcp.json 读取失败（${code ?? String(err)}），按坏配置处理：保留在跑的 MCP 服务器`);
			return { fp: `unreadable:${code ?? "unknown"}`, servers: null };
		}
		const parsed = parseMcpConfig(raw);
		if (!parsed) return { fp: `invalid:${raw}`, servers: null };
		return { fp: `ok:${fingerprint(parsed.servers)}`, servers: parsed.servers };
	}

	async function apply(): Promise<McpReloadOutcome> {
		const { fp, servers } = readOnce();
		if (fp === applied) return "unchanged";
		// 先记账再动手：同一个坏文件不反复刷屏，配置没再变也不重试。
		applied = fp;
		if (!servers) {
			log("[mcp] mcp.json 解析失败，保留在跑的 MCP 服务器");
			deps.onNotice?.(
				"warning",
				"mcp.json 解析/读取失败，已保留当前 MCP 服务器（恢复可读后会自动重载）",
				"Failed to parse/read mcp.json — keeping the running MCP servers (it reloads automatically once readable)",
			);
			return "invalid";
		}
		const summary = await deps.reload();
		deps.onToolsChanged?.();
		log(
			`[mcp] 配置已热加载：${summary.servers} 个服务器 / ${summary.tools} 个工具` +
				`（沿用 ${summary.kept}、启动 ${summary.started}、关闭 ${summary.stopped}、失败 ${summary.failed}）`,
		);
		deps.onNotice?.(
			"info",
			`mcp.json 已热加载：${summary.servers} 个服务器 / ${summary.tools} 个工具`,
			`mcp.json reloaded: ${summary.servers} server(s) / ${summary.tools} tool(s)`,
		);
		return "reloaded";
	}

	function run(): void {
		void apply().catch((err) => log("[mcp] 热加载失败：", err instanceof Error ? err.message : err));
	}

	function schedule(): void {
		if (debounce) return;
		debounce = setTimeout(() => {
			debounce = null;
			run();
		}, debounceMs);
	}

	/** fs.watch 用不了（目录还不存在、网络盘、容器）→ 回落到轮询：单文件不值得上更重的机制。 */
	function fallBackToPolling(): void {
		watcher?.close();
		watcher = null;
		if (poller) return;
		log(`[mcp] 目录监视不可用，mcp.json 热加载回落到 ${pollIntervalMs}ms 轮询`);
		poller = setInterval(run, pollIntervalMs);
		poller.unref();
	}

	function start(): void {
		if (watcher || poller) return;
		// 播种：启动时 load() 已按同一份文件启动过服务器，别在第一个事件里白重载一次。
		applied = readOnce().fp;
		try {
			watcher = watch(deps.dataDir, { persistent: false }, (_event, filename) => {
				// 有些平台/编辑器（保存 = 临时文件 + rename）给不出文件名，拿不到就当命中。
				if (typeof filename === "string" && filename && filename !== "mcp.json") return;
				schedule();
			});
			watcher.on("error", () => fallBackToPolling());
		} catch {
			fallBackToPolling();
		}
	}

	function dispose(): void {
		if (debounce) clearTimeout(debounce);
		debounce = null;
		if (poller) clearInterval(poller);
		poller = null;
		watcher?.close();
		watcher = null;
	}

	return { apply, start, dispose };
}
