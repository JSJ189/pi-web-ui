import { Fragment, memo, useEffect, useState, type ReactNode } from "react";
import { FiTarget, FiLock, FiUnlock, FiX, FiChevronUp } from "react-icons/fi";
import type { GoalStatus, ModelInfo } from "../types";
import { useT, useI18n } from "../i18n";
import { appSend, useIsDsh } from "../app-globals";
import { Dropdown, DropdownItem } from "./Dropdown";
import type { UiSlotEntry } from "../ui-slots";
import { renderMergedToolbar } from "../slot-toolbar";

/** Messages this component sends. */
export type GoalBarMsg =
	| { type: "set_goal"; goal: string; reviewModel?: string; maxRounds: number; locked: boolean }
	| { type: "clear_goal" }
	| { type: "start_goal_wizard"; text: string; wizardModel?: string; maxRounds?: number; locked?: boolean }
	| {
			type: "set_goal_prefs";
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
	  }
	| { type: "list_models" };

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  the goal bar entirely during streaming. */
interface Props {
	goal: GoalStatus;
	models: ModelInfo[];
	modelsLoading: boolean;
	activeConversationId: string;
	/** `goalbar.actions` 槽位的最终条目（全量，含 hidden；宿主 chrome + 插件按槽位顺序合并渲染）。
	 *  不传 = 未接线，回落默认顺序（与旧硬编码一致）。 */
	uiGoalbarActions?: UiSlotEntry[];
	/** 点击一条目标条动作：交回 App 分发给贡献它的插件（与顶栏 onUiAction 同通道）。 */
	onUiAction?: (item: UiSlotEntry) => void;
}

export const GoalBar = memo(function GoalBar({
	goal,
	models,
	modelsLoading,
	activeConversationId,
	uiGoalbarActions,
	onUiAction,
}: Props) {
	const t = useT();
	const { locale } = useI18n();
	const goalDetail = locale !== "zh" && goal.statusEn ? goal.statusEn : goal.status || "";
	const wizardDetail = locale !== "zh" && goal.wizard?.statusEn ? goal.wizard.statusEn : goal.wizard?.status || "";
	// DSH：无独立审查模型 —— 隐藏 reviewModel 下拉（轮次上限仍然有效）。
	// engine 走全局（web/src/app-globals.ts），不再从 App 一路传下来。
	const isDsh = useIsDsh();
	// Goals belong to the conversation that created them. The server keeps the
	// status around while switching chats so returning to the owner restores the
	// goal, but never show another conversation's goal as active.
	const goalBelongsToActiveConversation = !goal.conversationId || goal.conversationId === activeConversationId;
	const active = goal.goal !== null && goalBelongsToActiveConversation;

	// Draft fields (only meaningful while editing a new goal).
	const [text, setText] = useState("");
	const [reviewModel, setReviewModel] = useState<string>(goal.reviewModel ?? "");
	const [maxRounds, setMaxRounds] = useState(goal.maxRounds);
	const [locked, setLocked] = useState(goal.locked);
	const [modelOpen, setModelOpen] = useState(false);
	const [reqLoading, setReqLoading] = useState(false);
	// Collapsed by default: idle shows only a compact pill so the bar never
	// occupies vertical space until the user actually wants to set a goal.
	const [collapsed, setCollapsed] = useState(true);

	// Keep the editor's preference pickers in sync with the server's remembered
	// prefs (maxRounds 0 = unlimited). When the goal is inactive, adopt whatever
	// the server currently holds — so a reload restores the last-used model /
	// rounds / lock, and clearing a goal reverts to those remembered defaults.
	// `goal` (goaled status) holds the persisted prefs; upstream signals drive
	// this via `goal.goal !== null` transitions and the prefs fields changing.
	useEffect(() => {
		setReviewModel(goal.reviewModel ?? "");
		setMaxRounds(goal.maxRounds || 0);
		setLocked(goal.locked);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [goal.goal, goal.reviewModel, goal.maxRounds, goal.locked]);

	// Lazily fetch the model list when the review-model dropdown opens.
	useEffect(() => {
		if (modelOpen && models.length === 0 && !reqLoading && !modelsLoading) {
			setReqLoading(true);
			appSend({ type: "list_models" });
		}
	}, [modelOpen, models.length, reqLoading, modelsLoading]);
	useEffect(() => {
		if (models.length > 0) setReqLoading(false);
	}, [models.length]);

	const reviewModelName = (): string => {
		if (!reviewModel) return t("goalBarUseMainModel");
		return models.find((m) => m.id === reviewModel)?.name ?? reviewModel;
	};

	const set = () => {
		const trimmed = text.trim();
		if (!trimmed) return;
		appSend({
			type: "set_goal",
			goal: trimmed,
			...(reviewModel ? { reviewModel } : {}),
			maxRounds,
			locked,
		});
		setText("");
		setCollapsed(false);
	};

	/** Start the collaborative wizard: AI asks questions to refine the draft
	 *  into a goal, then auto-sets it. Reuses the reviewer-model picker as the
	 *  optional wizard model. */
	const startWizard = () => {
		const trimmed = text.trim();
		if (!trimmed) return;
		appSend({
			type: "start_goal_wizard",
			text: trimmed,
			...(reviewModel ? { wizardModel: reviewModel } : {}),
			maxRounds,
			locked,
		});
		setText("");
		setCollapsed(false);
	};

	// A wizard running (scoping questions in flight) — show its progress.
	// ---- 槽位合并：宿主 chrome 按 id 分区（编辑行/选项行/活跃行/pill），插件条目跟随同行；
	// 未接线时用默认顺序（与旧硬编码一致），hidden 由上层过滤（App 传全量）。 ----
	const GOAL_DEFAULT_ORDER = [
		"host:goal-pill",
		"host:goal-set",
		"host:goal-wizard",
		"host:goal-lock",
		"host:goal-collapse",
		"host:goal-model",
		"host:goal-rounds",
		"host:goal-clear",
	];
	const allGoalEntries: UiSlotEntry[] =
		uiGoalbarActions === undefined
			? GOAL_DEFAULT_ORDER.map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiGoalbarActions.filter((e) => !e.hidden);
	/** 取某行要画的条目：该行宿主 id + 全部插件条目（插件跟随每行，与旧版 renderSlotToolbar 四处都画一致），按槽位顺序。 */
	const goalZone = (ids: string[]): UiSlotEntry[] => {
		const set = new Set(ids);
		return allGoalEntries.filter((e) => set.has(e.id) || e.source !== "host");
	};
	const goalHostNodes: Record<string, ReactNode> = {
		"host:goal-pill": (
			<button
				type="button"
				className="goalbar-hint"
				title={t("goalBarPlaceholder")}
				onClick={() => setCollapsed(false)}
			>
				<FiTarget /> <span>{t("goalBarTitle")}</span>
			</button>
		),
		"host:goal-set": (
			<button type="button" className="goalbar-btn" disabled={!text.trim()} onClick={set}>
				{t("goalBarSet")}
			</button>
		),
		"host:goal-wizard": (
			<button
				type="button"
				className="goalbar-btn wizard"
				disabled={!text.trim()}
				title={t("goalWizardTip")}
				onClick={startWizard}
			>
				🔍 {t("goalWizardBtn")}
			</button>
		),
		"host:goal-lock": (
			<button
				type="button"
				className="goalbar-icon-btn"
				title={locked ? t("goalBarLocked") : t("goalBarUnlocked")}
				onClick={() =>
					setLocked((v) => {
						appSend({ type: "set_goal_prefs", locked: !v });
						return !v;
					})
				}
			>
				{locked ? <FiLock /> : <FiUnlock />}
			</button>
		),
		"host:goal-collapse": (
			<button type="button" className="goalbar-icon-btn" title={t("goalBarClear")} onClick={() => setCollapsed(true)}>
				<FiChevronUp />
			</button>
		),
		"host:goal-model": isDsh ? (
			<p className="goalbar-dsh-note">{t("dshNoReviewModel")}</p>
		) : (
			<Dropdown
				trigger={
					<span className="goalbar-opt">
						{t("goalBarReviewModel")}: <b>{reviewModelName()}</b>
					</span>
				}
				open={modelOpen}
				onOpenChange={setModelOpen}
				direction="up"
			>
				<div className="dd-header">{t("goalBarReviewModel")}</div>
				{(reqLoading || modelsLoading) && <div className="dd-loading">{t("loading")}</div>}
				{models.length === 0 && !reqLoading && !modelsLoading && <div className="dd-loading">{t("noModels")}</div>}
				<DropdownItem
					active={reviewModel === ""}
					onClick={() => {
						setReviewModel("");
						setModelOpen(false);
						appSend({ type: "set_goal_prefs", reviewModel: "" });
					}}
				>
					{t("goalBarUseMainModel")}
				</DropdownItem>
				{models.map((m) => (
					<DropdownItem
						key={m.id}
						active={reviewModel === m.id}
						onClick={() => {
							setReviewModel(m.id);
							setModelOpen(false);
							appSend({ type: "set_goal_prefs", reviewModel: m.id });
						}}
					>
						<span className="dd-model-cell">
							<span className="dd-model-name">{m.name}</span>
							<span className="dd-model-meta">
								<span className="dd-model-provider">{m.provider}</span>
								<span className="dd-model-id">{m.id.split("/").slice(1).join("/")}</span>
							</span>
						</span>
					</DropdownItem>
				))}
				<button type="button" className="dd-refresh" onClick={() => appSend({ type: "list_models" })}>
					{t("refreshModels")}
				</button>
			</Dropdown>
		),
		"host:goal-rounds": (
			<label className="goalbar-round" title={t("goalBarMaxRoundsTip")}>
				<span>{t("goalBarMaxRounds")}</span>
				<input
					type="number"
					min={0}
					step={1}
					value={maxRounds}
					placeholder={t("goalBarUnlimitedShort")}
					onChange={(e) => {
						const v = parseInt(e.target.value, 10);
						if (Number.isNaN(v) || v < 0) {
							setMaxRounds(0);
							return;
						}
						setMaxRounds(v);
					}}
					onBlur={() => appSend({ type: "set_goal_prefs", maxRounds: maxRounds })}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							appSend({ type: "set_goal_prefs", maxRounds: maxRounds });
							(e.target as HTMLInputElement).blur();
						}
					}}
				/>
			</label>
		),
	};
	const wizardActive = (goal.wizard?.active ?? false) && goalBelongsToActiveConversation;

	if (wizardActive) {
		return (
			<div className={`goalbar goalbar-active ${wizardActive ? "wizard" : ""}`}>
				<div className="goalbar-active-row">
					<span className="goalbar-icon">
						<span className="goalbar-spin">🔍</span>
					</span>
					<span className="goalbar-text" title={goal.wizard?.draft ?? ""}>
						{t("goalWizardRunning")}: {goal.wizard?.draft}
					</span>
					<span className="goalbar-chip reviewing">
						{t("goalBarRound", { n: (goal.wizard?.step ?? 0) + 1 })} / {goal.wizard?.maxSteps ?? 6}
					</span>
					<span className="goalbar-detail">{wizardDetail || t("goalBarReviewing")}</span>
					{renderMergedToolbar(
						goalZone(["host:goal-clear"]),
						{
							...goalHostNodes,
							"host:goal-clear": (
								<button
									type="button"
									className="goalbar-x"
									title={t("goalBarClear")}
									onClick={() => {
										appSend({ type: "clear_goal" });
										setCollapsed(true);
									}}
								>
									<FiX />
								</button>
							),
						},
						onUiAction,
					)}
				</div>
			</div>
		);
	}

	if (active) {
		return (
			<div className={`goalbar goalbar-active ${goal.reviewing ? "reviewing" : ""}`}>
				<div className="goalbar-active-row">
					<span className="goalbar-icon">{goal.reviewing ? <span className="goalbar-spin">◌</span> : "🎯"}</span>
					<span className="goalbar-text" title={goal.goal ?? ""}>
						{goal.goal}
					</span>
					{goal.reviewing ? (
						<span className="goalbar-chip reviewing">
							{t("goalBarReviewing")} {t("goalBarRound", { n: goal.round })}
						</span>
					) : (
						<span
							className={`goalbar-chip ${goal.verdict === "pass" ? "pass" : goal.verdict === "fail" ? "fail" : goal.verdict === "blocked" ? "blocked" : ""}`}
						>
							{goal.verdict === "pass"
								? t("goalBarPassed")
								: goal.verdict === "fail"
									? t("goalBarFailed")
									: goal.verdict === "blocked"
										? t("goalBarBlocked")
										: `${t("goalBarRound", { n: goal.round || 1 })} · ${goal.locked ? t("goalBarLocked") : t("goalBarUnlocked")}`}
						</span>
					)}
					<span className="goalbar-detail">{goalDetail}</span>
					{renderMergedToolbar(
						goalZone(["host:goal-clear"]),
						{
							...goalHostNodes,
							"host:goal-clear": (
								<button
									type="button"
									className="goalbar-x"
									title={t("goalBarClear")}
									disabled={goal.reviewing}
									onClick={() => {
										if (goal.goal) setText(goal.goal);
										appSend({ type: "clear_goal" });
										setCollapsed(false);
									}}
								>
									<FiX />
								</button>
							),
						},
						onUiAction,
					)}
				</div>
			</div>
		);
	}

	// Inactive, collapsed — a single compact pill aligned LEFT (not a centered
	// full-width strip). A discreet 🎯 chip; click to open the editor.
	if (collapsed) {
		// pill 藏掉且无插件条目时整条不占位（布局页「恢复」可找回）。
		const pillBar = renderMergedToolbar(goalZone(["host:goal-pill"]), goalHostNodes, onUiAction);
		if (!pillBar) return null;
		return <div className="goalbar goalbar-collapsed">{pillBar}</div>;
	}

	return (
		<div className="goalbar">
			<div className="goalbar-row">
				<span className="goalbar-icon">
					<FiTarget />
				</span>
				<input
					className="goalbar-input"
					value={text}
					placeholder={t("goalBarPlaceholder")}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") set();
					}}
				/>
				{renderMergedToolbar(
					goalZone(["host:goal-set", "host:goal-wizard", "host:goal-lock", "host:goal-collapse"]),
					goalHostNodes,
					onUiAction,
				)}
			</div>
			<div className="goalbar-opts">
				{goalZone(["host:goal-model", "host:goal-rounds"])
					.filter((e) => e.source === "host")
					.map((e) => (
						<Fragment key={e.id}>{goalHostNodes[e.id]}</Fragment>
					))}

				<span className="goalbar-lock-hint">{locked ? t("goalBarLocked") : t("goalBarUnlocked")}</span>
			</div>
		</div>
	);
});
