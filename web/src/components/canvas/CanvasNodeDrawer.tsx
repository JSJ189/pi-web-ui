/**
 * CanvasNodeDrawer.tsx — 数字员工审查门禁与深度控制台抽屉 (Review Gate & Steer Console)。
 */
import { useState, useEffect, useMemo } from "react";
import type { CanvasNode, CanvasEdge, ModelInfo, ProjectSummary } from "../../types";
import type { ThinkingValue } from "../../thinking-levels";
import { ENGINE_METAS, ROLE_METAS } from "./CanvasTypes";
import { ModelThinking } from "../ModelThinking";
import { UniversalPathPicker } from "../UniversalPathPicker";
import { FiX, FiSend, FiPlay, FiSquare, FiGitBranch, FiCheckCircle, FiAlertCircle } from "react-icons/fi";

interface CanvasNodeDrawerProps {
	node: CanvasNode | null;
	edges: CanvasEdge[];
	allNodes: CanvasNode[];
	models: ModelInfo[];
	projects: ProjectSummary[];
	onClose: () => void;
	onUpdate: (nodeId: string, patch: Partial<CanvasNode>) => void;
	onRun: (nodeId: string) => void;
	onStop: (nodeId: string) => void;
	onSteer: (nodeId: string, message: string) => void;
	onBrowseFolder: (nodeId: string) => void;
}

export function CanvasNodeDrawer({
	node,
	edges,
	allNodes,
	models,
	projects,
	onClose,
	onUpdate,
	onRun,
	onStop,
	onSteer,
	onBrowseFolder,
}: CanvasNodeDrawerProps) {
	const [steerInput, setSteerInput] = useState("");

	// 支持按 Escape 键关闭抽屉（必须放在顶部，保证 Hook 调用数量恒定）
	useEffect(() => {
		if (!node) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [node, onClose]);

	// 解析出与 ModelThinking 兼容的当前模型对象
	const selectedModelObj = useMemo(() => {
		if (!node) return null;
		const raw = node.model;
		const found = models.find((m) => m.id === raw || `${m.provider}/${m.id}` === raw);
		if (found) return found;
		const parts = raw.split("/");
		return {
			id: raw,
			name: parts.length > 1 ? parts.slice(1).join("/") : raw,
			provider: parts.length > 1 ? parts[0] : "custom",
		} as ModelInfo;
	}, [node, models]);

	if (!node) return null;

	const engineMeta = ENGINE_METAS[node.engine] || ENGINE_METAS.pi;
	const roleMeta = ROLE_METAS[node.role] || ROLE_METAS.coder;

	// 查询输入连线（上游契约）
	const incomingEdges = edges.filter((e) => e.targetNodeId === node.id);
	const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

	const handleSendSteer = () => {
		if (!steerInput.trim()) return;
		onSteer(node.id, steerInput.trim());
		setSteerInput("");
	};

	return (
		<div
			className="canvas-drawer-overlay"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) {
					e.stopPropagation();
				}
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) {
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<div
				className="canvas-drawer-panel"
				onPointerDown={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
				onWheel={(e) => e.stopPropagation()}
				onClick={(e) => e.stopPropagation()}
			>
				{/* 抽屉头部 */}
				<div className="canvas-drawer-header">
					<div className="canvas-drawer-title-group">
						<span className="canvas-drawer-role-icon">{roleMeta.icon}</span>
						<div>
							<h3 className="canvas-drawer-title">{node.title}</h3>
							<div className="canvas-drawer-subtitle">
								<span
									className="canvas-engine-chip"
									style={{
										color: engineMeta.color,
										borderColor: engineMeta.color,
										backgroundColor: engineMeta.bgColor,
									}}
								>
									{engineMeta.name}
								</span>
								<span className="canvas-model-chip">{node.model}</span>
							</div>
						</div>
					</div>

					<button type="button" className="canvas-drawer-close" onClick={onClose} title="关闭抽屉">
						<FiX />
					</button>
				</div>

				{/* 抽屉内容区 */}
				<div className="canvas-drawer-body">
					{/* 模型与思考强度配置（通用 ModelThinking 控件） */}
					<div className="canvas-drawer-section">
						<h4 className="canvas-section-title">模型选择与思考强度 (Model & Thinking)</h4>
						<ModelThinking
							state={{
								model: selectedModelObj,
								thinkingLevel: (node.thinkingLevel as ThinkingValue) || "off",
								availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
							}}
							models={models}
							direction="down"
							onSelectModel={(m) => onUpdate(node.id, { model: `${m.provider}/${m.id}` })}
							onSelectThinking={(lvl) => onUpdate(node.id, { thinkingLevel: lvl })}
						/>
					</div>

					{/* 环境与物理目录（通用 UniversalPathPicker 控件） */}
					<div className="canvas-drawer-section">
						<h4 className="canvas-section-title">工作区沙箱环境</h4>
						<UniversalPathPicker
							cwd={node.cwd}
							onSelectCwd={(c) => onUpdate(node.id, { cwd: c })}
							onOpenProjectPicker={() => onBrowseFolder(node.id)}
							projects={projects}
						/>
						<label className="canvas-checkbox-row" style={{ marginTop: "8px" }}>
							<input
								type="checkbox"
								checked={node.useWorktree}
								onChange={(e) => onUpdate(node.id, { useWorktree: e.target.checked })}
							/>
							<span className="canvas-checkbox-label">
								<FiGitBranch /> 启用独立 Git Worktree 物理隔离 (.worktrees/canvas-{node.id})
							</span>
						</label>
					</div>

					{/* 角色职责与 System Prompt */}
					<div className="canvas-drawer-section">
						<h4 className="canvas-section-title">角色指令规约 (System Prompt)</h4>
						<textarea
							className="canvas-drawer-textarea"
							rows={3}
							value={node.systemPromptOverride || ""}
							onChange={(e) => onUpdate(node.id, { systemPromptOverride: e.target.value })}
							placeholder="输入该数字员工的专属职责说明..."
						/>
					</div>

					{/* 上游任务契约 (Incoming Contracts) */}
					{incomingEdges.length > 0 && (
						<div className="canvas-drawer-section">
							<h4 className="canvas-section-title">上游前置契约 (Incoming Contracts)</h4>
							<div className="canvas-contract-list">
								{incomingEdges.map((edge) => {
									const sourceNode = nodeMap.get(edge.sourceNodeId);
									return (
										<div key={edge.id} className="canvas-contract-card">
											<div className="canvas-contract-header">
												<span>
													来源: <b>{sourceNode?.title || edge.sourceNodeId}</b>
												</span>
												<span className="canvas-contract-type">{edge.type}</span>
											</div>
											<div className="canvas-contract-content">
												{edge.lastHandoffSummary || "（等待上游完成交付后自动注入）"}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* 任务交付物与审查门禁 (Review Gate) */}
					<div className="canvas-drawer-section">
						<h4 className="canvas-section-title">任务交付与审查门禁 (Review Gate)</h4>
						<div className="canvas-review-gate-box">
							<div className="canvas-review-status-row">
								<span>当前状态：</span>
								<b className={`status-badge status-${node.status}`}>{node.status.toUpperCase()}</b>
							</div>
							<div className="canvas-summary-box">
								{node.lastOutputSummary ? (
									<div>
										<p className="canvas-summary-text">{node.lastOutputSummary}</p>
										<div className="canvas-review-actions">
											<button
												type="button"
												className="canvas-btn green"
												onClick={() => {
													onUpdate(node.id, { status: "done", currentAction: "人工审查批准合流" });
												}}
											>
												<FiCheckCircle /> 审查通过并批准
											</button>
											<button
												type="button"
												className="canvas-btn orange"
												onClick={() => {
													onUpdate(node.id, {
														status: "waiting_approval",
														currentAction: "人工驳回：需补充完善测试与注释",
													});
												}}
											>
												<FiAlertCircle /> 驳回修改
											</button>
										</div>
									</div>
								) : (
									<span className="canvas-text-muted">暂无交付物产出，等待节点执行完成。</span>
								)}
							</div>
						</div>
					</div>

					{/* 运行中实时插话干预 (Steer Console) */}
					<div className="canvas-drawer-section">
						<h4 className="canvas-section-title">实时插话干预 (Steer)</h4>
						<p className="canvas-tip">数字员工在后台干活时，你随时可以敲字发指令插话纠偏，信息会直接投递进当前会话。</p>
						<div className="canvas-steer-bar">
							<input
								type="text"
								className="canvas-steer-input"
								placeholder="输入实时纠偏意见 (如: 别修改 styles.css，只在组件内局部改动)..."
								value={steerInput}
								onChange={(e) => setSteerInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleSendSteer();
								}}
							/>
							<button type="button" className="canvas-steer-btn" onClick={handleSendSteer} title="发送插话">
								<FiSend />
							</button>
						</div>
					</div>
				</div>

				{/* 抽屉底部控制 */}
				<div className="canvas-drawer-footer">
					{node.status === "running" ? (
						<button type="button" className="canvas-btn stop" onClick={() => onStop(node.id)}>
							<FiSquare /> 停止当前任务
						</button>
					) : (
						<button type="button" className="canvas-btn run" onClick={() => onRun(node.id)}>
							<FiPlay /> 启动该节点
						</button>
					)}
					<button type="button" className="canvas-btn" onClick={onClose}>
						关闭
					</button>
				</div>
			</div>
		</div>
	);
}
