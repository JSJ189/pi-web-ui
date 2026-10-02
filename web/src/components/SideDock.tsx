import { useState, useRef, type ReactNode } from "react";
import {
	FiBox,
	FiDownload,
	FiFolder,
	FiFolderPlus,
	FiGitBranch,
	FiGithub,
	FiGlobe,
	FiMenu,
	FiMessageSquare,
	FiSearch,
	FiSun,
	FiPlus,
	FiSettings,
	FiLayers,
	FiTerminal,
	FiVolume2,
	FiChevronLeft,
	FiChevronRight,
	FiAnchor,
	FiCpu,
	FiActivity,
	FiCompass,
} from "react-icons/fi";
import { LuMessageSquareDashed } from "react-icons/lu";
import type { ChatState } from "../use-chat";
import type { UiSlotEntry, UiSlotId } from "../ui-slots";
import { PluginIcon } from "../plugin-icon";
import { useI18n } from "../i18n";
import { appSend } from "../app-globals";
import { focusComposer } from "../composer-bridge";
import { openContextMenu } from "../context-menu-state";

export interface SideDockProps {
	side: "left" | "right";
	items: UiSlotEntry[];
	chat: ChatState;
	view: "chat" | "terminal" | "git" | `plugin:${string}`;
	onViewChange: (view: "chat" | "terminal" | "git" | `plugin:${string}`) => void;
	onOpenPanel: (side: "left" | "right") => void;
	onOpenSettings: (initialSection?: string) => void;
	onOpenBgTasks: () => void;
	onOpenGlobalSearch: () => void;
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	uiContextTopbar?: UiSlotEntry[];
	onOpenProjectPicker?: () => void;
	onThemeToggle?: () => void;
	onSoundToggle?: () => void;
}

/**
 * 屏幕边缘浮动图标停靠栏（SideDock）。
 *
 * 贴在屏幕左侧或右侧边缘（left: 0 或 right: 0），支持收起与展开，
 * 渲染被分配到 sidebar.left 或 sidebar.right 的所有条目，
 * 点击触发对应的操作，右键弹出上下文菜单支持自由移到上下两侧任意位置。
 */
export function SideDock({
	side,
	items,
	chat,
	view,
	onViewChange,
	onOpenPanel,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGlobalSearch,
	onUiAction,
	uiContextTopbar,
	onOpenProjectPicker,
	onThemeToggle,
	onSoundToggle,
}: SideDockProps) {
	const { t } = useI18n();
	const [collapsed, setCollapsed] = useState(false);
	const dockRef = useRef<HTMLDivElement>(null);

	const layout = chat.settings?.uiLayout;
	/** 悬浮模式（设置 → 界面布局 → 侧边图标悬浮显示）：回到旧的 fixed 贴边浮层 ——
	 *  不占布局宽，但会盖在面板上面（相应地 CSS 把它从 .layout 的 flex 流里摘出去）。 */
	const floatCls = layout?.sideDockFloat ? " side-dock-float" : "";

	/** 右键条目打开菜单：支持移到顶部/底部/左侧/右侧，以及隐藏与插件菜单项 */
	const handleContextMenu = (e: React.MouseEvent, item: UiSlotEntry) => {
		e.preventDefault();
		e.stopPropagation();

		const setItemSlot = (targetSlot: UiSlotId) => {
			const slots = { ...layout?.slots, [item.id]: targetSlot };
			appSend({ type: "set_settings", uiLayout: { ...layout, slots } });
		};

		const hideItem = () => {
			const hidden = new Set(layout?.hidden ?? []);
			hidden.add(item.id);
			appSend({ type: "set_settings", uiLayout: { ...layout, hidden: [...hidden] } });
		};

		const menuEntries: UiSlotEntry[] = [
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
			},
			{
				id: "host:move-left",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToLeft"),
				kind: "action",
				order: 30,
				align: "start",
				hidden: side === "left",
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:move-right",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToRight"),
				kind: "action",
				order: 40,
				align: "start",
				hidden: side === "right",
				userOverrides: [],
				arrangedBy: [],
			},
			{
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
			},
			...(uiContextTopbar ?? []),
		];

		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.topbar",
			target: { id: item.id, label: item.label },
			entries: menuEntries,
			onHostAction: (entry) => {
				if (entry.id === "host:move-top") setItemSlot("topbar.primary");
				else if (entry.id === "host:move-bottom") setItemSlot("bottombar");
				else if (entry.id === "host:move-left") setItemSlot("sidebar.left");
				else if (entry.id === "host:move-right") setItemSlot("sidebar.right");
				else if (entry.id === "host:hide-item") hideItem();
			},
		});
	};

	/** 执行条目的点击动作 */
	const handleItemClick = (item: UiSlotEntry) => {
		const id = item.id;
		switch (id) {
			case "host:new-chat":
				onViewChange("chat");
				appSend({ type: "new_chat" });
				focusComposer();
				break;
			case "host:new-ephemeral-chat":
				onViewChange("chat");
				appSend({ type: "new_chat", ephemeral: true });
				focusComposer();
				break;
			case "host:chat":
				onViewChange("chat");
				break;
			case "host:terminal":
				onViewChange("terminal");
				break;
			case "host:git":
				onViewChange("git");
				break;
			case "host:open-project":
				onOpenProjectPicker?.();
				break;
			case "host:history":
				onOpenPanel("left");
				break;
			case "host:files":
				onOpenPanel("right");
				break;
			case "host:search":
				onOpenGlobalSearch();
				break;
			case "host:tasks":
				onOpenBgTasks();
				break;
			case "host:settings":
				onOpenSettings();
				break;
			case "host:plugins":
				onOpenSettings("plugins");
				break;
			case "host:sound":
				onSoundToggle?.();
				break;
			case "host:theme":
				onThemeToggle?.();
				break;
			case "host:update":
				appSend({ type: "check_update" });
				appSend({ type: "check_updates_all" });
				break;
			case "host:github":
				window.open("https://github.com/xing-shuyin/pi-web-ui", "_blank", "noreferrer,noopener");
				break;
			default:
				if (item.view) {
					onViewChange(item.view as any);
				} else {
					onUiAction?.(item);
				}
				break;
		}
	};

	/** 获取宿主条目图标 */
	const renderItemIcon = (item: UiSlotEntry): ReactNode => {
		const id = item.id;
		switch (id) {
			case "host:brand":
				return <span className="side-dock-brand">π</span>;
			case "host:open-project":
				return <FiFolderPlus />;
			case "host:history":
				return <FiMenu />;
			case "host:files":
				return <FiFolder />;
			case "host:new-chat":
				return <FiPlus />;
			case "host:new-ephemeral-chat":
				return <LuMessageSquareDashed />;
			case "host:chat":
				return <FiMessageSquare />;
			case "host:terminal":
				return <FiTerminal />;
			case "host:git":
				return <FiGitBranch />;
			case "host:plugins":
				return <FiBox />;
			case "host:search":
				return <FiSearch />;
			case "host:browser":
				return <FiGlobe />;
			case "host:tasks":
				return <FiLayers />;
			case "host:settings":
				return <FiSettings />;
			case "host:sound":
				return <FiVolume2 />;
			case "host:language":
				return <FiGlobe />;
			case "host:theme":
				return <FiSun />;
			case "host:update":
				return <FiDownload />;
			case "host:github":
				return <FiGithub />;
			case "host:conn":
				return <span className="status-dot ok" />;
			case "host:engine":
				return <FiCpu />;
			case "host:ctx":
				return <FiActivity />;
			case "host:cost":
				return <span className="side-dock-char">$</span>;
			case "host:cache":
				return <FiCompass />;
			case "host:msg-count":
				return <span className="side-dock-char">#</span>;
			case "host:cwd":
				return <FiFolder />;
			default:
				if (item.iconSvg || item.icon) {
					return <PluginIcon icon={item.icon} iconSvg={item.iconSvg} />;
				}
				return <FiAnchor />;
		}
	};

	const visibleItems = items.filter((e) => !e.hidden);

	// 该侧没有分配任何图标：整条不渲染 —— 停靠栏现在是**在流内**的贴边槽位，留空会白白挤走
	// 面板与主区的横向空间。（旧版这里渲染一个贴边悬浮的引导图标，但它自己就是「浮层压住
	// 面板按钮」的来源，故一并去掉；配置入口仍在 设置 → 界面布局。）
	if (visibleItems.length === 0) {
		return null;
	}

	// 收起状态：显示贴边悬浮图标，点击展开
	if (collapsed) {
		return (
			<div ref={dockRef} className={`side-dock side-dock-${side} side-dock-collapsed${floatCls}`}>
				<button
					type="button"
					className="side-dock-btn side-dock-toggle-btn"
					data-tip={`${t("sideDockExpand")} (${visibleItems.length})`}
					onClick={() => setCollapsed(false)}
					aria-label={t("sideDockExpand")}
				>
					{side === "left" ? <FiChevronRight /> : <FiChevronLeft />}
				</button>
			</div>
		);
	}

	return (
		<div ref={dockRef} className={`side-dock side-dock-${side}${floatCls}`}>
			<button
				type="button"
				className="side-dock-btn side-dock-collapse-btn"
				data-tip={t("sideDockCollapse")}
				onClick={() => setCollapsed(true)}
				aria-label={t("sideDockCollapse")}
			>
				{side === "left" ? <FiChevronLeft /> : <FiChevronRight />}
			</button>
			<div className="side-dock-items">
				{visibleItems.map((item) => {
					const isActive =
						(item.id === "host:chat" && view === "chat") ||
						(item.id === "host:terminal" && view === "terminal") ||
						(item.id === "host:git" && view === "git") ||
						(item.view && view === item.view);

					return (
						<button
							key={item.id}
							type="button"
							className={`side-dock-btn${isActive ? " active" : ""}`}
							data-tip={item.hint ?? item.label}
							onClick={() => handleItemClick(item)}
							onContextMenu={(e) => handleContextMenu(e, item)}
							aria-label={item.label}
						>
							{renderItemIcon(item)}
							{item.id === "host:tasks" && chat.bgServers.length > 0 && (
								<span className="side-dock-badge">{chat.bgServers.length}</span>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}
