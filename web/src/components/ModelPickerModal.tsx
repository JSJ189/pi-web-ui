import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FiRefreshCw, FiSearch, FiSettings, FiX } from "react-icons/fi";
import type { ModelInfo, ProviderKeyInfo } from "../types";
import { DropdownItem } from "./Dropdown";
import { useT } from "../i18n";
import { loadModelUsage, sortByUsage } from "../model-usage";
import { appSend } from "../app-globals";

export interface ModelPickerModalProps {
	open?: boolean;
	currentModelId?: string | null;
	models: ModelInfo[];
	modelsLoading?: boolean;
	providerKeys?: Record<string, ProviderKeyInfo[]>;
	defaultModel?: string | null;
	onManageModels?: () => void;
	onSelect: (modelId: string, model?: ModelInfo) => void;
	onClose: () => void;
	title?: string;
}

export const ModelPickerModal = memo(function ModelPickerModal({
	open = true,
	currentModelId,
	models,
	modelsLoading = false,
	providerKeys = {},
	defaultModel,
	onManageModels,
	onSelect,
	onClose,
	title,
}: ModelPickerModalProps) {
	const t = useT();
	const [modelFilter, setModelFilter] = useState("");
	const [providerFilter, setProviderFilter] = useState<{ provider: string; keyName: string | null } | null>(null);
	const [usage, setUsage] = useState<Record<string, number>>({});
	const [showAllModels, setShowAllModels] = useState(false);
	const modelScrollRef = useRef<HTMLDivElement>(null);

	// Lazily fetch the model list if empty
	useEffect(() => {
		if (!open) return;
		setUsage(loadModelUsage());
		if (models.length === 0 && !modelsLoading) {
			appSend({ type: "list_models" });
		}
	}, [open, models.length, modelsLoading]);

	// 键盘 Esc 关闭
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	const enabledCount = useMemo(() => models.filter((m) => m.enabled !== false).length, [models]);
	const hasEnabledScope = enabledCount > 0 && enabledCount < models.length;

	const visibleModels = useMemo(() => {
		if (!hasEnabledScope || showAllModels) return models;
		return models.filter((m) => m.enabled !== false);
	}, [models, hasEnabledScope, showAllModels]);

	const filteredModels = useMemo(() => {
		const q = modelFilter.trim().toLowerCase();
		let base = visibleModels;
		if (providerFilter) {
			base = base.filter((m) => m.provider === providerFilter.provider);
		}
		if (!q) return sortByUsage(base, usage);
		return sortByUsage(
			base.filter(
				(m) =>
					m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q),
			),
			usage,
		);
	}, [visibleModels, modelFilter, providerFilter, usage]);

	const providerEntries = useMemo(() => {
		const counts = new Map<string, number>();
		for (const m of visibleModels) {
			counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
		}
		const out: Array<{ provider: string; count: number; keyName: string | null }> = [];
		for (const [provider, count] of counts) {
			const keys = providerKeys[provider];
			if (keys && keys.length > 1) {
				for (const k of keys) {
					out.push({ provider, count, keyName: k.name });
				}
			} else {
				out.push({ provider, count, keyName: null });
			}
		}
		return out;
	}, [visibleModels, providerKeys]);

	const displayRows = useMemo(() => {
		const rows: Array<{ model: ModelInfo; key?: ProviderKeyInfo }> = [];
		for (const m of filteredModels) {
			const keys = providerKeys[m.provider];
			if (!keys || keys.length <= 1) {
				rows.push({ model: m });
				continue;
			}
			let key = keys.find((k) => k.active) ?? keys[0];
			if (providerFilter?.provider === m.provider && providerFilter.keyName) {
				const sel = keys.find((k) => k.name === providerFilter.keyName);
				if (sel) key = sel;
			}
			rows.push({ model: m, key });
		}
		return rows;
	}, [filteredModels, providerKeys, providerFilter]);

	if (!open) return null;

	return (
		<div
			className="modal-backdrop"
			style={{ zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center" }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="modal dd-menu-model"
				style={{
					position: "relative",
					top: "auto",
					bottom: "auto",
					left: "auto",
					right: "auto",
					transform: "none",
					width: "min(92vw, 680px)",
					maxWidth: "680px",
					height: "min(84vh, 640px)",
					maxHeight: "86vh",
					padding: 0,
					gap: 0,
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
					boxShadow: "0 24px 64px rgba(0, 0, 0, 0.55)",
					background: "var(--bg-elev2, #1b1b24)",
					borderRadius: "12px",
					border: "1px solid var(--border)",
				}}
			>
				{/* 顶部标题栏 */}
				<div
					className="dd-header dd-header-flex"
					style={{ padding: "10px 14px", borderBottom: "1px solid var(--border, #333)" }}
				>
					<span className="dd-header-title" style={{ fontWeight: 600 }}>
						{title || t("availableModels")}
					</span>
					<div className="dd-header-actions" style={{ marginLeft: "auto" }}>
						{Boolean(defaultModel) && (
							<div className="dd-header-default" title={`默认模型: ${defaultModel}`}>
								<span className="dd-header-default-star">★</span>
								<span className="dd-header-default-name">
									{defaultModel!.includes("/") ? defaultModel!.split("/").slice(1).join("/") : defaultModel}
								</span>
								<button
									type="button"
									className="dd-header-default-clear"
									title="清除全局默认模型"
									onClick={(e) => {
										e.stopPropagation();
										appSend({ type: "clear_default_model" });
									}}
								>
									✕
								</button>
							</div>
						)}
						{hasEnabledScope && (
							<button
								type="button"
								className={`dd-scope-toggle ${showAllModels ? "active" : ""}`}
								onClick={() => setShowAllModels((v) => !v)}
								title={
									showAllModels
										? t("showEnabledModelsTitle", { n: enabledCount })
										: t("showAllModelsTitle", { n: models.length })
								}
							>
								{showAllModels ? t("showEnabledModels", { n: enabledCount }) : t("showAllModels", { n: models.length })}
							</button>
						)}
						<button
							type="button"
							className="dd-header-btn dd-refresh-btn"
							onClick={() => appSend({ type: "list_models" })}
							title={t("refreshModels")}
							aria-label={t("refreshModels")}
						>
							<FiRefreshCw className={modelsLoading ? "spin" : ""} />
						</button>
						{onManageModels && (
							<button
								type="button"
								className="dd-header-btn dd-manage-btn"
								onClick={onManageModels}
								title={t("manageModels")}
								aria-label={t("manageModels")}
							>
								<FiSettings />
							</button>
						)}
						<button
							type="button"
							className="ghost dd-header-btn"
							style={{ border: 0, cursor: "pointer", fontSize: 16 }}
							onClick={onClose}
							title="关闭"
						>
							<FiX />
						</button>
					</div>
				</div>

				{/* 搜索框 */}
				<div className="dd-search-row">
					<FiSearch />
					<input
						className="dd-search"
						type="text"
						autoFocus
						placeholder={t("searchModels")}
						value={modelFilter}
						onChange={(e) => setModelFilter(e.target.value)}
					/>
				</div>

				{/* 模型主体（左侧服务商，右侧模型列表） */}
				<div className="dd-model-body" style={{ flex: 1, minHeight: 0 }}>
					{providerEntries.length > 1 && (
						<div className="dd-provider-col">
							<div className="dd-provider-head">{t("providers")}</div>
							<button
								type="button"
								className={`dd-provider-item ${providerFilter === null ? "active" : ""}`}
								onClick={() => setProviderFilter(null)}
							>
								<span>{t("allProviders")}</span>
							</button>
							{providerEntries.map((entry) => {
								const active = providerFilter?.provider === entry.provider && providerFilter?.keyName === entry.keyName;
								return (
									<button
										type="button"
										key={entry.keyName ? `${entry.provider}::${entry.keyName}` : entry.provider}
										className={`dd-provider-item ${active ? "active" : ""}`}
										onClick={() =>
											setProviderFilter(active ? null : { provider: entry.provider, keyName: entry.keyName })
										}
										title={
											entry.keyName ? `${entry.provider} · ${entry.keyName}` : `${entry.provider} · ${entry.count}`
										}
									>
										<span className="dd-provider-txt">
											<span className="dd-provider-name">{entry.provider}</span>
											{entry.keyName && <span className="dd-provider-key">{entry.keyName}</span>}
										</span>
										<span className="dd-provider-count">{entry.count}</span>
									</button>
								);
							})}
						</div>
					)}
					<div className="dd-model-scroll" ref={modelScrollRef}>
						{modelsLoading && <div className="dd-loading">{t("loading")}</div>}
						{models.length === 0 && !modelsLoading && <div className="dd-loading">{t("noModels")}</div>}
						{filteredModels.length === 0 && visibleModels.length > 0 && (
							<div className="dd-loading">
								<div>{t("noModelMatches")}</div>
								{hasEnabledScope && !showAllModels && (
									<button type="button" className="dd-scope-switch-link" onClick={() => setShowAllModels(true)}>
										{t("searchAllModelsHint", { n: models.length })}
									</button>
								)}
							</div>
						)}
						{displayRows.map((row) => {
							const m = row.model;
							const isActive =
								currentModelId === m.id ||
								`${m.provider}/${m.id}` === currentModelId ||
								(currentModelId?.includes("/") && currentModelId.split("/")[1] === m.id);
							const isDefault = defaultModel !== undefined && defaultModel === m.id;
							return (
								<DropdownItem
									key={row.key ? `${m.id}::${row.key.name}` : m.id}
									active={Boolean(isActive)}
									onClick={() => {
										onSelect(m.id, m);
										onClose();
									}}
								>
									<span className="dd-model-cell">
										<span className="dd-model-name">{m.name}</span>
										<span className="dd-model-meta">
											<span className="dd-model-provider">{m.provider}</span>
											<span className="dd-model-id">
												{m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id}
											</span>
											{row.key && (
												<span className={`dd-model-key ${row.key.active ? "active" : ""}`}>
													{row.key.active ? "●" : "○"} {row.key.name}
												</span>
											)}
											{(usage[m.id] ?? 0) > 0 && (
												<span className="dd-model-usage">{t("modelUsedCount", { n: usage[m.id] })}</span>
											)}
											{(m.reasoning || m.vision || (showAllModels && m.enabled === false)) && (
												<span className="dd-model-badges">
													{m.reasoning && <span className="dd-model-badge">{t("reasoning")}</span>}
													{m.vision && <span className="dd-model-badge">{t("vision")}</span>}
													{showAllModels && m.enabled === false && (
														<span className="dd-model-badge out-of-scope">{t("notInScopeBadge")}</span>
													)}
												</span>
											)}
										</span>
									</span>
									{defaultModel !== undefined && (
										<span className={`dd-star-btn ${isDefault ? "active" : ""}`}>{isDefault ? "★" : "☆"}</span>
									)}
								</DropdownItem>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
});
