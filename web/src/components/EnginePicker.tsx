import { useState, useRef, useEffect } from "react";
import { FiAperture, FiCheck } from "react-icons/fi";
import { appSend, useAppGlobals } from "../app-globals";
import { useI18n } from "../i18n";
import { Dropdown } from "./Dropdown";

/**
 * 智能体引擎元数据规格：支持未来无缝扩展 N 个引擎（如 Claude Code、自定义引擎等）。
 */
export interface EngineMeta {
	id: string;
	/** 显示名称多语言键 */
	titleKey: "settingsEnginePiTitle" | "settingsEngineDshTitle" | "settingsEngineClaudeTitle";
	/** 简短徽标标签 */
	badge: string;
	/** 特色定位标签（如「完整生态」「极速补丁」「通用驱动」） */
	tagKey: "engineTagFull" | "engineTagFast" | "engineTagUniversal";
	/** 描述说明翻译键 */
	descKey: "settingsEnginePiDesc" | "settingsEngineDshDesc" | "settingsEngineClaudeDesc";
	/** 样式色彩类 */
	colorClass: string;
}

/**
 * 支持的智能体引擎列表（单源可扩展名录）。
 * 后续引入新引擎只需在此追加一条定义。
 */
export const SUPPORTED_ENGINES: EngineMeta[] = [
	{
		id: "pi",
		titleKey: "settingsEnginePiTitle",
		badge: "PI",
		tagKey: "engineTagFull",
		descKey: "settingsEnginePiDesc",
		colorClass: "engine-pi",
	},
	{
		id: "dsh",
		titleKey: "settingsEngineDshTitle",
		badge: "DSH",
		tagKey: "engineTagFast",
		descKey: "settingsEngineDshDesc",
		colorClass: "engine-dsh",
	},
	{
		id: "claude",
		titleKey: "settingsEngineClaudeTitle",
		badge: "CLAUDE",
		tagKey: "engineTagUniversal",
		descKey: "settingsEngineClaudeDesc",
		colorClass: "engine-claude",
	},
];

interface EnginePickerProps {
	/** 下拉展开方向："down"（顶栏用）或 "up"（底栏用） */
	direction?: "down" | "up";
	/** 对齐方向 */
	align?: "left" | "right";
	/** 附加样式类 */
	className?: string;
	/** 显示的自定义文案（优先于默认引擎名） */
	label?: string;
	/** 是否渲染尾部 caret 箭头（默认 false） */
	caret?: boolean;
	/** 当前所在栏 */
	bar?: "top" | "bottom" | "left" | "right";
}

export function EnginePicker({ direction, align, className, label, caret = false, bar }: EnginePickerProps) {
	const { engine } = useAppGlobals();
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const [autoDirection, setAutoDirection] = useState<"down" | "up">(direction ?? (bar === "bottom" ? "up" : "down"));
	const [autoAlign, setAutoAlign] = useState<"left" | "right">(align ?? "left");
	const [fixedStyle, setFixedStyle] = useState<React.CSSProperties | undefined>(undefined);

	// 动态检测位置：若位于底栏或距离视口底部空间不足 320px，以 fixed 浮层朝上弹出，彻底避免父容器 overflow 裁切
	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen && wrapRef.current) {
			const rect = wrapRef.current.getBoundingClientRect();
			const spaceBelow = window.innerHeight - rect.bottom;
			if (bar === "bottom" || spaceBelow < 320) {
				setAutoDirection("up");
				setFixedStyle({
					position: "fixed",
					left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)),
					bottom: Math.max(8, window.innerHeight - rect.top + 6),
					top: "auto",
					right: "auto",
					zIndex: 9999,
				});
			} else {
				setAutoDirection(direction ?? "down");
				setFixedStyle(undefined);
			}
			if (window.innerWidth - rect.left < 340) {
				setAutoAlign("right");
			} else {
				setAutoAlign(align ?? "left");
			}
		} else {
			setFixedStyle(undefined);
		}
		setOpen(nextOpen);
	};

	const activeEngine = SUPPORTED_ENGINES.find((e) => e.id === engine) ?? {
		id: engine,
		titleKey: "settingsEnginePiTitle" as const,
		badge: engine.toUpperCase(),
		tagKey: "engineTagFull" as const,
		descKey: "settingsEnginePiDesc" as const,
		colorClass: `engine-${engine}`,
	};
	const activeName = t(activeEngine.titleKey);

	const trigger = (
		<>
			<FiAperture className="bar-item-icon engine-picker-icon" />
			{label ? (
				<>
					<span className="chip-sub bar-item-text engine-picker-name">{label}</span>
					<span className={`engine-badge bar-item-text ${activeEngine.colorClass}`}>{activeEngine.badge}</span>
				</>
			) : (
				<span className={`engine-badge bar-item-text ${activeEngine.colorClass}`}>{activeEngine.badge}</span>
			)}
		</>
	);

	return (
		<div
			ref={wrapRef}
			className={`engine-picker-wrap ${activeEngine.colorClass} ${className ?? ""}`}
			data-bar-item="host:engine"
		>
			<Dropdown
				trigger={trigger}
				open={open}
				onOpenChange={handleOpenChange}
				direction={autoDirection}
				align={autoAlign}
				fit
				caret={caret}
				menuStyle={fixedStyle}
				triggerClassName={`bar-item chip engine-picker-btn ${activeEngine.colorClass}`}
				menuClassName="engine-picker-menu"
				tip={`${t("engineBadge")}: ${label ?? activeName} — ${t("engineSwitchTip")}`}
			>
				<div className="engine-picker-header">
					<div className="engine-picker-title">
						<FiAperture />
						<span>{t("settingsEngineSection")}</span>
					</div>
					<div className="engine-picker-subtitle">{t("enginePickerDesc")}</div>
				</div>

				<div className="engine-picker-list" role="menu">
					{SUPPORTED_ENGINES.map((item) => {
						const isSelected = item.id === engine;
						return (
							<button
								key={item.id}
								type="button"
								role="menuitem"
								className={`engine-picker-item ${item.colorClass}${isSelected ? " active" : ""}`}
								onClick={() => {
									setOpen(false);
									if (!isSelected) {
										appSend({ type: "switch_engine", engine: item.id as "pi" | "dsh" | "claude" });
									}
								}}
							>
								<div className="engine-picker-item-head">
									<FiAperture className="engine-picker-item-icon" />
									<span className={`engine-badge ${item.colorClass}`}>{item.badge}</span>
									{t(item.titleKey) !== item.badge && (
										<span className="engine-picker-item-name">{t(item.titleKey)}</span>
									)}
									<span className="engine-picker-item-tag">{t(item.tagKey)}</span>
									{isSelected && <FiCheck className="engine-picker-check" />}
								</div>
								<div className="engine-picker-item-desc">{t(item.descKey)}</div>
							</button>
						);
					})}
				</div>
			</Dropdown>
		</div>
	);
}
