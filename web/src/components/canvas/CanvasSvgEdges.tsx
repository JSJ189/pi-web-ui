/**
 * CanvasSvgEdges.tsx — 画布 SVG 贝塞尔曲线连线层。
 *
 * 采用现代化动态流动发光粒子 (Particle Flow) 取代笨重三角箭头，
 * 支持流动光斑、双层发光光轨、中继胶囊与拉线预览。
 */
import { useMemo } from "react";
import type { CanvasEdge, CanvasNode } from "../../types";
import { PORT_Y_OFFSET } from "./CanvasTypes";

interface CanvasSvgEdgesProps {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	connectingSource: { nodeId: string; x: number; y: number } | null;
	mousePos: { x: number; y: number } | null;
	onDeleteEdge: (edgeId: string) => void;
}

export function CanvasSvgEdges({ nodes, edges, connectingSource, mousePos, onDeleteEdge }: CanvasSvgEdgesProps) {
	const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

	return (
		<svg className="canvas-svg-layer">
			{/* 已建立的连线 */}
			{edges.map((edge) => {
				const source = nodeMap.get(edge.sourceNodeId);
				const target = nodeMap.get(edge.targetNodeId);
				if (!source || !target) return null;

				const sourceX = source.x + (source.width ?? 300);
				const sourceY = source.y + PORT_Y_OFFSET;
				const targetX = target.x;
				const targetY = target.y + PORT_Y_OFFSET;

				// 优雅的水平束状起始切线，避免多线分叉时产生毛刺折角
				const dx = Math.max(Math.abs(targetX - sourceX) * 0.45, 50);
				const d = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${sourceY}, ${targetX - dx} ${targetY}, ${targetX} ${targetY}`;
				const midX = (sourceX + targetX) / 2;
				const midY = (sourceY + targetY) / 2;

				const isReview = edge.type === "review";
				const isParallel = edge.type === "parallel";
				const strokeColor = isReview
					? "var(--amber, #f97316)"
					: isParallel
						? "var(--info-blue, #38bdf8)"
						: "var(--accent, #a855f7)";

				const isSourceRunning = source.status === "running";

				return (
					<g key={edge.id} className="canvas-edge-group">
						{/* 加粗透明命中区域，方便鼠标交互 */}
						<path d={d} fill="none" stroke="transparent" strokeWidth="20" className="canvas-edge-hitbox" />

						{/* 运行中外光晕层 */}
						{isSourceRunning && (
							<path
								d={d}
								fill="none"
								stroke={strokeColor}
								strokeWidth="6"
								strokeLinecap="round"
								className="canvas-edge-glow"
							/>
						)}

						{/* 半透明底轨层 */}
						<path
							d={d}
							fill="none"
							stroke={strokeColor}
							strokeWidth="2"
							strokeLinecap="round"
							className="canvas-edge-track"
						/>

						{/* 动态发光流动光粒子层 (Particle Flow Stream) */}
						<path
							d={d}
							fill="none"
							stroke={isSourceRunning ? "var(--accent-contrast, #fff)" : strokeColor}
							strokeWidth={isSourceRunning ? "3" : "2.5"}
							strokeLinecap="round"
							className={`canvas-edge-particles ${isSourceRunning ? "active" : "ambient"} ${isReview ? "review" : ""}`}
						/>

						{/* 连线中间信息胶囊 */}
						<foreignObject x={midX - 70} y={midY - 14} width="140" height="28" className="canvas-edge-label-container">
							<div className="canvas-edge-badge">
								<span className="canvas-edge-text" title={edge.label || edge.type}>
									{edge.label || (isReview ? "审查驳回 ↺" : isParallel ? "并行派发 ❯❯" : "契约流转 ❯")}
								</span>
								<button
									type="button"
									className="canvas-edge-del"
									title="删除此连线"
									onClick={(e) => {
										e.stopPropagation();
										onDeleteEdge(edge.id);
									}}
								>
									×
								</button>
							</div>
						</foreignObject>
					</g>
				);
			})}

			{/* 正在拉取的临时连线 */}
			{connectingSource && mousePos && (
				<path
					d={`M ${connectingSource.x} ${connectingSource.y} C ${connectingSource.x + 60} ${connectingSource.y}, ${mousePos.x - 60} ${mousePos.y}, ${mousePos.x} ${mousePos.y}`}
					fill="none"
					stroke="var(--accent, #a855f7)"
					strokeWidth="2"
					strokeDasharray="4 4"
					className="canvas-connecting-line"
				/>
			)}
		</svg>
	);
}
