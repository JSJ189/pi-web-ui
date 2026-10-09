/**
 * 远程市场服务 —— MCP 服务器市场 API 与 GitHub 技能仓库目录抓取
 *
 * 职责：
 * 1. 从 Smithery 等开放 API、GitHub 官方仓库拉取公开 MCP 服务器目录；
 * 2. 从 GitHub 仓库（如 anthropics/skills 等）拉取公开 Agent Skills 清单及 SKILL.md 正文；
 * 3. 本地磁盘缓存与超时防抖，网络失败时不影响主程序运行。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RemoteMcpServer, RemoteSkillSummary } from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时缓存

/** 获取 GitHub Token（优先使用配置的预设分享令牌或标准环境变量） */
function getGitHubToken(): string | undefined {
	return (
		process.env.PI_WEB_PRESET_TOKEN?.trim() ||
		process.env.GH_TOKEN?.trim() ||
		process.env.GITHUB_TOKEN?.trim() ||
		undefined
	);
}

function fetchHeaders(customHeaders?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": "pi-web-ui-market/1.0",
		Accept: "application/json",
		...customHeaders,
	};
	const token = getGitHubToken();
	if (token && !headers.Authorization) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

// ---------------------------------------------------------------------------
// 1. MCP 服务器公开市场 API
// ---------------------------------------------------------------------------

export interface FetchMcpMarketOptions {
	source?: string; // "smithery" | "github" | 自定义 URL
	query?: string;
	page?: number;
	refresh?: boolean;
	dataDir: string;
}

interface CacheEnvelope<T> {
	timestamp: number;
	data: T;
}

function readCache<T>(cacheFile: string): T | null {
	if (!existsSync(cacheFile)) return null;
	try {
		const raw = JSON.parse(readFileSync(cacheFile, "utf8")) as CacheEnvelope<T>;
		if (Date.now() - raw.timestamp < CACHE_TTL_MS) {
			return raw.data;
		}
	} catch {
		/* invalid cache */
	}
	return null;
}

function writeCache<T>(cacheFile: string, data: T): void {
	try {
		mkdirSync(dirname(cacheFile), { recursive: true });
		const payload: CacheEnvelope<T> = {
			timestamp: Date.now(),
			data,
		};
		writeFileSync(cacheFile, JSON.stringify(payload), "utf8");
	} catch {
		/* ignore write cache failure */
	}
}

/** 从公开 API 或仓库拉取 MCP 服务器列表 */
export async function fetchRemoteMcpMarket(opts: FetchMcpMarketOptions): Promise<{
	ok: boolean;
	servers: RemoteMcpServer[];
	source: string;
	total?: number;
	error?: string;
}> {
	const source = opts.source || "smithery";
	const cacheKey = `mcp-market-${source.replace(/[^a-zA-Z0-9_-]/g, "_")}-${opts.query || "all"}.json`;
	const cacheFile = join(opts.dataDir, "market-cache", cacheKey);

	if (!opts.refresh) {
		const cached = readCache<RemoteMcpServer[]>(cacheFile);
		if (cached) {
			return { ok: true, servers: cached, source, total: cached.length };
		}
	}

	try {
		if (source === "smithery" || source.startsWith("https://api.smithery.ai")) {
			const baseUrl = source === "smithery" ? "https://api.smithery.ai/servers" : source;
			const url = new URL(baseUrl);
			url.searchParams.set("pageSize", "50");
			if (opts.query?.trim()) {
				url.searchParams.set("q", opts.query.trim());
			}

			const res = await fetch(url.toString(), {
				headers: fetchHeaders(),
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			});
			if (!res.ok) {
				throw new Error(`Smithery API 响应错误 HTTP ${res.status}: ${res.statusText}`);
			}

			const json = (await res.json()) as { servers?: unknown[]; pagination?: { total?: number } };
			const rawServers = Array.isArray(json.servers) ? json.servers : [];
			const servers: RemoteMcpServer[] = rawServers.map((item: any) => {
				const id = item.qualifiedName || item.id || "mcp-server";
				const isRemote = !!item.remote;
				return {
					id,
					name: item.displayName || item.qualifiedName || id,
					displayName: item.displayName,
					description: item.description || "Model Context Protocol Server",
					homepage: item.homepage || `https://smithery.ai/server/${encodeURIComponent(id)}`,
					package: item.qualifiedName ? `@smithery/${item.qualifiedName}` : id,
					command: isRemote ? undefined : "npx",
					args: isRemote ? undefined : ["-y", `@smithery/${item.qualifiedName}`],
					transport: isRemote ? "http" : "stdio",
					url: isRemote ? item.deploymentUrl : undefined,
					source: "smithery",
					downloads: typeof item.useCount === "number" ? item.useCount : undefined,
					verified: !!item.verified,
					iconUrl: item.iconUrl,
				};
			});

			writeCache(cacheFile, servers);
			return { ok: true, servers, source: "smithery", total: json.pagination?.total ?? servers.length };
		}

		if (source === "github" || source.includes("github.com/modelcontextprotocol/servers")) {
			const apiUrl = "https://api.github.com/repos/modelcontextprotocol/servers/contents/src";
			const res = await fetch(apiUrl, {
				headers: fetchHeaders(),
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			});
			if (!res.ok) {
				throw new Error(`GitHub API 响应错误 HTTP ${res.status}`);
			}

			const list = (await res.json()) as Array<{ name: string; type: string; html_url: string }>;
			const dirs = list.filter((item) => item.type === "dir" && !item.name.startsWith("."));

			const servers: RemoteMcpServer[] = dirs.map((d) => ({
				id: d.name,
				name: d.name,
				description: `Official Model Context Protocol reference server for ${d.name}`,
				homepage: d.html_url,
				package: `@modelcontextprotocol/server-${d.name}`,
				command: "npx",
				args: ["-y", `@modelcontextprotocol/server-${d.name}`],
				transport: "stdio",
				source: "github",
				verified: true,
			}));

			writeCache(cacheFile, servers);
			return { ok: true, servers, source: "github", total: servers.length };
		}

		// 自定义 URL（支持返回 JSON 格式的 servers 列表）
		const customRes = await fetch(source, {
			headers: fetchHeaders(),
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		});
		if (!customRes.ok) {
			throw new Error(`自定义目录响应错误 HTTP ${customRes.status}`);
		}
		const customData = (await customRes.json()) as { servers?: RemoteMcpServer[] } | RemoteMcpServer[];
		const customServers: RemoteMcpServer[] = Array.isArray(customData)
			? customData
			: Array.isArray(customData.servers)
				? customData.servers
				: [];

		writeCache(cacheFile, customServers);
		return { ok: true, servers: customServers, source, total: customServers.length };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// 网络出错时尝试回退至缓存
		const cached = readCache<RemoteMcpServer[]>(cacheFile);
		if (cached) {
			return { ok: true, servers: cached, source, total: cached.length, error: `网络请求失败，已展示本地缓存：${msg}` };
		}
		return { ok: false, servers: [], source, error: msg };
	}
}

// ---------------------------------------------------------------------------
// 2. Skill 技能仓库目录及内容抓取
// ---------------------------------------------------------------------------

export interface FetchSkillMarketOptions {
	repo?: string; // 默认 "anthropics/skills"
	refresh?: boolean;
	dataDir: string;
}

/** 从 GitHub 仓库拉取 Skills 清单 */
export async function fetchRemoteSkillMarket(opts: FetchSkillMarketOptions): Promise<{
	ok: boolean;
	skills: RemoteSkillSummary[];
	repo: string;
	error?: string;
}> {
	const repo = (opts.repo || "anthropics/skills").trim();
	const cacheKey = `skill-market-${repo.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
	const cacheFile = join(opts.dataDir, "market-cache", cacheKey);

	if (!opts.refresh) {
		const cached = readCache<RemoteSkillSummary[]>(cacheFile);
		if (cached) {
			return { ok: true, skills: cached, repo };
		}
	}

	try {
		// 1. 优先尝试读取 repo 下的 skills 目录；若不存在则尝试根目录
		let apiUrl = `https://api.github.com/repos/${repo}/contents/skills`;
		let res = await fetch(apiUrl, {
			headers: fetchHeaders(),
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		});

		if (res.status === 404) {
			apiUrl = `https://api.github.com/repos/${repo}/contents`;
			res = await fetch(apiUrl, {
				headers: fetchHeaders(),
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			});
		}

		if (!res.ok) {
			throw new Error(`GitHub 仓库 ${repo} 读取失败 HTTP ${res.status}: ${res.statusText}`);
		}

		const items = (await res.json()) as Array<{ name: string; type: string; html_url: string }>;
		const skillDirs = items.filter((item) => item.type === "dir" && !item.name.startsWith("."));

		// 2. 并发读取每个 skill 的 SKILL.md 提取描述（按 raw github 内容读取，避开 GitHub API rate limit）
		const skills: RemoteSkillSummary[] = await Promise.all(
			skillDirs.map(async (dir) => {
				const id = dir.name;
				const rawUrl = `https://raw.githubusercontent.com/${repo}/main/skills/${id}/SKILL.md`;
				let description = `Agent skill ${id} from ${repo}`;
				try {
					const rawRes = await fetch(rawUrl, {
						headers: { "User-Agent": "pi-web-ui" },
						signal: AbortSignal.timeout(5000),
					});
					if (rawRes.ok) {
						const text = await rawRes.text();
						const descMatch = text.match(/description:\s*(?:>|\|)?\s*([^\r\n]+)/);
						if (descMatch && descMatch[1].trim()) {
							description = descMatch[1].trim();
						}
					}
				} catch {
					/* fallback to default description */
				}

				return {
					id,
					name: id,
					description,
					repo,
					url: dir.html_url,
				};
			}),
		);

		writeCache(cacheFile, skills);
		return { ok: true, skills, repo };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const cached = readCache<RemoteSkillSummary[]>(cacheFile);
		if (cached) {
			return { ok: true, skills: cached, repo, error: `网络请求失败，已展示本地缓存：${msg}` };
		}
		return { ok: false, skills: [], repo, error: msg };
	}
}

/** 从 GitHub 仓库读取单个技能的完整 SKILL.md 内容 */
export async function fetchRemoteSkillContent(opts: {
	repo: string;
	skillId: string;
	dataDir: string;
}): Promise<{ ok: boolean; skillId: string; content: string; error?: string }> {
	const { repo, skillId } = opts;
	const branches = ["main", "master"];

	for (const branch of branches) {
		const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/skills/${skillId}/SKILL.md`;
		try {
			const res = await fetch(rawUrl, {
				headers: { "User-Agent": "pi-web-ui" },
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			});
			if (res.ok) {
				const content = await res.text();
				return { ok: true, skillId, content };
			}
		} catch {
			/* try next branch */
		}
	}

	// 根目录下直接查找
	for (const branch of branches) {
		const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${skillId}/SKILL.md`;
		try {
			const res = await fetch(rawUrl, {
				headers: { "User-Agent": "pi-web-ui" },
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			});
			if (res.ok) {
				const content = await res.text();
				return { ok: true, skillId, content };
			}
		} catch {
			/* try next */
		}
	}

	return {
		ok: false,
		skillId,
		content: "",
		error: `未在仓库 ${repo} 中找到技能 ${skillId} 的 SKILL.md 文件`,
	};
}
