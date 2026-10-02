import {
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { FiBox, FiMenu, FiSettings } from "react-icons/fi";
import { PiPushPinFill, PiPushPinSlash } from "react-icons/pi";
import { PluginIcon } from "../plugin-icon";
import { useI18n } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";

/**
 * 插件面板（顶栏那个插件入口，Chrome 扩展图标的位置）：列出**全部已装插件**，
 * 每行一个「钉到顶栏」开关 —— 钉住的插件视图 tab 才回到顶栏，没钉的只在面板里。
 *
 * 为什么是 portal + `position: fixed`：触发器坐在横滑的 `.topbar-flow` 里
 * （窄屏 `overflow-x:auto` 会让纵向也变成裁剪，CSS Overflow 3 §3.1），
 * 面板往下展开正好落在被裁的轴上，`z-index` 再高也逃不出来 —— 与
 * TopbarOverflowMenu / ContextMenu 同一招（portal 到 body + 实测钳制）。
 *
 * 统一接入 `useFloatingPanel`：锚点优先使用 `anchorEl` 的实时位置，退化时使用
 * `anchorRect` 快照；页面滚动/缩放时只重算位置不关闭。
 */
interface PluginMenuRow {
	id: string;
	name: string;
	icon?: string;
	iconSvg?: string;
	error?: string;
	/** false = 纯渲染器插件（没有独立界面，钉不钉都没有 tab）。 */
	view?: boolean;
}

interface PluginMenuProps {
	/** 触发器的视口矩形（点击时快照）。 */
	anchorRect: { left: number; right: number; top: number; bottom: number };
	/** 触发器本体（可能已随「⋯」菜单卸载，只用来忽略点在自己身上的 mousedown）。 */
	anchorEl?: HTMLElement | null;
	plugins: PluginMenuRow[];
	/** 已经钉在顶栏上的插件 id。 */
	pinnedIds: ReadonlySet<string>;
	/** 插件视图的当前顺序（同时决定已钉 tab 在顶栏里的相对顺序）。 */
	orderedPluginIds?: readonly string[];
	onTogglePin: (pluginId: string, pinned: boolean) => void;
	onReorder: (pluginIds: string[]) => void;
	onOpenView: (pluginId: string) => void;
	onManagePlugins: () => void;
	onClose: () => void;
}

export function PluginMenu({
	anchorRect,
	anchorEl,
	plugins,
	pinnedIds,
	orderedPluginIds,
	onTogglePin,
	onReorder,
	onOpenView,
	onManagePlugins,
	onClose,
}: PluginMenuProps) {
	const { t } = useI18n();
	const {
		panelRef: menuRef,
		style,
		measure,
	} = useFloatingPanel({
		anchor: anchorRect,
		anchorEl,
		onClose,
	});

	const [, setDraggingId] = useState<string | null>(null);
	const draggingIdRef = useRef<string | null>(null);
	const [dropId, setDropId] = useState<string | null>(null);
	const orderedPlugins = useMemo(() => {
		const rank = new Map((orderedPluginIds ?? []).map((id, index) => [id, index]));
		return plugins
			.map((plugin, index) => ({ plugin, index }))
			.sort((a, b) => (rank.get(a.plugin.id) ?? 1_000_000 + a.index) - (rank.get(b.plugin.id) ?? 1_000_000 + b.index))
			.map(({ plugin }) => plugin);
	}, [plugins, orderedPluginIds]);

	// 内容变化后重新实测
	useLayoutEffect(() => {
		measure();
	}, [orderedPlugins, measure]);

	const movePlugin = (id: string, delta: number) => {
		const ids = orderedPlugins.filter((p) => p.view !== false && !p.error).map((p) => p.id);
		const from = ids.indexOf(id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= ids.length) return;
		const [moved] = ids.splice(from, 1);
		if (!moved) return;
		ids.splice(to, 0, moved);
		onReorder(ids);
	};
	const dropPlugin = (sourceId: string | null, targetId: string) => {
		if (!sourceId || sourceId === targetId) return;
		const ids = orderedPlugins.filter((p) => p.view !== false && !p.error).map((p) => p.id);
		const from = ids.indexOf(sourceId);
		const to = ids.indexOf(targetId);
		if (from < 0 || to < 0) return;
		const [moved] = ids.splice(from, 1);
		if (!moved) return;
		ids.splice(to, 0, moved);
		onReorder(ids);
	};

	return createPortal(
		<div ref={menuRef} className="pm-panel" role="menu" aria-label={t("pluginMenuTitle")} style={style}>
			{/* 标题与 aria-label 重复，纯装饰 —— 对读屏器藏掉，免得它插在 menuitem 中间。 */}
			<div className="pm-head" aria-hidden="true">
				<FiBox className="pm-head-icon" aria-hidden />
				{t("pluginMenuTitle")}
			</div>
			<div className="pm-list">
				{plugins.length === 0 ? (
					<div className="pm-empty">{t("pluginMenuEmpty")}</div>
				) : (
					orderedPlugins.map((p) => {
						// 报错插件：合并引擎整份丢弃了它的贡献（含合成视图条目），钉住也是空操作；
						// 纯渲染器插件（view:false）压根没有视图。两类都只列出来、不给开关。
						const noView = p.view === false || !!p.error;
						const pinned = !noView && pinnedIds.has(p.id);
						const hint = p.error ?? (p.view === false ? t("pluginMenuNoView") : undefined);
						// 与顶栏/布局页同一套图标口径：词表名当文字画（这里没有词表，无图标就回落矢量），
						// emoji/单字符原样画，插件自带 SVG 优先。回落不用 🧩 emoji：旧 Windows 缺这个
						// 字会显示成空框（见 TopBar host:plugins），矢量图标永远能画出来。
						const glyph = p.iconSvg ? undefined : p.icon && !/[a-z]/i.test(p.icon) ? p.icon : undefined;
						return (
							<div
								key={p.id}
								className={`pm-row${dropId === p.id ? " drop-target" : ""}`}
								role="none"
								onDragOver={(e) => {
									if (noView || !draggingIdRef.current) return;
									e.preventDefault();
									setDropId(p.id);
								}}
								onDrop={(e) => {
									e.preventDefault();
									dropPlugin(e.dataTransfer.getData("text/plain") || draggingIdRef.current, p.id);
									draggingIdRef.current = null;
									setDraggingId(null);
									setDropId(null);
								}}
							>
								{!noView && (
									<button
										type="button"
										className="pm-drag"
										draggable
										aria-label={t("pluginMenuReorder")}
										title={t("pluginMenuReorderHint")}
										onDragStart={(e: DragEvent<HTMLButtonElement>) => {
											setDraggingId(p.id);
											draggingIdRef.current = p.id;
											e.dataTransfer.effectAllowed = "move";
											e.dataTransfer.setData("text/plain", p.id);
											// 使用挂到 DOM 上的透明拖拽图像：浏览器不会把把手单独拖成一张浮图。
											const ghost = document.createElement("div");
											ghost.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0";
											document.body.appendChild(ghost);
											e.dataTransfer.setDragImage(ghost, 0, 0);
											requestAnimationFrame(() => ghost.remove());
										}}
										onDragEnd={() => {
											draggingIdRef.current = null;
											setDraggingId(null);
											setDropId(null);
										}}
										onKeyDown={(e: ReactKeyboardEvent<HTMLButtonElement>) => {
											if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
											e.preventDefault();
											movePlugin(p.id, e.key === "ArrowUp" ? -1 : 1);
										}}
									>
										<FiMenu aria-hidden />
									</button>
								)}
								<button
									type="button"
									role="menuitem"
									className="pm-row-main"
									disabled={noView}
									title={hint}
									onClick={() => onOpenView(p.id)}
								>
									{glyph || p.iconSvg ? (
										<PluginIcon icon={glyph} iconSvg={p.iconSvg} className="pm-icon" />
									) : (
										<FiBox className="pm-icon" aria-hidden />
									)}
									<span className="pm-name">{p.name}</span>
									{hint && <span className="pm-sub">{hint}</span>}
								</button>
								{!noView && (
									<button
										type="button"
										role="menuitemcheckbox"
										aria-checked={pinned}
										aria-label={pinned ? t("pluginMenuUnpin") : t("pluginMenuPin")}
										className={`pm-pin${pinned ? " on" : ""}`}
										onClick={() => onTogglePin(p.id, !pinned)}
									>
										{pinned ? <PiPushPinFill aria-hidden /> : <PiPushPinSlash aria-hidden />}
									</button>
								)}
							</div>
						);
					})
				)}
			</div>
			<button
				type="button"
				role="menuitem"
				className="pm-manage"
				onClick={() => {
					onClose();
					onManagePlugins();
				}}
			>
				<FiSettings aria-hidden />
				<span>{t("pluginMenuManage")}</span>
			</button>
		</div>,
		document.body,
	);
}
