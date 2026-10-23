/**
 * CanvasNodeCard.tsx — 智能体画布单个节点组件（数字员工 Teammate 卡片）。
 */
import { useState, useMemo, type PointerEvent as ReactPointerEvent } from "react";
import type { CanvasEngineId, CanvasNode, ModelInfo, ProjectSummary } from "../../types";
import type { ThinkingValue } from "../../thinking-levels";
import { ENGINE_METAS, ROLE_METAS, STATUS_COLORS, PORT_Y_OFFSET } from "./CanvasTypes";
import { ModelThinking } from "../ModelThinking";
import { UniversalPathPicker } from "../UniversalPathPicker";
import { FiPlay, FiSquare, FiSliders, FiTrash2, FiGitBranch, FiCpu } from "react-icons/fi";

interface CanvasNodeCardProps {
	node: CanvasNode;
	isSelected: boolean;
	hasIncoming?: boolean;
	hasOutgoing?: boolean;
	models: ModelInfo[];
	/** 全局默认模型（"provider/model-id"），列表中找不到节点模型时的显示回退 */
	defaultModel?: string | null;
	projects: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	/** cwd 为 "." 时弹窗初始目录的回退（画布 currentCwd） */
	baseCwd?: string;
	/** 经画布通道下发 make_dir（缺省由通用选择器内置回退经主通道创建） */
	onMakeDir?: (path: string) => void;
	onSelect: (nodeId: string) => void;
	onUpdate: (nodeId: string, patch: Partial<CanvasNode>) => void;
	onDelete: (nodeId: string) => void;
	onRun: (nodeId: string) => void;
	onStop: (nodeId: string) => void;
	onOpenDrawer: (nodeId: string) => void;
	onStartConnect: (nodeId: string, outX: number, outY: number) => void;
	onEndConnect: (nodeId: string) => void;
}

export function CanvasNodeCard({
	node,
	isSelected,
	hasIncoming,
	hasOutgoing,
	models,
	defaultModel,
	projects,
	workspaceRoots = [],
	pathCompletions = [],
	baseCwd,
	onMakeDir,
	onSelect,
	onUpdate,
	onDelete,
	onRun,
	onStop,
	onOpenDrawer,
	onStartConnect,
	onEndConnect,
}: CanvasNodeCardProps) {
	const [isDragging, setIsDragging] = useState(false);
	const [dragStart, setDragStart] = useState({ x: 0, y: 0, nodeX: 0, nodeY: 0 });

	const engineMeta = ENGINE_METAS[node.engine] || ENGINE_METAS.pi;
	const roleMeta = ROLE_METAS[node.role] || ROLE_METAS.coder;
	const statusColor = STATUS_COLORS[node.status] || STATUS_COLORS.idle;

	// 解析出与 ModelThinking 兼容的当前模型对象：绝不杜撰，不存在时回退到全局默认/列表第一个
	const selectedModelObj = useMemo(() => {
		const raw = node.model;
		const found = models.find((m) => m.id === raw || `${m.provider}/${m.id}` === raw);
		if (found) return found;
		if (defaultModel) {
			const def = models.find((m) => `${m.provider}/${m.id}` === defaultModel || m.id === defaultModel);
			if (def) return def;
		}
		if (models.length > 0) return models[0];
		const parts = raw.split("/");
		return {
			id: raw,
			name: parts.length > 1 ? parts.slice(1).join("/") : raw,
			provider: parts.length > 1 ? parts[0] : "custom",
		} as ModelInfo;
	}, [node.model, models, defaultModel]);

	// 处理按住卡头拖拽节点位置
	const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return; // 仅左键拖拽
		e.stopPropagation();
		onSelect(node.id);
		setIsDragging(true);
		setDragStart({
			x: e.clientX,
			y: e.clientY,
			nodeX: node.x,
			nodeY: node.y,
		});
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	};

	const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!isDragging) return;
		const dx = e.clientX - dragStart.x;
		const dy = e.clientY - dragStart.y;
		onUpdate(node.id, {
			x: Math.round(dragStart.nodeX + dx),
			y: Math.round(dragStart.nodeY + dy),
		});
	};

	const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (isDragging) {
			setIsDragging(false);
			try {
				(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
			} catch {
				// 忽略释放异常
			}
		}
	};

	return (
		<div
			className={`canvas-node-card ${isSelected ? "selected" : ""} ${node.status === "running" ? "running" : ""}`}
			style={{
				transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
				width: `${node.width || 300}px`,
			}}
			onPointerDown={(e) => {
				e.stopPropagation();
				onSelect(node.id);
			}}
			onClick={(e) => {
				e.stopPropagation();
				onSelect(node.id);
			}}
			onDoubleClick={(e) => {
				e.stopPropagation();
				onOpenDrawer(node.id);
			}}
		>
			{/* 输入端口 (In Port) */}
			<div
				className={`canvas-port port-in ${hasIncoming ? "connected" : ""}`}
				style={{
					top: `${PORT_Y_OFFSET}px`,
					borderColor: hasIncoming ? "var(--accent)" : "var(--border)",
				}}
				title="输入端口：拖入连线建立前置契约"
				onPointerUp={(e) => {
					e.stopPropagation();
					onEndConnect(node.id);
				}}
			>
				<span className="canvas-port-dot" />
			</div>

			{/* 节点头部：拖拽把手 + 角色 + 引擎徽标 */}
			<div
				className="canvas-node-header"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
			>
				<div className="canvas-node-title-group">
					<span className="canvas-role-icon">{roleMeta.icon}</span>
					<input
						type="text"
						className="canvas-node-title-input"
						value={node.title}
						onChange={(e) => onUpdate(node.id, { title: e.target.value })}
						onClick={(e) => e.stopPropagation()}
						title="点击修改队友名称"
					/>
				</div>

				<div
					className="canvas-engine-badge"
					style={{
						color: engineMeta.color,
						backgroundColor: engineMeta.bgColor,
						borderColor: engineMeta.color,
					}}
					title={engineMeta.desc}
				>
					{engineMeta.badge}
				</div>
			</div>

			{/* 节点配置面板：引擎、模型、目录 */}
			<div className="canvas-node-body">
				<div className="canvas-node-field-row">
					<span className="canvas-field-label">
						<FiCpu /> 引擎底座
					</span>
					<select
						className="canvas-select"
						value={node.engine}
						onChange={(e) => onUpdate(node.id, { engine: e.target.value as CanvasEngineId })}
					>
						<option value="pi">Pi 原生</option>
						<option value="dsh">DSH 极速</option>
						<option value="claude">Claude Code</option>
						<option value="durable">Durable 自愈</option>
					</select>
				</div>

				{/* 模型与思考强度胶囊（直接复用主对话通用 ModelThinking 组件） */}
				<div className="canvas-node-field-col">
					<span className="canvas-field-label">模型与思考强度</span>
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

				{/* 工作目录选择与本地浏览（直接复用通用 UniversalPathPicker 组件） */}
				<div className="canvas-node-field-col">
					<span className="canvas-field-label">工作区目录</span>
					<UniversalPathPicker
						cwd={node.cwd}
						onSelectCwd={(c) => onUpdate(node.id, { cwd: c })}
						projects={projects}
						workspaceRoots={workspaceRoots}
						pathCompletions={pathCompletions}
						baseCwd={baseCwd}
						mode="project"
						onCreateProject={
							onMakeDir
								? (p) => {
										onMakeDir(p);
										onUpdate(node.id, { cwd: p });
									}
								: undefined
						}
					/>
				</div>

				{/* Git Worktree 物理隔离开关 */}
				<label className="canvas-checkbox-row" title="为该数字员工拉取独立的 Git Worktree 沙箱，避免文件并发冲突">
					<input
						type="checkbox"
						checked={node.useWorktree}
						onChange={(e) => onUpdate(node.id, { useWorktree: e.target.checked })}
					/>
					<span className="canvas-checkbox-label">
						<FiGitBranch /> 启用独立 Git Worktree 物理隔离
					</span>
				</label>

				{/* 实时状态灯与动态简报 */}
				<div
					className="canvas-node-status-bar"
					style={{
						backgroundColor: statusColor.bg,
						color: statusColor.text,
					}}
				>
					<span className="canvas-status-dot" style={{ backgroundColor: statusColor.dot }} />
					<span className="canvas-status-text">
						{node.currentAction ||
							(node.status === "idle"
								? "待命中"
								: node.status === "running"
									? "执行中"
									: node.status === "waiting_approval"
										? "待人工审批"
										: node.status === "done"
											? "任务交付完成"
											: "执行出错")}
					</span>
				</div>
			</div>

			{/* 节点底部控制条 */}
			<div className="canvas-node-footer">
				{node.status === "running" ? (
					<button
						type="button"
						className="canvas-btn stop"
						title="中止执行"
						onClick={(e) => {
							e.stopPropagation();
							onStop(node.id);
						}}
					>
						<FiSquare /> 停止
					</button>
				) : (
					<button
						type="button"
						className="canvas-btn run"
						title="启动该节点"
						onClick={(e) => {
							e.stopPropagation();
							onRun(node.id);
						}}
					>
						<FiPlay /> 启动
					</button>
				)}

				<button
					type="button"
					className="canvas-btn"
					title="打开审查与深控抽屉"
					onClick={(e) => {
						e.stopPropagation();
						onOpenDrawer(node.id);
					}}
				>
					<FiSliders /> 审查/插话
				</button>

				<button
					type="button"
					className="canvas-btn del"
					title="删除此节点"
					onClick={(e) => {
						e.stopPropagation();
						onDelete(node.id);
					}}
				>
					<FiTrash2 />
				</button>
			</div>

			{/* 输出端口 (Out Port) */}
			<div
				className={`canvas-port port-out ${hasOutgoing ? "connected" : ""}`}
				style={{
					top: `${PORT_Y_OFFSET}px`,
					borderColor: engineMeta.color,
				}}
				title="输出端口：按住拖拽连线至目标节点"
				onPointerDown={(e) => {
					e.stopPropagation();
					onStartConnect(node.id, node.x + (node.width || 300), node.y + PORT_Y_OFFSET);
				}}
			>
				<span
					className="canvas-port-dot"
					style={{
						backgroundColor: engineMeta.color,
					}}
				/>
			</div>
		</div>
	);
}
