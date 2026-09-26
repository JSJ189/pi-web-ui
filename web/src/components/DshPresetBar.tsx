import { memo, useEffect, useState } from "react";
import { FiLock, FiPlus, FiSliders } from "react-icons/fi";
import type { UiAgentPreset } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { focusComposer } from "../composer-bridge";
import { Dropdown, DropdownItem } from "./Dropdown";

/** 当前会话预设（快照 UiState.agentPreset；null = 快照未到）。 */
export interface DshPresetInfo {
	id: string;
	name: string;
	locked: boolean;
}

interface Props {
	preset: DshPresetInfo | null;
	presets: UiAgentPreset[];
	defaultPreset: string;
	/** 空白会话（无消息）→ 允许切换；否则锁定展示。 */
	blank: boolean;
	/** 会话切换时重置下拉框选中值。 */
	conversationId: string;
	/** 紧凑模式：只渲染一个下拉按钮（输入框工具条内，思考强度右侧）。 */
	compact?: boolean;
}

/** 已知内置预设的展示顺序（名录 order 优先，此表兜底；自建按名称排最后）。 */
const KNOWN_ORDER = ["standard", "ptc", "minimal", "cordis"];

export function sortAgentPresets(list: UiAgentPreset[]): UiAgentPreset[] {
	return [...list].sort((a, b) => {
		const ao = Number.isSafeInteger(a.order) ? a.order! : KNOWN_ORDER.indexOf(a.id);
		const bo = Number.isSafeInteger(b.order) ? b.order! : KNOWN_ORDER.indexOf(b.id);
		const ai = ao >= 0 ? ao : 1000;
		const bi = bo >= 0 ? bo : 1000;
		if (ai !== bi) return ai - bi;
		return a.id.localeCompare(b.id);
	});
}

export const DshPresetBar = memo(function DshPresetBar({
	preset,
	presets,
	defaultPreset,
	blank,
	conversationId,
	compact = false,
}: Props) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState(preset?.id ?? defaultPreset);
	// 会话/预设变化时同步下拉框（用户操作中不打断：只在 id 变化时跟）。
	useEffect(() => {
		setSelected(preset?.id ?? defaultPreset);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conversationId, preset?.id, defaultPreset]);

	if (presets.length === 0) return null;
	const locked = preset?.locked || !blank;
	const ordered = sortAgentPresets(presets);
	const current = ordered.find((p) => p.id === preset?.id);
	const sel = ordered.find((p) => p.id === selected) ?? current;

	const pick = (id: string) => {
		setSelected(id);
		setOpen(false);
		if (blank && id !== preset?.id) appSend({ type: "dsh_preset_select", preset: id });
	};

	if (compact) {
		const title = current?.description ?? current?.id ?? t("dshPreset");
		return (
			<Dropdown
				trigger={
					<>
						<FiSliders />
						<span className="chip-sub" title={locked ? `${title}（${t("dshPresetLocked")}）` : title}>
							{current?.name ?? current?.id ?? preset?.name ?? t("dshPreset")}
							{locked && <FiLock style={{ marginLeft: 3 }} />}
						</span>
					</>
				}
				open={open && !locked}
				onOpenChange={setOpen}
				direction="up"
				align="left"
			>
				{ordered.map((p) => (
					<DropdownItem
						key={p.id}
						active={p.id === preset?.id}
						disabled={!!p.broken}
						title={p.broken ?? p.description ?? p.id}
						onClick={() => pick(p.id)}
					>
						<span className="dd-preset-name">
							{p.name ?? p.id}
							{p.trust === "user" && <span className="dd-preset-tag">{t("dshPresetUser")}</span>}
							{p.id === defaultPreset && <span className="dd-preset-tag">{t("dshPresetDefaultTag")}</span>}
							{p.broken && <span className="dd-preset-tag warn">{t("dshPresetBroken")}</span>}
						</span>
						{p.description && !p.broken && <span className="dd-preset-desc">{p.description}</span>}
					</DropdownItem>
				))}
			</Dropdown>
		);
	}

	return (
		<div className="dsh-presetbar" data-testid="dsh-presetbar">
			<span className="dsh-preset-label">
				<FiSliders />
				{t("dshPreset")}
			</span>
			<Dropdown
				trigger={
					<span title={current?.description ?? current?.id ?? ""}>
						{current?.name ?? current?.id ?? preset?.name ?? "…"}
						{locked && (
							<span className="dsh-preset-lock" title={t("dshPresetBlankOnly")}>
								<FiLock /> {t("dshPresetLocked")}
							</span>
						)}
					</span>
				}
				open={open && !locked}
				onOpenChange={setOpen}
			>
				{ordered.map((p) => (
					<DropdownItem
						key={p.id}
						active={p.id === preset?.id}
						disabled={!!p.broken}
						title={p.broken ?? p.description ?? p.id}
						onClick={() => pick(p.id)}
					>
						<span className="dd-preset-name">
							{p.name ?? p.id}
							{p.trust === "user" && <span className="dd-preset-tag">{t("dshPresetUser")}</span>}
							{p.id === defaultPreset && <span className="dd-preset-tag">{t("dshPresetDefaultTag")}</span>}
							{p.broken && <span className="dd-preset-tag warn">{t("dshPresetBroken")}</span>}
						</span>
						{p.description && !p.broken && <span className="dd-preset-desc">{p.description}</span>}
					</DropdownItem>
				))}
			</Dropdown>
			{!locked && (
				<span className="dsh-preset-hint" title={t("dshPresetBlankOnly")}>
					{t("dshPresetBlankOnly")}
				</span>
			)}
			{sel?.id === "minimal" && <span className="dsh-preset-hint warn">{t("dshPresetMinimalNote")}</span>}
			<button
				type="button"
				className="chip"
				title={t("dshPresetNewChat")}
				onClick={() => {
					appSend({ type: "new_chat", preset: sel?.id ?? selected });
					focusComposer();
				}}
			>
				<FiPlus /> {t("dshPresetNewChat")}
			</button>
		</div>
	);
});
