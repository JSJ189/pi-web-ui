/**
 * 插件宿主设施：插件私有 KV 存储 + 加密 secrets，从 plugins.ts 抽出的纯设施。
 *
 * storage —— <pluginDir>/storage.json 单文件 JSON KV：
 *   - 全内存缓存、写入 tmp+rename 原子落盘（同 client-state.ts 的做法）；
 *   - 供插件存非敏感配置（窗口布局、上次选中项…），替代各家手搓的
 *     read/write config.json 样板；
 *   - 生命周期跟插件目录绑定（uninstall 即删除），跨升级保留。
 *
 * secrets —— AES-256-GCM 加密的机密存储（密码/API key/token）：
 *   - 密钥文件 <dataDir>/secrets.key（随机 32 字节，首次生成；chmod 0600 仅对
 *     POSIX 有意义，Windows 上 NTFS 权限继承用户目录默认 ACL）；
 *   - 密文文件随插件目录 <pluginDir>/secrets.bin——拷到别的机器因无密钥解不开
 *     （fail closed）；卸载插件即连密文一起删除；
 *   - 威胁模型：防「 casually 复制/查看文件」（混淆级保护）与「密文外泄」，
 *     不能防同一用户账号下的完整进程妥协——本地个人工具的合理折衷。
 */
import { existsSync, readFileSync } from "node:fs";
import {
	readFile as fspReadFile,
	readdir as fspReaddir,
	rm as fspRm,
	mkdir as fspMkdir,
	writeFile as fspWriteFile,
	appendFile as fspAppendFile,
	stat as fspStat,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { writeAtomicSync } from "./atomic-file.js";
import { SETTINGS_SECRETS_KEY } from "./plugin-secrets.js";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
// 与 plugin-project 共用同一套 realpath 越界复核（isInsideRoot / realPathOfNearest），
// 避免「同一个安全语义、两份实现」漂移。
import { isInsideRoot, realPathOfNearest } from "./plugin-project.js";

/** tmp+rename 原子写（错误由调用方隔离——插件设施的 IO 一律尽力而为）。 */
function atomicWrite(file: string, data: string): void {
	writeAtomicSync(file, data);
}

// ---------------------------------------------------------------------------
// storage.json 的进程内「读-改-写」互斥
// ---------------------------------------------------------------------------

/** 按文件路径的 RMW 互斥链（key = resolve 后的绝对路径）。 */
const rmwChains = new Map<string, Promise<unknown>>();

/**
 * 进程内「读-改-写」互斥（按文件路径的 promise 链锁）。
 *
 * storage.json 有两个读-改-写者：PluginStorage（插件 KV）与宿主 settings 面板的
 * saveSettingsValues（plugins.ts，直写同一文件的 settings 键）。两段 RMW 必须互斥
 * —— 现在两段关键区都是同步的（单线程下本就不会交错），但只要将来任何一处把
 * 「读」和「写」之间插进 await，就会退回「旧快照整份回写、抹掉对方刚写的键」的
 * 丢更新。两处统一收进这把锁：
 *  - 空链 + 同步 fn：原地直跑（不引入微任务延迟，set() 后同步 get() 立即可见，
 *    语义与未加锁完全一致）；fn 若返回 promise（异步写者）则占住链尾，后续排队；
 *  - 链忙：挂到链尾串行（前一个成功/失败都放行下一个）。
 * 每个链尾完成后仅在仍是当前尾部时清理，避免删掉后续排队任务的锁。
 */
/** Synchronous settings commits cannot report success while queued behind an async writer. */
export function withFileRmwLockSync<T>(file: string, fn: () => T): T {
	if (rmwChains.has(resolve(file))) throw new Error("Plugin storage is busy; retry settings save");
	return fn();
}

export function withFileRmwLock<T>(file: string, fn: () => T): T | Promise<T> {
	const key = resolve(file);
	const prev = rmwChains.get(key);
	const result = prev ? (prev.then(fn, fn) as Promise<T>) : fn();
	if (result instanceof Promise) {
		const tail = result
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				if (rmwChains.get(key) === tail) rmwChains.delete(key);
			});
		rmwChains.set(key, tail);
		// Return after cleanup, preserving the caller's result or rejection.
		return tail.then(() => result);
	}
	return result;
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/** 每插件的同步 JSON KV。读写都重读权威文件，拒绝损坏/不可读文件；
 * 写入使用独立候选，原子提交成功后才发布缓存。同步 API 遇异步写锁占用直接抛错。 */
export class PluginStorage {
	private cache: Record<string, unknown> | undefined;
	/** Only ENOENT means an empty store; unreadable or malformed data must never be overwritten. */
	constructor(private readonly file: string) {}

	private readFromDisk(): Record<string, unknown> {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw err;
		}
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid plugin storage");
		return parsed as Record<string, unknown>;
	}

	private load(): Record<string, unknown> {
		// Re-read to observe settings commits even when filesystem timestamps are unchanged.
		const committed = this.readFromDisk();
		this.cache = committed;
		return this.cache;
	}

	private commit(candidate: Record<string, unknown>): void {
		const serialized = JSON.stringify(candidate);
		const committed = JSON.parse(serialized) as Record<string, unknown>;
		atomicWrite(this.file, serialized);
		this.cache = committed;
	}

	get<T>(key: string, fallback?: T): T | undefined {
		if (key === SETTINGS_SECRETS_KEY) return fallback;
		const v = this.load()[key];
		return v === undefined ? fallback : (v as T);
	}

	all(): Record<string, unknown> {
		return Object.fromEntries(Object.entries(this.load()).filter(([key]) => key !== SETTINGS_SECRETS_KEY));
	}

	set(key: string, value: unknown): void {
		if (!key) throw new Error("storage.set: key 不能为空");
		if (key === SETTINGS_SECRETS_KEY) throw new Error("Reserved plugin storage key");
		withFileRmwLockSync(this.file, () => {
			const candidate = { ...this.readFromDisk(), [key]: value };
			this.commit(candidate);
		});
	}

	has(key: string): boolean {
		return key !== SETTINGS_SECRETS_KEY && key in this.load();
	}

	keys(): string[] {
		return Object.keys(this.load()).filter((key) => key !== SETTINGS_SECRETS_KEY);
	}

	clear(preserveSettings = true): void {
		withFileRmwLockSync(this.file, () => {
			const store = this.readFromDisk();
			const candidate: Record<string, unknown> = {};
			if (SETTINGS_SECRETS_KEY in store) candidate[SETTINGS_SECRETS_KEY] = store[SETTINGS_SECRETS_KEY];
			if (preserveSettings && "settings" in store) candidate.settings = store.settings;
			this.commit(candidate);
		});
	}

	delete(key: string): void {
		if (key === SETTINGS_SECRETS_KEY) throw new Error("Reserved plugin storage key");
		withFileRmwLockSync(this.file, () => {
			const candidate = this.readFromDisk();
			if (!Object.hasOwn(candidate, key)) return;
			delete candidate[key];
			this.commit(candidate);
		});
	}
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

export { PluginSecrets } from "./plugin-secrets.js";

// ---------------------------------------------------------------------------
// deps（宿主代插件自动补装运行时依赖）
// ---------------------------------------------------------------------------

const DEP_TIMEOUT_MS = 180_000; // 慢网安装兜底（含第一次拉取包元数据）

/** spec（`name` / `name@range` / `@scope/name@range`）→ 裸包名。
 *  require.resolve 不认 `@版本号` 后缀（`foo@1.2.3` 会被当成字面目录名，
 *  恒判缺失 → 带版本 pin 的 ensureDeps 永远装完还报缺，voice-input 踩过）。
 *  非标准形状（URL / 本地路径 / tag）原样返回，resolve 失败即判缺失，行为不变。
 *  纯函数，单测覆盖。 */
export function depName(spec: string): string {
	const m = /^(?:(@[^/\s]+\/[^/\s@]+)|([^/\s@:.]+))(?:@[^/\s]*)?$/.exec(str(spec));
	if (!m) return spec;
	return m[1] ?? m[2] ?? spec;
}

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

/** 纯包名（`foo` / `@scope/foo`）：能按 `node_modules/<name>/package.json` 判盘。
 *  `node:path`、URL、相对/绝对路径、git spec 一律 false（交给 resolve 判）。 */
function isPlainPackageName(name: string): boolean {
	return /^(?:@[a-z\d](?:[a-z\d._-]*[a-z\d])?\/)?[a-z\d](?:[a-z\d._-]*[a-z\d])?$/i.test(name);
}

/** 从 fromDir 沿目录树向上找 `node_modules/<name>/package.json` 是否已落盘。 */
function depOnDisk(fromDir: string, name: string): boolean {
	let dir = fromDir;
	for (;;) {
		try {
			if (existsSync(join(dir, "node_modules", ...name.split("/"), "package.json"))) return true;
		} catch {
			/* 权限/坏路径：当作这一层没有，继续往上找 */
		}
		const up = dirname(dir);
		if (!up || up === dir) return false;
		dir = up;
	}
}

/** 从插件目录出发能否解析到这个模块（模拟插件自身 import() 的查找链）。
 *
 *  resolve 失败后再看一眼「文件是否已落盘」，这不是冗余判据而是**修 bug**（issue #383）：
 *  Node 的 CJS 解析会把 `node_modules/<pkg>/package.json` 不存在的**负结果**缓存在
 *  进程内存里（packageJsonReader 的路径缓存）。于是「探测缺失 → npm install 成功 →
 *  复查」这组三连里，最后一次复查永远命中那条负缓存，恒抛
 *  `Cannot find module`，用户看到的是「装成功了却报 npm install 没跑通」，
 *  且非重启整个进程不能恢复。落盘判据不碰 CJS 缓存，天然免疫。
 *
 *  顺序保持「先 resolve 后判盘」：解析成功仍然是最强的信号（含 exports 映射等
 *  盘上判据覆盖不到的形状），判盘只是给解析的假阴性兜底，不会放宽真缺失。 */
export function isDepAvailable(pluginDir: string, spec: string): boolean {
	const name = depName(spec);
	try {
		createRequire(join(pluginDir, "index.mjs")).resolve(name);
		return true;
	} catch {
		return isPlainPackageName(name) && depOnDisk(pluginDir, name);
	}
}

const depInstallLocks = new Map<string, Promise<boolean>>();

/** 确保依赖就绪：先逐个解析，缺了才一次性 `npm install` 补装，装完复查。
 *  返回 true = 全部可用；false = 安装失败或超时。同目录并发调用单飞合并。
 *
 *  这是 webmail / db-client / vscode-editor 三家手搓 ensureXxxMod 的上收——
 *  之前每家都自己拼 spawn 参数、自己处理 win32 的 npm.cmd、自己等 install 完成。 */
export function ensurePluginDeps(
	pluginDir: string,
	specs: string[],
	onProgress?: (msg: string) => void,
): Promise<boolean> {
	if (specs.length === 0) return Promise.resolve(true);
	const missing = specs.filter((s) => !isDepAvailable(pluginDir, s));
	if (missing.length === 0) return Promise.resolve(true);

	const lockKey = join(pluginDir, missing.sort().join("|"));
	const inflight = depInstallLocks.get(lockKey);
	if (inflight) return inflight;

	const run = async (): Promise<boolean> => {
		// 无 package.json 时 npm 会沿目录树向上找最近一个，可能把依赖装进父目录——
		// 先落一个最小 package.json 钉住安装位置。
		if (!existsSync(join(pluginDir, "package.json"))) {
			try {
				atomicWrite(
					join(pluginDir, "package.json"),
					JSON.stringify({ name: "plugin-runtime-deps", private: true }, null, 2),
				);
			} catch {}
		}
		onProgress?.(`正在安装依赖：${missing.join(", ")}…（首次约需几分钟）`);
		// win32 的 npm 是 .cmd——spawnSync 直接跑会被 EINVAL 拒绝；走 cmd.exe /d /s /c
		// 规避 DEP0190 与命令行注入，posix 不用 shell（路径不含空格假设成立，与宿主其它 spawn 一致）。
		const isWin = process.platform === "win32";
		const spawnCmd = isWin ? process.env.ComSpec || "cmd.exe" : "npm";
		const runNpmInstall = (extraFlags: string[]) => {
			const spawnArgs = isWin
				? ["/d", "/s", "/c", "npm.cmd", "install", "--no-audit", "--no-fund", ...extraFlags, ...missing]
				: ["install", "--no-audit", "--no-fund", ...extraFlags, ...missing];
			return spawnSync(spawnCmd, spawnArgs, {
				cwd: pluginDir,
				timeout: DEP_TIMEOUT_MS,
				windowsHide: true,
				encoding: "utf8",
			});
		};
		let res = runNpmInstall([]);
		// 传递依赖（如 @xenova/transformers 拉进来的 sharp@0.32）在无编译环境或连不上
		// GitHub Release 拉 libvips 时，install 脚本会以非 0 退出拖垮整轮安装；
		// 用 --ignore-scripts 重试一次，让预打包二进制（如 onnxruntime-node）与纯 JS 包先落盘。
		if (res.error || res.status !== 0) {
			res = runNpmInstall(["--ignore-scripts"]);
		}
		if (res.error || res.status !== 0) {
			console.error(`[plugin-deps] ${join(pluginDir)} npm install 失败:`, res.error ?? res.stderr?.slice(0, 500));
			return false;
		}
		const stillMissing = specs.filter((s) => !isDepAvailable(pluginDir, s));
		if (stillMissing.length) {
			console.error(`[plugin-deps] 安装完成但仍缺：${stillMissing.join(", ")}`);
			return false;
		}
		onProgress?.("依赖安装完成");
		return true;
	};
	const p = run().finally(() => depInstallLocks.delete(lockKey));
	depInstallLocks.set(lockKey, p);
	return p;
}

// ---------------------------------------------------------------------------
// WorkspaceFS —— 受限工作区文件访问（host.fs，能力 "fs" 门控）
//
// 与插件自己 import node:fs 的本质区别：路径解析永远锚定「当前工作区根」
// （活值，跟随主应用 set_cwd），越界一律拒绝。这是宿主能真正强制执行的那层。
// ---------------------------------------------------------------------------

/** host.fs.list 返回的目录条目。 */
export interface WsEntry {
	name: string;
	type: "file" | "dir";
}

/** host.fs.stat 返回的文件元信息（size/mtime 供插件做同步/缓存判断）。 */
export interface WsStat {
	name: string;
	type: "file" | "dir";
	/** 字节数（目录为 0）。 */
	size: number;
	/** 修改时间毫秒时间戳（取不到为 0）。 */
	mtime: number;
}

/** 深度/条数护栏：glob 递归遍历与结果都封顶，防大仓库扫爆内存。 */
const GLOB_MAX_WALK = 2000;
const GLOB_MAX_RESULTS = 500;

/** 极简 glob 转 RegExp：只支持 `*`（单段任意）/`?`（单字符）/`**`（跨段任意）。
 *  纯函数，单测覆盖。 */
export function globToRegExp(pattern: string): RegExp {
	const src = String(pattern ?? "")
		.trim()
		.replace(/\\/g, "/");
	let re = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "*") {
			if (src[i + 1] === "*") {
				// `**`：跨段；`/**/` 整体可省（根下也命中）。
				if (src[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/, (m) => `\\${m}`);
		}
	}
	return new RegExp(`^${re}$`);
}

export class WorkspaceFS {
	/** root 是活值 getter（返回当前工作区绝对路径），跟随 set_cwd。 */
	constructor(private readonly root: () => string) {}

	/** 相对路径 → 活根下的绝对路径；越界抛错。空串 = 根本身。 */
	private abs(rel: unknown): string {
		const rootDir = resolve(this.root());
		const target = resolve(rootDir, typeof rel === "string" ? rel : "");
		if (target !== rootDir && !target.startsWith(rootDir + sepOf())) {
			throw new Error(`路径越界：${String(rel)}`);
		}
		return target;
	}

	/**
	 * 写类操作（write/append/mkdir/remove）的 realpath 复核：abs() 是纯字符串
	 * 比较，工作区里的符号链接/junction 能把写入（或递归删除）引到工作区之外。
	 * 取目标最近已存在祖先的 realpath，复核它仍在「活根」的 realpath 内。
	 * 读/list/stat/glob 保持字符串校验（高频路径；读不存在「把内容写到别处」
	 * 的风险，性能优先 —— 有意的取舍）。
	 */
	private assertRealInsideRoot(rel: unknown): void {
		const target = this.abs(rel); // 字符串越界先拒绝（错误文案不变）
		const targetReal = realPathOfNearest(target);
		if (!targetReal) throw new Error(`路径越界：无法解析真实路径 ${String(rel)}`);
		const rootDir = resolve(this.root());
		const rootReal = realPathOfNearest(rootDir) ?? rootDir;
		if (!isInsideRoot(rootReal, targetReal)) {
			throw new Error(`路径越界（符号链接指向工作区之外）：${String(rel)}`);
		}
	}

	/** 单层目录列表（浅层；深度遍历请插件自行递归）。 */
	async list(relDir = ""): Promise<WsEntry[]> {
		try {
			const dirents = await fspReaddir(this.abs(relDir), { withFileTypes: true });
			return dirents
				.slice(0, 2000)
				.map((d) => ({ name: d.name, type: d.isDirectory() ? ("dir" as const) : ("file" as const) }));
		} catch (err) {
			throw new Error(`读取目录失败：${(err as Error).message}`);
		}
	}

	/** 读文件（二进制）。声明为 async：路径校验失败以 rejected promise 表达
	 * （非 async 版本会同步 throw，破坏调用方 .catch/.rejects 契约）。 */
	async read(relPath: string): Promise<Buffer> {
		return fspReadFile(this.abs(relPath));
	}

	/** 读文本（默认上限 512KB，超出截断——预览同款约定）。 */
	async readText(relPath: string, maxBytes = 512 * 1024): Promise<string> {
		const buf = await this.read(relPath);
		return buf.subarray(0, maxBytes).toString("utf8");
	}

	/** 写文件（自动补父目录；注意相对路径锚定当前项目——切换 cwd 后写进新项目）。 */
	async write(relPath: string, data: string | Uint8Array): Promise<void> {
		this.assertRealInsideRoot(relPath);
		const target = this.abs(relPath);
		await fspMkdir(dirname(target), { recursive: true });
		await fspWriteFile(target, data);
	}

	/** 追加写文件（日志/队列场景；父目录自动补；越界拒绝与 write 同口径）。 */
	async append(relPath: string, data: string | Uint8Array): Promise<void> {
		this.assertRealInsideRoot(relPath);
		const target = this.abs(relPath);
		await fspMkdir(dirname(target), { recursive: true });
		await fspAppendFile(target, data);
	}

	/** 建目录（递归；已存在幂等成功；越界拒绝与 write 同口径）。 */
	async mkdir(relDir: string): Promise<void> {
		this.assertRealInsideRoot(relDir);
		await fspMkdir(this.abs(relDir), { recursive: true });
	}

	/** 文件元信息（size/mtime 供同步/缓存判断；不存在抛错）。 */
	async stat(relPath: string): Promise<WsStat> {
		const target = this.abs(relPath);
		const st = await fspStat(target);
		const base =
			target
				.replace(/[/\\]+$/, "")
				.split("/")
				.pop() ?? String(relPath);
		return {
			name: base,
			type: st.isDirectory() ? "dir" : "file",
			size: st.isDirectory() ? 0 : st.size,
			mtime: Number(st.mtimeMs) || 0,
		};
	}

	/** 极简 glob 搜索（星号匹配如 `*.json`、双星匹配如 `foo/bar.md` 的父目录任意层）：
	 *  相对路径（`/` 分隔）按 pattern 过滤。walk 与结果双封顶，目录本身也参与
	 *  匹配（`docs*` 能命中目录）。只返回相对路径字符串，调用方再 read/stat。 */
	async glob(pattern: string, relDir = ""): Promise<string[]> {
		const pat = String(pattern ?? "")
			.trim()
			.replace(/\\/g, "/");
		if (!pat) throw new Error("glob: pattern 为空");
		const re = globToRegExp(pat);
		const base = this.abs(relDir);
		const out: string[] = [];
		const stack: string[] = [base];
		let walked = 0;
		while (stack.length && walked < GLOB_MAX_WALK && out.length < GLOB_MAX_RESULTS) {
			const dir = stack.pop()!;
			let ents;
			try {
				ents = await fspReaddir(dir, { withFileTypes: true });
			} catch {
				continue; // 无权限/中途删除：跳过该分支，不整单失败
			}
			for (const e of ents) {
				if (walked++ >= GLOB_MAX_WALK || out.length >= GLOB_MAX_RESULTS) break;
				const abs = join(dir, e.name);
				const rel = relative(base, abs).replace(/\\/g, "/");
				if (e.isDirectory()) {
					if (re.test(rel) || re.test(`${rel}/`)) out.push(rel);
					stack.push(abs);
				} else if (re.test(rel)) {
					out.push(rel);
				}
			}
		}
		return out;
	}

	/** 删除文件/目录（递归；只允许删工作区内的路径）。 */
	async remove(relPath: string): Promise<void> {
		// remove 同样做 realpath 复核：递归删除跟着目录链接走，比写文件更危险。
		this.assertRealInsideRoot(relPath);
		await fspRm(this.abs(relPath), { recursive: true, force: false });
	}
}

function sepOf(): string {
	return process.platform === "win32" ? "\\" : "/";
}
