import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
	FiPlus,
	FiSettings,
	FiSearch,
	FiLayers,
	FiMessageSquare,
	FiTerminal,
	FiGitBranch,
	FiBox,
} from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";
import { appSend, useAppField, useAppGlobals } from "../app-globals";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";
import type { UiSlotEntry } from "../ui-slots";
import { openContextMenu } from "../context-menu-state";
import { focusComposer } from "../composer-bridge";
import { DirectoryBrowser } from "./DirectoryBrowser.js";

interface FooterBarProps {
	/** 底栏条目（bottombar 槽位：内置 + 插件的最终结果，宿主已排好序）。 */
	bottombarItems?: import("../ui-slots").UiSlotEntry[];
	/** 点击一个条目：view 由宿主切视图，其余（action）交给贡献它的插件。 */
	onUiAction?: (item: import("../ui-slots").UiSlotEntry, value?: string) => void;
	chat: ChatState;
	onOpenSettings?: () => void;
	onViewChange?: (view: "chat" | "terminal" | "git" | `plugin:${string}`) => void;
	onOpenGlobalSearch?: () => void;
	onOpenBgTasks?: () => void;
}

/** 未接线时的回退顺序（= BUILTIN_UI_ITEMS 里 bottombar 槽位的默认次序）。
 *  降级路径没有 slot 数据，分区只能按这张静态表（正常链路一律走 entry.align）。 */
const FALLBACK_BOTTOMBAR: { id: string; align: "start" | "end" }[] = [
	{ id: "host:conn", align: "start" },
	{ id: "host:engine", align: "start" },
	{ id: "host:ctx", align: "start" },
	{ id: "host:cost", align: "start" },
	{ id: "host:cache", align: "start" },
	{ id: "host:msg-count", align: "start" },
	{ id: "host:plugin-status", align: "start" },
	{ id: "host:status-delegate", align: "start" },
	{ id: "host:working", align: "start" },
	{ id: "host:host-metrics", align: "end" },
	{ id: "host:cwd", align: "end" },
];

/**
 * Compact status bar: connection, context usage, cost, session, queue, and the
 * workspace path — click the path to open a directory picker (browse into
 * folders, go up, create folders, or pick one as the working directory).
 */
export function FooterBar({
	chat,
	bottombarItems,
	onUiAction,
	onOpenSettings,
	onViewChange,
	onOpenGlobalSearch,
	onOpenBgTasks,
}: FooterBarProps) {
	const t = useT();
	// 引擎徐标：走全局（web/src/app-globals.ts），不依赖 chat 整体对象。
	const { engine } = useAppGlobals();
	/** 额外工作区根（多根，见 server/protocol.ts 的 set_workspace_roots）：cwd 选择器里
	 *  可以直接把**当前浏览的目录**加成根 —— 这是除「右栏文件树右键」之外的第二个人口，
	 *  底栏本来就是改/看工作目录的地方，用户找得到。 */
	const workspaceRoots = useAppField("workspaceRoots");
	const state = chat.state;
	const [editing, setEditing] = useState(false);

	// Live generation-speed samples (tokens/sec). Kept in a ref so pushing a
	// sample never triggers a re-render. The SDK only commits a turn's usage
	// counters at message_end, so `stats.tokens.output` is FLAT while streaming —
	// instead we estimate tokens from the in-flight message content (text +
	// thinking), which grows every token. Sample at most every 250ms; baseline
	// resets the moment streaming stops.
	const samplesRef = useRef<RateSample[]>([]);
	const streamingNow = state?.isStreaming ?? false;
	const streamEst = state?.streamingMessage ? estimateStreamTokens(state.streamingMessage.content) : 0;
	useEffect(() => {
		if (!streamingNow) {
			samplesRef.current = [];
			return;
		}
		const now = Date.now();
		const prev = samplesRef.current;
		const last = prev[prev.length - 1];
		if (last && now - last.t < 250) return; // throttle
		samplesRef.current = trimRateSamples([...prev, { t: now, out: streamEst }], now);
	}, [streamingNow, streamEst]);

	if (!state) return null;
	const s = state.stats;

	const cache = cacheMetrics(s.tokens);
	const hitPct = cache.hitRate * 100;
	const hitClass = cache.totalInput === 0 ? "" : cache.hitRate >= 0.7 ? "ok" : cache.hitRate >= 0.4 ? "mid" : "warn";
	const hitText = cache.totalInput > 0 ? `${hitPct.toFixed(1)}%` : "—";
	const rate = streamingNow ? streamRate(samplesRef.current) : 0;

	const connClass = chat.ready ? "ok" : chat.status === "closed" ? "error" : "busy";
	const connLabel = chat.ready ? t("connected") : chat.status === "closed" ? t("reconnecting") : t("connecting");

	const context = s.contextUsage;
	// 压缩软上限（issue #229 / #245）：设置了有效软上限时，底栏进度条与数字显示以该上限为满格刻度
	const cap = context.softCap ?? null;
	const hasCap = cap !== null && cap > 0 && cap < context.contextWindow;
	const effectiveMax = hasCap ? cap : context.contextWindow;

	const ctxPercent =
		context.tokens !== null && effectiveMax > 0
			? Math.min(100, Math.round((context.tokens / effectiveMax) * 100))
			: null;
	const ctxText =
		context.tokens !== null && ctxPercent !== null
			? `${formatTokens(context.tokens)} / ${formatTokens(effectiveMax)}`
			: "—";
	const ctxBarClass = ctxPercent === null ? "" : ctxPercent >= 80 ? "warn" : ctxPercent >= 50 ? "mid" : "ok";

	const queueTotal = state.queue.steering.length + state.queue.followUp.length;

	/**
	 * 宿主内置条目的**节点工厂**（issue #146 的「位置登记」真正落地）：底栏的可见性与顺序
	 * 完全由 `bottombarItems`（= `buildUiSlots` 的结果）决定 —— 用户在设置面板「界面布局」里
	 * 隐藏一条、或在 ↑↓ 里挪一条，这里就少画一个 / 换位置（以前宿主条目写死在 JSX 里，
	 * 布局页那几个勾选框是摆设）。
	 *
	 * 条件渲染（引擎徽标只在非 pi 引擎、插件状态只在有状态、工作中只在流式时）留在各工厂里：
	 * 条件不满足 → 返回 null → 那一条**连同分隔符**一起不画（不留孤零零的 `·`）。
	 */
	const hostNodes: Record<string, ReactNode> = {
		"host:conn": (
			<span className={`status-item status-conn ${connClass}`} title={connLabel}>
				<span className={`status-dot ${connClass}`} />
				<span className="status-conn-label">{connLabel}</span>
			</span>
		),
		"host:engine":
			engine !== "pi" ? (
				<span className={`status-item engine-badge engine-${engine}`} title={`${t("engineBadge")}: ${engine}`}>
					{engine === "dsh" ? "DSH" : engine}
				</span>
			) : null,
		"host:ctx": (() => {
			const ctxTitle = hasCap
				? `${t("contextUsage")}: ${formatTokens(context.tokens ?? 0)} / ${formatTokens(cap)} (${t("softCapMarker")}, max ${formatTokens(context.contextWindow)})`
				: cap !== null && cap > 0
					? `${t("contextUsage")} · ${t("softCapMarker")}: ${formatTokens(cap)}`
					: t("contextUsage");
			return (
				<span className="status-item status-ctx" title={ctxTitle}>
					{/* 窄屏（≤420px）只留进度条 + 数字，标签由 CSS 收起 */}
					<span className="ctx-label">{t("context")}</span>
					<span className={`ctx-bar ${ctxBarClass}`}>
						{ctxPercent !== null && (
							<span className="ctx-bar-fill" style={{ width: `${Math.min(ctxPercent, 100)}%` }} />
						)}
					</span>
					{ctxText}
				</span>
			);
		})(),
		"host:cost": (
			<span className="status-item status-cost" title={t("cumulativeCost")}>
				${formatCost(s.cost)}
			</span>
		),
		"host:cache": (
			<span
				className="status-item status-cache"
				title={t("cacheHitTip", {
					read: formatTokens(cache.read),
					write: formatTokens(cache.write),
					miss: formatTokens(cache.miss),
					input: formatTokens(cache.totalInput),
				})}
			>
				<span className="status-cache-label">{t("cacheHit")}</span>
				<b className={`cache-pct ${hitClass}`}>{hitText}</b>
			</span>
		),
		"host:msg-count": (
			<span className="status-item" title={t("sessionMessages")}>
				{t("messages")} {s.totalMessages}
			</span>
		),
		"host:plugin-status":
			chat.statuses.length > 0 ? (
				<span className="status-item ext-status" title={t("pluginStatus")}>
					{chat.statuses.map((st) => st.text).join(" · ")}
				</span>
			) : null,
		"host:working": state.isStreaming ? (
			<>
				<span className="status-item working">
					<span className="working-spin" />
					{t("working")}
					{queueTotal > 0 && (
						<span className="status-queue">
							⏳ {queueTotal} {t("queued")}
						</span>
					)}
				</span>
				<span className="status-item status-rate" title={t("rateTip")}>
					{/* 手机上「工作中」文案被隐藏，这里给个小转圈（仅窄屏显示） */}
					<span className="working-spin rate-spin" />
					{rate > 0 ? `${Math.round(rate)}${t("tps")}` : "…"}
				</span>
			</>
		) : null,
		// 审查者模式标识：开启时画一枚可点的徐标 —— 点开常驻执行对话看全文。
		"host:status-delegate": state?.delegateMode ? (
			<span
				className="status-item delegate-badge"
				title={state.delegateConvId ? t("delegateModeOpenTip") : t("delegateModeBadgeTip")}
			>
				🔎 {t("delegateModeBadge")}
				{state.delegateConvId ? (
					<button
						type="button"
						className="delegate-badge-open"
						title={t("delegateModeOpenTip")}
						onClick={() => appSend({ type: "switch_conversation", id: state.delegateConvId as string })}
					>
						↗
					</button>
				) : null}
			</span>
		) : null,
		"host:host-metrics": (() => {
			const metrics = chat.hostMetrics;
			if (!metrics) return null;
			const cpu =
				metrics.cpuPercent === null || !Number.isFinite(metrics.cpuPercent)
					? "—"
					: `${Math.round(metrics.cpuPercent)}%`;
			const memory = Number.isFinite(metrics.memoryPercent) ? `${Math.round(metrics.memoryPercent)}%` : "—";
			return (
				<span
					className="status-item status-host-metrics"
					title={`${t("hostResourcesTip")}\n${t("hostProcessor")}: ${cpu} · ${t("hostMemory")}: ${memory}`}
				>
					{t("hostProcessor")} {cpu} · {t("hostMemory")} {memory}
				</span>
			);
		})(),
		"host:cwd": editing ? (
			<DirectoryBrowser
				currentCwd={state.cwd}
				pathCompletions={chat.pathCompletions}
				workspaceRoots={workspaceRoots}
				onClose={() => setEditing(false)}
				onSelectDirectory={(p) => {
					if (p && p !== state.cwd) appSend({ type: "set_cwd", path: p });
					setEditing(false);
				}}
				mode="folder"
			/>
		) : (
			<button
				type="button"
				className="status-item status-cwd"
				title={t("cwdTip", { path: state.cwd })}
				onClick={() => setEditing(true)}
			>
				📁 {state.cwd}
			</button>
		),
		"host:new-chat": (
			<button
				type="button"
				className="status-action"
				title={t("newChat")}
				onClick={() => {
					onViewChange?.("chat");
					appSend({ type: "new_chat" });
					focusComposer();
				}}
			>
				<FiPlus /> {t("newChat")}
			</button>
		),
		"host:settings": (
			<button type="button" className="status-action" title={t("settings")} onClick={() => onOpenSettings?.()}>
				<FiSettings /> {t("settings")}
			</button>
		),
		"host:search": (
			<button type="button" className="status-action" title={t("searchGlobal")} onClick={() => onOpenGlobalSearch?.()}>
				<FiSearch /> {t("searchGlobal")}
			</button>
		),
		"host:tasks": (
			<button type="button" className="status-action" title={t("bgTasks")} onClick={() => onOpenBgTasks?.()}>
				<FiLayers /> {t("bgTasks")}
				{chat.bgServers.length > 0 && <span className="status-badge">{chat.bgServers.length}</span>}
			</button>
		),
		"host:chat": (
			<button type="button" className="status-action" title={t("chat")} onClick={() => onViewChange?.("chat")}>
				<FiMessageSquare /> {t("chat")}
			</button>
		),
		"host:terminal": (
			<button type="button" className="status-action" title={t("terminal")} onClick={() => onViewChange?.("terminal")}>
				<FiTerminal /> {t("terminal")}
			</button>
		),
		"host:git": (
			<button type="button" className="status-action" title={t("scmTab")} onClick={() => onViewChange?.("git")}>
				<FiGitBranch /> {t("scmTab")}
			</button>
		),
		"host:plugins": (
			<button type="button" className="status-action" title={t("pluginMenuTitle")} onClick={() => onOpenSettings?.()}>
				<FiBox /> {t("pluginMenuTitle")}
			</button>
		),
	};

	const openItemMenu = (e: React.MouseEvent, id: string, label: string) => {
		e.preventDefault();
		e.stopPropagation();
		const layout = chat.settings?.uiLayout;
		const setItemSlot = (targetSlot: import("../ui-slots").UiSlotId) => {
			const slots = { ...layout?.slots, [id]: targetSlot };
			appSend({ type: "set_settings", uiLayout: { ...layout, slots } });
		};
		const hideItem = () => {
			const hidden = new Set(layout?.hidden ?? []);
			hidden.add(id);
			appSend({ type: "set_settings", uiLayout: { ...layout, hidden: [...hidden] } });
		};
		const menuEntries: import("../ui-slots").UiSlotEntry[] = [
			{
				id: "host:move-top",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToTop"),
				kind: "action",
				order: 10,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:move-left",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToLeft"),
				kind: "action",
				order: 20,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:move-right",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToRight"),
				kind: "action",
				order: 30,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:hide-item",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("uiLayoutRestore"),
				kind: "action",
				order: 40,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
		];
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.topbar",
			target: { id, label },
			entries: menuEntries,
			onHostAction: (entry) => {
				if (entry.id === "host:move-top") setItemSlot("topbar.primary");
				else if (entry.id === "host:move-left") setItemSlot("sidebar.left");
				else if (entry.id === "host:move-right") setItemSlot("sidebar.right");
				else if (entry.id === "host:hide-item") hideItem();
			},
		});
	};

	/**
	 * 按 slot 顺序落成要画的一串：宿主条目查节点工厂，插件条目画按钮。
	 *
	 * `bottombarItems` 没给（未接线 / 单测）时**回退到内置默认顺序**：没拿到 slot 数据就把整个
	 * 底栏清空是最糟的降级（与 TopBar 的 hostOn 同口径）。
	 */
	const entries: { id: string; entry: UiSlotEntry | null; fallbackAlign: "start" | "end" }[] = bottombarItems
		? bottombarItems.map((e) => ({ id: e.id, entry: e, fallbackAlign: "start" as const }))
		: FALLBACK_BOTTOMBAR.map(({ id, align }) => ({ id, entry: null, fallbackAlign: align }));
	const leftItems: { key: string; node: ReactNode }[] = [];
	const centerItems: { key: string; node: ReactNode }[] = [];
	const rightItems: { key: string; node: ReactNode }[] = [];
	for (const { id, entry, fallbackAlign } of entries) {
		if (entry?.hidden) continue;
		let node: ReactNode = null;
		if (id.startsWith("host:")) {
			node = hostNodes[id];
		} else if (entry) {
			// kind="select"：底栏空间小，只画下拉本身（title=hint||label）。
			if (entry.kind === "select" && entry.options?.length) {
				node = (
					<select
						className="status-select"
						title={entry.hint ?? entry.label}
						aria-label={entry.label}
						value={
							entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value
						}
						onChange={(e) => onUiAction?.(entry, e.target.value)}
					>
						{entry.options.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				);
			} else {
				node = (
					<button
						type="button"
						className="status-action"
						title={entry.hint ?? entry.label}
						onClick={() => onUiAction?.(entry)}
					>
						{entry.icon ? `${entry.icon} ` : ""}
						{entry.label}
						{entry.badge ? <span className="status-badge">{entry.badge}</span> : null}
					</button>
				);
			}
		}
		if (!node) continue;
		const wrappedNode = (
			<span key={id} className="status-item-wrap" onContextMenu={(e) => openItemMenu(e, id, entry?.label ?? id)}>
				{node}
			</span>
		);
		// 分区走数据不走 id：正常链路看 entry.align（manifest/arrange/用户偏好都能改），
		// 降级链路（entry 为空）看 FALLBACK 表里的静态 align。
		const zone = entry?.align ?? fallbackAlign;
		if (zone === "end") {
			rightItems.push({ key: id, node: wrappedNode });
		} else if (zone === "center") {
			centerItems.push({ key: id, node: wrappedNode });
		} else {
			leftItems.push({ key: id, node: wrappedNode });
		}
	}

	const renderGroup = (groupItems: { key: string; node: ReactNode }[]) =>
		groupItems.map((it, i) => (
			<Fragment key={it.key}>
				{/* 分隔符只在「前面真画了东西」时插：条件不满足的宿主条目不留孤儿 `·`。 */}
				{i > 0 && <span className="status-sep">·</span>}
				{it.node}
			</Fragment>
		));

	return (
		<footer className="statusbar">
			<div className="statusbar-left">{renderGroup(leftItems)}</div>
			{centerItems.length > 0 && <div className="statusbar-center">{renderGroup(centerItems)}</div>}
			<div className="statusbar-right">{renderGroup(rightItems)}</div>
		</footer>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

function formatCost(cost: number): string {
	if (cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}
