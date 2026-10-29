/**
 * subagent-security-gate.ts — 子代理安全规格与动态命令拦截闸门（issue #727）。
 *
 * 核心职责：
 * 1. 提供 SubagentSecurityMode（normal / readonly / verify）及解析器 resolveSecurityMode；
 * 2. 提供 delegate_task 的 required_tools 宽容解析器 parseRequiredTools；
 * 3. 基于 plan-mode.ts / goal-review-gate.ts 现有的只读与测试命令纯函数，
 *    在运行时拦截写工具、交互终端输入、越权派发与破坏性 bash 命令；
 * 4. 提供 withSubagentSecurityGate 包装器。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";
import { bashCommandHasSupportedSyntax, bashCommandIsReadOnly, readOnlyToolCallAllowed } from "./plan-mode.js";
import { goalReviewBashAllowed } from "./goal-review-gate.js";
import {
	isReadOnlyConversationAction,
	conversationToolAllowed,
	isConversationTool,
} from "./conversation-tool-names.js";

/** 子代理安全规格模式：
 * - normal: 全功能（默认，受主会话设置与审批规则约束）
 * - readonly: 严格只读（用于探针/侦察 explore/scout/research，剔除写工具，bash 仅放行只读命令）
 * - verify: 审查验证（用于审查 review/audit，剔除写工具，bash 放行只读命令与测试套件如 npm test）
 */
export type SubagentSecurityMode = "normal" | "readonly" | "verify";

/** 派发子代理时的扩展控制参数（平滑挂在 spawnSubagent 末尾，避免破坏旧位置参数契约）。 */
export interface SubagentSpawnExtra {
	/** 显式工具白名单（子代理活跃集仅暴露这些工具） */
	allowedTools?: string[];
	/** 安全规格模式 */
	securityMode?: SubagentSecurityMode;
}

/** 常见只读角色关键词（转小写后包含即判定为 readonly）。 */
const READONLY_ROLE_KEYWORDS = ["explore", "scout", "research", "oracle", "librarian", "reader"];

/** 常见审查验证角色关键词（转小写后包含即判定为 verify）。 */
const VERIFY_ROLE_KEYWORDS = ["review", "audit", "verify", "inspector"];

/**
 * 解析并推导子代理的安全模式：
 * 1. 优先使用模板显式声明的 securityMode；
 * 2. 其次根据模板名或 type 关键词兜底（保障老用户无 securityMode 字段的模板或直接传 type 时自然生效）；
 * 3. 缺省返回 "normal"。
 */
export function resolveSecurityMode(
	nameOrType?: string,
	template?: { securityMode?: SubagentSecurityMode; name?: string },
): SubagentSecurityMode {
	if (template?.securityMode && template.securityMode !== "normal") {
		return template.securityMode;
	}
	const candidate = `${template?.name ?? ""} ${nameOrType ?? ""}`.trim().toLowerCase();
	if (!candidate) return "normal";
	for (const kw of VERIFY_ROLE_KEYWORDS) {
		if (candidate.includes(kw)) return "verify";
	}
	for (const kw of READONLY_ROLE_KEYWORDS) {
		if (candidate.includes(kw)) return "readonly";
	}
	return "normal";
}

/** 别名映射：将调用方可能传入的泛称归一化为实际注册的工具名。 */
const TOOL_NAME_ALIASES: Record<string, string> = {
	terminal: "terminal",
	shell: "bash",
	sh: "bash",
	cmd: "bash",
	exec: "bash",
	cli: "bash",
	grep: "grep",
	find: "find",
	read: "read",
	view: "read",
	cat: "read",
};

/**
 * 宽容解析 delegate_task 的 required_tools 文本。
 * 支持：
 * - 逗号/分号/空白分隔："read, grep, find"
 * - 换行列表："- read\n- grep"
 * - 预设代称识别："read-only" / "readonly" -> 返回空 allowedTools 但可标明预设意图
 *
 * @param raw 模型传入的原始输入
 * @param availableTools 当前环境可用工具名集合（可选，若提供则校验合法性）
 */
export function parseRequiredTools(
	raw: unknown,
	availableTools?: readonly string[] | Set<string>,
): {
	allowedTools?: string[];
	unrecognized?: string[];
	requestedReadOnly?: boolean;
} {
	if (typeof raw !== "string" || !raw.trim()) {
		return {};
	}

	const text = raw.trim();
	// 特殊标记识别
	const lower = text.toLowerCase();
	const requestedReadOnly = lower.includes("read-only") || lower.includes("readonly") || lower.includes("reader");

	// 匹配单词 token（支持连字符与下划线，如 edit_soft）
	const matches = text.match(/[A-Za-z0-9_-]+/g) || [];
	const availableSet = availableTools instanceof Set ? availableTools : availableTools ? new Set(availableTools) : null;

	const seen = new Set<string>();
	const allowedTools: string[] = [];
	const unrecognized: string[] = [];

	for (const item of matches) {
		const token = item.trim().toLowerCase();
		// 跳过常见的介词、连接词与预设代称关键词
		if (
			[
				"and",
				"or",
				"with",
				"only",
				"tools",
				"tool",
				"the",
				"for",
				"read-only",
				"readonly",
				"reader",
				"none",
				"all",
			].includes(token)
		) {
			continue;
		}
		const mapped = TOOL_NAME_ALIASES[token] ?? token;
		if (seen.has(mapped)) continue;
		seen.add(mapped);

		if (availableSet) {
			if (
				availableSet.has(mapped) ||
				(mapped.startsWith("terminal_") &&
					availableSet.has("terminal") &&
					["create", "list", "close", "input", "key", "read", "wait"].includes(mapped.slice(9)))
			) {
				allowedTools.push(mapped);
			} else {
				unrecognized.push(token);
			}
		} else {
			allowedTools.push(mapped);
		}
	}

	return {
		allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
		unrecognized: unrecognized.length > 0 ? unrecognized : undefined,
		requestedReadOnly,
	};
}

/** 目标模式与只读模式下公认的硬写类工具名。 */
export const SUBAGENT_WRITE_TOOL_NAMES = new Set<string>([
	"write",
	"create",
	"create_file",
	"write_file",
	"edit",
	"edit_file",
	"edit_soft",
	"apply_patch",
	"patch",
	"patch_tool",
	"str_replace",
	"str_replace_editor",
	"multi_edit",
	"notebook_edit",
	"mv",
	"move",
	"cp",
	"copy",
	"mkdir",
	"rm",
	"rmdir",
	"delete",
	"delete_file",
	"touch",
	"chmod",
	"chown",
	"codemode",
	"powershell",
]);

/** 交互式终端输入工具：受限模式下必须禁用，防止通过交互输入写命令绕过检测。 */
export const SUBAGENT_TERMINAL_INPUT_TOOLS = new Set<string>([
	"terminal_input",
	"terminal_key",
	"terminal_create",
	"terminal_close",
]);

/** 越权派发工具：受限子代理禁止再派生/操控其他子代理。 */
export const SUBAGENT_DISPATCH_TOOLS = new Set<string>(["delegate_task"]);

/** bash 类工具名。 */
const BASH_TOOL_NAMES = new Set(["bash", "bash_execute", "run_command", "shell", "terminal_exec"]);

/** 取工具参数中的命令字段。 */
function commandOf(params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const p = params as Record<string, unknown>;
	for (const key of ["command", "cmd", "script", "input"]) {
		const v = p[key];
		if (typeof v === "string" && v.trim() !== "") return v;
	}
	return "";
}

export interface SubagentSecurityDenial {
	kind: "write-tool" | "terminal-input" | "dispatch-tool" | "bash-write" | "not-allowed-tool";
	reason: string;
	reasonEn: string;
}

/**
 * 校验子代理对指定工具的调用是否违规（纯函数）。
 *
 * @param mode 子代理的安全模式
 * @param toolName 被调用的工具名
 * @param params 调用参数
 * @param allowedTools 显式工具白名单集合（若设置）
 */
/** Keep legacy allowlists action-scoped; never upgrade terminal_read to unrestricted terminal. */
export function subagentAllowedToolCall(allowed: ReadonlySet<string>, name: string, params: unknown): boolean {
	if (conversationToolAllowed(allowed, name)) return true;
	if (name !== "terminal" || !params || typeof params !== "object") return false;
	const action = (params as Record<string, unknown>).action;
	return (
		typeof action === "string" &&
		["create", "list", "close", "input", "key", "read", "wait"].includes(action) &&
		allowed.has(`terminal_${action}`)
	);
}

/** Visibility only; execution must still call subagentAllowedToolCall with actual params. */
export function subagentAllowedToolVisible(allowed: ReadonlySet<string>, name: string): boolean {
	return (
		conversationToolAllowed(allowed, name) ||
		(name === "terminal" &&
			["create", "list", "close", "input", "key", "read", "wait"].some((action) => allowed.has(`terminal_${action}`)))
	);
}

export function subagentSecurityDenial(
	mode: SubagentSecurityMode,
	toolName: string,
	params: unknown,
	allowedTools?: Set<string>,
): SubagentSecurityDenial | undefined {
	const name = (toolName ?? "").trim();

	// 1. 显式白名单门控（若配置了 allowedTools）
	if (allowedTools && allowedTools.size > 0 && !subagentAllowedToolCall(allowedTools, name, params)) {
		return {
			kind: "not-allowed-tool",
			reason: `受限子代理：工具 "${name}" 不在本次任务允许的工具白名单内（仅限：${[...allowedTools].join(", ")}）。`,
			reasonEn: `Restricted subagent: tool "${name}" is not in the allowed tool whitelist for this task (only: ${[...allowedTools].join(", ")}).`,
		};
	}

	// normal 模式下不追加写拦截与 bash 只读限制
	if (mode === "normal") {
		return undefined;
	}

	// 2. 派发工具拦截（只读/审查子代理禁止派发或操纵同伴，防止安全穿透）
	if (SUBAGENT_DISPATCH_TOOLS.has(name)) {
		return {
			kind: "dispatch-tool",
			reason: `受限子代理（${mode}）：禁止调用派发工具 "${name}"。请在当前会话内独立完成分析与核实并返回结论。`,
			reasonEn: `Restricted subagent (${mode}): dispatch tool "${name}" is blocked. Complete inspection and return findings within this session.`,
		};
	}
	if (isConversationTool(name)) {
		const action =
			typeof params === "object" && params !== null ? (params as Record<string, unknown>).action : undefined;
		const act = typeof action === "string" ? action.trim().toLowerCase() : "";
		// Allow transcript inspection and collaboration queries; block dispatch and mutations.
		if (!isReadOnlyConversationAction(act)) {
			return {
				kind: "dispatch-tool",
				reason: `受限子代理（${mode}）：禁止调用 subagent(action="${act || "spawn"}") 派生或操控其他子代理。`,
				reasonEn: `Restricted subagent (${mode}): subagent(action="${act || "spawn"}") is blocked in restricted mode.`,
			};
		}
	}

	// 3. 硬写类工具拦截
	if (SUBAGENT_WRITE_TOOL_NAMES.has(name)) {
		return {
			kind: "write-tool",
			reason: `受限子代理（${mode}）：当前属于只读/审查模式，禁止调用写工具 "${name}"。请使用 read/grep/只读命令进行核实。`,
			reasonEn: `Restricted subagent (${mode}): write tool "${name}" is blocked in read/verify mode. Use read/grep/read-only commands to inspect.`,
		};
	}

	// 4. 交互式终端输入拦截（防绕过）
	if (SUBAGENT_TERMINAL_INPUT_TOOLS.has(name)) {
		return {
			kind: "terminal-input",
			reason: `受限子代理（${mode}）：禁止使用交互式终端输入工具 "${name}"。请使用一次性 bash 只读命令。`,
			reasonEn: `Restricted subagent (${mode}): interactive terminal tool "${name}" is blocked. Use one-shot read-only bash commands instead.`,
		};
	}

	// 5. Bash 命令动态审查拦截
	if (BASH_TOOL_NAMES.has(name)) {
		const cmd = commandOf(params);
		if (!cmd.trim()) {
			return {
				kind: "bash-write",
				reason: `受限子代理（${mode}）：不接受无命令的 bash 调用。`,
				reasonEn: `Restricted subagent (${mode}): empty bash calls are rejected.`,
			};
		}

		if (mode === "readonly") {
			// 严格只读模式：必须过 bashCommandIsReadOnly
			if (!bashCommandIsReadOnly(cmd)) {
				return {
					kind: "bash-write",
					reason: `只读侦察子代理（readonly）：命令被阻断（仅允许纯只读命令，如 ls/cat/grep/git diff/git log 等）：\`${cmd.slice(0, 160)}\`。`,
					reasonEn: `Read-only subagent (readonly): command blocked (only pure read-only commands allowed, e.g. ls/cat/grep/git diff/git log): \`${cmd.slice(0, 160)}\`.`,
				};
			}
		} else if (mode === "verify") {
			// 审查验证模式：允许只读命令 + 测试套件（goalReviewBashAllowed）
			if (!bashCommandHasSupportedSyntax(cmd) || !goalReviewBashAllowed(cmd)) {
				return {
					kind: "bash-write",
					reason: `审查验证子代理（verify）：命令被阻断（仅允许只读命令与测试套件，禁止重定向写或破坏性操作）：\`${cmd.slice(0, 160)}\`。`,
					reasonEn: `Verification subagent (verify): command blocked (only read-only and test runner commands allowed, no redirect writes or destructive ops): \`${cmd.slice(0, 160)}\`.`,
				};
			}
		}
		return undefined;
	}

	if (!readOnlyToolCallAllowed(name, params)) {
		return {
			kind: "not-allowed-tool",
			reason: `受限子代理（${mode}）：工具 "${name}" 的本次调用未声明为只读，已拒绝。请使用 read/grep 或结构化查询。`,
			reasonEn: `Restricted subagent (${mode}): tool "${name}" is not an explicitly supported read-only call. Use read/grep or structured queries.`,
		};
	}
	return undefined;
}

/**
 * 将工具包裹上子代理安全门禁（withSubagentSecurityGate）。
 */
export function withSubagentSecurityGate(
	def: ToolDefinition,
	getSecurityInfo: () => { mode?: SubagentSecurityMode; allowedTools?: Set<string> },
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			const info = getSecurityInfo();
			const mode = info.mode ?? "normal";
			const allowedTools = info.allowedTools;

			if (mode !== "normal" || (allowedTools && allowedTools.size > 0)) {
				const params = args[1];
				const denied = subagentSecurityDenial(mode, def.name, params, allowedTools);
				if (denied) {
					return {
						content: [{ type: "text", text: pick(getLang(), denied.reason, denied.reasonEn) }],
						details: { guardDenied: true, subagentSecurityDenied: true, kind: denied.kind },
						isError: true,
					} as never;
				}
			}

			return (def.execute as (...a: unknown[]) => unknown)(...args);
		}) as ToolDefinition["execute"],
	};
}
