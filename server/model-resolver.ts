/**
 * model-resolver.ts — 跨引擎通用模型与服务商凭据解析器。
 *
 * 职责：
 *   作为宿主级模型配置基础层的只读解析器，统一读取与解析：
 *   1. `<agentDir>/models.json`（自定义服务商、BaseURL、API 类型、模型列表与内置覆盖）
 *   2. `<agentDir>/auth.json`（持久化 API 密钥）
 *   3. `<agentDir>/provider-keys.json`（多密钥管理与当前激活密钥）
 *   4. 进程环境变量回退（如 ANTHROPIC_API_KEY, DEEPSEEK_API_KEY 等）
 *
 * 供 Claude Code CLI 驱动、DSH 引擎与 Pi 引擎统一调用，消除各引擎间的配置孤岛。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultAgentDir(agentDir?: string): string {
	return agentDir && agentDir.trim()
		? agentDir.trim()
		: (process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
}

export interface ResolvedProviderCredential {
	providerId: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
}

export interface CustomModelEntry {
	providerId: string;
	providerName?: string;
	modelId: string;
	name: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	vision?: boolean;
}

/** 剥离 JSON 字符串中的 // 和 /* *\/ 注释（保护字符串字面量内的 URL） */
export function stripJsonComments(src: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (inString) {
			out += c;
			if (c === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** 读取并解析 models.json（容忍注释） */
export function readModelsJson(agentDir?: string): { providers: Record<string, Record<string, unknown>> } {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "models.json");
	if (!existsSync(filePath)) return { providers: {} };
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(stripJsonComments(raw)) as {
			providers?: Record<string, Record<string, unknown>>;
		};
		return { providers: parsed?.providers ?? {} };
	} catch {
		return { providers: {} };
	}
}

/** 读取并解析 auth.json */
export function readAuthJson(agentDir?: string): Record<string, unknown> {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "auth.json");
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf8");
		return (JSON.parse(raw) as Record<string, unknown>) ?? {};
	} catch {
		return {};
	}
}

/** 读取并解析 provider-keys.json */
export function readProviderKeysJson(agentDir?: string): Record<
	string,
	{
		activeKeyName: string | null;
		keys: Array<{ name: string; apiKey: string }>;
	}
> {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "provider-keys.json");
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(raw) as Record<
			string,
			{
				activeKeyName: string | null;
				keys: Array<{ name: string; apiKey: string }>;
			}
		>;
	} catch {
		return {};
	}
}

/**
 * 为指定 provider 解析完整凭据（BaseURL、API Key、API 类型、自定义 Headers）。
 * 优先级：models.json 明确定义 > provider-keys.json 激活密钥 > auth.json > 环境变量。
 */
export function resolveProviderCredential(
	agentDir: string | undefined,
	providerId: string,
): ResolvedProviderCredential {
	const dir = defaultAgentDir(agentDir);
	const pid = providerId.trim();
	const { providers } = readModelsJson(dir);
	const prov = providers[pid];

	let baseUrl: string | undefined = typeof prov?.baseUrl === "string" ? prov.baseUrl.trim() : undefined;
	let apiKey: string | undefined = typeof prov?.apiKey === "string" ? prov.apiKey.trim() : undefined;
	const api: string | undefined = typeof prov?.api === "string" ? prov.api.trim() : undefined;
	const headers: Record<string, string> | undefined =
		prov?.headers && typeof prov.headers === "object" && !Array.isArray(prov.headers)
			? (prov.headers as Record<string, string>)
			: undefined;

	// 1. 若 models.json 未显式配置 apiKey，则从 provider-keys.json 取激活密钥
	if (!apiKey) {
		const multiKeys = readProviderKeysJson(dir);
		const entry = multiKeys[pid];
		if (entry?.keys && entry.keys.length > 0) {
			const active = entry.keys.find((k) => k.name === entry.activeKeyName);
			apiKey = active?.apiKey ?? entry.keys[0]?.apiKey;
		}
	}

	// 2. 若仍无 apiKey，回落到 auth.json
	if (!apiKey) {
		const auth = readAuthJson(dir);
		const authEntry = auth[pid];
		if (authEntry && typeof authEntry === "object" && "key" in authEntry) {
			const k = (authEntry as { key?: unknown }).key;
			if (typeof k === "string" && k.trim()) apiKey = k.trim();
		} else if (typeof authEntry === "string" && authEntry.trim()) {
			apiKey = authEntry.trim();
		}
	}

	// 3. 环境变量兜底
	if (!apiKey) {
		const normPid = pid.toLowerCase();
		if (normPid === "anthropic" || normPid.includes("claude")) {
			apiKey = process.env.ANTHROPIC_API_KEY?.trim();
		} else if (normPid === "deepseek") {
			apiKey = process.env.DEEPSEEK_API_KEY?.trim();
		} else if (normPid === "openai") {
			apiKey = process.env.OPENAI_API_KEY?.trim();
		} else if (normPid === "openrouter") {
			apiKey = process.env.OPENROUTER_API_KEY?.trim();
		} else if (normPid === "google" || normPid.includes("gemini")) {
			apiKey = process.env.GEMINI_API_KEY?.trim() ?? process.env.GOOGLE_API_KEY?.trim();
		}
	}

	if (!baseUrl) {
		const normPid = pid.toLowerCase();
		if (normPid === "anthropic" || normPid.includes("claude")) {
			baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
		} else if (normPid === "deepseek") {
			baseUrl = process.env.DEEPSEEK_BASE_URL?.trim();
		} else if (normPid === "openai") {
			baseUrl = process.env.OPENAI_BASE_URL?.trim();
		}
	}

	return {
		providerId: pid,
		baseUrl: baseUrl || undefined,
		apiKey: apiKey || undefined,
		api: api || undefined,
		headers,
	};
}

/**
 * 从 models.json 中列出所有自定义模型。
 * 可选 filter 谓词过滤 API 类型（如只挑 Claude 兼容的）。
 */
export function listCustomModelsFromConfig(
	agentDir?: string,
	filter?: (entry: { providerId: string; api?: string; baseUrl?: string }) => boolean,
): CustomModelEntry[] {
	const dir = defaultAgentDir(agentDir);
	const { providers } = readModelsJson(dir);
	const results: CustomModelEntry[] = [];

	for (const [providerId, p] of Object.entries(providers)) {
		const api = typeof p.api === "string" ? p.api.trim() : undefined;
		const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : undefined;
		const providerName = typeof p.name === "string" ? p.name.trim() : undefined;

		if (filter && !filter({ providerId, api, baseUrl })) {
			continue;
		}

		if (Array.isArray(p.models)) {
			for (const m of p.models) {
				if (!m || typeof m !== "object") continue;
				const row = m as Record<string, unknown>;
				const modelId = typeof row.id === "string" ? row.id.trim() : "";
				if (!modelId) continue;
				const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : modelId;
				results.push({
					providerId,
					providerName,
					modelId,
					name,
					api,
					baseUrl,
					reasoning: Boolean(row.reasoning),
					vision: Array.isArray(row.input) ? row.input.includes("image") : undefined,
				});
			}
		}
	}

	return results;
}
