/**
 * lsp-tool.ts — 导出给 AI Agent 的原生 LSP 语言服务器工具（Native Opt-in LSP Tool）。
 *
 * 核心设计：
 * - 零重型外部依赖：基于 Node.js 标准流与原生 JSON-RPC 2.0 实现轻量级 LSP 客户端。
 * - 多会话共享池（Project-level Pool）：同项目多会话与并发子代理复用同一个后台语言服务器实例，
 *   避免多子代理重复拉起语言服务器导致内存爆炸（参考 omp 的 lspmux 理念）。
 * - 支持 4 大核心语义动作：
 *   1. definition：跳转到符号定义位置（支持展示定义代码片段）；
 *   2. references：列出工作区内所有引用/调用处；
 *   3. hover：获取类型签名与文档说明（Docstring/Markdown）；
 *   4. diagnostics：获取文件或项目的实时编译与类型检查错误。
 * - 闲置自动回收：15 分钟无请求自动休眠退出，释放系统内存。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const LSP_TOOL_NAME = "lsp";

export type LspAction = "definition" | "references" | "hover" | "diagnostics";

interface LspDiagnostic {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	severity?: number; // 1 = Error, 2 = Warning, 3 = Info, 4 = Hint
	message: string;
	source?: string;
	code?: string | number;
}

interface LspLocation {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

interface LanguageServerConfig {
	languageId: string;
	commands: Array<{ bin: string; args: string[]; installHint: string; npmPackage?: string }>;
}

const LANGUAGE_SERVER_CATALOG: Record<string, LanguageServerConfig> = {
	ts: {
		languageId: "typescript",
		commands: [
			{
				bin: "vtsls",
				args: ["--stdio"],
				installHint: "npm install -g @vtsls/language-server",
				npmPackage: "@vtsls/language-server typescript",
			},
			{
				bin: "typescript-language-server",
				args: ["--stdio"],
				installHint: "npm install -g typescript-language-server typescript",
				npmPackage: "typescript-language-server typescript",
			},
		],
	},
	js: {
		languageId: "javascript",
		commands: [
			{
				bin: "vtsls",
				args: ["--stdio"],
				installHint: "npm install -g @vtsls/language-server",
				npmPackage: "@vtsls/language-server typescript",
			},
			{
				bin: "typescript-language-server",
				args: ["--stdio"],
				installHint: "npm install -g typescript-language-server typescript",
				npmPackage: "typescript-language-server typescript",
			},
		],
	},
	py: {
		languageId: "python",
		commands: [
			{
				bin: "pyright-langserver",
				args: ["--stdio"],
				installHint: "npm install -g pyright",
				npmPackage: "pyright",
			},
			{ bin: "pyright", args: ["--stdio"], installHint: "pip install pyright" },
			{ bin: "pylsp", args: [], installHint: "pip install python-lsp-server" },
		],
	},
	rs: {
		languageId: "rust",
		commands: [{ bin: "rust-analyzer", args: [], installHint: "rustup component add rust-analyzer" }],
	},
	go: {
		languageId: "go",
		commands: [{ bin: "gopls", args: ["serve"], installHint: "go install golang.org/x/tools/gopls@latest" }],
	},
	c: {
		languageId: "c",
		commands: [{ bin: "clangd", args: [], installHint: "Install LLVM/clangd from package manager" }],
	},
	cpp: {
		languageId: "cpp",
		commands: [{ bin: "clangd", args: [], installHint: "Install LLVM/clangd from package manager" }],
	},
};

function getLanguageForPath(filePath: string): { langKey: string; config: LanguageServerConfig } | null {
	const ext = extname(filePath).toLowerCase().replace(/^\./, "");
	if (["ts", "tsx", "mts", "cts"].includes(ext)) return { langKey: "ts", config: LANGUAGE_SERVER_CATALOG.ts };
	if (["js", "jsx", "mjs", "cjs"].includes(ext)) return { langKey: "js", config: LANGUAGE_SERVER_CATALOG.js };
	if (["py", "pyi"].includes(ext)) return { langKey: "py", config: LANGUAGE_SERVER_CATALOG.py };
	if (ext === "rs") return { langKey: "rs", config: LANGUAGE_SERVER_CATALOG.rs };
	if (ext === "go") return { langKey: "go", config: LANGUAGE_SERVER_CATALOG.go };
	if (["c", "h"].includes(ext)) return { langKey: "c", config: LANGUAGE_SERVER_CATALOG.c };
	if (["cpp", "cc", "cxx", "hpp", "hxx"].includes(ext)) return { langKey: "cpp", config: LANGUAGE_SERVER_CATALOG.cpp };
	return null;
}

/** 二进制探测结果的内存缓存（cwd + cmd 为 key；用户态安装成功后按包失效） */
const resolveBinaryCache = new Map<string, string | null>();

export function clearResolveBinaryCache(): void {
	resolveBinaryCache.clear();
}

/** 探测二进制是否可在当前系统执行（优先项目本地、Pi 生态共享目录、用户态托管目录、系统 PATH） */
export function resolveBinary(cmd: string, cwd: string): string | null {
	const cacheKey = `${cwd}::${cmd}`;
	const cached = resolveBinaryCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const found = resolveBinaryUncached(cmd, cwd);
	resolveBinaryCache.set(cacheKey, found);
	return found;
}

function resolveBinaryUncached(cmd: string, cwd: string): string | null {
	const isWin = process.platform === "win32";
	const exts = isWin ? [".cmd", ".exe", ".bat", ""] : [""];

	if (isAbsolute(cmd)) {
		if (existsSync(cmd)) return cmd;
		if (isWin) {
			for (const ext of exts) {
				if (ext && existsSync(cmd + ext)) return cmd + ext;
			}
		}
		return null;
	}

	// 1. 本地 workspace node_modules/.bin 优先
	const localBinDir = resolve(cwd, "node_modules", ".bin");
	for (const ext of exts) {
		const target = join(localBinDir, cmd + ext);
		if (existsSync(target)) return target;
	}

	// 2. Pi 生态工具与用户态目录（pi-lens / pi-web 用户态托管，零权限直接复用）
	const home = homedir();
	const sharedDirs = [
		join(home, ".pi-lens", "tools", "node_modules", ".bin"),
		join(home, ".pi-web", "lsp-servers", "node_modules", ".bin"),
		join(home, ".pi", "agent", "tools", "node_modules", ".bin"),
	];
	for (const sharedDir of sharedDirs) {
		for (const ext of exts) {
			const target = join(sharedDir, cmd + ext);
			if (existsSync(target)) return target;
		}
	}

	// 3. 遍历系统 PATH 目录（纯文件系统检查，零子进程开销、杜绝 Windows cmd.exe 引号卡死）
	const pathDirs = (process.env.PATH || "").split(delimiter);
	for (const dir of pathDirs) {
		if (!dir) continue;
		for (const ext of exts) {
			const target = join(dir, cmd + ext);
			if (existsSync(target)) return target;
		}
	}

	return null;
}

const installTasks = new Map<string, Promise<boolean>>();
/** 安装失败的负缓存（pkg -> 失败时间戳）：失败后 5 分钟内不再重复执行 120s 的 npm install */
const installFailedAt = new Map<string, number>();
const INSTALL_FAIL_NEGATIVE_CACHE_MS = 5 * 60 * 1000;

/**
 * 在用户专属目录（~/.pi-web/lsp-servers）执行无侵入、免 sudo/root 的语言服务包按需安装。
 * 注意：必须经用户显式授权（lsp 工具的 allowInstall 参数）后才能调用，不得静默触发。
 */
export async function autoInstallLanguageServer(pkg: string): Promise<boolean> {
	const existing = installTasks.get(pkg);
	if (existing) return existing;
	const failedAt = installFailedAt.get(pkg);
	if (failedAt !== undefined && Date.now() - failedAt < INSTALL_FAIL_NEGATIVE_CACHE_MS) {
		console.warn(`[LSP] Skip auto-install for ${pkg}: failed recently, retry later with allowInstall`);
		return false;
	}

	const task = (async () => {
		try {
			const userLspDir = join(homedir(), ".pi-web", "lsp-servers");
			console.warn(`[LSP] Installing language server [${pkg}] into ${userLspDir} (user-space, no sudo)…`);
			mkdirSync(userLspDir, { recursive: true });
			const pkgJson = join(userLspDir, "package.json");
			if (!existsSync(pkgJson)) {
				writeFileSync(pkgJson, JSON.stringify({ name: "pi-web-lsp-servers", private: true }) + "\n");
			}

			const pkgs = pkg.split(/\s+/).filter(Boolean);
			const isWin = process.platform === "win32";
			const npmCmd = isWin ? "npm.cmd" : "npm";

			let stderr = "";
			await new Promise<void>((resolve, reject) => {
				const proc = spawn(npmCmd, ["install", "--no-audit", "--no-fund", "--save-dev", ...pkgs], {
					cwd: userLspDir,
					stdio: ["ignore", "ignore", "pipe"],
					shell: isWin,
				});
				const timer = setTimeout(() => {
					proc.kill();
					reject(new Error("npm install timed out"));
				}, 120_000);
				proc.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				proc.on("error", (err) => {
					clearTimeout(timer);
					reject(err);
				});
				proc.on("exit", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve();
					else reject(new Error(`npm install exited with code ${code}${stderr ? `: ${stderr.slice(-500)}` : ""}`));
				});
			});
			console.warn(`[LSP] Language server [${pkg}] installed, resolving binaries…`);
			// 新二进制落盘，探测缓存失效
			clearResolveBinaryCache();
			installFailedAt.delete(pkg);
			return true;
		} catch (err) {
			console.warn(`[LSP] Auto-install failed for ${pkg}: ${(err as Error).message}`);
			installFailedAt.set(pkg, Date.now());
			return false;
		} finally {
			installTasks.delete(pkg);
		}
	})();

	installTasks.set(pkg, task);
	return task;
}

// ----------------------------------------------------------------------------
// JSON-RPC 2.0 传输层与单项目 LSP 客户端
// ----------------------------------------------------------------------------

export class LspClient {
	private proc: ChildProcess | null = null;
	private nextId = 1;
	private pendingRequests = new Map<
		number,
		{ resolve: (res: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();
	private diagnosticsCache = new Map<string, LspDiagnostic[]>(); // fileUri -> diagnostics
	private openFiles = new Set<string>(); // fileUri
	private docVersions = new Map<string, number>(); // fileUri -> version
	private buffer = Buffer.alloc(0);
	private idleTimer: NodeJS.Timeout | null = null;
	private initialized = false;
	private isShuttingDown = false;

	constructor(
		public readonly projectCwd: string,
		public readonly langKey: string,
		public readonly binPath: string,
		public readonly binArgs: string[],
		public readonly languageId: string,
		private readonly onIdleEvict: () => void,
	) {}

	async start(): Promise<void> {
		this.touch();
		this.proc = spawn(this.binPath, this.binArgs, {
			cwd: this.projectCwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.binPath),
		});

		this.proc.stdout?.on("data", (chunk: Buffer) => this.handleData(chunk));
		this.proc.stderr?.on("data", (d: Buffer) => {
			// 可选记录 debug 日志，不干扰输出
		});

		this.proc.on("exit", (code) => {
			this.proc = null;
			this.rejectAllPending(new Error(`Language server exited with code ${code}`));
		});

		try {
			// 发送 initialize 握手
			const initRes = await this.request("initialize", {
				processId: process.pid,
				rootUri: pathToFileURL(this.projectCwd).toString(),
				workspaceFolders: [
					{
						name: "workspace",
						uri: pathToFileURL(this.projectCwd).toString(),
					},
				],
				capabilities: {
					textDocument: {
						synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
						definition: { dynamicRegistration: false },
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
						publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
					},
				},
			});

			this.notify("initialized", {});
			this.initialized = true;
		} catch (err) {
			if (this.proc) {
				try {
					this.proc.kill();
				} catch {}
				this.proc = null;
			}
			throw err;
		}
	}

	touch(): void {
		if (this.isShuttingDown) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		// 15 分钟无调用自动回收
		this.idleTimer = setTimeout(
			() => {
				this.shutdown().catch(() => {});
				this.onIdleEvict();
			},
			15 * 60 * 1000,
		);
		this.idleTimer.unref();
	}

	private handleData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const header = this.buffer.slice(0, headerEnd).toString("utf8");
			const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
			if (!lenMatch) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}

			const length = parseInt(lenMatch[1], 10);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) break;

			const bodyBuf = this.buffer.slice(bodyStart, bodyStart + length);
			this.buffer = this.buffer.slice(bodyStart + length);

			try {
				const msg = JSON.parse(bodyBuf.toString("utf8"));
				this.handleMessage(msg);
			} catch {}
		}
	}

	private handleMessage(msg: any): void {
		if (msg.id !== undefined) {
			if (msg.method) {
				// 服务端向客户端发起的请求（如 window/workDoneProgress/create, client/registerCapability）
				// 标准 JSON-RPC 必须回复 result: null，防止上游语言服务器挂起等待
				const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null });
				const wire = `Content-Length: ${Buffer.byteLength(reply, "utf8")}\r\n\r\n${reply}`;
				try {
					this.proc?.stdin?.write(wire);
				} catch {}
				return;
			}

			if (this.pendingRequests.has(msg.id)) {
				const { resolve, reject, timer } = this.pendingRequests.get(msg.id)!;
				clearTimeout(timer);
				this.pendingRequests.delete(msg.id);
				if (msg.error) {
					reject(new Error(msg.error.message || `LSP error ${msg.error.code}`));
				} else {
					resolve(msg.result);
				}
			}
		} else if (msg.method === "textDocument/publishDiagnostics") {
			const params = msg.params;
			if (params?.uri && Array.isArray(params?.diagnostics)) {
				this.diagnosticsCache.set(params.uri, params.diagnostics);
			}
		}
	}

	request(method: string, params: any, timeoutMs = 15000): Promise<any> {
		this.touch();
		if (!this.proc || !this.proc.stdin) {
			return Promise.reject(new Error("Language server is not running"));
		}

		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		const wire = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;

		return new Promise((res, rej) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				rej(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve: res, reject: rej, timer });
			this.proc!.stdin!.write(wire);
		});
	}

	notify(method: string, params: any): void {
		this.touch();
		if (!this.proc || !this.proc.stdin) return;
		const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
		const wire = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
		this.proc.stdin.write(wire);
	}

	async syncDocument(absPath: string): Promise<string> {
		const uri = pathToFileURL(absPath).toString();
		if (!existsSync(absPath)) return uri;
		const content = readFileSync(absPath, "utf8");

		if (!this.openFiles.has(uri)) {
			this.docVersions.set(uri, 1);
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: this.languageId,
					version: 1,
					text: content,
				},
			});
			this.openFiles.add(uri);
		} else {
			const nextVer = (this.docVersions.get(uri) ?? 1) + 1;
			this.docVersions.set(uri, nextVer);
			this.notify("textDocument/didChange", {
				textDocument: { uri, version: nextVer },
				contentChanges: [{ text: content }],
			});
		}
		return uri;
	}

	getDiagnostics(uri: string): LspDiagnostic[] {
		return this.diagnosticsCache.get(uri) ?? [];
	}

	getAllDiagnostics(): Map<string, LspDiagnostic[]> {
		return new Map(this.diagnosticsCache);
	}

	isAlive(): boolean {
		return Boolean(this.proc && !this.isShuttingDown);
	}

	private rejectAllPending(err: Error): void {
		for (const { reject, timer } of this.pendingRequests.values()) {
			clearTimeout(timer);
			reject(err);
		}
		this.pendingRequests.clear();
	}

	async shutdown(): Promise<void> {
		this.isShuttingDown = true;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (!this.proc) return;

		try {
			await this.request("shutdown", {}, 3000);
			this.notify("exit", {});
		} catch {}

		if (this.proc) {
			try {
				this.proc.kill();
			} catch {}
			this.proc = null;
		}
		this.rejectAllPending(new Error("LSP client shut down"));
	}
}

// ----------------------------------------------------------------------------
// 全局项目级语言服务器管理池（Project-Level LSP Pool）
// ----------------------------------------------------------------------------

class LspServerPool {
	private pool = new Map<string, LspClient>(); // key: `${cwd}::${langKey}`
	private inFlight = new Map<string, Promise<{ client: LspClient } | { error: string }>>();
	private shuttingDown = false;

	hasAliveClient(projectCwd: string, filePath: string): boolean {
		const langInfo = getLanguageForPath(filePath);
		if (!langInfo) return false;
		const poolKey = `${projectCwd}::${langInfo.langKey}`;
		const client = this.pool.get(poolKey);
		return Boolean(client && client.isAlive());
	}

	async getClient(
		projectCwd: string,
		filePath: string,
		opts?: { allowInstall?: boolean },
	): Promise<{ client: LspClient } | { error: string }> {
		if (this.shuttingDown) {
			return { error: "LSP server pool is shutting down" };
		}

		const langInfo = getLanguageForPath(filePath);
		if (!langInfo) {
			return { error: `No language server mapping for file extension: ${extname(filePath)}` };
		}

		const poolKey = `${projectCwd}::${langInfo.langKey}`;
		const client = this.pool.get(poolKey);
		if (client) {
			client.touch();
			return { client };
		}

		const pending = this.inFlight.get(poolKey);
		if (pending) {
			return pending;
		}

		const task = (async () => {
			// 寻找可用命令
			let resolvedBin: string | null = null;
			let resolvedArgs: string[] = [];
			let hint = "";
			let autoPkg: string | undefined = undefined;

			for (const cmd of langInfo.config.commands) {
				const found = resolveBinary(cmd.bin, projectCwd);
				if (found) {
					resolvedBin = found;
					resolvedArgs = cmd.args;
					break;
				}
				hint = cmd.installHint;
				if (!autoPkg && cmd.npmPackage) autoPkg = cmd.npmPackage;
			}

			// 用户态按需安装必须经用户显式授权（allowInstall），避免在工具调用链里无提示联网 npm install
			if (!resolvedBin && autoPkg && opts?.allowInstall === true) {
				const ok = await autoInstallLanguageServer(autoPkg);
				if (ok) {
					for (const cmd of langInfo.config.commands) {
						const found = resolveBinary(cmd.bin, projectCwd);
						if (found) {
							resolvedBin = found;
							resolvedArgs = cmd.args;
							break;
						}
					}
				}
			}

			if (!resolvedBin) {
				const installGateHint = autoPkg
					? `\nOr retry this tool call with { "allowInstall": true } to install \`${autoPkg}\` into ~/.pi-web/lsp-servers (user-space, no sudo) automatically.`
					: "";
				return {
					error: `Language server for ${langInfo.config.languageId} not found.\nPlease install it: \`${hint}\`${installGateHint}`,
				};
			}

			const newClient = new LspClient(
				projectCwd,
				langInfo.langKey,
				resolvedBin,
				resolvedArgs,
				langInfo.config.languageId,
				() => {
					if (this.pool.get(poolKey) === newClient) {
						this.pool.delete(poolKey);
					}
				},
			);

			try {
				await newClient.start();
				if (this.shuttingDown) {
					await newClient.shutdown();
					return { error: "LSP server pool is shutting down" };
				}
				this.pool.set(poolKey, newClient);
				return { client: newClient };
			} catch (err) {
				return { error: `Failed to start ${langInfo.config.languageId} language server: ${(err as Error).message}` };
			} finally {
				this.inFlight.delete(poolKey);
			}
		})();

		this.inFlight.set(poolKey, task);
		return task;
	}

	async shutdownAll(): Promise<void> {
		this.shuttingDown = true;
		const inFlightTasks = [...this.inFlight.values()];
		this.inFlight.clear();
		await Promise.allSettled(inFlightTasks);
		const promises = [...this.pool.values()].map((c) => c.shutdown());
		this.pool.clear();
		await Promise.allSettled(promises);
	}
}

export const globalLspPool = new LspServerPool();

/**
 * 辅助函数：在文件改动后，若已有存活的语言服务器，获取即时编译报错（Writethrough Diagnostics）
 */
export async function getLiveLspDiagnostics(absPath: string, cwd: string): Promise<string | null> {
	if (!globalLspPool.hasAliveClient(cwd, absPath)) {
		return null;
	}
	const res = await globalLspPool.getClient(cwd, absPath);
	if ("error" in res) return null;

	const { client } = res;
	const uri = await client.syncDocument(absPath);
	// 稍等 80ms 让后台增量分析返回
	await new Promise((r) => setTimeout(r, 80));

	const diags = client.getDiagnostics(uri);
	const errors = diags.filter((d) => d.severity === 1 || !d.severity);
	if (errors.length === 0) return null;

	const rel = absPath.startsWith(cwd) ? absPath.slice(cwd.length).replace(/^[/\\]/, "") : absPath;
	const lines = errors.slice(0, 5).map((e) => {
		const line = e.range.start.line + 1;
		const col = e.range.start.character + 1;
		const code = e.code ? ` (${e.code})` : "";
		return `• ${rel}:${line}:${col} - ${e.message}${code}`;
	});

	return `⚠️ Post-edit Diagnostics (${errors.length} error${errors.length > 1 ? "s" : ""}):\n${lines.join("\n")}`;
}

// ----------------------------------------------------------------------------
// 导出给 AI Agent 的工具对象
// ----------------------------------------------------------------------------

export interface LspToolOptions {
	cwd: string;
	ownerId?: string;
}

export function makeLspTool(options: LspToolOptions) {
	const cwd = options.cwd;

	return defineTool({
		name: LSP_TOOL_NAME,
		label: "LSP code intelligence",
		description: `Query language intelligence from Language Server Protocol (LSP) across the workspace.
Provides IDE-grade semantic analysis to prevent guessing and hallucinating symbol references.
Supported actions:
- \`definition\`: Jump to definition of the symbol at \`line\` & \`character\` in \`path\` (returns file, line, and code snippet).
- \`references\`: Find all workspace references/usages of the symbol at \`line\` & \`character\` in \`path\`.
- \`hover\`: Get type signature and documentation (Docstring/Markdown) for symbol at \`line\` & \`character\`.
- \`diagnostics\`: Get compiler/type errors and warnings for \`path\` (or pass no line to check whole file).
Note: Line numbers are 1-indexed.`,
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("definition"), Type.Literal("references"), Type.Literal("hover"), Type.Literal("diagnostics")],
				{
					description: "The LSP operation to perform.",
				},
			),
			path: Type.String({
				description: "Workspace-relative or absolute path to the target source file.",
			}),
			line: Type.Optional(
				Type.Number({
					description: "1-indexed line number in the source file.",
				}),
			),
			character: Type.Optional(
				Type.Number({
					description: "1-indexed column/character position (defaults to 1).",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (defaults to 15).",
				}),
			),
			allowInstall: Type.Optional(
				Type.Boolean({
					description:
						"Allow installing the missing language server into ~/.pi-web/lsp-servers (user-space, no sudo). Defaults to false; when false and no server is found, the tool returns an installHint instead.",
				}),
			),
		}),
		async execute(
			_callId,
			params: {
				action: LspAction;
				path: string;
				line?: number;
				character?: number;
				timeout?: number;
				allowInstall?: boolean;
			},
			_signal,
			_onUpdate,
			_ctx,
		) {
			const action = params.action;
			const targetPath = params.path;
			const absPath = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
			const line = typeof params.line === "number" ? Math.max(1, params.line) : 1;
			const character = typeof params.character === "number" ? Math.max(1, params.character) : 1;
			const timeoutMs = (params.timeout ?? 15) * 1000;

			const rel = relative(cwd, absPath);
			if (
				rel === ".." ||
				rel.startsWith(".." + sep) ||
				rel.startsWith("../") ||
				rel.startsWith("..\\") ||
				isAbsolute(rel)
			) {
				return {
					content: [{ type: "text", text: `Error: Path traversal denied: ${targetPath} is outside workspace.` }],
					details: { ok: false, error: "Path traversal denied" },
				};
			}

			if (!existsSync(absPath)) {
				return {
					content: [{ type: "text", text: `Error: File not found: ${targetPath}` }],
					details: { ok: false, error: "File not found" },
				};
			}

			const clientRes = await globalLspPool.getClient(cwd, absPath, { allowInstall: params.allowInstall });
			if ("error" in clientRes) {
				return {
					content: [{ type: "text", text: `LSP Error: ${clientRes.error}` }],
					details: { ok: false, error: clientRes.error },
				};
			}

			const client = clientRes.client;
			const uri = await client.syncDocument(absPath);

			// 0-indexed positions for LSP protocol
			const position = {
				line: line - 1,
				character: character - 1,
			};

			try {
				if (action === "definition") {
					const result = await client.request(
						"textDocument/definition",
						{ textDocument: { uri }, position },
						timeoutMs,
					);
					const locs: LspLocation[] = Array.isArray(result) ? result : result ? [result] : [];

					if (locs.length === 0) {
						return {
							content: [{ type: "text", text: `No definition found for symbol at ${targetPath}:${line}:${character}` }],
							details: { ok: true, locations: [] },
						};
					}

					const formatted = locs.map((loc: any) => {
						const targetUri: string = loc.targetUri || loc.uri || "";
						let defPath = targetUri;
						try {
							if (targetUri.startsWith("file:")) {
								defPath = fileURLToPath(targetUri);
							}
						} catch {}

						const targetRange = loc.targetSelectionRange || loc.targetRange || loc.range;
						const defRel = defPath.startsWith(cwd) ? defPath.slice(cwd.length).replace(/^[/\\]/, "") : defPath;
						const defLine = (targetRange?.start?.line ?? 0) + 1;
						const defCol = (targetRange?.start?.character ?? 0) + 1;

						let snippet = "";
						if (existsSync(defPath)) {
							const fileLines = readFileSync(defPath, "utf8").split(/\r?\n/);
							const startL = Math.max(0, defLine - 1);
							const endL = Math.min(fileLines.length, defLine + 3);
							snippet = fileLines
								.slice(startL, endL)
								.map((l, idx) => `${startL + idx + 1}: ${l}`)
								.join("\n");
						}

						return `• ${defRel}:${defLine}:${defCol}\n\`\`\`\n${snippet}\n\`\`\``;
					});

					return {
						content: [{ type: "text", text: `Definitions (${locs.length}):\n\n${formatted.join("\n\n")}` }],
						details: { ok: true, locations: locs },
					};
				}

				if (action === "references") {
					const result = await client.request(
						"textDocument/references",
						{
							textDocument: { uri },
							position,
							context: { includeDeclaration: true },
						},
						timeoutMs,
					);
					const locs: LspLocation[] = Array.isArray(result) ? result : [];

					if (locs.length === 0) {
						return {
							content: [{ type: "text", text: `No references found for symbol at ${targetPath}:${line}:${character}` }],
							details: { ok: true, references: [] },
						};
					}

					const formatted = locs.slice(0, 25).map((loc) => {
						const refPath = fileURLToPath(loc.uri);
						const refRel = refPath.startsWith(cwd) ? refPath.slice(cwd.length).replace(/^[/\\]/, "") : refPath;
						const refLine = loc.range.start.line + 1;
						const refCol = loc.range.start.character + 1;
						return `• ${refRel}:${refLine}:${refCol}`;
					});

					const tail = locs.length > 25 ? `\n... and ${locs.length - 25} more references` : "";

					return {
						content: [
							{
								type: "text",
								text: `Found ${locs.length} reference${locs.length > 1 ? "s" : ""}:\n${formatted.join("\n")}${tail}`,
							},
						],
						details: { ok: true, count: locs.length, references: locs },
					};
				}

				if (action === "hover") {
					const result = await client.request("textDocument/hover", { textDocument: { uri }, position }, timeoutMs);
					if (!result || !result.contents) {
						return {
							content: [{ type: "text", text: `No hover information available at ${targetPath}:${line}:${character}` }],
							details: { ok: true, hover: null },
						};
					}

					let hoverText = "";
					const c = result.contents;
					if (typeof c === "string") {
						hoverText = c;
					} else if (Array.isArray(c)) {
						hoverText = c.map((item) => (typeof item === "string" ? item : item.value)).join("\n\n");
					} else if (typeof c === "object" && c.value) {
						hoverText = c.value;
					}

					return {
						content: [{ type: "text", text: hoverText ? `Hover Info:\n${hoverText}` : "Empty hover information" }],
						details: { ok: true, hover: result },
					};
				}

				if (action === "diagnostics") {
					// 给予极短缓冲以确保 publishDiagnostics 缓存已收到
					await new Promise((r) => setTimeout(r, 120));
					const diags = client.getDiagnostics(uri);

					if (diags.length === 0) {
						return {
							content: [{ type: "text", text: `No diagnostics (clean): ${targetPath}` }],
							details: { ok: true, diagnostics: [] },
						};
					}

					const formatted = diags.slice(0, 30).map((d) => {
						const sev = d.severity === 1 ? "ERROR" : d.severity === 2 ? "WARN" : "INFO";
						const startLine = d.range.start.line + 1;
						const startCol = d.range.start.character + 1;
						const code = d.code ? ` [${d.code}]` : "";
						return `[${sev}] line ${startLine}:${startCol}${code} - ${d.message}`;
					});

					return {
						content: [
							{
								type: "text",
								text: `Diagnostics for ${targetPath} (${diags.length}):\n${formatted.join("\n")}`,
							},
						],
						details: { ok: true, diagnostics: diags },
					};
				}

				return {
					content: [{ type: "text", text: `Unsupported action: ${action}` }],
					details: { ok: false, error: "Unsupported action" },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `LSP request failed: ${(err as Error).message}` }],
					details: { ok: false, error: (err as Error).message },
				};
			}
		},
	});
}
