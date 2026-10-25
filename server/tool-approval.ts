/**
 * server/tool-approval.ts
 *
 * 人机协同拦截与「改写执行」（Human-in-the-Loop: Edit & Run）。
 *
 * 功能：
 * 1. 高危操作识别与规则裁决（Dangerous Tool Call & Rule Evaluation）：
 *    - 委托 server/approval-rules.ts 的规则引擎评估
 *    - 支持三种动作：ask（弹窗审批）、deny（直接拒绝报错）、allow（白名单放行）
 * 2. 审批事件挂起与答复处理（askApproval / resolveApproval）：
 *    - 用户可「批准」（Approve）
 *    - 用户可「拒绝」（Deny）
 *    - 用户可就地修改参数后「修改并放行」（Edit & Run）
 * 3. 三档放行策略（省去反复弹窗）：
 *    - 全局关（设置 →「工具」页的「工具执行审批」总开关）→ 一律不弹；
 *    - 本对话「全部允许」→ 该对话内一律不弹；
 *    - 本对话「允许同类」→ 该对话内同一规则档位（category）不再弹。
 *    策略只活在内存里（挂在 Conversation 上，过户随对话搬走），重启/新对话即恢复询问。
 */

import type { UiApprovalCategory } from "./protocol.js";
import {
	DEFAULT_APPROVAL_RULES,
	evaluateApprovalRules,
	extractTargetPath,
	type ApprovalRule,
	type RuleHitDetail,
} from "./approval-rules.js";

/** 高危操作/自定义规则检测结果。 */
export interface DangerousCheckResult {
	dangerous: boolean;
	/** 是否直接阻断（deny 动作）：无需弹窗等待，直接拒绝执行并返回原因给模型。 */
	denied?: boolean;
	/** 是否命中白名单明确放行（allow 动作）。 */
	allowed?: boolean;
	reason?: string;
	reasonEn?: string;
	/** 命中的规则档位（「允许同类审批」按它记忆/撤销；无档位的自定义拦截缺省）。 */
	category?: UiApprovalCategory;
	/** 命中的高危片段清单（issue #566）。 */
	hits?: RuleHitDetail[];
}

/** 本对话的审批放行策略（仅内存；挂在 Conversation 上，见 server/agent-service.ts）。 */
export interface ApprovalPolicy {
	/** 本对话「全部允许审批」（后续高危操作不再询问）。 */
	allowAll: boolean;
	/** 本对话已记住的同类档位（id → 档位，含双语名，设置面板撤销列表要用）。 */
	categories: Map<string, UiApprovalCategory>;
}

/** 策略为空（既没全部允许也没记同类）：调用方据此不挂空策略、面板据此不显示撤销区。 */
export function isApprovalPolicyEmpty(policy: ApprovalPolicy | undefined): boolean {
	return !policy || (!policy.allowAll && policy.categories.size === 0);
}

/**
 * 判定某个工具调用是否属于超宽范围、全局根目录或系统级不可逆操作（Issue #722）。
 * 针对此类全局高危操作，即便用户之前曾为局部目录勾选过「允许同类」，
 * 同类记忆（category）亦强制失效，必须显式弹窗审批（除非用户选择了本对话「全部允许」）。
 */
export function isWideScopeOrRootOperation(toolName: string, params: unknown): boolean {
	if (!params || typeof params !== "object") return false;
	const obj = params as Record<string, unknown>;

	if (toolName === "bash") {
		const cmd = String(obj.command ?? "").trim();
		// 1. 递归/强制删除大范围根路径、家目录、父目录、盘符根目录或通配符
		// 形如 `rm -rf /`、`rm -rf ~`、`rm -rf ..`、`rm -rf *`、`rm -rf C:\`
		if (/\brm\s+.*(-[a-zA-Z0-9]*[rf]|--recursive)/i.test(cmd)) {
			// 匹配单独的危险目标 token：/、~、..、*、或 Windows 根盘如 C:\
			if (/(?:^|\s)(?:[/~*]|\.\.|[a-zA-Z]:[\\/])(?:\s|$)/.test(cmd)) {
				return true;
			}
		}
		// 2. Windows 强制递归删除系统/根盘目标
		if (/\b(del|rmdir|rd)\s+[/\\-][fsq]/i.test(cmd)) {
			if (/(?:^|\s)(?:[/~*]|\.\.|[a-zA-Z]:[\\/])(?:\s|$)/.test(cmd)) {
				return true;
			}
		}
		// 3. 磁盘格式化或底层写入 (format C:, mkfs, dd if=)
		if (/\b(mkfs|format\s+[a-zA-Z]:|dd\s+if=)/i.test(cmd)) {
			return true;
		}
		// 4. 重定向覆盖系统目录
		if (/>\s*(?:\/etc\/|\/boot\/|C:\\Windows)/i.test(cmd)) {
			return true;
		}
		// 5. 全局危险权限修改 chmod 777 -R / 或 chmod -R 777 /
		if (/\bchmod\s+.*?(?:777|000).*?(?:[/~]|[a-zA-Z]:[\\/])/i.test(cmd)) {
			return true;
		}
	}

	if (toolName === "write" || toolName === "edit" || toolName === "edit_soft" || toolName === "patch") {
		const p = extractTargetPath(params);
		// 敏感系统文件与密钥凭据（跨文件的同类不能随意扩散到系统或密钥）
		if (
			p.includes("/etc/") ||
			p.includes("/boot/") ||
			p.includes("C:\\Windows") ||
			p.includes(".ssh") ||
			p.includes("id_rsa") ||
			p.includes("id_ed25519")
		) {
			return true;
		}
	}

	return false;
}

/**
 * 三档放行的纯判定：返回 null = 需要弹审批，否则返回放行的原因。
 * - `disabled`：全局开关关（设置 →「工具」页）→ 一切审批都不弹（插件显式 ask 也放行）；
 * - `allow-all`：本对话已「全部允许」；
 * - `category`：本对话已记住该同类档位（但全局高危/根路径操作除外，见 isWideScopeOrRootOperation）。
 */
export function approvalSuppressionReason(
	policy: ApprovalPolicy | undefined,
	enabled: boolean,
	categoryId?: string,
	toolName?: string,
	params?: unknown,
): "disabled" | "allow-all" | "category" | null {
	if (!enabled) return "disabled";
	if (!policy) return null;
	if (policy.allowAll) return "allow-all";
	if (categoryId && policy.categories.has(categoryId)) {
		// 特权边界收敛（Issue #722）：
		// 即使已记住同类档位，若当前操作属于全局根路径、系统破坏性或敏感密钥写入等超宽操作，
		// 严禁凭同类记忆静默放行，必须强制弹窗要求显式确认。
		if (toolName && params && isWideScopeOrRootOperation(toolName, params)) {
			return null;
		}
		return "category";
	}
	return null;
}

/** 插件显式要求确认（pre guard 的 ask）对应的档位：按插件 id 分档，可「允许同类」。 */
export function pluginApprovalCategory(pluginId: string): UiApprovalCategory {
	return {
		id: `plugin:${pluginId}`,
		label: `插件 ${pluginId} 要求确认`,
		labelEn: `Plugin ${pluginId} requested confirmation`,
	};
}

/** 审批解决结果。 */
export interface ToolApprovalResolution {
	decision: "approve" | "deny" | "edit";
	editedParams?: Record<string, unknown> | unknown;
	reason?: string;
}

/**
 * 检测某个工具调用是否属于高危操作，或命中用户自定义规则。
 * 可选接收 rules 规则集；缺省时以内置默认高危规则集判定。
 */
export function checkDangerousToolCall(
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
	rules?: ApprovalRule[],
): DangerousCheckResult {
	if (!params || typeof params !== "object") {
		return { dangerous: false };
	}

	const res = evaluateApprovalRules(rules ?? DEFAULT_APPROVAL_RULES, toolName, params, cwd, workspaceRoots);

	if (res.action === "deny") {
		return {
			dangerous: true,
			denied: true,
			reason: res.reason,
			reasonEn: res.reasonEn,
			category: res.category,
			hits: res.hits,
		};
	}

	if (res.action === "allow") {
		return {
			dangerous: false,
			allowed: true,
		};
	}

	if (res.action === "ask") {
		return {
			dangerous: true,
			denied: false,
			reason: res.reason,
			reasonEn: res.reasonEn,
			category: res.category,
			hits: res.hits,
		};
	}

	return { dangerous: false };
}

/** 待审批项记录。 */
export interface PendingApprovalEntry {
	id: string;
	toolCallId: string;
	toolName: string;
	params: Record<string, unknown> | unknown;
	reason?: string;
	reasonEn?: string;
	/** 命中的规则档位（弹窗据此显示「允许同类」并作为记忆键）。 */
	category?: UiApprovalCategory;
	/** 命中的高危片段清单（issue #566）。 */
	hits?: RuleHitDetail[];
	/** 若该工具调用是由某个上层工具嵌套发起（例如 codemode 沙箱脚本调用），记录上层工具名。 */
	parentTool?: string;
	conversationId?: string;
	conversationTitle?: string;
	resolve: (res: ToolApprovalResolution) => void;
	createdAt: number;
}

export type { ApprovalRule, RuleHitDetail } from "./approval-rules.js";
