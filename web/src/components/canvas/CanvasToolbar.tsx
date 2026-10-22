/**
 * CanvasToolbar.tsx — 画布协作工作室顶部浮动控制栏。
 */
import { useState } from "react";
import type { CanvasGraph, CanvasGraphSummary } from "../../types";
import { SQUAD_TEMPLATES } from "./CanvasTemplates";
import {
	FiPlus,
	FiPlay,
	FiSquare,
	FiRotateCcw,
	FiZoomIn,
	FiZoomOut,
	FiMaximize2,
	FiUsers,
	FiFolder,
	FiSave,
} from "react-icons/fi";

interface CanvasToolbarProps {
	graph: CanvasGraph;
	graphList: CanvasGraphSummary[];
	onSelectGraph: (id: string) => void;
	onSave: () => void;
	onAddNode: () => void;
	onApplyTemplate: (templateGraph: CanvasGraph) => void;
	onRunAll: () => void;
	onStopAll: () => void;
	onResetStatus: () => void;
	onToggleExecutionMode: (mode: "real" | "simulate") => void;
	zoom: number;
	onZoomChange: (newZoom: number) => void;
	onResetViewport: () => void;
}

export function CanvasToolbar({
	graph,
	graphList,
	onSelectGraph,
	onSave,
	onAddNode,
	onApplyTemplate,
	onRunAll,
	onStopAll,
	onResetStatus,
	onToggleExecutionMode,
	zoom,
	onZoomChange,
	onResetViewport,
}: CanvasToolbarProps) {
	const [showSquadMenu, setShowSquadMenu] = useState(false);

	return (
		<div className="canvas-toolbar">
			{/* 工程列表选择 */}
			<div className="canvas-toolbar-group">
				<FiFolder className="canvas-toolbar-icon" />
				<select
					className="canvas-toolbar-select"
					value={graph.id}
					onChange={(e) => onSelectGraph(e.target.value)}
					title="切换画布工程"
				>
					{graphList.map((g) => (
						<option key={g.id} value={g.id}>
							{g.name} ({g.nodeCount}人)
						</option>
					))}
				</select>
				<button type="button" className="canvas-toolbar-btn" onClick={onSave} title="保存当前工程">
					<FiSave />
				</button>
			</div>

			<div className="canvas-toolbar-divider" />

			{/* 添加数字员工与预设战队 */}
			<div className="canvas-toolbar-group">
				<button type="button" className="canvas-toolbar-btn primary" onClick={onAddNode} title="新增数字员工节点">
					<FiPlus /> 新增队友
				</button>

				<div className="canvas-dropdown-wrap">
					<button
						type="button"
						className="canvas-toolbar-btn"
						onClick={() => setShowSquadMenu(!showSquadMenu)}
						title="加载官方开箱即用战队模板"
					>
						<FiUsers /> 战队模板 ▾
					</button>

					{showSquadMenu && (
						<div
							className="canvas-dropdown-menu"
							onClick={() => setShowSquadMenu(false)}
							onPointerDown={(e) => e.stopPropagation()}
							onMouseDown={(e) => e.stopPropagation()}
							onWheel={(e) => e.stopPropagation()}
						>
							{SQUAD_TEMPLATES.map((tmpl) => (
								<button
									key={tmpl.id}
									type="button"
									className="canvas-dropdown-item"
									onClick={() => onApplyTemplate(tmpl.createGraph())}
								>
									<b>{tmpl.title}</b>
									<small>{tmpl.desc}</small>
								</button>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="canvas-toolbar-divider" />

			{/* 全图调度控制 */}
			<div className="canvas-toolbar-group">
				{graph.status === "running" ? (
					<button type="button" className="canvas-toolbar-btn stop" onClick={onStopAll} title="全部停止">
						<FiSquare /> 全部停止
					</button>
				) : (
					<button type="button" className="canvas-toolbar-btn run" onClick={onRunAll} title="启动全队流水线">
						<FiPlay /> 启动流水线
					</button>
				)}

				<button type="button" className="canvas-toolbar-btn" onClick={onResetStatus} title="重置全队状态为待命 (idle)">
					<FiRotateCcw /> 复位
				</button>

				{/* 真实执行 vs 拓扑演练模式切换 */}
				<button
					type="button"
					className={`canvas-toolbar-btn ${graph.executionMode !== "simulate" ? "real-mode" : "sim-mode"}`}
					onClick={() => onToggleExecutionMode(graph.executionMode === "simulate" ? "real" : "simulate")}
					title={
						graph.executionMode === "simulate"
							? "当前为拓扑演练模式（不耗 Token，快速演示流程；点击切换为真实引擎调用）"
							: "当前为真实智能体编码模式（真实调用所选模型与工具修改项目代码；点击切换为演练模式）"
					}
				>
					{graph.executionMode === "simulate" ? "🧪 演练模式" : "⚡ 真实执行"}
				</button>
			</div>

			<div className="canvas-toolbar-divider" />

			{/* 视口缩放与居中控制 */}
			<div className="canvas-toolbar-group">
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={() => onZoomChange(Math.max(zoom - 0.15, 0.25))}
					title="缩小"
				>
					<FiZoomOut />
				</button>
				<button type="button" className="canvas-toolbar-btn" onClick={onResetViewport} title="恢复 100% 居中视图">
					<FiMaximize2 /> {Math.round(zoom * 100)}%
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={() => onZoomChange(Math.min(zoom + 0.15, 2.0))}
					title="放大"
				>
					<FiZoomIn />
				</button>
			</div>
		</div>
	);
}
