/**
 * CanvasStudio.tsx — 智能体画布工作室 (Canvas Studio) 主视窗。
 *
 * 融合 Multica 数字员工理念、四大异构引擎与 Git Worktree 物理目录隔离。
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type {
	CanvasEdge,
	CanvasGraph,
	CanvasGraphSummary,
	CanvasNode,
	ClientMessage,
	ServerMessage,
	ModelInfo,
	ProjectSummary,
} from "../../types";
import { CanvasSvgEdges } from "./CanvasSvgEdges";
import { CanvasNodeCard } from "./CanvasNodeCard";
import { CanvasNodeDrawer } from "./CanvasNodeDrawer";
import { CanvasToolbar } from "./CanvasToolbar";
import { SQUAD_TEMPLATES } from "./CanvasTemplates";
import { CanvasClient } from "./canvas-client";
import { ProjectPicker } from "../ProjectPicker";
import { appSend } from "../../app-globals";

interface CanvasStudioProps {
	send?: (msg: ClientMessage) => void;
	lastMessage?: ServerMessage | null;
	models?: ModelInfo[];
	projects?: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	currentCwd?: string;
}

export function CanvasStudio({
	send: propSend,
	lastMessage: propLastMessage,
	models = [],
	projects = [],
	workspaceRoots = [],
	pathCompletions = [],
	currentCwd = ".",
}: CanvasStudioProps) {
	const clientRef = useRef<CanvasClient | null>(null);

	// 画布工程全量状态
	const [graph, setGraph] = useState<CanvasGraph>(() => SQUAD_TEMPLATES[0].createGraph());
	const [graphList, setGraphList] = useState<CanvasGraphSummary[]>([]);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null);
	const [projectPickerTargetNodeId, setProjectPickerTargetNodeId] = useState<string | null>(null);

	// 视口平移与缩放 (Pan & Zoom)
	const [viewport, setViewport] = useState({ x: 60, y: 60, zoom: 1 });
	const [isPanning, setIsPanning] = useState(false);
	const [panStart, setPanStart] = useState({ x: 0, y: 0, vpX: 0, vpY: 0 });

	// 正在拉取的临时连线状态
	const [connectingSource, setConnectingSource] = useState<{ nodeId: string; x: number; y: number } | null>(null);
	const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

	const canvasRef = useRef<HTMLDivElement>(null);

	// 统一发送消息
	const sendMessage = useCallback(
		(msg: ClientMessage): boolean => {
			if (propSend) {
				propSend(msg);
				return true;
			}
			if (clientRef.current?.send(msg)) {
				return true;
			}
			return appSend(msg);
		},
		[propSend],
	);

	// 初始化专用连接并订阅消息
	useEffect(() => {
		const client = new CanvasClient();
		clientRef.current = client;
		client.connect();

		const unsubscribe = client.subscribe((msg) => {
			handleIncomingServerMessage(msg);
		});

		return () => {
			unsubscribe();
			client.dispose();
			clientRef.current = null;
		};
	}, []);

	const handleIncomingServerMessage = (msg: ServerMessage) => {
		if (msg.type === "canvas_list_result") {
			setGraphList(msg.graphs);
		} else if (msg.type === "canvas_graph_state") {
			setGraph(msg.graph);
			if (msg.graph.viewport) {
				setViewport(msg.graph.viewport);
			}
		} else if (msg.type === "canvas_node_event") {
			const { nodeId, currentAction, summary, error } = msg;
			setGraph((prev) => {
				const nextNodes = prev.nodes.map((n) => {
					if (n.id !== nodeId) return n;
					return {
						...n,
						currentAction: currentAction ?? n.currentAction,
						lastOutputSummary: summary ?? n.lastOutputSummary,
						error: error ?? n.error,
						status:
							msg.event === "started" || msg.event === "action"
								? "running"
								: msg.event === "done"
									? "done"
									: msg.event === "error"
										? "error"
										: msg.event === "paused"
											? "paused"
											: n.status,
					};
				});
				return { ...prev, nodes: nextNodes };
			});
		}
	};

	// 也响应 props 传入的消息
	useEffect(() => {
		if (propLastMessage) {
			handleIncomingServerMessage(propLastMessage);
		}
	}, [propLastMessage]);

	// 处理画布缩放 (以鼠标光标所在点为中心平滑缩放)
	const handleWheel = useCallback((e: React.WheelEvent) => {
		// 1. 如果事件目标不在画布容器的实际 DOM 树内（例如通过 Portal 渲染在 document.body 的目录选择器或模型菜单），坚决不拦截滚轮、不缩放画布
		if (!canvasRef.current || !canvasRef.current.contains(e.target as Node)) {
			return;
		}

		// 2. 如果事件发生在控件、卡片、抽屉面板、工具栏、下拉列表等内部，不缩放画布，保留组件自身默认滚动
		const target = e.target as HTMLElement;
		if (
			target.closest(".canvas-node-card") ||
			target.closest(".canvas-toolbar") ||
			target.closest(".canvas-drawer-panel") ||
			target.closest(".canvas-drawer-overlay") ||
			target.closest(".universal-path-menu") ||
			target.closest(".cwd-picker") ||
			target.closest(".dd-menu") ||
			target.closest("button, input, select, textarea, [role='dialog'], [role='menu']")
		) {
			return;
		}

		e.preventDefault();
		const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
		setViewport((prev) => {
			const newZoom = Math.min(Math.max(prev.zoom * zoomFactor, 0.25), 2.0);
			if (!canvasRef.current) return { ...prev, zoom: newZoom };

			const rect = canvasRef.current.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			const newX = mouseX - (mouseX - prev.x) * (newZoom / prev.zoom);
			const newY = mouseY - (mouseY - prev.y) * (newZoom / prev.zoom);

			return { x: Math.round(newX), y: Math.round(newY), zoom: Number(newZoom.toFixed(3)) };
		});
	}, []);

	// 处理空白区域拖拽平移 (Pan)
	const handleCanvasPointerDown = (e: React.PointerEvent) => {
		if (e.button !== 0 && e.button !== 1) return; // 允许左键或中键拖拽画布

		// 1. 如果事件目标不在画布容器的实际 DOM 树内（例如通过 Portal 渲染在 document.body 的弹窗、下拉菜单），坚决不处理、绝不捕获指针
		if (!canvasRef.current || !canvasRef.current.contains(e.target as Node)) {
			return;
		}

		// 2. 如果点击发生在节点卡片、工具栏、抽屉、端口、弹窗或各类交互控件上，坚决不触发画布平移
		const target = e.target as HTMLElement;
		if (
			target.closest(".canvas-node-card") ||
			target.closest(".canvas-toolbar") ||
			target.closest(".canvas-drawer-overlay") ||
			target.closest(".canvas-drawer-panel") ||
			target.closest(".canvas-port") ||
			target.closest(".canvas-edge-label-container") ||
			target.closest(".canvas-edge-badge") ||
			target.closest(".universal-path-menu") ||
			target.closest(".cwd-picker") ||
			target.closest(".status-cwd-backdrop") ||
			target.closest(".dd-menu") ||
			target.closest("button, input, select, textarea, a, [role='dialog'], [role='menu']")
		) {
			return;
		}

		setIsPanning(true);
		setPanStart({
			x: e.clientX,
			y: e.clientY,
			vpX: viewport.x,
			vpY: viewport.y,
		});
		setSelectedNodeId(null);
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	};

	const handleCanvasPointerMove = (e: React.PointerEvent) => {
		if (isPanning) {
			const dx = e.clientX - panStart.x;
			const dy = e.clientY - panStart.y;
			setViewport((prev) => ({
				...prev,
				x: Math.round(panStart.vpX + dx),
				y: Math.round(panStart.vpY + dy),
			}));
		}

		if (connectingSource && canvasRef.current) {
			const rect = canvasRef.current.getBoundingClientRect();
			const xInCanvas = (e.clientX - rect.left - viewport.x) / viewport.zoom;
			const yInCanvas = (e.clientY - rect.top - viewport.y) / viewport.zoom;
			setMousePos({ x: xInCanvas, y: yInCanvas });
		}
	};

	const handleCanvasPointerUp = (e: React.PointerEvent) => {
		if (isPanning) {
			setIsPanning(false);
			try {
				(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
			} catch {}
		}
		if (connectingSource) {
			setConnectingSource(null);
			setMousePos(null);
		}
	};

	// 更新单个节点属性
	const handleUpdateNode = useCallback((nodeId: string, patch: Partial<CanvasNode>) => {
		setGraph((prev) => ({
			...prev,
			nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
		}));
	}, []);

	// 删除节点
	const handleDeleteNode = useCallback((nodeId: string) => {
		setGraph((prev) => ({
			...prev,
			nodes: prev.nodes.filter((n) => n.id !== nodeId),
			edges: prev.edges.filter((e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId),
		}));
	}, []);

	// 删除连线
	const handleDeleteEdge = useCallback((edgeId: string) => {
		setGraph((prev) => ({
			...prev,
			edges: prev.edges.filter((e) => e.id !== edgeId),
		}));
	}, []);

	// 开始从源节点的 Out 桩拉线
	const handleStartConnect = useCallback((nodeId: string, outX: number, outY: number) => {
		setConnectingSource({ nodeId, x: outX, y: outY });
		setMousePos({ x: outX, y: outY });
	}, []);

	// 在目标节点的 In 桩松开，建立连线
	const handleEndConnect = useCallback(
		(targetNodeId: string) => {
			if (!connectingSource || connectingSource.nodeId === targetNodeId) {
				setConnectingSource(null);
				setMousePos(null);
				return;
			}

			// 检查是否已存在相同连线
			const exists = graph.edges.some(
				(e) => e.sourceNodeId === connectingSource.nodeId && e.targetNodeId === targetNodeId,
			);
			if (!exists) {
				const newEdge: CanvasEdge = {
					id: `edge_${Date.now()}`,
					sourceNodeId: connectingSource.nodeId,
					targetNodeId,
					type: "handoff",
					label: "契约交接",
				};
				setGraph((prev) => ({
					...prev,
					edges: [...prev.edges, newEdge],
				}));
			}

			setConnectingSource(null);
			setMousePos(null);
		},
		[connectingSource, graph.edges],
	);

	// 新增数字员工节点
	const handleAddNode = useCallback(() => {
		const id = `node_${Date.now()}`;
		const newNode: CanvasNode = {
			id,
			title: `新队友 ${graph.nodes.length + 1}`,
			role: "coder",
			x: Math.round((-viewport.x + 300) / viewport.zoom),
			y: Math.round((-viewport.y + 200) / viewport.zoom),
			width: 300,
			engine: "pi",
			model: "anthropic/claude-3-7-sonnet",
			cwd: ".",
			useWorktree: true,
			status: "idle",
		};
		setGraph((prev) => ({
			...prev,
			nodes: [...prev.nodes, newNode],
		}));
		setSelectedNodeId(id);
	}, [graph.nodes.length, viewport]);

	// 保存画布
	const handleSave = useCallback(() => {
		const fullGraph = { ...graph, viewport };
		sendMessage({ type: "canvas_save", graph: fullGraph });
	}, [graph, sendMessage, viewport]);

	// 运行单个节点
	const handleRunNode = useCallback(
		(nodeId: string) => {
			sendMessage({ type: "canvas_run_node", graphId: graph.id, nodeId });
		},
		[graph.id, sendMessage],
	);

	// 停止单个节点
	const handleStopNode = useCallback(
		(nodeId: string) => {
			sendMessage({ type: "canvas_stop_node", graphId: graph.id, nodeId });
		},
		[graph.id, sendMessage],
	);

	// 启动全图流水线
	const handleRunAll = useCallback(() => {
		sendMessage({ type: "canvas_run_all", graphId: graph.id });
	}, [graph.id, sendMessage]);

	// 停止全图
	const handleStopAll = useCallback(() => {
		sendMessage({ type: "canvas_stop_all", graphId: graph.id });
	}, [graph.id, sendMessage]);

	// 复位全图状态
	const handleResetStatus = useCallback(() => {
		sendMessage({ type: "canvas_reset_status", graphId: graph.id });
	}, [graph.id, sendMessage]);

	// 实时插话 (Steer)
	const handleSteer = useCallback(
		(nodeId: string, message: string) => {
			sendMessage({ type: "canvas_steer_node", graphId: graph.id, nodeId, message });
		},
		[graph.id, sendMessage],
	);

	// 获取抽屉对应的当前节点对象
	const drawerNode = graph.nodes.find((n) => n.id === drawerNodeId) || null;

	// 缓存已有输入/输出连线的节点集合，供端口高亮展示
	const incomingSet = useMemo(() => new Set(graph.edges.map((e) => e.targetNodeId)), [graph.edges]);
	const outgoingSet = useMemo(() => new Set(graph.edges.map((e) => e.sourceNodeId)), [graph.edges]);

	return (
		<div
			className="canvas-studio-root"
			ref={canvasRef}
			onWheel={handleWheel}
			onPointerDown={handleCanvasPointerDown}
			onPointerMove={handleCanvasPointerMove}
			onPointerUp={handleCanvasPointerUp}
		>
			{/* 浮动顶栏控制条 */}
			<CanvasToolbar
				graph={graph}
				graphList={graphList}
				onSelectGraph={(id) => sendMessage({ type: "canvas_load", id })}
				onSave={handleSave}
				onAddNode={handleAddNode}
				onApplyTemplate={(tmpl) => {
					setGraph(tmpl);
					sendMessage({ type: "canvas_save", graph: tmpl });
				}}
				onRunAll={handleRunAll}
				onStopAll={handleStopAll}
				onResetStatus={handleResetStatus}
				onToggleExecutionMode={(mode) => {
					setGraph((prev) => {
						const next = { ...prev, executionMode: mode };
						sendMessage({ type: "canvas_save", graph: next });
						return next;
					});
				}}
				zoom={viewport.zoom}
				onZoomChange={(newZoom) => setViewport((prev) => ({ ...prev, zoom: newZoom }))}
				onResetViewport={() => setViewport({ x: 60, y: 60, zoom: 1 })}
			/>

			{/* 可缩放平移的画布主容器 */}
			<div
				className="canvas-transform-container"
				style={{
					transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
					transformOrigin: "0 0",
				}}
			>
				{/* 底层 SVG 连线图层 */}
				<CanvasSvgEdges
					nodes={graph.nodes}
					edges={graph.edges}
					connectingSource={connectingSource}
					mousePos={mousePos}
					onDeleteEdge={handleDeleteEdge}
				/>

				{/* 顶层 HTML 节点组件图层 */}
				<div className="canvas-nodes-layer">
					{graph.nodes.map((node) => (
						<CanvasNodeCard
							key={node.id}
							node={node}
							isSelected={node.id === selectedNodeId}
							hasIncoming={incomingSet.has(node.id)}
							hasOutgoing={outgoingSet.has(node.id)}
							models={models}
							projects={projects}
							onSelect={setSelectedNodeId}
							onUpdate={handleUpdateNode}
							onDelete={handleDeleteNode}
							onRun={handleRunNode}
							onStop={handleStopNode}
							onOpenDrawer={setDrawerNodeId}
							onBrowseFolder={(id) => setProjectPickerTargetNodeId(id)}
							onStartConnect={handleStartConnect}
							onEndConnect={handleEndConnect}
						/>
					))}
				</div>
			</div>

			{/* 单个数字员工审查与深控抽屉（仅选中节点时挂载） */}
			{drawerNode && (
				<CanvasNodeDrawer
					node={drawerNode}
					edges={graph.edges}
					allNodes={graph.nodes}
					models={models}
					projects={projects}
					onClose={() => setDrawerNodeId(null)}
					onUpdate={handleUpdateNode}
					onRun={handleRunNode}
					onStop={handleStopNode}
					onSteer={handleSteer}
					onBrowseFolder={(id) => setProjectPickerTargetNodeId(id)}
				/>
			)}

			{/* 全项目通用项目与目录选择弹窗 (ProjectPicker) */}
			{(() => {
				const pickerNode = graph.nodes.find((n) => n.id === projectPickerTargetNodeId);
				const pickerInitialCwd = pickerNode?.cwd && pickerNode.cwd !== "." ? pickerNode.cwd : currentCwd || ".";
				return (
					<ProjectPicker
						open={Boolean(projectPickerTargetNodeId)}
						currentCwd={pickerInitialCwd}
						pathCompletions={pathCompletions || []}
						workspaceRoots={workspaceRoots || []}
						onClose={() => setProjectPickerTargetNodeId(null)}
						onSelectDirectory={(selectedPath) => {
							if (projectPickerTargetNodeId) {
								handleUpdateNode(projectPickerTargetNodeId, { cwd: selectedPath });
							}
							setProjectPickerTargetNodeId(null);
						}}
						onCreateProject={(newPath) => {
							sendMessage({ type: "make_dir", path: newPath });
							if (projectPickerTargetNodeId) {
								handleUpdateNode(projectPickerTargetNodeId, { cwd: newPath });
							}
							setProjectPickerTargetNodeId(null);
						}}
					/>
				);
			})()}
		</div>
	);
}
