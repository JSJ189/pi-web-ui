import { useEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import {
	FiActivity,
	FiBox,
	FiCpu,
	FiDatabase,
	FiDownload,
	FiFolder,
	FiFolderPlus,
	FiGitBranch,
	FiGithub,
	FiGlobe,
	FiLayers,
	FiMenu,
	FiMessageSquare,
	FiPlus,
	FiSearch,
	FiSettings,
	FiSun,
	FiTerminal,
	FiVolume2,
} from "react-icons/fi";
import { LuMessageSquareDashed } from "react-icons/lu";
import type { UiSlotEntry, UiSlotId } from "../ui-slots";
import type { ChatState } from "../use-chat";
import { useT, useI18n } from "../i18n";
import { useAppGlobals, appSend } from "../app-globals";
import { PluginIcon } from "../plugin-icon";
import { focusComposer } from "../composer-bridge";
import { openContextMenu } from "../context-menu-state";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";
import { Dropdown, DropdownItem } from "./Dropdown";
import { SoundSettingsPanel } from "./SoundSettings";
import { NotifyToggle } from "./NotifyToggle";
import { BrowserControl } from "./BrowserControl";
import { BROWSER_PAGE_TOOL_NAME } from "../../../server/tool-manager.js";
import type { SoundKind, SoundSettings } from "../sounds";

export type ViewName = "chat" | "terminal" | "git" | `plugin:${string}`;

export interface BarItemTheme {
	id: string;
	name: string;
	builtin: boolean;
	nameEn?: string;
	group?: "classic" | "builtin";
	scheme?: "dark" | "light";
}

export interface BarItemProps {
	entry: UiSlotEntry;
	bar: "top" | "bottom" | "left" | "right";
	chat: ChatState;
	view?: ViewName;
	plugins?: { id: string; name?: string; error?: string; icon?: string; iconSvg?: string }[];
	onViewChange?: (view: ViewName) => void;
	onOpenPanel?: (side: "left" | "right") => void;
	onOpenSettings?: (initialSection?: string) => void;
	onOpenGlobalSearch?: () => void;
	onOpenBgTasks?: () => void;
	onOpenProjectPicker?: () => void;
	onOpenPluginMenu?: (el: HTMLElement) => void;
	isPluginMenuOpen?: boolean;
	isProjectPickerOpen?: boolean;
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	uiContextEntries?: UiSlotEntry[];
	dropdownProps?: {
		sound?: SoundSettings;
		onSoundChange?: (settings: SoundSettings) => void;
		onSoundPreview?: (kind: SoundKind) => void;
		theme?: string | null;
		themes?: BarItemTheme[];
		onThemeChange?: (themeId: string | null) => void;
		reloadThemes?: () => void;
		onLocaleModalOpen?: () => void;
		renderUpdateBody?: () => ReactNode;
		renderAllUpdatesBody?: () => ReactNode;
		updatesCount?: number;
		managed?: boolean;
		appVersion?: string;
	};
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

function formatCost(cost: number): string {
	if (cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}

function localeShort(code: string): string {
	if (code.startsWith("zh")) return "ZH";
	if (code.startsWith("ja")) return "JA";
	if (code.startsWith("ko")) return "KO";
	if (code.startsWith("fr")) return "FR";
	if (code.startsWith("de")) return "DE";
	if (code.startsWith("es")) return "ES";
	if (code.startsWith("ru")) return "RU";
	if (code.startsWith("pt")) return "PT";
	if (code.startsWith("it")) return "IT";
	return "EN";
}

/**
 * 通用条目组件（BarItem）：
 * 统一服务于顶栏（topbar.primary）、底栏（bottombar）、左侧栏（sidebar.left）、右侧栏（sidebar.right）。
 * 统一采用【图标 + 文字】的形式展现（特殊条目保留其环形进度、状态指示灯等特色结构），
 * 支持跨栏拖动后在任意位置正常渲染与交互，右键菜单支持在四个栏之间自由互移。
 */
export function BarItem({
	entry,
	bar,
	chat,
	view,
	plugins,
	onViewChange,
	onOpenPanel,
	onOpenSettings,
	onOpenGlobalSearch,
	onOpenBgTasks,
	onOpenProjectPicker,
	onOpenPluginMenu,
	isPluginMenuOpen,
	isProjectPickerOpen,
	onUiAction,
	uiContextEntries,
	dropdownProps,
}: BarItemProps) {
	const t = useT();
	const { locale, packs, setLocale } = useI18n();
	const { engine } = useAppGlobals();
	const isDsh = engine === "dsh";

	const [soundOpen, setSoundOpen] = useState(false);
	const [langOpen, setLangOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);

	const layout = chat.settings?.uiLayout;
	const state = chat.state;
	const stats = state?.stats;
	const isStreaming = state?.isStreaming ?? false;

	const samplesRef = useRef<RateSample[]>([]);
	const streamEst = state?.streamingMessage ? estimateStreamTokens(state.streamingMessage.content) : 0;
	useEffect(() => {
		if (!isStreaming) {
			samplesRef.current = [];
			return;
		}
		const now = Date.now();
		const prev = samplesRef.current;
		const last = prev[prev.length - 1];
		if (last && now - last.t < 250) return;
		samplesRef.current = trimRateSamples([...prev, { t: now, out: streamEst }], now);
	}, [isStreaming, streamEst]);

	const rate = isStreaming ? streamRate(samplesRef.current) : 0;

	const handleContextMenu = (e: ReactMouseEvent) => {
		e.preventDefault();
		e.stopPropagation();

		const setItemSlot = (targetSlot: UiSlotId) => {
			const slots = { ...layout?.slots, [entry.id]: targetSlot };
			appSend({ type: "set_settings", uiLayout: { ...layout, slots } });
		};
		const hideItem = () => {
			const hidden = new Set(layout?.hidden ?? []);
			hidden.add(entry.id);
			appSend({ type: "set_settings", uiLayout: { ...layout, hidden: [...hidden] } });
		};

		const menuEntries: UiSlotEntry[] = [];
		if (bar !== "top") {
			menuEntries.push({
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
			});
		}
		if (bar !== "bottom") {
			menuEntries.push({
				id: "host:move-bottom",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToBottom"),
				kind: "action",
				order: 20,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		if (bar !== "left") {
			menuEntries.push({
				id: "host:move-left",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToLeft"),
				kind: "action",
				order: 30,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		if (bar !== "right") {
			menuEntries.push({
				id: "host:move-right",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToRight"),
				kind: "action",
				order: 40,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		menuEntries.push({
			id: "host:hide-item",
			slot: "contextmenu.topbar",
			source: "host",
			label: t("uiLayoutRestore"),
			kind: "action",
			order: 50,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		});
		if (uiContextEntries && uiContextEntries.length > 0) {
			menuEntries.push(...uiContextEntries);
		}

		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.topbar",
			target: { id: entry.id, label: entry.label },
			entries: menuEntries,
			onHostAction: (actionEntry) => {
				if (actionEntry.id === "host:move-top") setItemSlot("topbar.primary");
				else if (actionEntry.id === "host:move-bottom") setItemSlot("bottombar");
				else if (actionEntry.id === "host:move-left") setItemSlot("sidebar.left");
				else if (actionEntry.id === "host:move-right") setItemSlot("sidebar.right");
				else if (actionEntry.id === "host:hide-item") hideItem();
			},
		});
	};

	const id = entry.id;

	// 下拉选择类型插件条目
	if (entry.kind === "select" && entry.options?.length) {
		const val = entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value;
		return (
			<select
				className="bar-item bar-item-select"
				title={entry.hint ?? entry.label}
				data-tip={entry.hint ?? entry.label}
				aria-label={entry.label}
				value={val}
				onChange={(e) => onUiAction?.(entry, e.target.value)}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				{entry.options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		);
	}

	// 1. 特殊条目：品牌（唯品牌徽标例外，不加 data-tip）
	if (id === "host:brand") {
		return (
			<span
				className="bar-item brand bar-item-brand"
				title={t("brand")}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className="brand-logo bar-item-brand-logo">π</span>
				<span className="brand-name bar-item-text">pi-web-ui</span>
			</span>
		);
	}

	// 2. 特殊条目：连接状态
	if (id === "host:conn") {
		const connClass = chat.ready ? "ok" : chat.status === "closed" ? "error" : "busy";
		const connLabel = chat.ready ? t("connected") : chat.status === "closed" ? t("reconnecting") : t("connecting");
		return (
			<span
				className={`bar-item status-item status-conn ${connClass} bar-item-conn`}
				title={connLabel}
				data-tip={connLabel}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className={`status-dot ${connClass}`} />
				{/* 连接态常驻「指示灯 + 文字」：只留圆点虽然紧凑，但底栏缺少一处明文的健康状态，
				 * 用户看不出「亮着的是绿灯还是黄灯」，所以文字保留（窄屏≤768px 由 CSS 单独隐藏文字）。 */}
				<span className="status-conn-label bar-item-text">{connLabel}</span>
			</span>
		);
	}

	// 3. 特殊条目：引擎徽标（仅非 pi 引擎有效）
	if (id === "host:engine") {
		if (engine === "pi") return null;
		return (
			<span
				className={`bar-item status-item engine-badge engine-${engine} bar-item-engine`}
				title={`${t("engineBadge")}: ${engine}`}
				data-tip={`${t("engineBadge")}: ${engine}`}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				{engine === "dsh" ? "DSH" : engine}
			</span>
		);
	}

	// 4. 特殊条目：上下文进度环
	if (id === "host:ctx") {
		const context = stats?.contextUsage;
		const cap = context?.softCap ?? null;
		const hasCap = cap !== null && cap > 0 && cap < (context?.contextWindow ?? 0);
		const effectiveMax = hasCap ? cap : (context?.contextWindow ?? 0);
		const ctxPercent =
			context?.tokens !== null && context?.tokens !== undefined && effectiveMax > 0
				? Math.min(100, Math.round((context.tokens / effectiveMax) * 100))
				: null;
		const usedFormatted =
			context?.tokens !== null && context?.tokens !== undefined ? formatTokens(context.tokens) : null;
		const maxFormatted = effectiveMax > 0 ? formatTokens(effectiveMax) : null;
		const ctxText =
			usedFormatted !== null && maxFormatted !== null && ctxPercent !== null
				? `${usedFormatted} / ${maxFormatted}`
				: "—";
		const ctxRingClass = ctxPercent === null ? "" : ctxPercent >= 80 ? "warn" : ctxPercent >= 50 ? "mid" : "ok";
		const ctxTitle = hasCap
			? `${t("contextUsage")}: ${formatTokens(context?.tokens ?? 0)} / ${formatTokens(cap)} (${t("softCapMarker")}, max ${formatTokens(context?.contextWindow ?? 0)})`
			: cap !== null && cap > 0
				? `${t("contextUsage")}: ${ctxText} · ${t("softCapMarker")}: ${formatTokens(cap)}`
				: `${t("contextUsage")}: ${ctxText}`;
		const strokeDashoffset =
			ctxPercent !== null && ctxPercent > 0 ? +(31.42 * (1 - Math.min(ctxPercent, 100) / 100)).toFixed(2) : 31.42;

		return (
			<span
				className="bar-item status-item status-ctx bar-item-ctx"
				title={ctxTitle}
				data-tip={ctxTitle}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<svg className={`ctx-ring ${ctxRingClass}`} viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
					<circle className="ctx-ring-bg" cx="7" cy="7" r="5" />
					{ctxPercent !== null && ctxPercent > 0 && (
						<circle
							className="ctx-ring-fill"
							cx="7"
							cy="7"
							r="5"
							strokeDasharray={31.42}
							strokeDashoffset={strokeDashoffset}
							data-percent={ctxPercent}
						/>
					)}
				</svg>
				<span className="bar-item-text">
					{usedFormatted !== null && maxFormatted !== null ? (
						<>
							<span className="ctx-val">{usedFormatted}</span>
							<span className="status-sep">/</span>
							<span className="ctx-max">{maxFormatted}</span>
						</>
					) : (
						ctxText
					)}
				</span>
			</span>
		);
	}

	// 5. 特殊条目：缓存命中率
	if (id === "host:cache") {
		const cache = cacheMetrics(stats?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		const hitPct = cache.hitRate * 100;
		const hitClass = cache.totalInput === 0 ? "" : cache.hitRate >= 0.7 ? "ok" : cache.hitRate >= 0.4 ? "mid" : "warn";
		const hitText = cache.totalInput > 0 ? `${hitPct.toFixed(1)}%` : "—";
		const cacheTip = t("cacheHitTip", {
			read: formatTokens(cache.read),
			write: formatTokens(cache.write),
			miss: formatTokens(cache.miss),
			input: formatTokens(cache.totalInput),
		});
		const cacheTitle = cache.totalInput > 0 ? `${t("cacheHit")}: ${hitText} · ${cacheTip}` : t("cacheHit");
		const isZero = cache.totalInput === 0;

		return (
			<span
				className={`bar-item status-item status-cache bar-item-cache${isZero ? " is-zero" : ""}`}
				title={cacheTitle}
				data-tip={cacheTitle}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<FiDatabase className="bar-item-icon" />
				<span className="bar-item-text">
					<b className={`cache-pct ${hitClass}`}>{hitText}</b>
				</span>
			</span>
		);
	}

	// 5.5 特殊条目：累计成本（与 ctx / cache 同级的纯状态指标，无按钮行为）
	if (id === "host:cost") {
		const cost = stats?.cost ?? 0;
		const costFormatted = formatCost(cost);
		const costTip = t("cumulativeCost");
		const isZero = cost <= 0;
		return (
			<span
				className={`bar-item status-item status-cost bar-item-cost${isZero ? " is-zero" : ""}`}
				title={costTip}
				data-tip={costTip}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className="bar-item-char">$</span>
				<span className="bar-item-text">{costFormatted}</span>
			</span>
		);
	}

	// 5.6 特殊条目：消息数（纯图标 + 数字，去掉了文字和 #）
	if (id === "host:msg-count") {
		const count = stats?.totalMessages ?? 0;
		const tip = `${t("sessionMessages")}: ${count}`;
		const isZero = count === 0;
		return (
			<span
				className={`bar-item status-item status-msg-count bar-item-msg-count${isZero ? " is-zero" : ""}`}
				title={tip}
				data-tip={tip}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<FiMessageSquare className="bar-item-icon" />
				<span className="bar-item-text">{count}</span>
			</span>
		);
	}

	// 6. 特殊条目：运行状态
	if (id === "host:working") {
		if (!isStreaming) return null;
		const queueTotal = (state?.queue?.steering?.length ?? 0) + (state?.queue?.followUp?.length ?? 0);
		return (
			<span
				className="bar-item status-item working bar-item-working"
				title={t("working")}
				data-tip={t("working")}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className="working-spin" />
				<span className="bar-item-text">
					{t("working")}
					{queueTotal > 0 && ` ⏳ ${queueTotal}`}
				</span>
				<span className="status-rate bar-item-rate" title={t("rateTip")}>
					{rate > 0 ? `${Math.round(rate)}${t("tps")}` : "…"}
				</span>
			</span>
		);
	}

	// 7. 特殊条目：审查者模式
	if (id === "host:status-delegate") {
		if (!state?.delegateMode) return null;
		return (
			<span
				className="bar-item status-item delegate-badge bar-item-delegate"
				title={state.delegateConvId ? t("delegateModeOpenTip") : t("delegateModeBadgeTip")}
				data-tip={state.delegateConvId ? t("delegateModeOpenTip") : t("delegateModeBadgeTip")}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className="bar-item-icon">🔎</span>
				<span className="bar-item-text">{t("delegateModeBadge")}</span>
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
		);
	}

	// 8. 特殊条目：主机资源占用
	if (id === "host:host-metrics") {
		const metrics = chat.hostMetrics;
		if (!metrics) return null;
		const cpu =
			metrics.cpuPercent === null || !Number.isFinite(metrics.cpuPercent) ? "—" : `${Math.round(metrics.cpuPercent)}%`;
		const memory = Number.isFinite(metrics.memoryPercent) ? `${Math.round(metrics.memoryPercent)}%` : "—";
		return (
			<span
				className="bar-item status-item status-host-metrics bar-item-host-metrics"
				title={`${t("hostResourcesTip")}\n${t("hostProcessor")}: ${cpu} · ${t("hostMemory")}: ${memory}`}
				data-tip={`${t("hostResourcesTip")}\n${t("hostProcessor")}: ${cpu} · ${t("hostMemory")}: ${memory}`}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<FiCpu className="bar-item-icon" />
				<span className="bar-item-text">
					{cpu} · {memory}
				</span>
			</span>
		);
	}

	// 浏览器控制条目
	if (id === "host:browser") {
		if (chat.settings?.disabledAgentTools?.includes(BROWSER_PAGE_TOOL_NAME)) return null;
		return (
			<span className="bar-item-wrap" onContextMenu={handleContextMenu} data-bar-item={id}>
				<BrowserControl />
			</span>
		);
	}

	// 9. 下拉面板类条目
	if (id === "host:sound") {
		return (
			<Dropdown
				direction={bar === "bottom" ? "up" : "down"}
				align={bar === "right" ? "right" : "left"}
				open={soundOpen}
				onOpenChange={setSoundOpen}
				tip={t("sound")}
				caret={false}
				trigger={
					<button
						type="button"
						className="bar-item chip"
						title={t("sound")}
						data-tip={t("sound")}
						onContextMenu={handleContextMenu}
						data-bar-item={id}
					>
						<FiVolume2 className="bar-item-icon" />
						<span className="chip-sub bar-item-text">{t("sound")}</span>
					</button>
				}
			>
				{dropdownProps?.sound && dropdownProps?.onSoundChange ? (
					<SoundSettingsPanel
						settings={dropdownProps.sound}
						onChange={dropdownProps.onSoundChange}
						onPreview={dropdownProps.onSoundPreview ?? (() => {})}
					/>
				) : null}
				<NotifyToggle />
			</Dropdown>
		);
	}

	if (id === "host:language") {
		return (
			<Dropdown
				direction={bar === "bottom" ? "up" : "down"}
				align={bar === "right" ? "right" : "left"}
				open={langOpen}
				onOpenChange={setLangOpen}
				tip={t("language")}
				caret={false}
				trigger={
					<button
						type="button"
						className="bar-item chip"
						title={t("language")}
						data-tip={t("language")}
						onContextMenu={handleContextMenu}
						data-bar-item={id}
					>
						<FiGlobe className="bar-item-icon" />
						<span className="chip-sub bar-item-text">{localeShort(locale)}</span>
					</button>
				}
			>
				<div className="dd-header">{t("language")}</div>
				{packs.map((l) => (
					<DropdownItem
						key={l.code}
						active={locale === l.code}
						onClick={() => {
							setLocale(l.code);
							setLangOpen(false);
						}}
					>
						{l.nativeName}
					</DropdownItem>
				))}
				{dropdownProps?.onLocaleModalOpen ? (
					<DropdownItem
						onClick={() => {
							setLangOpen(false);
							dropdownProps.onLocaleModalOpen?.();
						}}
					>
						<FiDownload /> {t("localeGetMore")}
					</DropdownItem>
				) : null}
			</Dropdown>
		);
	}

	if (id === "host:theme") {
		const themes = dropdownProps?.themes ?? [];
		const currentTheme = dropdownProps?.theme ?? null;
		return (
			<Dropdown
				direction={bar === "bottom" ? "up" : "down"}
				align={bar === "right" ? "right" : "left"}
				open={themeOpen}
				onOpenChange={(v) => {
					setThemeOpen(v);
					if (v && themes.length === 0) dropdownProps?.reloadThemes?.();
				}}
				tip={t("theme")}
				caret={false}
				trigger={
					<button
						type="button"
						className="bar-item chip"
						title={t("theme")}
						data-tip={t("theme")}
						onContextMenu={handleContextMenu}
						data-bar-item={id}
					>
						<FiSun className="bar-item-icon" />
						<span className="chip-sub bar-item-text">{t("theme")}</span>
					</button>
				}
			>
				{(() => {
					const classics = themes.filter((th) => th.group === "classic");
					const builtins = themes.filter((th) => th.group !== "classic");
					const themeLabel = (th: BarItemTheme) => {
						const base = locale === "zh" ? th.name : (th.nameEn ?? th.name);
						const scheme = th.scheme === "light" ? t("themeLight") : th.scheme === "dark" ? t("themeDark") : "";
						if (!scheme) return base;
						return locale === "zh" ? `${base}（${scheme}）` : `${base} (${scheme})`;
					};
					return (
						<>
							{classics.length > 0 && (
								<>
									<div className="dd-header">{t("themeGroupClassics")}</div>
									{classics.map((th) => (
										<DropdownItem
											key={th.id}
											active={currentTheme === th.id}
											onClick={() => {
												dropdownProps?.onThemeChange?.(th.id);
												setThemeOpen(false);
											}}
										>
											{themeLabel(th)}
										</DropdownItem>
									))}
								</>
							)}
							<div className="dd-header">{classics.length > 0 ? t("themeGroupBuiltin") : t("theme")}</div>
							<DropdownItem
								active={currentTheme === null}
								onClick={() => {
									dropdownProps?.onThemeChange?.(null);
									setThemeOpen(false);
								}}
							>
								{t("themeDefault")}
							</DropdownItem>
							{builtins.map((th) => (
								<DropdownItem
									key={th.id}
									active={currentTheme === th.id}
									onClick={() => {
										dropdownProps?.onThemeChange?.(th.id);
										setThemeOpen(false);
									}}
								>
									{themeLabel(th)}
								</DropdownItem>
							))}
						</>
					);
				})()}
			</Dropdown>
		);
	}

	if (id === "host:update") {
		const updatesCount = dropdownProps?.updatesCount ?? 0;
		return dropdownProps?.managed ? (
			<span
				className="bar-item chip"
				title={t("updatesManaged")}
				data-tip={t("updatesManaged")}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<FiDownload className="bar-item-icon" />
				<span className="chip-sub bar-item-text">v{dropdownProps?.appVersion ?? chat.update?.current ?? "…"}</span>
			</span>
		) : (
			<Dropdown
				direction={bar === "bottom" ? "up" : "down"}
				align={bar === "right" ? "right" : "left"}
				open={updateOpen}
				onOpenChange={(v) => {
					setUpdateOpen(v);
					if (v) {
						appSend({ type: "check_update" });
						appSend({ type: "check_updates_all" });
					}
				}}
				tip={t("update")}
				fit
				caret={false}
				trigger={
					<button
						type="button"
						className="bar-item chip"
						title={t("update")}
						data-tip={t("update")}
						onContextMenu={handleContextMenu}
						data-bar-item={id}
					>
						<FiDownload className="bar-item-icon" />
						<span className="chip-sub bar-item-text">v{chat.update?.current ?? "…"}</span>
						{chat.update && !chat.update.upToDate && <span className="update-dot" />}
						{updatesCount > 0 && <span className="update-badge">{updatesCount}</span>}
					</button>
				}
			>
				<div className="dd-header">{t("update")}</div>
				{dropdownProps?.renderUpdateBody?.()}
				{dropdownProps?.renderAllUpdatesBody?.()}
			</Dropdown>
		);
	}

	// 10. 标准【图标 + 文字】各类按钮
	let iconNode: ReactNode = null;
	let labelText = entry.label;
	let badgeNode: ReactNode = null;
	let isActive = false;
	let isTab = false;
	let extraClasses = "";
	let tipOverride: string | undefined = undefined;
	let onClick: ((e: ReactMouseEvent<HTMLButtonElement>) => void) | undefined = undefined;

	switch (id) {
		case "host:chat":
			iconNode = <FiMessageSquare className="bar-item-icon" />;
			labelText = t("chat");
			isActive = view === "chat";
			isTab = true;
			onClick = () => onViewChange?.("chat");
			break;
		case "host:terminal":
			iconNode = <FiTerminal className="bar-item-icon" />;
			labelText = t("terminal");
			isActive = view === "terminal";
			isTab = true;
			onClick = () => onViewChange?.("terminal");
			break;
		case "host:git":
			iconNode = <FiGitBranch className="bar-item-icon" />;
			labelText = t("scmTab");
			isActive = view === "git";
			isTab = true;
			onClick = () => onViewChange?.("git");
			break;
		case "host:new-chat":
			iconNode = <FiPlus className="bar-item-icon" />;
			labelText = t("newChat");
			extraClasses = "chip newchat";
			onClick = () => {
				onViewChange?.("chat");
				appSend({ type: "new_chat" });
				focusComposer();
			};
			break;
		case "host:new-ephemeral-chat":
			if (isDsh) return null;
			iconNode = <LuMessageSquareDashed className="bar-item-icon" />;
			labelText = t("newChatEphemeral");
			extraClasses = "chip newchat ephemeral-chat-btn";
			onClick = () => {
				onViewChange?.("chat");
				appSend({ type: "new_chat", ephemeral: true });
				focusComposer();
			};
			break;
		case "host:history":
			if (view && view !== "chat") return null;
			iconNode = <FiMenu className="bar-item-icon" />;
			labelText = t("openHistory");
			extraClasses = "panel-toggle";
			onClick = () => onOpenPanel?.("left");
			break;
		case "host:files":
			if (view && view !== "chat") return null;
			iconNode = <FiFolder className="bar-item-icon" />;
			labelText = t("openFiles");
			extraClasses = "panel-toggle has-label";
			onClick = () => onOpenPanel?.("right");
			break;
		case "host:open-project":
			iconNode = <FiFolderPlus className="bar-item-icon" />;
			labelText = t("openProject");
			extraClasses = "chip open-project";
			isActive = Boolean(isProjectPickerOpen);
			onClick = () => onOpenProjectPicker?.();
			break;
		case "host:search":
			iconNode = <FiSearch className="bar-item-icon" />;
			labelText = t("searchGlobal");
			extraClasses = "chip";
			onClick = () => onOpenGlobalSearch?.();
			break;
		case "host:tasks":
			iconNode = <FiLayers className="bar-item-icon" />;
			labelText = t("bgTasks");
			extraClasses = "chip bg-task-chip";
			if (chat.bgServers.length > 0) {
				badgeNode = <span className="bg-task-badge bar-item-badge">{chat.bgServers.length}</span>;
			}
			onClick = () => onOpenBgTasks?.();
			break;
		case "host:settings":
			iconNode = <FiSettings className="bar-item-icon" />;
			labelText = t("settings");
			extraClasses = "chip";
			onClick = () => onOpenSettings?.();
			break;
		case "host:plugins":
			iconNode = <FiBox className="bar-item-icon" />;
			labelText = t("pluginMenuTitle");
			extraClasses = "chip";
			onClick = (e) => {
				if (onOpenPluginMenu) onOpenPluginMenu(e.currentTarget);
				else onOpenSettings?.("plugins");
			};
			break;
		case "host:github":
			iconNode = <FiGithub className="bar-item-icon" />;
			labelText = "GitHub";
			extraClasses = "chip github";
			onClick = () => window.open("https://github.com/xing-shuyin/pi-web-ui", "_blank", "noreferrer,noopener");
			break;
		case "host:cwd":
			iconNode = <FiFolder className="bar-item-icon" />;
			labelText = state?.cwd ? state.cwd.split(/[/\\]/).pop() || state.cwd : t("openProject");
			extraClasses = "status-item status-cwd";
			isActive = Boolean(isProjectPickerOpen);
			onClick = () => onOpenProjectPicker?.();
			break;
		case "host:plugin-status":
			if (chat.statuses.length === 0) return null;
			iconNode = <FiActivity className="bar-item-icon" />;
			labelText = chat.statuses.map((st) => st.text).join(" · ");
			extraClasses = "status-item ext-status";
			break;
		default:
			// 插件视图（kind === "view"）或常规插件 action
			if (entry.kind === "view") {
				const target = entry.view ?? "";
				isActive = view === target;
				isTab = true;
				const pluginList = plugins ?? chat.plugins ?? [];
				const meta = pluginList.find((p) => `plugin:${p.id}` === entry.source);
				const isBroken = Boolean(meta?.error);
				extraClasses = `plugin-tab${isBroken ? " broken" : ""}`;
				if (meta?.error) {
					tipOverride = `${entry.label}: ${meta.error}`;
				}
				// 优先展示插件定义的线性矢量 SVG 图标（iconSvg），无 SVG 时才回退到 emoji（icon）
				const svg = entry.iconSvg || meta?.iconSvg;
				const glyph = entry.icon || meta?.icon;
				iconNode = svg ? (
					<PluginIcon icon={glyph} iconSvg={svg} className="bar-item-icon plugin-icon-svg" />
				) : glyph ? (
					<span className="bar-item-icon bar-item-glyph">{glyph}</span>
				) : null;
				onClick = () => onViewChange?.(target as ViewName);
			} else {
				const svg = entry.iconSvg;
				const glyph = entry.icon;
				extraClasses = bar === "bottom" ? "status-item status-action chip" : "chip";
				iconNode = svg ? (
					<PluginIcon icon={glyph} iconSvg={svg} className="bar-item-icon plugin-icon-svg" />
				) : glyph ? (
					<span className="bar-item-icon bar-item-glyph">{glyph}</span>
				) : null;
				if (entry.badge) {
					badgeNode = <span className="bar-item-badge">{entry.badge}</span>;
				}
				onClick = () => onUiAction?.(entry);
			}
			break;
	}

	const tip = tipOverride ?? entry.hint ?? labelText;
	const tabClass = isTab ? `tb-tab${isActive ? " active" : ""}` : "";
	const combinedClass = ["bar-item", tabClass, extraClasses, isActive && !isTab ? "active" : ""]
		.filter(Boolean)
		.join(" ");

	return (
		<button
			type="button"
			role={isTab ? "tab" : undefined}
			aria-selected={isTab ? isActive : undefined}
			aria-haspopup={id === "host:plugins" ? "menu" : undefined}
			aria-expanded={id === "host:plugins" ? Boolean(isPluginMenuOpen) : undefined}
			className={combinedClass}
			title={tip}
			data-tip={tip}
			aria-label={labelText}
			onClick={onClick}
			onContextMenu={handleContextMenu}
			data-bar-item={id}
		>
			{iconNode}
			<span className="bar-item-text">{labelText}</span>
			{badgeNode}
		</button>
	);
}
