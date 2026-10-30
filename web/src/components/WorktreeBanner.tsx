/**
 * web/src/components/WorktreeBanner.tsx
 *
 * 顶部 Git 工作树（Worktree）状态横幅：
 * 1. 状态一：当前工作区正处于某个子工作树（Linked Worktree）内：
 *    - 强视觉提示当前分支与关联主仓库；
 *    - 一键切回主仓库 (main)；
 *    - 一键清理/销毁工作树。
 * 2. 状态二：当前在主仓库，但检测到名下有尚未清理的子工作树（含修改/隔离分支）：
 *    - 提醒用户有未合入或未清理的工作树，防止漏改；
 *    - 支持一键切换过去查看或一键清理。
 */

import React, { useState, useEffect, useRef } from "react";
import type { WorktreeInfo } from "../types";
import { useT } from "../i18n";
import { FiX } from "react-icons/fi";

export interface WorktreeBannerProps {
	worktree: WorktreeInfo;
	onRefresh: () => void;
	onSwitch: (path: string) => void;
	onRemove: (path: string, force?: boolean) => void;
}

export const WorktreeBanner: React.FC<WorktreeBannerProps> = ({ worktree, onRefresh, onSwitch, onRemove }) => {
	const t = useT();
	const [expanded, setExpanded] = useState(false);

	const getFolderName = (p: string) => {
		const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
		return parts[parts.length - 1] || p;
	};

	const linked = worktree.linkedWorktrees || [];
	const linkedSig = JSON.stringify(linked.map((w) => w.path).sort());
	const dismissKey = `pi-worktree-dismiss:${worktree.mainPath}`;
	const [dismissedSig, setDismissedSig] = useState<string | null>(null);
	useEffect(() => {
		try {
			setDismissedSig(localStorage.getItem(dismissKey));
		} catch {
			setDismissedSig(null);
		}
	}, [dismissKey]);
	const refreshRef = useRef(onRefresh);
	refreshRef.current = onRefresh;
	useEffect(() => {
		const refresh = () => {
			if (document.visibilityState === "visible") refreshRef.current();
		};
		refresh();
		const timer = window.setInterval(refresh, 30_000);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [worktree.mainPath]);

	// 状态一：当前工作区就是子工作树
	if (worktree.isLinkedWorktree) {
		const branchName = worktree.branch || getFolderName(worktree.currentPath);
		return (
			<div className="worktree-banner linked" role="region" aria-label={branchName}>
				<div className="worktree-banner-info">
					<span className="worktree-banner-title">
						🌿 {t("worktreeBannerActiveTitle", { branch: branchName })}
						<span className="lp-worktree-badge linked">{t("worktreeBadgeLinked")}</span>
					</span>
					<span className="worktree-banner-desc">
						{t("worktreeBannerActiveDesc", {
							main: worktree.mainPath,
							mainBranch: worktree.mainBranch || "main",
						})}
					</span>
				</div>
				<div className="worktree-banner-actions">
					<button
						type="button"
						className="worktree-banner-btn primary"
						title={t("worktreeActionSwitchMainTip")}
						onClick={() => onSwitch(worktree.mainPath)}
					>
						⬅️ {t("worktreeActionSwitchMain")}
					</button>
					<button
						type="button"
						className="worktree-banner-btn danger"
						title={t("worktreeActionRemoveTip")}
						onClick={() => {
							if (window.confirm(t("worktreeActionRemoveConfirm", { path: branchName }))) {
								onRemove(worktree.currentPath);
							}
						}}
					>
						🗑️ {t("worktreeActionRemove")}
					</button>
				</div>
			</div>
		);
	}

	// 状态二：忽略选择仅随工作树增删失效，文件修改不再触发横幅。
	if (linked.length === 0 || dismissedSig === linkedSig) {
		return null;
	}

	const handleDismiss = () => {
		setDismissedSig(linkedSig);
		try {
			localStorage.setItem(dismissKey, linkedSig);
		} catch {
			// ignore
		}
	};

	const dirtyCount = linked.filter((w) => w.isDirty).length;
	const namesSummary = linked
		.map((w) => {
			const b = w.branch || getFolderName(w.path);
			return w.isDirty ? `${b}*` : b;
		})
		.join(" · ");

	return (
		<div className="worktree-banner notice" role="region" aria-label="Git Worktrees">
			<div className="worktree-banner-info">
				<span className="worktree-banner-title">
					⚠️ {t("worktreeBannerUncleanedTitle", { count: linked.length })}
					{dirtyCount > 0 && (
						<span className="lp-worktree-badge dirty">{t("worktreeBadgeDirtyCount", { count: dirtyCount })}</span>
					)}
				</span>
				<span className="worktree-banner-desc">{t("worktreeBannerUncleanedDesc", { names: namesSummary })}</span>
			</div>
			<div className="worktree-banner-actions">
				{linked.slice(0, 2).map((wt) => {
					const name = wt.branch || getFolderName(wt.path);
					return (
						<React.Fragment key={wt.path}>
							<button
								type="button"
								className="worktree-banner-btn"
								title={t("worktreeActionSwitchToTip", { name })}
								onClick={() => onSwitch(wt.path)}
							>
								➡️ {t("worktreeActionSwitchTo", { name })}
							</button>
							<button
								type="button"
								className="worktree-banner-btn danger"
								title={t("worktreeActionRemoveTip")}
								onClick={() => {
									if (window.confirm(t("worktreeActionRemoveConfirm", { path: name }))) {
										onRemove(wt.path);
									}
								}}
							>
								🗑️
							</button>
						</React.Fragment>
					);
				})}
				{linked.length > 2 && (
					<button type="button" className="worktree-banner-btn" onClick={() => setExpanded(!expanded)}>
						{expanded ? t("worktreeActionCollapse") : t("worktreeActionMore", { count: linked.length - 2 })}
					</button>
				)}
				<button
					type="button"
					className="worktree-banner-close"
					title={t("worktreeActionDismissTip")}
					aria-label={t("worktreeActionDismiss")}
					onClick={handleDismiss}
				>
					<FiX aria-hidden />
				</button>
			</div>
			{expanded && linked.length > 2 && (
				<div className="worktree-banner-expand">
					{linked.slice(2).map((wt) => {
						const name = wt.branch || getFolderName(wt.path);
						return (
							<div key={wt.path} className="worktree-expand-row">
								<span className="worktree-expand-name">
									{name}
									{wt.isDirty && (
										<span className="lp-worktree-badge dirty">
											{t("worktreeBadgeDirtyCount", { count: wt.uncommittedCount || 1 })}
										</span>
									)}
								</span>
								<div className="worktree-expand-actions">
									<button type="button" className="worktree-banner-btn" onClick={() => onSwitch(wt.path)}>
										➡️ {t("worktreeActionSwitchTo", { name })}
									</button>
									<button
										type="button"
										className="worktree-banner-btn danger"
										onClick={() => {
											if (window.confirm(t("worktreeActionRemoveConfirm", { path: name }))) {
												onRemove(wt.path);
											}
										}}
									>
										🗑️
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};
