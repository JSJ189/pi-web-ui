/**
 * 沙盒项目服务（Sandbox Project Service）：
 *
 * 1. 隔离副本工作区管理（`<dataDir>/sandboxes/registry.json` + `<dataDir>/sandboxes/<id>/`）：
 *    - 支持「空白沙盒」与「导入现有项目」（自动跳过 node_modules/.venv/target 等重型缓存目录与越界软链）；
 *    - 支持「临时沙盒（用完即删）」与「永久沙盒（持久化保留，随时一键转正）」；
 *    - 支持一键重置（还原到初始空白或重新从源项目同步）、另存为正式项目（promote）、将修改写回源项目（applyToSource）、彻底销毁（destroy）。
 *
 * 2. 沙盒安全围栏（Sandbox Jail Gate）：
 *    - 当会话处于受管沙盒目录内时，所有文件写入/编辑/补丁（write/edit/edit_soft/patch）必须严格落在
 *      `sandbox.path` 内部（含祖先目录 realpath 校验，防软链逃逸），越界直接硬拒绝（不走审批放行）；
 *    - 没有操作系统隔离后端时拒绝宿主 shell、解释器、终端和任意代码执行；
 *    - 仅放行来源可信且能力明确的受限文件工具，未知工具和外部副作用默认拒绝。
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as sandboxJailFs from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizePathKey } from "./client-state.js";
import { isConversationTool } from "./conversation-tool-names.js";
import { pick, type ServerLang } from "./i18n.js";
import type { SandboxInfo } from "./protocol.js";

/** 导入项目进沙盒时默认跳过的重型依赖/构建缓存目录名。 */
export const SANDBOX_IGNORED_DIRS = new Set([
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".parcel-cache",
	"target",
	".gradle",
	".cache",
	"coverage",
	".nyc_output",
]);

function toComparablePath(p: string): string {
	return normalizePathKey(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function isSameOrSubpath(childAbs: string, parentAbs: string): boolean {
	const c = toComparablePath(childAbs);
	const p = toComparablePath(parentAbs);
	return c === p || c.startsWith(p + "/");
}

/**
 * 解析目标路径并校验是否严格位于 `sandboxRoot` 内部（含祖先目录 realpath 校验，防软链逃逸）。
 */
export function isStrictlyInsideSandbox(targetPath: string, cwd: string, sandboxRoot: string): boolean {
	if (!targetPath || typeof targetPath !== "string") return false;
	const trimmed = targetPath.trim();
	if (!trimmed) return false;
	const expanded =
		trimmed === "~"
			? homedir()
			: trimmed.startsWith("~/") || trimmed.startsWith("~\\")
				? join(homedir(), trimmed.slice(2))
				: trimmed;
	const resolvedTarget = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
	const resolvedSandbox = resolve(sandboxRoot);

	// 1. 词法路径必须在 sandboxRoot 之内
	if (!isSameOrSubpath(resolvedTarget, resolvedSandbox)) {
		return false;
	}

	// 2. 真实路径（realpath）校验：沿目标路径向上找到第一个已存在的祖先目录，防止通过沙盒内软链写到外部
	let realSandbox: string;
	try {
		if (sandboxJailFs.lstatSync(resolvedSandbox).isSymbolicLink()) return false;
		realSandbox = realpathSync(resolvedSandbox);
	} catch {
		return false;
	}

	let cur = resolvedTarget;
	while (true) {
		if (existsSync(cur)) {
			try {
				const realCur = realpathSync(cur);
				if (!isSameOrSubpath(realCur, realSandbox)) {
					return false;
				}
			} catch {
				return false;
			}
			break;
		}
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}

	return true;
}

/** 从 patch 工具的补丁文本中提取所有涉及的文件路径。 */
export function extractPatchTargetPaths(patchText: string): string[] {
	if (!patchText || typeof patchText !== "string") return [];
	const paths: string[] = [];
	for (const rawLine of patchText.split(/\r?\n/)) {
		const line = rawLine.trim();
		const mHeader = line.match(/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s+(.+)$/);
		if (mHeader?.[1]) {
			paths.push(mHeader[1].trim());
			continue;
		}
		const mUnified = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\r\n]+)$/);
		if (mUnified?.[1] && mUnified[1] !== "/dev/null") {
			paths.push(mUnified[1].trim());
			continue;
		}
		// hashline 格式段头（本仓 patch 工具实际消费的唯一格式）：[path#TAG] / [path]。
		// 不识别的话 hashline 补丁提取出 0 个目标 → 围栏检查整体空转，patch 路径
		// 只剩 hashline-engine 的词法 cwd 限制（无 realpath，沙盒内软链可逃逸）
		const mHashline = rawLine.match(/^\s*\[([^#\]]+)(?:#[0-9a-fA-F]{4})?\]\s*$/);
		if (mHashline?.[1]?.trim()) {
			paths.push(mHashline[1].trim());
		}
	}
	return paths;
}

export interface SandboxDenial {
	reason: string;
	reasonEn: string;
}

/**
 * 评估一次工具调用是否违反沙盒硬围栏。
 * 返回 null = 放行；返回 SandboxDenial = 硬拒绝（不弹审批框、不受“全部允许”影响）。
 */
/** Trust is granted by the host from implementation ownership, never by tool name or arguments. */
export interface SandboxJailPolicy {
	trustedTool?: boolean;
	/** Only set when the host enforces the same sandbox identity on every child. */
	inheritedSandboxSubagent?: boolean;
}

/** Copy workspaces are not an OS execution boundary. Capabilities are opt-in. */
const SANDBOX_MANAGEMENT_ACTIONS = new Set([
	"list",
	"create",
	"diff",
	"reset",
	"persist",
	"promote",
	"apply_to_source",
	"destroy",
]);

/** Reject links (including dangling links), special files and Windows alternate streams.
 * This is a preflight for trusted local file tools, not protection against a hostile
 * process racing filesystem changes; arbitrary host execution is therefore denied.
 */
function sandboxJailPath(raw: unknown, cwd: string, root: string): boolean {
	// SDK file tools strip a leading @ and normalize Unicode spaces. Refuse
	// alternate spellings rather than checking a different path from execution.
	if (
		typeof raw !== "string" ||
		!raw.trim() ||
		raw !== raw.trim() ||
		raw.startsWith("@") ||
		/[\x00-\x1f\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(raw)
	)
		return false;
	if (!isStrictlyInsideSandbox(raw, cwd, root)) return false;
	const target = resolve(cwd, raw);
	const sandboxRoot = resolve(root);
	const suffix = target.slice(sandboxRoot.length);
	if (suffix.includes(":")) return false;
	const safeEntry = (path: string): boolean => {
		const entry = sandboxJailFs.lstatSync(path);
		return !entry.isSymbolicLink() && (entry.isDirectory() || (entry.isFile() && entry.nlink === 1));
	};
	try {
		if (!sandboxJailFs.lstatSync(sandboxRoot).isDirectory() || sandboxJailFs.lstatSync(sandboxRoot).isSymbolicLink())
			return false;
		let current = sandboxRoot;
		for (const part of suffix.split(/[\\/]/).filter(Boolean)) {
			current = join(current, part);
			try {
				if (!safeEntry(current)) return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
				throw error;
			}
		}
		return true;
	} catch {
		return false;
	}
}

export function evaluateSandboxJail(
	sandbox: SandboxInfo,
	toolName: string,
	params: Record<string, unknown> | undefined,
	cwd: string,
	policy: SandboxJailPolicy = {},
): SandboxDenial | null {
	const deny = (detail: string): SandboxDenial => ({
		reason: "【沙盒安全隔离拦截】副本沙盒只允许可信宿主的受限文件工具与管理操作。" + detail,
		reasonEn:
			"[Sandbox Isolation Blocked] Copy sandboxes only allow trusted, bounded local file tools and management operations. " +
			detail,
	});
	if (!policy.trustedTool) return deny("Untrusted or unknown tool implementation: " + toolName);
	const p = params ?? {};
	if (toolName === "sandbox") {
		return typeof p.action === "string" && SANDBOX_MANAGEMENT_ACTIONS.has(p.action)
			? null
			: deny("Unknown sandbox management action.");
	}
	if (!sandboxJailPath(".", cwd, sandbox.path))
		return deny("Sandbox workspace is unavailable or outside its boundary.");
	// The trusted host must validate both endpoints against the captured sandbox identity.
	// Tool arguments cannot grant trust or select a different security boundary.
	if (toolName === "communicate") {
		return typeof p.action === "string" && ["read", "send", "request", "reply", "escalate"].includes(p.action)
			? null
			: deny("Unknown communication action.");
	}
	if (isConversationTool(toolName) && policy.inheritedSandboxSubagent) return null;
	if (toolName === "bash")
		return deny(
			"Host command execution (including scripts, eval and test/build commands) requires a secure OS-isolated backend; a workspace copy cannot isolate execution.",
		);
	const paths: unknown[] = [];
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "edit_soft":
			// Validate both aliases when present; different implementations choose different precedence.
			if (p.path !== undefined) paths.push(p.path);
			if (p.file_path !== undefined) paths.push(p.file_path);
			break;
		case "grep":
		case "find":
			// Host ownership alone does not make SDK search safe: inherited
			// configuration (e.g. RIPGREP_CONFIG_PATH/--pre) can execute code.
			// Reject direct wrapper calls too, until a safe search backend exists.
			return deny(
				"Search requires a verified safe backend without host execution or inherited executable configuration; trusted tool ownership alone is insufficient.",
			);
		case "patch": {
			if (typeof p.patch !== "string" || !p.patch.trim()) return deny("Missing patch targets.");
			paths.push(...extractPatchTargetPaths(p.patch));
			// Hashline MV is an additional destination, not a section header.
			for (const line of p.patch.split(/\r?\n/)) {
				const move = line.trim().match(/^MV\s+([^\s]+)/i);
				if (move) paths.push(move[1]);
			}
			break;
		}
		case "present_files":
			if (!Array.isArray(p.items)) return deny("Missing local file items.");
			for (const item of p.items)
				paths.push(item && typeof item === "object" ? (item as Record<string, unknown>).path : undefined);
			break;
		default:
			return deny("Tool capability is not allowed in a copy sandbox: " + toolName);
	}
	if (!paths.length || paths.some((path) => !sandboxJailPath(path, cwd, sandbox.path))) {
		return deny(
			"Every file target must stay inside the sandbox; links, special files, invalid paths and unsafe recursive searches are refused.",
		);
	}
	return null;
}

/**
 * 为工具包一层「沙盒硬围栏」：当 `getSandbox()` 返回非空时，对越界写操作与源项目触达直接硬拒绝。
 */
export function withSandboxJailGate(
	tool: ToolDefinition,
	getSandbox: () => SandboxInfo | undefined,
	getCwd: () => string,
	getLang: () => ServerLang,
	policy: SandboxJailPolicy = {},
	acquireExecution?: () => () => void,
): ToolDefinition {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			signal?.throwIfAborted();
			const sbx = getSandbox();
			if (sbx) {
				const denied = evaluateSandboxJail(
					sbx,
					tool.name,
					params as Record<string, unknown> | undefined,
					getCwd(),
					policy,
				);
				if (denied) {
					return {
						content: [{ type: "text", text: pick(getLang(), denied.reason, denied.reasonEn) }],
						details: { guardDenied: true, sandboxDenied: true, sandboxId: sbx.id },
						isError: true,
					} as never;
				}
			}
			const release = acquireExecution?.();
			try {
				signal?.throwIfAborted();
				return await tool.execute(toolCallId, params as never, signal, onUpdate, ctx);
			} finally {
				release?.();
			}
		},
	};
}

export { SandboxManager, type SandboxLifecycle } from "./sandbox-data.js";
