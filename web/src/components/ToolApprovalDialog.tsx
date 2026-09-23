import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FiAlertTriangle, FiCheck, FiCheckCircle, FiEdit3, FiLayers, FiX } from "react-icons/fi";
import { appSend } from "../app-globals";
import { useI18n, useT } from "../i18n";
import type { UiToolApproval } from "../types";

interface ToolApprovalDialogProps {
	approval: UiToolApproval | null;
}

/**
 * 人机协同拦截与「改写执行」（Human-in-the-Loop: Edit & Run）审批弹窗。
 *
 * 当工具拦截层（ToolGuard / 权限沙箱）识别到高危操作或关键文件修改时弹出，
 * 用户可选择：
 * 1. 「批准」（Approve）：放行原参数执行；
 * 2. 「拒绝」（Deny）：阻断执行并将拒绝原因返回模型；
 * 3. 「修改并放行」（Edit & Run）：就地修改工具参数后提交执行；
 * 4. 「本对话允许同类」（Allow this kind）：批准 + 记住本对话内该规则档位，后续同类不再问；
 * 5. 「本对话全部允许」（Allow all）：批准 + 本对话内后续全部不再问。
 *
 * 后两个只在内存里（服务重启/新对话即恢复询问），撤销入口在 设置 →「工具」页。
 */
export function ToolApprovalDialog({ approval }: ToolApprovalDialogProps) {
	const t = useT();
	const { locale } = useI18n();

	// 本地编辑的参数文本（JSON 字符串）
	const [paramsText, setParamsText] = useState("");
	const [parseError, setParseError] = useState<string | null>(null);

	useEffect(() => {
		if (approval) {
			try {
				setParamsText(JSON.stringify(approval.params ?? {}, null, 2));
				setParseError(null);
			} catch {
				setParamsText(String(approval.params ?? ""));
			}
		}
	}, [approval]);

	if (!approval) return null;

	const handleApprove = (scope?: "once" | "category" | "all") => {
		appSend({
			type: "tool_approval_response",
			id: approval.id,
			decision: "approve",
			...(scope && scope !== "once" ? { scope } : {}),
		});
	};

	const handleDeny = () => {
		appSend({
			type: "tool_approval_response",
			id: approval.id,
			decision: "deny",
			reason: "Operation rejected by user",
		});
	};

	const handleEditAndRun = () => {
		try {
			let edited: unknown;
			if (typeof approval.params === "object" && approval.params !== null) {
				edited = JSON.parse(paramsText);
			} else {
				edited = paramsText;
			}
			setParseError(null);
			appSend({
				type: "tool_approval_response",
				id: approval.id,
				decision: "edit",
				editedParams: edited,
			});
		} catch (err) {
			setParseError(`JSON 格式错误：${(err as Error).message}`);
		}
	};

	return createPortal(
		<div className="modal-backdrop">
			<div
				className="tool-info-modal approval-modal"
				role="dialog"
				aria-modal="true"
				aria-label={t("toolApprovalTitle")}
				style={{ maxWidth: 640, borderTop: "4px solid var(--amber, #f59e0b)" }}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="tool-info-head">
					<span className="tool-info-title" style={{ color: "var(--amber, #f59e0b)" }}>
						<FiAlertTriangle />
						{t("toolApprovalTitle")}
					</span>
					<code className="tool-info-name" style={{ fontWeight: 700 }}>
						{approval.toolName}
					</code>
					{approval.conversationTitle && <span className="tool-info-label">{approval.conversationTitle}</span>}
					<button type="button" className="btn" title={t("toolApprovalDeny")} onClick={handleDeny}>
						<FiX />
					</button>
				</div>

				<div className="tool-info-body" style={{ padding: "16px 20px" }}>
					{/* 风险告警原因 */}
					{(approval.reason || approval.reasonEn) && (
						<div
							style={{
								padding: "10px 14px",
								borderRadius: 6,
								backgroundColor: "rgba(245, 158, 11, 0.12)",
								border: "1px solid rgba(245, 158, 11, 0.3)",
								marginBottom: 16,
								color: "var(--amber, #f59e0b)",
								fontSize: 13,
								lineHeight: 1.5,
								fontWeight: 500,
							}}
						>
							<div style={{ fontWeight: 600, marginBottom: 2 }}>{t("toolApprovalRiskAlert")}:</div>
							<div>{approval.reason || approval.reasonEn}</div>
							{approval.category && (
								<div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
									{t("toolApprovalCategory")}：{locale === "zh" ? approval.category.label : approval.category.labelEn}
								</div>
							)}
						</div>
					)}

					{/* 参数就地修改编辑区域 */}
					<div style={{ marginBottom: 16 }}>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								marginBottom: 6,
							}}
						>
							<span style={{ fontSize: 13, fontWeight: 600, color: "var(--text, #e2e8f0)" }}>
								{t("toolApprovalParams")}
							</span>
							<span style={{ fontSize: 11, color: "var(--text-dim, #9aa1b4)" }}>
								{t("toolApprovalEditPlaceholder")}
							</span>
						</div>
						<textarea
							rows={8}
							value={paramsText}
							onChange={(e) => {
								setParamsText(e.target.value);
								if (parseError) setParseError(null);
							}}
							style={{
								width: "100%",
								fontFamily: "var(--mono, monospace)",
								fontSize: 12,
								lineHeight: 1.5,
								padding: 10,
								borderRadius: 6,
								backgroundColor: "var(--bg-elev, #111827)",
								color: "var(--text, #f8fafc)",
								border: parseError
									? "1px solid var(--red, #ef4444)"
									: "1px solid var(--border-subtle, rgba(255,255,255,0.1))",
								boxSizing: "border-box",
								resize: "vertical",
							}}
						/>
						{parseError && <div style={{ color: "var(--red, #ef4444)", fontSize: 12, marginTop: 4 }}>{parseError}</div>}
					</div>

					{/* 动作按钮组：本对话允许同类 / 本对话全部允许 / 拒绝 / 批准 / 修改并放行 */}
					<div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 10 }}>
						{approval.category && (
							<button
								type="button"
								className="btn"
								title={t("toolApprovalAllowCategoryHint")}
								onClick={() => handleApprove("category")}
							>
								<FiLayers />
								{t("toolApprovalAllowCategory")}
							</button>
						)}
						<button
							type="button"
							className="btn"
							title={t("toolApprovalAllowConversationHint")}
							onClick={() => handleApprove("all")}
						>
							<FiCheckCircle />
							{t("toolApprovalAllowConversation")}
						</button>
						<button type="button" className="btn" style={{ color: "var(--red, #ef4444)" }} onClick={handleDeny}>
							<FiX />
							{t("toolApprovalDeny")}
						</button>
						<button type="button" className="btn" onClick={() => handleApprove()} style={{ fontWeight: 500 }}>
							<FiCheck />
							{t("toolApprovalApprove")}
						</button>
						<button
							type="button"
							className="btn btn-primary"
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								backgroundColor: "var(--amber, #f59e0b)",
								borderColor: "var(--amber, #f59e0b)",
								color: "#000",
								fontWeight: 600,
							}}
							onClick={handleEditAndRun}
						>
							<FiEdit3 />
							{t("toolApprovalEditAndRun")}
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
