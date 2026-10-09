/**
 * MCP 服务器管理服务
 *
 * 负责 Pi 全局 (~/.pi/agent/mcp.json 或兼容 ~/.pi-web/mcp.json)
 * 与工作区项目级 (.pi/mcp.json) MCP 服务器配置的读写、合并与生命周期。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpScope, UiMcpServer, UiMcpToolInfo } from "./protocol.js";
import {
	getGlobalMcpPath,
	getProjectMcpPath,
	parseMcpConfig,
	type McpBridge,
	type McpServerSpec,
} from "./mcp-bridge.js";

export { getGlobalMcpPath, getProjectMcpPath };

/** 读取指定文件的 MCP 服务器配置 */
export function readMcpConfigFile(filePath: string): {
	servers: Record<string, McpServerSpec>;
	raw: Record<string, unknown> | null;
	legacy: boolean;
	exists: boolean;
} {
	if (!existsSync(filePath)) {
		return { servers: {}, raw: null, legacy: false, exists: false };
	}
	try {
		const text = readFileSync(filePath, "utf8");
		let raw: Record<string, unknown> | null = null;
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch {
			/* invalid json */
		}
		const legacy = !!raw && raw.servers !== undefined && raw.mcpServers === undefined;
		const parsedConfig = parseMcpConfig(text);
		return {
			servers: parsedConfig ? parsedConfig.servers : {},
			raw,
			legacy,
			exists: true,
		};
	} catch {
		return { servers: {}, raw: null, legacy: false, exists: true };
	}
}

/** 写入指定文件的 MCP 服务器配置（保留除服务器清单以外的其它字段） */
export function writeMcpConfigFile(
	filePath: string,
	servers: Record<string, McpServerSpec>,
	preferLegacy = false,
): void {
	mkdirSync(dirname(filePath), { recursive: true });
	let raw: Record<string, unknown> = {};
	if (existsSync(filePath)) {
		try {
			const text = readFileSync(filePath, "utf8");
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch {
			/* ignore corrupt file, rewrite cleanly */
		}
	}

	const legacy = raw.servers !== undefined && raw.mcpServers === undefined ? true : preferLegacy;
	const next = { ...raw };
	if (legacy) {
		delete next.mcpServers;
		next.servers = servers;
	} else {
		delete next.servers;
		next.mcpServers = servers;
	}

	writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/** 校验 MCP 服务器名称合法性（字母、数字、下划线、短横线） */
export function isValidMcpServerName(name: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(name.trim());
}

/** 汇总查询全局与项目级配置列表，并结合 McpBridge 运行时状态组装 UiMcpServer 数组 */
export function listAllMcpServers(opts: { agentDir?: string; cwd?: string; dataDir?: string; bridge?: McpBridge }): {
	servers: UiMcpServer[];
	globalPath: string;
	projectPath: string;
} {
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);

	const globalCfg = readMcpConfigFile(globalPath);
	const projectCfg = readMcpConfigFile(projectPath);

	const result: UiMcpServer[] = [];

	// 全局服务器
	for (const [name, spec] of Object.entries(globalCfg.servers)) {
		const status = getRuntimeStatus(name, spec, opts.bridge);
		result.push({
			name,
			scope: "global",
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			url: spec.url,
			headers: spec.headers,
			type: spec.type,
			timeout: spec.timeout,
			protocolVersion: spec.protocolVersion,
			enabled: spec.enabled !== false,
			description: spec.description,
			status: status.status,
			error: status.error,
			tools: status.tools,
		});
	}

	// 项目级服务器
	for (const [name, spec] of Object.entries(projectCfg.servers)) {
		const status = getRuntimeStatus(name, spec, opts.bridge);
		result.push({
			name,
			scope: "project",
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			url: spec.url,
			headers: spec.headers,
			type: spec.type,
			timeout: spec.timeout,
			protocolVersion: spec.protocolVersion,
			enabled: spec.enabled !== false,
			description: spec.description,
			status: status.status,
			error: status.error,
			tools: status.tools,
		});
	}

	return { servers: result, globalPath, projectPath };
}

function getRuntimeStatus(
	name: string,
	spec: McpServerSpec,
	bridge?: McpBridge,
): { status: "running" | "stopped" | "error"; error?: string; tools: UiMcpToolInfo[] } {
	if (spec.enabled === false) {
		return { status: "stopped", tools: [] };
	}
	if (!bridge) {
		return { status: "stopped", tools: [] };
	}
	return bridge.getServerStatus(name);
}

/** 保存或更新 MCP 服务器 */
export function saveMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	server: UiMcpServer;
	prevName?: string;
	prevScope?: McpScope;
}): { ok: boolean; error?: string } {
	const name = opts.server.name.trim();
	if (!isValidMcpServerName(name)) {
		return { ok: false, error: "服务器名称仅允许包含英文字母、数字、下划线及中划线" };
	}

	const targetScope = opts.server.scope;
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = targetScope === "global" ? globalPath : projectPath;

	// 若存在旧名称或作用域移动，从原作用域文件中移除
	if (opts.prevName && opts.prevScope) {
		const prevCleanName = opts.prevName.trim();
		if (prevCleanName !== name || opts.prevScope !== targetScope) {
			const oldPath = opts.prevScope === "global" ? globalPath : projectPath;
			const oldCfg = readMcpConfigFile(oldPath);
			if (oldCfg.servers[prevCleanName]) {
				delete oldCfg.servers[prevCleanName];
				writeMcpConfigFile(oldPath, oldCfg.servers, oldCfg.legacy);
			}
		}
	}

	const targetCfg = readMcpConfigFile(targetPath);
	const spec: McpServerSpec = {
		command: opts.server.command?.trim() || undefined,
		args: Array.isArray(opts.server.args) && opts.server.args.length > 0 ? opts.server.args.map(String) : undefined,
		cwd: opts.server.cwd?.trim() || undefined,
		env:
			opts.server.env && Object.keys(opts.server.env).length > 0
				? (opts.server.env as Record<string, string>)
				: undefined,
		url: opts.server.url?.trim() || undefined,
		headers:
			opts.server.headers && Object.keys(opts.server.headers).length > 0
				? (opts.server.headers as Record<string, string>)
				: undefined,
		type: opts.server.type,
		timeout: typeof opts.server.timeout === "number" ? opts.server.timeout : undefined,
		protocolVersion: opts.server.protocolVersion?.trim() || undefined,
		enabled: opts.server.enabled !== false,
		description: opts.server.description?.trim() || undefined,
	};

	targetCfg.servers[name] = spec;
	writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
	return { ok: true };
}

/** 删除指定作用域下的 MCP 服务器 */
export function deleteMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	name: string;
	scope: McpScope;
}): { ok: boolean; error?: string } {
	const name = opts.name.trim();
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = opts.scope === "global" ? globalPath : projectPath;

	const targetCfg = readMcpConfigFile(targetPath);
	if (!targetCfg.servers[name]) {
		return { ok: false, error: `服务器 ${name} 在 ${opts.scope === "global" ? "全局" : "项目"} 配置中不存在` };
	}

	delete targetCfg.servers[name];
	writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
	return { ok: true };
}

/** 切换指定作用域下的 MCP 服务器启用/停用状态 */
export function toggleMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	name: string;
	scope: McpScope;
	enabled: boolean;
}): { ok: boolean; error?: string } {
	const name = opts.name.trim();
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = opts.scope === "global" ? globalPath : projectPath;

	const targetCfg = readMcpConfigFile(targetPath);
	if (targetCfg.servers[name]) {
		targetCfg.servers[name].enabled = opts.enabled;
		writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
		return { ok: true };
	}

	// 若在项目级切换全局服务器的启用状态（项目级覆盖）：写入仅带 enabled 的配置项
	if (opts.scope === "project") {
		const globalCfg = readMcpConfigFile(globalPath);
		if (globalCfg.servers[name]) {
			targetCfg.servers[name] = { enabled: opts.enabled };
			writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
			return { ok: true };
		}
	}

	return { ok: false, error: `服务器 ${name} 不存在` };
}
