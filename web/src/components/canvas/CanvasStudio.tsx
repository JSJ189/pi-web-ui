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
import { appSend } from "../../app-globals";
import { FiPlus, FiUsers } from "react-icons/fi";

interface CanvasStudioProps {
	send?: (msg: ClientMessage) => void;
	lastMessage?: ServerMessage | null;
	models?: ModelInfo[];
	/** 全局默认模型（"provider/model-id" 格式），新节点与模板套用的首选模型 */
	defaultModel?: string | null;
	projects?: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	currentCwd?: string;
}

export function CanvasStudio({
	send: propSend,
	lastMessage: propLastMessage,
	models = [],
	defaultModel = null,
	projects = [],
	workspaceRoots = [],
	pathCompletions = [],
	currentCwd = ".",
}: CanvasStudioProps) {
	const clientRef = useRef<CanvasClient | null>(null);

	// 画布工程全量状态
	const [graph, setGraph] = useState<CanvasGraph>(() => SQUAD_TEMPLATES[0].createGraph());
	/** 当前工程 id 镜像：canvas_node_event 按 graphId 过滤，跨工程事件直接丢弃（#706） */
	const graphIdRef = useRef(graph.id);
	graphIdRef.current = graph.id;
	const [graphList, setGraphList] = useState<CanvasGraphSummary[]>([]);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null);

	// 视口平移与缩放 (Pan & Zoom)
	const [viewport, setViewport] = useState({ x: 60, y: 60, zoom: 1 });
	const [isPanning, setIsPanning] = useState(false);
	const [panStart, setPanStart] = useState({ x: 0, y: 0, vpX: 0, vpY: 0 });

	// 正在拉取的临时连线状态
	const [connectingSource, setConnectingSource] = useState<{ nodeId: string; x: number; y: number } | null>(null);
	const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

	// 初始 Prompt 对话框
	const [promptNodeId, setPromptNodeId] = useState<string | null>(null);
	const [promptInput, setPromptInput] = useState("");
	const promptInputRef = useRef<HTMLTextAreaElement>(null);

	// 未保存更改追踪
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const lastSavedRef = useRef<string>("");

	const canvasRef = useRef<HTMLDivElement>(null);

	// 统一发送消息：优先走画布专用连接（回包就在这条连接上订阅，#switch-race）。
	// 主 WS 只做工程 id 同步追踪，保证重连恢复当前工程（#704）。
	const sendMessage = useCallback(
		(msg: ClientMessage): boolean => {
			if (msg.type === "canvas_load") clientRef.current?.setCurrentGraphId(msg.id);
			else if (msg.type === "canvas_save") clientRef.current?.setCurrentGraphId(msg.graph.id);
			if (clientRef.current?.send(msg)) {
				return true;
			}
			if (propSend) {
				propSend(msg);
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
			clientRef.current?.setCurrentGraphId(msg.graph.id);
			// 演练模式已下线：旧存量图若还是 simulate，一律纠正为真实执行
			const normalized =
				msg.graph.executionMode === "real" ? msg.graph : { ...msg.graph, executionMode: "real" as const };
			setGraph(normalized);
			lastSavedRef.current = JSON.stringify(normalized);
			setHasUnsavedChanges(false);
			if (msg.graph.viewport) {
				setViewport(msg.graph.viewport);
			}
		} else if (msg.type === "canvas_node_event") {
			// 跨工程事件隔离：只处理当前画布工程的节点事件，非同工程直接丢弃（#706）
			if (msg.graphId !== graphIdRef.current) return;
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

	// 追踪未保存更改（切换工程哨兵期间不误报）
	useEffect(() => {
		if (lastSavedRef.current === "__switching__") return;
		if (lastSavedRef.current && JSON.stringify(graph) !== lastSavedRef.current) {
			setHasUnsavedChanges(true);
		}
	}, [graph]);

	// 自动保存（30 秒无操作后）
	useEffect(() => {
		if (!hasUnsavedChanges) return;
		const timer = setTimeout(() => {
			handleSave();
		}, 30000);
		return () => clearTimeout(timer);
	}, [hasUnsavedChanges, graph]);

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
			target.closest(".canvas-empty-state") ||
			target.closest(".canvas-prompt-dialog") ||
			target.closest("button, input, select, textarea, a, [role='dialog'], [role='menu']")
		) {
			return;
		}

		// 点击空白区域取消节点选中
		setSelectedNodeId(null);

		setIsPanning(true);
		setPanStart({ x: e.clientX, y: e.clientY, vpX: viewport.x, vpY: viewport.y });
		canvasRef.current.setPointerCapture(e.pointerId);
	};

	const handleCanvasPointerMove = (e: React.PointerEvent) => {
		// 更新连线跟随鼠标位置
		if (connectingSource && canvasRef.current) {
			const rect = canvasRef.current.getBoundingClientRect();
			const canvasX = (e.clientX - rect.left - viewport.x) / viewport.zoom;
			const canvasY = (e.clientY - rect.top - viewport.y) / viewport.zoom;
			setMousePos({ x: canvasX, y: canvasY });
		}
		if (!isPanning) return;
		const dx = e.clientX - panStart.x;
		const dy = e.clientY - panStart.y;
		setViewport((prev) => ({ ...prev, x: panStart.vpX + dx, y: panStart.vpY + dy }));
	};

	const handleCanvasPointerUp = (e: React.PointerEvent) => {
		// 结束连线操作
		if (connectingSource) {
			setConnectingSource(null);
			setMousePos(null);
		}
		if (isPanning) {
			setIsPanning(false);
			try {
				canvasRef.current?.releasePointerCapture(e.pointerId);
			} catch {
				// 忽略释放异常
			}
		}
	};

	// 连线操作
	const handleStartConnect = useCallback((nodeId: string, outX: number, outY: number) => {
		setConnectingSource({ nodeId, x: outX, y: outY });
	}, []);

	const handleEndConnect = useCallback(
		(targetNodeId: string) => {
			if (!connectingSource || connectingSource.nodeId === targetNodeId) {
				setConnectingSource(null);
				setMousePos(null);
				return;
			}
			// 避免重复连线
			const exists = graph.edges.some(
				(e) => e.sourceNodeId === connectingSource.nodeId && e.targetNodeId === targetNodeId,
			);
			if (!exists) {
				const newEdge: CanvasEdge = {
					id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
					sourceNodeId: connectingSource.nodeId,
					targetNodeId,
					type: "handoff",
				};
				setGraph((prev) => ({ ...prev, edges: [...prev.edges, newEdge] }));
			}
			setConnectingSource(null);
			setMousePos(null);
		},
		[connectingSource, graph.edges],
	);

	/**
	 * 解析节点模型：绝不杜撰不存在的模型。
	 * 优先级：请求的模型（若在模型列表中存在）→ 全局默认模型（若存在）→ 模型列表第一个 → ""（列表未加载时保持原值）。
	 */
	const resolveNodeModel = useCallback(
		(requested: string): string => {
			if (models.length === 0) return requested; // 模型列表尚未加载，不做任何改写
			const inList = (m: string) => models.some((info) => `${info.provider}/${info.id}` === m || info.id === m);
			if (requested && inList(requested)) return requested;
			if (defaultModel && inList(defaultModel)) return defaultModel;
			return `${models[0].provider}/${models[0].id}`;
		},
		[models, defaultModel],
	);

	// 模型列表加载完成后，自动修复图中所有不存在的杜撰模型（存量脏数据自愈）
	useEffect(() => {
		if (models.length === 0) return;
		setGraph((prev) => {
			let changed = false;
			const nodes = prev.nodes.map((n) => {
				const resolved = resolveNodeModel(n.model);
				if (resolved !== n.model) {
					changed = true;
					return { ...n, model: resolved };
				}
				return n;
			});
			return changed ? { ...prev, nodes } : prev;
		});
	}, [models, defaultModel, resolveNodeModel]);

	// 新增节点：优先使用全局默认模型
	const handleAddNode = useCallback(() => {
		const newNode: CanvasNode = {
			id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			title: `队友 ${graph.nodes.length + 1}`,
			role: "coder",
			x: -viewport.x / viewport.zoom + 300 + Math.random() * 100,
			y: -viewport.y / viewport.zoom + 200 + Math.random() * 100,
			width: 300,
			engine: "pi",
			model: resolveNodeModel(""),
			cwd: ".",
			useWorktree: false,
			status: "idle",
		};
		setGraph((prev) => ({ ...prev, nodes: [...prev.nodes, newNode] }));
	}, [graph.nodes.length, viewport, resolveNodeModel]);

	// 套用战队模板：模板内写死的示例模型一律映射为真实可用模型
	const handleApplyTemplate = useCallback(
		(tmpl: CanvasGraph) => {
			const remapped: CanvasGraph = {
				...tmpl,
				nodes: tmpl.nodes.map((n) => ({ ...n, model: resolveNodeModel(n.model) })),
			};
			setGraph(remapped);
			sendMessage({ type: "canvas_save", graph: remapped });
		},
		[resolveNodeModel, sendMessage],
	);

	// 删除节点（带确认）
	const handleDeleteNode = useCallback((nodeId: string) => {
		setGraph((prev) => ({
			...prev,
			nodes: prev.nodes.filter((n) => n.id !== nodeId),
			edges: prev.edges.filter((e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId),
		}));
		setSelectedNodeId((prev) => (prev === nodeId ? null : prev));
		setDrawerNodeId((prev) => (prev === nodeId ? null : prev));
	}, []);

	// 删除连线
	const handleDeleteEdge = useCallback((edgeId: string) => {
		setGraph((prev) => ({
			...prev,
			edges: prev.edges.filter((e) => e.id !== edgeId),
		}));
	}, []);

	// 更新节点属性（本地乐观更新）
	const handleUpdateNode = useCallback((nodeId: string, patch: Partial<CanvasNode>) => {
		setGraph((prev) => ({
			...prev,
			nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
		}));
	}, []);

	// 保存工程
	const handleSave = useCallback(() => {
		const fullGraph: CanvasGraph = { ...graph, viewport };
		setGraph(fullGraph);
		sendMessage({ type: "canvas_save", graph: fullGraph });
		lastSavedRef.current = JSON.stringify(fullGraph);
		setHasUnsavedChanges(false);
	}, [graph, viewport, sendMessage]);

	// 创建新画布工程
	const handleCreateGraph = useCallback(
		(name: string) => {
			const newGraph: CanvasGraph = {
				id: `graph_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				name,
				viewport: { x: 60, y: 60, zoom: 1 },
				nodes: [],
				edges: [],
				status: "idle",
				executionMode: "real",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			sendMessage({ type: "canvas_save", graph: newGraph });
		},
		[sendMessage],
	);

	// 删除画布工程
	const handleDeleteGraph = useCallback(
		(id: string) => {
			sendMessage({ type: "canvas_delete", id });
			// 服务端会返回更新后的列表；如果删除的是当前工程，切换到列表中第一个
			if (id === graph.id) {
				const remaining = graphList.filter((g) => g.id !== id);
				if (remaining.length > 0) {
					sendMessage({ type: "canvas_load", id: remaining[0].id });
				}
			}
		},
		[sendMessage, graph.id, graphList],
	);

	// 重命名画布工程
	const handleRenameGraph = useCallback(
		(name: string) => {
			const renamedGraph = { ...graph, name, updatedAt: Date.now() };
			setGraph(renamedGraph);
			sendMessage({ type: "canvas_save", graph: renamedGraph });
		},
		[graph, sendMessage],
	);

	// Fit-to-View：自动缩放和平移以适配所有节点
	const handleFitView = useCallback(() => {
		if (graph.nodes.length === 0) {
			setViewport({ x: 60, y: 60, zoom: 1 });
			return;
		}
		if (!canvasRef.current) return;
		const rect = canvasRef.current.getBoundingClientRect();
		const padding = 80;

		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const n of graph.nodes) {
			const w = n.width || 300;
			const h = 280; // 估计节点高度
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x + w > maxX) maxX = n.x + w;
			if (n.y + h > maxY) maxY = n.y + h;
		}

		const contentW = maxX - minX;
		const contentH = maxY - minY;
		if (contentW <= 0 || contentH <= 0) {
			setViewport({ x: 60, y: 60, zoom: 1 });
			return;
		}

		const availW = rect.width - padding * 2;
		const availH = rect.height - padding * 2;
		const fitZoom = Math.min(Math.max(Math.min(availW / contentW, availH / contentH), 0.25), 1.5);

		const centerX = padding + (availW - contentW * fitZoom) / 2 - minX * fitZoom;
		const centerY = padding + (availH - contentH * fitZoom) / 2 - minY * fitZoom;

		setViewport({ x: Math.round(centerX), y: Math.round(centerY), zoom: Number(fitZoom.toFixed(3)) });
	}, [graph.nodes]);

	// 启动单节点（带初始 Prompt 对话框）
	const handleRunNode = useCallback((nodeId: string) => {
		setPromptNodeId(nodeId);
		setPromptInput("");
		// 聚焦 prompt 输入框
		setTimeout(() => promptInputRef.current?.focus(), 60);
	}, []);

	// 确认启动单节点
	const handleConfirmRunNode = useCallback(
		(nodeId: string, prompt?: string) => {
			sendMessage({ type: "canvas_run_node", graphId: graph.id, nodeId, prompt: prompt || undefined });
			setPromptNodeId(null);
			setPromptInput("");
		},
		[graph.id, sendMessage],
	);

	// 直接启动（跳过 prompt）
	const handleRunNodeDirect = useCallback(
		(nodeId: string) => {
			sendMessage({ type: "canvas_run_node", graphId: graph.id, nodeId });
		},
		[graph.id, sendMessage],
	);

	// 停止单节点
	const handleStopNode = useCallback(
		(nodeId: string) => {
			sendMessage({ type: "canvas_stop_node", graphId: graph.id, nodeId });
		},
		[graph.id, sendMessage],
	);

	// 全图启动
	const handleRunAll = useCallback(() => {
		// 先保存再启动
		handleSave();
		sendMessage({ type: "canvas_run_all", graphId: graph.id });
	}, [graph.id, sendMessage, handleSave]);

	// 全图停止
	const handleStopAll = useCallback(() => {
		sendMessage({ type: "canvas_stop_all", graphId: graph.id });
	}, [graph.id, sendMessage]);

	// 重置全图状态
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

	// 审查门禁裁决（#707）：真协议动作 + 乐观本地回显，服务端回执 graph_state 校准
	const handleReviewNode = useCallback(
		(nodeId: string, decision: "approve" | "reject", comment?: string) => {
			setGraph((prev) => ({
				...prev,
				nodes: prev.nodes.map((n) =>
					n.id === nodeId
						? {
								...n,
								status: decision === "approve" ? ("done" as const) : ("waiting_approval" as const),
								currentAction:
									comment && comment.trim()
										? decision === "approve"
											? `人工审查批准合流：${comment.trim().slice(0, 500)}`
											: `人工驳回：${comment.trim().slice(0, 500)}`
										: decision === "approve"
											? "人工审查批准合流"
											: "人工驳回：需补充完善测试与注释",
							}
						: n,
				),
			}));
			sendMessage({ type: "canvas_review_node", graphId: graph.id, nodeId, decision, comment });
		},
		[graph.id, sendMessage],
	);

	// 全局键盘快捷键
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// 如果焦点在输入框里，不劫持快捷键
			const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
			if (tag === "input" || tag === "textarea" || tag === "select") return;

			// Ctrl+S / Cmd+S → 保存
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				handleSave();
				return;
			}

			// Ctrl+0 → Fit to View
			if ((e.ctrlKey || e.metaKey) && e.key === "0") {
				e.preventDefault();
				handleFitView();
				return;
			}

			// Delete / Backspace → 删除选中节点
			if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId) {
				e.preventDefault();
				handleDeleteNode(selectedNodeId);
				return;
			}

			// Escape → 取消选中 / 关闭抽屉
			if (e.key === "Escape") {
				if (promptNodeId) {
					setPromptNodeId(null);
					return;
				}
				if (drawerNodeId) {
					setDrawerNodeId(null);
					return;
				}
				if (selectedNodeId) {
					setSelectedNodeId(null);
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [selectedNodeId, drawerNodeId, promptNodeId, handleSave, handleFitView, handleDeleteNode]);

	// 获取抽屉对应的当前节点对象
	const drawerNode = graph.nodes.find((n) => n.id === drawerNodeId) || null;

	// 获取 prompt 对话框对应的节点
	const promptNode = graph.nodes.find((n) => n.id === promptNodeId) || null;

	// 缓存已有输入/输出连线的节点集合，供端口高亮展示
	const incomingSet = useMemo(() => new Set(graph.edges.map((e) => e.targetNodeId)), [graph.edges]);
	const outgoingSet = useMemo(() => new Set(graph.edges.map((e) => e.sourceNodeId)), [graph.edges]);

	// 切换工程：先冻结自动保存避免旧图回写弹回 (#switch-race)
	const handleSelectGraph = useCallback(
		(id: string) => {
			if (id === graphIdRef.current) return;
			setHasUnsavedChanges(false);
			lastSavedRef.current = "__switching__";
			sendMessage({ type: "canvas_load", id });
		},
		[sendMessage],
	);

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
				onSelectGraph={handleSelectGraph}
				onSave={handleSave}
				onAddNode={handleAddNode}
				onApplyTemplate={handleApplyTemplate}
				onRunAll={handleRunAll}
				onStopAll={handleStopAll}
				onResetStatus={handleResetStatus}
				onCreateGraph={handleCreateGraph}
				onDeleteGraph={handleDeleteGraph}
				onRenameGraph={handleRenameGraph}
				onFitView={handleFitView}
				zoom={viewport.zoom}
				onZoomChange={(newZoom) => setViewport((prev) => ({ ...prev, zoom: newZoom }))}
				onResetViewport={() => setViewport({ x: 60, y: 60, zoom: 1 })}
				hasUnsavedChanges={hasUnsavedChanges}
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
							defaultModel={defaultModel}
							projects={projects}
							workspaceRoots={workspaceRoots}
							pathCompletions={pathCompletions}
							baseCwd={currentCwd}
							onMakeDir={(p) => sendMessage({ type: "make_dir", path: p })}
							onSelect={setSelectedNodeId}
							onUpdate={handleUpdateNode}
							onDelete={handleDeleteNode}
							onRun={handleRunNode}
							onStop={handleStopNode}
							onOpenDrawer={setDrawerNodeId}
							onStartConnect={handleStartConnect}
							onEndConnect={handleEndConnect}
						/>
					))}
				</div>
			</div>

			{/* 空画布引导状态 */}
			{graph.nodes.length === 0 && (
				<div className="canvas-empty-state">
					<div className="canvas-empty-icon">🎨</div>
					<h3 className="canvas-empty-title">画布是空的</h3>
					<p className="canvas-empty-desc">添加数字员工或加载一个战队模板来开始协作</p>
					<div className="canvas-empty-actions">
						<button type="button" className="canvas-btn primary" onClick={handleAddNode}>
							<FiPlus /> 添加第一个队友
						</button>
						<button
							type="button"
							className="canvas-btn"
							onClick={() => handleApplyTemplate(SQUAD_TEMPLATES[0].createGraph())}
						>
							<FiUsers /> 快速加载模板
						</button>
					</div>
					<div className="canvas-empty-shortcuts">
						<span>
							<kbd>Ctrl+S</kbd> 保存
						</span>
						<span>
							<kbd>Ctrl+0</kbd> 适配视图
						</span>
						<span>
							<kbd>Delete</kbd> 删除选中
						</span>
						<span>
							<kbd>Esc</kbd> 取消选择
						</span>
					</div>
				</div>
			)}

			{/* 初始 Prompt 对话框（启动节点时可选输入任务指令） */}
			{promptNode && (
				<div
					className="canvas-prompt-overlay"
					onClick={(e) => {
						if (e.target === e.currentTarget) setPromptNodeId(null);
					}}
				>
					<div className="canvas-prompt-dialog" onClick={(e) => e.stopPropagation()}>
						<h4 className="canvas-prompt-title">启动「{promptNode.title}」</h4>
						<p className="canvas-prompt-desc">
							可选：输入一段初始任务指令，数字员工将基于此开始工作。留空则使用节点默认配置启动。
						</p>
						<textarea
							ref={promptInputRef}
							className="canvas-prompt-input"
							value={promptInput}
							onChange={(e) => setPromptInput(e.target.value)}
							placeholder="例：请实现一个 React 表单验证组件，支持邮箱和手机号格式校验..."
							rows={4}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
									handleConfirmRunNode(promptNode.id, promptInput);
								}
								if (e.key === "Escape") {
									setPromptNodeId(null);
								}
							}}
						/>
						<div className="canvas-prompt-actions">
							<button type="button" className="canvas-btn" onClick={() => setPromptNodeId(null)}>
								取消
							</button>
							<button type="button" className="canvas-btn" onClick={() => handleConfirmRunNode(promptNode.id)}>
								直接启动
							</button>
							<button
								type="button"
								className="canvas-btn primary"
								onClick={() => handleConfirmRunNode(promptNode.id, promptInput)}
							>
								▶ 带指令启动 {promptInput.trim() ? "" : "(Ctrl+Enter)"}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* 单个数字员工审查与深控抽屉（仅选中节点时挂载） */}
			{drawerNode && (
				<CanvasNodeDrawer
					node={drawerNode}
					edges={graph.edges}
					allNodes={graph.nodes}
					models={models}
					defaultModel={defaultModel}
					projects={projects}
					workspaceRoots={workspaceRoots}
					pathCompletions={pathCompletions}
					baseCwd={currentCwd}
					onMakeDir={(p) => sendMessage({ type: "make_dir", path: p })}
					onClose={() => setDrawerNodeId(null)}
					onUpdate={handleUpdateNode}
					onRun={handleRunNodeDirect}
					onStop={handleStopNode}
					onSteer={handleSteer}
					onReview={handleReviewNode}
				/>
			)}
		</div>
	);
}
