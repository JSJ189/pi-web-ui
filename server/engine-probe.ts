import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { runtimeBaseCandidates } from "./dsh/preset-clones.js";
import type { EngineStatus } from "./protocol.js";
import { probeClaudeCode } from "./universal/drivers/claude-code.js";
import {
	compareVersions,
	defaultFetcher,
	fetchLatest,
	NPM_DEFAULT_REGISTRY,
	type LocalPackage,
} from "./update-check.js";

export interface EnginePackageMeta {
	id: string;
	packageName: string;
	installCommand: string;
}

export const ENGINE_PACKAGES: Record<string, EnginePackageMeta> = {
	pi: {
		id: "pi",
		packageName: "@earendil-works/pi-coding-agent",
		installCommand: "npm i -g @earendil-works/pi-coding-agent",
	},
	dsh: {
		id: "dsh",
		packageName: "@deepseek-ai/dsh",
		installCommand: "npm i -g @deepseek-ai/dsh",
	},
	claude: {
		id: "claude",
		packageName: "@anthropic-ai/claude-code",
		installCommand: "npm i -g @anthropic-ai/claude-code",
	},
};

/** 探针缓存 TTL：5 秒（短时多次连接或 UI 打开时免除重复频繁执行进程调用） */
const CACHE_TTL_MS = 5000;
/** 远端 npm registry 查询缓存：5 分钟 */
const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

interface RegistryCacheEntry {
	at: number;
	latest: string | null;
}
const registryCache = new Map<string, RegistryCacheEntry>();

let lastProbeAt = 0;
let cachedStatuses: EngineStatus[] = [
	{ id: "pi", installed: true, packageName: ENGINE_PACKAGES.pi.packageName, version: VERSION },
	{ id: "dsh", installed: false, packageName: ENGINE_PACKAGES.dsh.packageName },
	{ id: "claude", installed: false, packageName: ENGINE_PACKAGES.claude.packageName },
];

/**
 * 查询全局包在 npm 远端的最新版本号（带 5 分钟缓存）。
 */
export async function checkPackageLatest(packageName: string, force = false): Promise<string | null> {
	const now = Date.now();
	const cached = registryCache.get(packageName);
	if (!force && cached && now - cached.at < REGISTRY_CACHE_TTL_MS) {
		return cached.latest;
	}
	try {
		const res = await fetchLatest(defaultFetcher, packageName, NPM_DEFAULT_REGISTRY, null);
		registryCache.set(packageName, { at: now, latest: res.latest });
		return res.latest;
	} catch {
		return cached?.latest ?? null;
	}
}

/**
 * 为已安装的引擎注入 npm 远端更新检测结果（latestVersion 与 hasUpdate 标记）。
 */
export async function enrichWithUpdateInfo(status: EngineStatus, force = false): Promise<EngineStatus> {
	if (!status.installed || !status.packageName || !status.version) {
		return status;
	}
	try {
		const latest = await checkPackageLatest(status.packageName, force);
		if (latest) {
			status.latestVersion = latest;
			status.hasUpdate = compareVersions(latest, status.version) > 0;
		}
	} catch {
		/* best effort */
	}
	return status;
}

/**
 * 探测 Pi 原生引擎状态（作为内置/捆绑引擎恒存在）。
 */
export function probePi(): EngineStatus {
	return {
		id: "pi",
		installed: true,
		packageName: ENGINE_PACKAGES.pi.packageName,
		version: VERSION,
	};
}

/**
 * 快速探测 DSH 引擎全局包/运行时树是否已安装。
 * 1. 优先检查常见全局 node_modules / 候选路径中的 @deepseek-ai/dsh package.json 与 dsh-base；
 * 2. 回退通过命令行探针执行 `dsh --version`。
 */
export async function probeDsh(): Promise<EngineStatus> {
	const pkgName = ENGINE_PACKAGES.dsh.packageName;

	// 1. 路径快速探测（纯 fs 访问，无进程派生开销）
	try {
		for (const root of runtimeBaseCandidates()) {
			if (!root) continue;
			// A. 直接在全局或候选 node_modules 中找到 @deepseek-ai/dsh 包目录
			const dshPkgJson = join(root, "@deepseek-ai", "dsh", "package.json");
			if (existsSync(dshPkgJson)) {
				try {
					const pkg = JSON.parse(readFileSync(dshPkgJson, "utf8")) as { version?: string };
					return { id: "dsh", installed: true, packageName: pkgName, version: pkg.version };
				} catch {
					return { id: "dsh", installed: true, packageName: pkgName };
				}
			}

			// B. 检查平铺运行树（@deepseek-ai/dsh-base）
			const flatBase = join(root, "@deepseek-ai", "dsh-base", "cordis.patch.yml");
			const flatBoot = join(root, "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
			if (existsSync(flatBase) && existsSync(flatBoot)) {
				return { id: "dsh", installed: true, packageName: pkgName };
			}

			// C. 检查嵌套运行树（@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base）
			const nestedBase = join(
				root,
				"@deepseek-ai",
				"dsh",
				"node_modules",
				"@deepseek-ai",
				"dsh-base",
				"cordis.patch.yml",
			);
			const nestedBoot = join(
				root,
				"@deepseek-ai",
				"dsh",
				"node_modules",
				"@deepseek-ai",
				"dsh-app-boot",
				"lib",
				"index.js",
			);
			if (existsSync(nestedBase) && existsSync(nestedBoot)) {
				return { id: "dsh", installed: true, packageName: pkgName };
			}
		}
	} catch {
		/* ignore fs errors */
	}

	// 2. 命令行回退探测（检查 PATH 中是否有可用的 dsh CLI）
	try {
		const cliProbe = await new Promise<{ installed: boolean; version?: string }>((resolve) => {
			execFile(
				"dsh",
				["--version"],
				{
					timeout: 3000,
					shell: process.platform === "win32",
				},
				(err, stdout) => {
					if (err) {
						resolve({ installed: false });
					} else {
						const v = stdout.trim();
						resolve({ installed: true, version: v || undefined });
					}
				},
			);
		});
		if (cliProbe.installed) {
			return {
				id: "dsh",
				installed: true,
				packageName: pkgName,
				version: cliProbe.version,
			};
		}
	} catch {
		/* ignore cli error */
	}

	return { id: "dsh", installed: false, packageName: pkgName };
}

/**
 * 探测 Claude Code 引擎状态。
 */
export async function probeClaude(): Promise<EngineStatus> {
	const pkgName = ENGINE_PACKAGES.claude.packageName;
	try {
		const res = await probeClaudeCode();
		return {
			id: "claude",
			installed: res.installed,
			packageName: pkgName,
			version: res.version,
		};
	} catch {
		return { id: "claude", installed: false, packageName: pkgName };
	}
}

/**
 * 按引擎 ID 单独探测状态。
 */
export async function probeEngine(id: string, force = false): Promise<EngineStatus> {
	if (id === "pi") return probePi();
	if (!force && Date.now() - lastProbeAt < CACHE_TTL_MS) {
		const found = cachedStatuses.find((e) => e.id === id);
		if (found) return found;
	}
	let result: EngineStatus;
	if (id === "dsh") {
		result = await probeDsh();
	} else if (id === "claude") {
		result = await probeClaude();
	} else {
		result = { id, installed: false };
	}
	await enrichWithUpdateInfo(result, force);
	// 更新单项缓存
	const idx = cachedStatuses.findIndex((e) => e.id === id);
	if (idx >= 0) cachedStatuses[idx] = result;
	else cachedStatuses.push(result);
	return result;
}

/**
 * 探测全部已知引擎并返回最新状态列表（带 TTL 缓存防抖）。
 */
export async function probeAllEngines(force = false): Promise<EngineStatus[]> {
	if (!force && Date.now() - lastProbeAt < CACHE_TTL_MS && cachedStatuses.length > 0) {
		return cachedStatuses;
	}
	const [pi, dsh, claude] = await Promise.all([probePi(), probeDsh(), probeClaude()]);
	await Promise.all([
		enrichWithUpdateInfo(pi, force),
		enrichWithUpdateInfo(dsh, force),
		enrichWithUpdateInfo(claude, force),
	]);
	cachedStatuses = [pi, dsh, claude];
	lastProbeAt = Date.now();
	return cachedStatuses;
}

/**
 * 同步获取当前缓存的引擎探测结果（握手帧或即时读取使用）。
 */
export function getCachedEngineStatuses(): EngineStatus[] {
	return [...cachedStatuses];
}

/**
 * 收集已安装的第三方全局引擎包，供全量更新检查（check_updates_all）纳入统一检查名录。
 */
export function collectInstalledEngineTargets(): LocalPackage[] {
	const out: LocalPackage[] = [];
	for (const status of cachedStatuses) {
		// pi-core 在 collectTargets 中已有独立专属条目（PI_CORE_PACKAGE），此处收纳其他已安装引擎全局包
		if (status.id !== "pi" && status.installed && status.packageName && status.version) {
			out.push({
				name: status.packageName,
				version: status.version,
				kind: "engine",
			});
		}
	}
	return out;
}

// 模块加载时预热后台探测
void probeAllEngines(true).catch(() => {});
