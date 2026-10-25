/**
 * server/approval-audit.ts
 *
 * 审批决策与安全拦截审计日志（Append-Only Structured Audit Trail，Issue #722）。
 *
 * 记录每一个高危操作与自定义规则的安全事件：
 * - 规则直接阻断（rule_denied）
 * - 弹窗审批答复（user_approved / user_denied / user_edited）
 * - 策略静默放行（suppressed_category / suppressed_all / suppressed_disabled）
 * - 批量自动放行（batch_approved_policy / batch_approved_disabled）
 *
 * 存储路径：<dataDir>/audit/approvals.jsonl
 * 轮转规则：单文件达到 10MB 自动轮转，最多保留 3 份归档。
 */

import { existsSync, mkdirSync, statSync, renameSync, unlinkSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ApprovalAuditEntry {
	id: string;
	timestamp: number;
	isoTime: string;
	conversationId?: string;
	toolName: string;
	params?: unknown;
	decision: "approved" | "denied" | "edited";
	decisionSource:
		| "user_dialog"
		| "suppressed_category"
		| "suppressed_all"
		| "suppressed_disabled"
		| "rule_denied"
		| "batch_approved_policy"
		| "batch_approved_disabled";
	scope?: "once" | "category" | "all";
	userEdited?: boolean;
	ruleId?: string;
	categoryId?: string;
	reason?: string;
}

export type ToolAuditRecordFn = (entry: Omit<ApprovalAuditEntry, "id" | "timestamp" | "isoTime">) => void;

const MAX_AUDIT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUP_FILES = 3;

/** 参数摘录与截断（单个字段最长 1024 字符，防止长文本撑爆审计日志）。 */
export function sanitizeAuditParams(params: unknown): unknown {
	if (params === null || params === undefined) return params;
	if (typeof params === "string") {
		return params.length > 1024 ? `${params.slice(0, 1024)}... [truncated ${params.length} chars]` : params;
	}
	if (typeof params !== "object") return params;
	if (Array.isArray(params)) {
		return params.slice(0, 20).map(sanitizeAuditParams);
	}
	const obj = params as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = sanitizeAuditParams(v);
	}
	return out;
}

export class ApprovalAuditLogger {
	private readonly logPath: string;
	private seq = 0;

	constructor(dataDir: string) {
		this.logPath = join(dataDir, "audit", "approvals.jsonl");
	}

	getFilePath(): string {
		return this.logPath;
	}

	/** 记录一条审批/安全决策。 */
	record(entry: Omit<ApprovalAuditEntry, "id" | "timestamp" | "isoTime">): void {
		try {
			const now = Date.now();
			const fullEntry: ApprovalAuditEntry = {
				id: `audit-${now}-${++this.seq}`,
				timestamp: now,
				isoTime: new Date(now).toISOString(),
				...entry,
				params: sanitizeAuditParams(entry.params),
			};

			this.rotateIfNeeded();
			const dir = dirname(this.logPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			appendFileSync(this.logPath, JSON.stringify(fullEntry) + "\n", "utf8");
		} catch (err) {
			// 审计日志写入为旁路监控，绝不中断正常业务流，仅记录调试警告
			console.warn("[approval-audit] Failed to write audit log:", err);
		}
	}

	/** 检查文件大小并按需轮转。 */
	private rotateIfNeeded(): void {
		if (!existsSync(this.logPath)) return;
		try {
			const stat = statSync(this.logPath);
			if (stat.size < MAX_AUDIT_FILE_SIZE) return;

			for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
				const src = this.logPath.replace(/\.jsonl$/, `.${i}.jsonl`);
				const dst = this.logPath.replace(/\.jsonl$/, `.${i + 1}.jsonl`);
				if (existsSync(src)) {
					if (i === MAX_BACKUP_FILES - 1 && existsSync(dst)) {
						unlinkSync(dst);
					}
					renameSync(src, dst);
				}
			}
			const firstBackup = this.logPath.replace(/\.jsonl$/, ".1.jsonl");
			if (existsSync(firstBackup)) unlinkSync(firstBackup);
			renameSync(this.logPath, firstBackup);
		} catch (err) {
			console.warn("[approval-audit] Log rotation failed:", err);
		}
	}

	/** 读取最近 N 条审计记录（主要供单测和审计查看）。 */
	readRecentEntries(limit = 100): ApprovalAuditEntry[] {
		if (!existsSync(this.logPath)) return [];
		try {
			const content = readFileSync(this.logPath, "utf8");
			const lines = content.trim().split("\n").filter(Boolean);
			const out: ApprovalAuditEntry[] = [];
			for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
				try {
					out.push(JSON.parse(lines[i]));
				} catch {
					// 忽略单行解析异常
				}
			}
			return out;
		} catch {
			return [];
		}
	}
}
