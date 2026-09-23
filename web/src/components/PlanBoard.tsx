import { useState } from "react";
import {
	FiCheckCircle,
	FiClock,
	FiAlertCircle,
	FiCircle,
	FiChevronDown,
	FiChevronUp,
	FiTrash2,
	FiList,
} from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import type { PlanState, PlanStep, PlanStepStatus } from "../types";

interface PlanBoardProps {
	plan: PlanState | null | undefined;
}

/**
 * 结构化任务计划看板（Plan Mode / Step State Machine）。
 *
 * 借鉴 DSH 的 dsh-plan-mode：
 * 实时展示模型制定和推进的任务步骤状态机（pending / in_progress / done / failed），
 * 支持折叠/展开，并提供总体进度条。
 */
export function PlanBoard({ plan }: PlanBoardProps) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);

	if (!plan || !plan.steps || plan.steps.length === 0) {
		return null;
	}

	const steps = plan.steps;
	const doneCount = steps.filter((s) => s.status === "done").length;
	const totalCount = steps.length;
	const percent = Math.round((doneCount / totalCount) * 100);

	const activeStep = steps.find((s) => s.id === plan.activeStepId) ?? steps.find((s) => s.status === "in_progress");

	const handleClearPlan = () => {
		if (window.confirm("确定要清空当前任务计划看板吗？")) {
			appSend({
				type: "plan_update",
				steps: [],
			});
		}
	};

	const getStatusBadge = (status: PlanStepStatus) => {
		switch (status) {
			case "done":
				return (
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 4,
							color: "var(--green, #22c55e)",
							fontSize: 12,
							fontWeight: 600,
						}}
					>
						<FiCheckCircle />
						{t("planBoardCompleted")}
					</span>
				);
			case "in_progress":
				return (
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 4,
							color: "var(--accent, #38bdf8)",
							fontSize: 12,
							fontWeight: 600,
						}}
					>
						<FiClock />
						{t("planBoardInProgress")}
					</span>
				);
			case "failed":
				return (
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 4,
							color: "var(--red, #ef4444)",
							fontSize: 12,
							fontWeight: 600,
						}}
					>
						<FiAlertCircle />
						{t("planBoardFailed")}
					</span>
				);
			case "pending":
			default:
				return (
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 4,
							color: "var(--text-dim, #9aa1b4)",
							fontSize: 12,
						}}
					>
						<FiCircle />
						{t("planBoardPending")}
					</span>
				);
		}
	};

	return (
		<div
			className="plan-board"
			style={{
				/* 左右内缩与宽度交给 .plan-board（同 .goalbar 的列 token），
				   别在这里写固定 margin —— 固定值在宽屏聊天列/窄屏下都比对话列宽一截。 */
				padding: "10px 14px",
				borderRadius: 8,
				backgroundColor: "var(--bg-elev, #18202f)",
				border: "1px solid var(--border-subtle, rgba(255, 255, 255, 0.1))",
				boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
				fontSize: 13,
			}}
		>
			{/* 顶部概要栏 */}
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					cursor: "pointer",
					userSelect: "none",
				}}
				onClick={() => setExpanded(!expanded)}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
					<FiList style={{ color: "var(--accent, #38bdf8)", flexShrink: 0 }} />
					<span style={{ fontWeight: 600, color: "var(--text, #f1f5f9)" }}>{t("planBoardTitle")}</span>
					<span style={{ fontSize: 12, color: "var(--text-dim, #9aa1b4)", marginLeft: 4 }}>
						{doneCount}/{totalCount} ({percent}%)
					</span>
					{/* 紧凑模式下显示当前进行中步骤 */}
					{!expanded && activeStep && (
						<span
							style={{
								marginLeft: 8,
								fontSize: 12,
								padding: "2px 8px",
								borderRadius: 4,
								backgroundColor: "rgba(56, 189, 248, 0.12)",
								color: "var(--accent, #38bdf8)",
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
								maxWidth: 260,
							}}
						>
							{activeStep.title}
						</span>
					)}
				</div>

				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<button
						type="button"
						className="btn-icon"
						title={t("clear")}
						style={{
							background: "none",
							border: "none",
							color: "var(--text-dim, #9aa1b4)",
							cursor: "pointer",
							padding: 4,
							display: "inline-flex",
						}}
						onClick={(e) => {
							e.stopPropagation();
							handleClearPlan();
						}}
					>
						<FiTrash2 />
					</button>
					<button
						type="button"
						className="btn-icon"
						style={{
							background: "none",
							border: "none",
							color: "var(--text-dim, #9aa1b4)",
							cursor: "pointer",
							padding: 4,
							display: "inline-flex",
						}}
					>
						{expanded ? <FiChevronUp /> : <FiChevronDown />}
					</button>
				</div>
			</div>

			{/* 进度条 */}
			<div
				style={{
					height: 4,
					backgroundColor: "rgba(255, 255, 255, 0.08)",
					borderRadius: 2,
					margin: "8px 0",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						height: "100%",
						width: `${percent}%`,
						backgroundColor: percent === 100 ? "var(--green, #22c55e)" : "var(--accent, #38bdf8)",
						transition: "width 0.3s ease",
					}}
				/>
			</div>

			{/* 展开的完整步骤清单 */}
			{expanded && (
				<div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
					{steps.map((step, idx) => {
						const isCurrent = step.id === plan.activeStepId || step.status === "in_progress";
						return (
							<div
								key={step.id || idx}
								style={{
									display: "flex",
									alignItems: "flex-start",
									justifyContent: "space-between",
									padding: "6px 10px",
									borderRadius: 6,
									backgroundColor: isCurrent ? "rgba(56, 189, 248, 0.08)" : "var(--bg-elev2, rgba(0, 0, 0, 0.2))",
									border: isCurrent ? "1px solid rgba(56, 189, 248, 0.25)" : "1px solid transparent",
								}}
							>
								<div style={{ flex: 1, minWidth: 0, paddingRight: 10 }}>
									<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
										<span
											style={{
												fontSize: 11,
												fontWeight: 700,
												color: isCurrent ? "var(--accent, #38bdf8)" : "var(--text-dim, #9aa1b4)",
												minWidth: 16,
											}}
										>
											{idx + 1}.
										</span>
										<span
											style={{
												fontWeight: isCurrent ? 600 : 500,
												color: step.status === "done" ? "var(--text-dim, #9aa1b4)" : "var(--text, #f1f5f9)",
												textDecoration: step.status === "done" ? "line-through" : "none",
											}}
										>
											{step.title}
										</span>
									</div>
									{step.description && (
										<div
											style={{
												fontSize: 12,
												color: "var(--text-dim, #9aa1b4)",
												marginTop: 2,
												paddingLeft: 22,
												lineHeight: 1.4,
											}}
										>
											{step.description}
										</div>
									)}
								</div>
								<div style={{ flexShrink: 0, marginTop: 2 }}>{getStatusBadge(step.status)}</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
