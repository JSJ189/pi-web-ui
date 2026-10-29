import { useEffect, useMemo, useRef, useState } from "react";
import {
	FiDownload,
	FiExternalLink,
	FiFilePlus,
	FiGlobe,
	FiRefreshCw,
	FiShare2,
	FiUploadCloud,
	FiX,
} from "react-icons/fi";
import type { UiPresetCatalogEntry, UiPresetPluginDependency, UiSettingsPreset } from "../types";
import {
	clearsPresetField,
	pendingPresetPluginJob,
	presetPluginDependency,
	presetPluginStatus,
} from "../preset-plugins";
import { isZhLocale, useI18n, useT } from "../i18n";
import { appSend } from "../app-globals";
import { saveDownloadBlob } from "../download";
import { randomUuid } from "../uuid";
import { useCopyFeedback } from "../use-copy-feedback";
import {
	groupPresetFields,
	presetFieldLabel,
	presetFieldHint,
	formatPresetFieldValue,
	type PresetFieldGroup,
} from "../../../server/preset-fields.js";
import { Modal } from "./Modal";
import type {
	ChatState,
	PresetCatalogState,
	PresetExportState,
	PresetImportState,
	PresetShareState,
} from "../use-chat";

interface PresetShareModalProps {
	/** 本地预设名（设置状态里的预设列表视图）。 */
	presets: UiSettingsPreset[];
	plugins: ChatState["plugins"];
	pluginCatalog: ChatState["pluginCatalog"];
	pluginJobs: ChatState["pluginJobs"];
	disabledPlugins: string[];
	presetExport: PresetExportState | null;
	presetImport: (PresetImportState & { applyError?: string }) | null;
	presetCatalog: PresetCatalogState | null;
	presetShare: PresetShareState | null;
	/** 打开时预选的预设名（"" = 当前设置）。 */
	initialPreset?: string;
	/** 打开时先落在哪个页签（默认导出/分享）。 */
	initialTab?: PresetShareTab;
	onClose: () => void;
}

export type PresetShareTab = "export" | "import" | "browse";
type Tab = PresetShareTab;
/** 导入来源（编进 requestId 前缀，服务端回执时前端据此提示“粘贴/文件/网址”）。 */
type ImportSource = "paste" | "file" | "url";

/** 导入请求的 requestId 前缀（use-chat 按前缀还原来源，见那里的 preset_import_result）。 */
function reqId(source: ImportSource): string {
	return `${source === "paste" ? "paste" : source}:${randomUuid()}`;
}

/** 目录条目的时间戳 → 本地短日期（空/坏值返回 ""）。 */
function shortDate(iso: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString();
}

/** 分组 → i18n key（字面量分支，is18n 死 key 守卫才认得出）。 */
function presetGroupLabelKey(g: PresetFieldGroup): string {
	switch (g) {
		case "prompt":
			return "presetGroupPrompt";
		case "tools":
			return "presetGroupTools";
		case "terminal":
			return "presetGroupTerminal";
		case "skills":
			return "presetGroupSkills";
		case "ai":
			return "presetGroupAi";
		case "ui":
			return "presetGroupUi";
		case "engine":
			return "presetGroupEngine";
	}
	return "presetGroupOther";
}

/**
 * 预设分享面板（设置 → 预设 → 分享/导入/浏览分享）。
 *
 * 三个页签对应三条真实路径：
 *   导出/分享 — 导成 JSON（复制/下载），或一键发到社区共享仓库（服务端 gh issue）；
 *   导入      — 粘贴 / 选文件 / 网址，先预览（dryRun）再确认导入，可选导入后立即应用；
 *   浏览      — 拉社区仓库 index.json，搜索 + 一键导入（走网址导入预览）。
 *
 * 全部动作都经服务端（server/preset-share.ts）：下发的是裁剪视图，完整字段只在服务端，
 * 且抓取必须绕开浏览器 CORS。回执通过 use-chat 的 reducer 落到 chat.preset*。
 */
export function PresetShareModal({
	presets,
	plugins,
	pluginCatalog,
	pluginJobs,
	disabledPlugins,
	presetExport: exportReceipt,
	presetImport: importReceipt,
	presetCatalog: catalogReceipt,
	presetShare: shareReceipt,
	initialPreset = "",
	initialTab = "export",
	onClose,
}: PresetShareModalProps) {
	const t = useT();
	const { locale } = useI18n();
	const [tab, setTab] = useState<Tab>(initialTab);

	// ---- 导出/分享页签 -----------------------------------------------------
	const [shareName, setShareName] = useState(initialPreset);
	const [description, setDescription] = useState("");
	const [tags, setTags] = useState("");
	const [author, setAuthor] = useState("");
	const copyFeedback = useCopyFeedback({ duration: 1500 });
	const [sharing, setSharing] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importName, setImportName] = useState("");
	const [selectedPlugins, setSelectedPlugins] = useState<UiPresetPluginDependency[]>(
		() => presets.find((p) => p.name === initialPreset)?.plugins ?? [],
	);
	const [installJobs, setInstallJobs] = useState<Record<string, string>>({});
	const installLocks = useRef(new Set<string>());
	const requestLocks = useRef(new Set<string>());
	const [requests, setRequests] = useState({ export: "", share: "", import: "", catalog: "" });
	const request = (kind: keyof typeof requests, id: string) => {
		setRequests((prev) => ({ ...prev, [kind]: id }));
		return id;
	};
	const presetExport = exportReceipt?.requestId === requests.export ? exportReceipt : null;
	const presetShare = shareReceipt?.requestId === requests.share ? shareReceipt : null;
	const presetImport = importReceipt?.requestId === requests.import ? importReceipt : null;
	const presetCatalog = catalogReceipt?.requestId === requests.catalog ? catalogReceipt : null;

	// ---- 导入页签 ----------------------------------------------------------
	const [text, setText] = useState("");
	const [url, setUrl] = useState("");
	/** 最后一次预览请求的来源载荷（确认导入时原样重发）。 */
	const [pending, setPending] = useState<{ source: ImportSource; json?: string; url?: string } | null>(null);
	const [applyAfter, setApplyAfter] = useState(false);
	/** 可选导入：勾选的字段名；null = 跟随预览全选（新预览到达时重置）。 */
	const [picked, setPicked] = useState<Set<string> | null>(null);
	/** 字段详情展开状态。 */
	const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
	const fileRef = useRef<HTMLInputElement | null>(null);
	const importGeneration = useRef(0);
	useEffect(
		() => () => {
			importGeneration.current++;
		},
		[],
	);

	// ---- 浏览页签 ----------------------------------------------------------
	const [query, setQuery] = useState("");
	const [browsing, setBrowsing] = useState(false);

	// 打开时先把目录拉一遍（列表是这一页的主内容，早拉早显示）。
	useEffect(() => {
		appSend({ type: "preset_catalog", requestId: request("catalog", `catalog:${randomUuid()}`) });
	}, []);

	// 目录回执到达 = 不再加载中。
	const lastCatalog = useRef<PresetCatalogState | null>(null);
	useEffect(() => {
		if (!presetCatalog || presetCatalog === lastCatalog.current) return;
		lastCatalog.current = presetCatalog;
		setBrowsing(false);
	}, [presetCatalog]);

	// A receipt updates status only; opening links and copying require an explicit click.
	const lastShare = useRef<PresetShareState | null>(null);
	useEffect(() => {
		if (!presetShare || presetShare === lastShare.current) return;
		lastShare.current = presetShare;
		setSharing(false);
		requestLocks.current.delete("share");
	}, [presetShare]);

	// 导入回执：非 dryRun 成功 = 这一单已经落盘（清掉预览，避免重复点）。
	const lastImport = useRef<PresetImportState | null>(null);
	useEffect(() => {
		if (!presetImport || presetImport === lastImport.current) return;
		lastImport.current = presetImport;
		// 新预览到达（dryRun）时把「可选导入」重置成全选，避免上一次的勾选残留误事。
		setImporting(false);
		requestLocks.current.delete("import");
		if (presetImport.dryRun && presetImport.preview) {
			setPicked(new Set(presetImport.preview.fields));
			setImportName(presetImport.preview.name);
		}
		if (presetImport.ok && !presetImport.dryRun) {
			setText("");
			setUrl("");
			setPending(null);
			setPicked(null);
		}
	}, [presetImport]);

	useEffect(() => {
		if (presetExport) {
			setExporting(false);
			requestLocks.current.delete("export");
		}
	}, [presetExport]);

	const shareArgs = useMemo(() => {
		const list = tags
			.split(/[,，]/)
			.map((s) => s.trim())
			.filter(Boolean);
		return {
			source: shareName ? ("preset" as const) : ("current" as const),
			name: shareName,
			plugins: selectedPlugins
				.map((p) => presetPluginDependency(p, pluginCatalog))
				.filter((p): p is UiPresetPluginDependency => !!p),
			...(description.trim() ? { description: description.trim() } : {}),
			...(author.trim() ? { author: author.trim() } : {}),
			...(list.length > 0 ? { tags: list } : {}),
		};
	}, [shareName, description, tags, author, selectedPlugins, pluginCatalog]);

	const doExport = () => {
		if (requestLocks.current.has("export")) return;
		requestLocks.current.add("export");
		setExporting(true);
		appSend({ type: "preset_export", ...shareArgs, requestId: request("export", `export:${randomUuid()}`) });
	};
	const doShare = () => {
		if (requestLocks.current.has("share")) return;
		requestLocks.current.add("share");
		setSharing(true);
		appSend({ type: "preset_share", ...shareArgs, requestId: request("share", `share:${randomUuid()}`) });
	};

	const downloadExport = () => {
		if (!presetExport?.json) return;
		void saveDownloadBlob(
			new Blob([presetExport.json], { type: "application/json" }),
			presetExport.fileName || `${presetExport.name || "preset"}.json`,
		);
	};
	const copyExport = () => {
		if (!presetExport?.json) return;
		void copyFeedback.copy(presetExport.json);
	};

	/** 发一次 dryRun 预览（粘贴/文件 → preset_import；网址 → preset_import_url）。 */
	const previewText = (json: string, src: ImportSource) => {
		if (!json.trim() || requestLocks.current.has("import")) return;
		requestLocks.current.add("import");
		setImporting(true);
		setPending({ source: src, json });
		appSend({ type: "preset_import", json, dryRun: true, requestId: request("import", reqId(src)) });
	};
	const previewUrl = (target: string, src: ImportSource = "url") => {
		if (!target.trim() || requestLocks.current.has("import")) return;
		requestLocks.current.add("import");
		setImporting(true);
		setPending({ source: src, url: target });
		appSend({ type: "preset_import_url", url: target, dryRun: true, requestId: request("import", reqId(src)) });
	};

	/** 确认导入：把预览用的载荷原样重发（dryRun:false），可选导入后立即应用；
	 *  同时带上**勾选的字段**（可选导入 —— 只写用户要的那部分）。 */
	const confirmImport = () => {
		if (!pending || chosen.size === 0 || !importName.trim() || requestLocks.current.has("import")) return;
		requestLocks.current.add("import");
		setImporting(true);
		const base = {
			dryRun: false,
			name: importName.trim(),
			apply: applyAfter,
			fields: [...chosen],
			requestId: request("import", reqId(pending.source)),
		};
		if (pending.url) appSend({ type: "preset_import_url", url: pending.url, ...base });
		else if (pending.json) appSend({ type: "preset_import", json: pending.json, ...base });
	};

	const pickFile = (file: File | undefined) => {
		if (!file || importing) return;
		const reader = new FileReader();
		const generation = ++importGeneration.current;
		reader.onload = () => {
			if (generation === importGeneration.current) previewText(String(reader.result ?? ""), "file");
		};
		reader.readAsText(file);
	};

	const refreshCatalog = () => {
		setBrowsing(true);
		appSend({ type: "preset_catalog", refresh: true, requestId: request("catalog", `catalog:${randomUuid()}`) });
	};

	const entries = presetCatalog?.entries ?? [];
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter((e) =>
			[e.name, e.description, e.author, e.tags.join(" ")].some((s) => s.toLowerCase().includes(q)),
		);
	}, [entries, query]);

	const installPlugin = (dependency: UiPresetPluginDependency) => {
		if (
			!dependency.source ||
			plugins.some((p) => p.id === dependency.id) ||
			pendingPresetPluginJob(dependency.id, pluginJobs) ||
			installLocks.current.has(dependency.id)
		)
			return;
		if (
			!window.confirm(t("presetPluginsConfirm", { name: dependency.name || dependency.id, source: dependency.source }))
		)
			return;
		installLocks.current.add(dependency.id);
		const jobId = randomUuid();
		setInstallJobs((prev) => ({ ...prev, [dependency.id]: jobId }));
		appSend({ type: "plugin_job", action: "install", jobId, id: dependency.id, source: dependency.source });
	};
	useEffect(() => {
		for (const [id, jobId] of Object.entries(installJobs)) {
			if (pluginJobs[jobId]?.phase === "done") installLocks.current.delete(id);
		}
	}, [installJobs, pluginJobs]);
	const invalidateImport = () => {
		importGeneration.current++;
		setRequests((prev) => ({ ...prev, import: "" }));
		setPending(null);
		setPicked(null);
	};
	const preview = presetImport?.dryRun ? presetImport.preview : undefined;
	const dependencyPreview = preview ?? (presetImport?.ok ? presetImport.preview : undefined);
	const importDone = presetImport?.ok && !presetImport.dryRun ? presetImport.preview : undefined;
	// 按界面语言判断（中文系含 zh-TW；旧做法比对 t("ok") 的简中译文，繁中会被误判为英文）
	const isZh = isZhLocale(locale);
	const lang = isZh ? ("zh" as const) : ("en" as const);
	// 可选导入：按分组拆分预览里的字段，默认全选（picked === null 时视作全选）。
	const previewFields = preview?.fields ?? [];
	const chosen = picked ?? new Set(previewFields);
	const previewGroups = groupPresetFields(previewFields);
	const allChosen = previewFields.length > 0 && previewFields.every((f) => chosen.has(f));
	const togglePresetField = (field: string) =>
		setPicked(() => {
			const next = new Set(chosen);
			if (next.has(field)) next.delete(field);
			else next.add(field);
			return next;
		});
	const toggleFieldExpand = (field: string) =>
		setExpandedFields((prev) => {
			const next = new Set(prev);
			if (next.has(field)) next.delete(field);
			else next.add(field);
			return next;
		});
	const setPresetGroup = (fields: readonly string[], on: boolean) =>
		setPicked(() => {
			const next = new Set(chosen);
			for (const f of fields) {
				if (on) next.add(f);
				else next.delete(f);
			}
			return next;
		});

	return (
		<Modal className="preset-share-modal" onClose={onClose} showCloseButton={false}>
			<div className="preset-share-head">
				<span className="preset-share-title">
					<FiShare2 /> {t("presetShare")}
				</span>
				<div className="preset-share-tabs">
					{(
						[
							["export", "presetShareTabExport"],
							["import", "presetShareTabImport"],
							["browse", "presetShareTabBrowse"],
						] as const
					).map(([id, key]) => (
						<button
							key={id}
							type="button"
							className={`preset-share-tab${tab === id ? " active" : ""}`}
							onClick={() => setTab(id)}
						>
							{t(key)}
							{id === "browse" && entries.length > 0 && <em className="preset-share-badge">{entries.length}</em>}
						</button>
					))}
				</div>
				<button type="button" className="btn" title={t("close")} onClick={onClose}>
					<FiX />
				</button>
			</div>

			<div className="preset-share-body">
				{tab === "export" && (
					<div
						className="preset-share-pane"
						onChange={() => setRequests((prev) => ({ ...prev, export: "", share: "" }))}
					>
						<fieldset disabled={sharing || exporting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
							<label className="preset-share-field">
								<span>{t("presetShareSource")}</span>
								<select
									className="set-input"
									value={shareName}
									onChange={(e) => {
										setShareName(e.target.value);
										setSelectedPlugins(presets.find((p) => p.name === e.target.value)?.plugins ?? []);
									}}
								>
									<option value="">{t("presetShareSourceCurrent")}</option>
									{presets.map((n) => (
										<option key={n.name} value={n.name}>
											{n.name}
										</option>
									))}
								</select>
							</label>
							<label className="preset-share-field">
								<span>{t("presetShareDescription")}</span>
								<input
									className="set-input"
									value={description}
									placeholder={t("presetShareDescriptionPlaceholder")}
									onChange={(e) => setDescription(e.target.value)}
								/>
							</label>
							<label className="preset-share-field">
								<span>{t("presetShareTags")}</span>
								<input
									className="set-input"
									value={tags}
									placeholder={t("presetShareTagsPlaceholder")}
									onChange={(e) => setTags(e.target.value)}
								/>
							</label>
							<label className="preset-share-field">
								<span>{t("presetShareAuthor")}</span>
								<input className="set-input" value={author} onChange={(e) => setAuthor(e.target.value)} />
							</label>
							<div className="preset-share-pick">
								<strong>{t("presetPluginsTitle")}</strong>
								<p className="set-note">{t("presetPluginsExportHint")}</p>
								{[...plugins, ...selectedPlugins.filter((p) => !plugins.some((i) => i.id === p.id))].map((plugin) => {
									const portable = presetPluginDependency(plugin, pluginCatalog);
									return (
										<label className="preset-share-check" key={plugin.id}>
											<input
												type="checkbox"
												disabled={!portable}
												checked={!!portable && selectedPlugins.some((p) => p.id === plugin.id)}
												onChange={(e) =>
													setSelectedPlugins((prev) =>
														e.target.checked
															? [...prev.filter((p) => p.id !== plugin.id), portable!]
															: prev.filter((p) => p.id !== plugin.id),
													)
												}
											/>
											{plugin.name || plugin.id} {plugin.version} · {portable?.source ?? t("presetPluginsLocal")}
										</label>
									);
								})}
							</div>
						</fieldset>
						<div className="preset-share-actions">
							<button type="button" className="btn" disabled={exporting || sharing} onClick={doExport}>
								<FiDownload /> {t("presetExportJson")}
							</button>
							<button type="button" className="btn primary" onClick={doShare} disabled={sharing || exporting}>
								{sharing ? <FiRefreshCw className="preset-share-spin" /> : <FiShare2 />}
								{sharing ? t("presetShareSubmitting") : t("presetShareSubmit")}
							</button>
						</div>
						<p className="preset-share-hint">{t("presetShareHint")}</p>

						{presetShare && presetShare.method === "browser" && (
							<div className="preset-share-result-box">
								<div className="preset-share-result-head">
									<FiExternalLink /> <strong>{t("presetShareOpenWebTitle")}</strong>
								</div>
								{presetShare.error && <p className="preset-share-warn">{presetShare.error}</p>}
								<p className="preset-share-hint">{t("presetShareManualSubmission")}</p>
								<div className="preset-share-actions">
									{presetShare.url && (
										<a href={presetShare.url} target="_blank" rel="noopener noreferrer" className="btn primary">
											<FiExternalLink /> {t("presetShareOpenWebBtn")}
										</a>
									)}
									{presetShare.json && (
										<button
											type="button"
											className="btn"
											onClick={() => {
												if (presetShare.json) {
													void copyFeedback.copy(presetShare.json);
												}
											}}
										>
											{copyFeedback.copied ? t("copied") : t("presetShareCopyJson")}
										</button>
									)}
								</div>
							</div>
						)}

						{presetShare?.ok && (presetShare.method === "gh" || presetShare.method === "api") && presetShare.url && (
							<div className="preset-share-result-box preset-share-result-success">
								<p className="preset-share-ok">{t("presetShareCreated")}</p>
								<div className="preset-share-actions">
									<a href={presetShare.url} target="_blank" rel="noopener noreferrer" className="btn">
										<FiExternalLink /> {t("presetShareOpenIssueBtn")}
									</a>
								</div>
							</div>
						)}

						{presetShare?.ok === false && !presetShare.method && presetShare.error && (
							<p className="preset-share-error">{presetShare.error}</p>
						)}
						{presetExport?.ok === false && presetExport.error && (
							<p className="preset-share-error">{presetExport.error}</p>
						)}
						{presetExport?.ok && presetExport.json && (
							<>
								<div className="preset-share-actions">
									<button type="button" className="btn" onClick={copyExport}>
										{copyFeedback.copied ? t("copied") : t("copy")}
									</button>
									<button type="button" className="btn" onClick={downloadExport}>
										<FiDownload /> {t("presetExportDownload")}
									</button>
								</div>
								<textarea className="preset-share-json" readOnly value={presetExport.json} spellCheck={false} />
							</>
						)}
					</div>
				)}

				{tab === "import" && (
					<div className="preset-share-pane">
						<label className="preset-share-field">
							<span>{t("presetImportText")}</span>
							<textarea
								className="preset-share-input"
								value={text}
								placeholder={t("presetImportTextPlaceholder")}
								spellCheck={false}
								disabled={importing}
								onChange={(e) => {
									setText(e.target.value);
									invalidateImport();
								}}
							/>
						</label>
						<div className="preset-share-actions">
							<button
								type="button"
								className="btn"
								onClick={() => previewText(text, "paste")}
								disabled={importing || !text.trim()}
							>
								<FiUploadCloud /> {t("preview")}
							</button>
							<button type="button" className="btn" disabled={importing} onClick={() => fileRef.current?.click()}>
								<FiFilePlus /> {t("presetImportPickFile")}
							</button>
							<input
								ref={fileRef}
								type="file"
								accept=".json,application/json"
								style={{ display: "none" }}
								onChange={(e) => {
									pickFile(e.target.files?.[0]);
									e.target.value = "";
								}}
							/>
						</div>
						<div className="preset-share-url-row">
							<input
								className="set-input"
								value={url}
								placeholder={t("presetImportUrlPlaceholder")}
								disabled={importing}
								onChange={(e) => {
									setUrl(e.target.value);
									invalidateImport();
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") previewUrl(url);
								}}
							/>
							<button type="button" className="btn" onClick={() => previewUrl(url)} disabled={importing || !url.trim()}>
								<FiGlobe /> {t("presetImportFromUrl")}
							</button>
						</div>

						{presetImport?.ok === false && presetImport.error && (
							<p className="preset-share-error">{presetImport.error}</p>
						)}
						{preview && (
							<div className="preset-share-preview">
								<fieldset disabled={importing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
									<div className="preset-share-preview-head">
										<strong>{t("presetImportPreview")}</strong>
										<input
											className="set-input"
											aria-label={t("presetImportName")}
											disabled={importing}
											value={importName}
											onChange={(e) => setImportName(e.target.value)}
										/>
									</div>
									{preview.description && <p className="preset-share-preview-desc">{preview.description}</p>}
									<ul className="preset-share-meta">
										<li>{t("presetImportFields", { n: preview.fields.length })}</li>
										{preview.author && <li>{preview.author}</li>}
										{preview.tags.length > 0 && <li>{preview.tags.join(" · ")}</li>}
										{preview.summary.skills > 0 && <li>{`${t("settingsSkills")} ${preview.summary.skills}`}</li>}
										{preview.summary.agentTools > 0 && <li>{`${t("settingsTools")} ${preview.summary.agentTools}`}</li>}
									</ul>
									{preview.ignored.length > 0 && (
										<p className="preset-share-warn">
											{t("presetImportIgnored", { list: preview.ignored.join(", ") })}
										</p>
									)}
									{preview.rejected.length > 0 && (
										<p className="preset-share-warn">
											{t("presetImportRejected", { list: preview.rejected.join(", ") })}
										</p>
									)}
									{preview.customSystemPrompt && (
										<pre className="preset-share-snippet">{preview.customSystemPrompt}</pre>
									)}
									{preview.reviewPrompt && <pre className="preset-share-snippet">{preview.reviewPrompt}</pre>}
									{presets.some((p) => p.name === importName.trim()) && (
										<p className="preset-share-warn">{t("presetImportReplaces")}</p>
									)}
									{preview.fields.includes("promptTemplate") && (
										<p className="preset-share-warn">{t("presetImportTemplateWarning")}</p>
									)}
									{/* 可选导入：按分组/按字段勾选（默认全选）。字段名用原始键名，
								    与设置页/文档一一对应，不另建 47 条翻译。 */}
									{previewFields.length > 0 && (
										<div className="preset-share-pick">
											<div className="preset-share-pick-head">
												<strong>{t("presetImportPick")}</strong>
												<button type="button" className="chip" onClick={() => setPicked(new Set(previewFields))}>
													{t("presetImportSelectAll")}
												</button>
												<button type="button" className="chip" onClick={() => setPicked(new Set())}>
													{t("presetImportSelectNone")}
												</button>
											</div>
											<p className="set-note">{t("presetImportPickHint")}</p>
											{allChosen && <span className="preset-share-pick-all">{t("presetImportAllSelected")}</span>}
											{previewGroups.map(({ group, fields }) => (
												<div key={group} className="preset-share-pick-group">
													<label className="preset-share-check preset-share-pick-grouptitle">
														<input
															type="checkbox"
															checked={fields.every((f) => chosen.has(f))}
															onChange={(e) => setPresetGroup(fields, e.target.checked)}
														/>
														{t(presetGroupLabelKey(group) as Parameters<typeof t>[0])}
														<span className="set-count">
															{fields.filter((f) => chosen.has(f)).length}/{fields.length}
														</span>
													</label>
													<div className="preset-share-pick-fields">
														{fields.map((f) => {
															const val = preview.settings?.[f];
															const { summary, detail } = formatPresetFieldValue(f, val, lang);
															const label = presetFieldLabel(f, lang);
															const hint = presetFieldHint(f, lang);
															const isExpanded = expandedFields.has(f);
															return (
																<div key={f} className="preset-share-pick-item">
																	<div className="preset-share-pick-item-head">
																		<label className="preset-share-check">
																			<input
																				type="checkbox"
																				checked={chosen.has(f)}
																				onChange={() => togglePresetField(f)}
																			/>
																			<span className="preset-share-pick-label">{label}</span>
																		</label>
																		<code className="preset-share-pick-code">{f}</code>
																		{summary && <span className="preset-share-pick-summary">{summary}</span>}
																		{detail && (
																			<button
																				type="button"
																				className="preset-share-pick-toggle"
																				onClick={() => toggleFieldExpand(f)}
																			>
																				{isExpanded
																					? isZh
																						? "收起 ▲"
																						: "Collapse ▲"
																					: isZh
																						? "查看详情 ▼"
																						: "Details ▼"}
																			</button>
																		)}
																	</div>
																	{hint && <p className="preset-share-pick-hint">{hint}</p>}
																	{clearsPresetField(val) && (
																		<p className="preset-share-warn">{t("presetImportClears")}</p>
																	)}
																	{detail && isExpanded && <pre className="preset-share-pick-detail">{detail}</pre>}
																</div>
															);
														})}
													</div>
												</div>
											))}
											{chosen.size === 0 && <p className="preset-share-warn">{t("presetImportNoneSelected")}</p>}
										</div>
									)}
									<label className="preset-share-check">
										<input type="checkbox" checked={applyAfter} onChange={(e) => setApplyAfter(e.target.checked)} />
										{t("presetImportApply")}
									</label>
									<div className="preset-share-actions">
										<button
											type="button"
											className="btn primary"
											disabled={importing || chosen.size === 0 || !importName.trim()}
											onClick={confirmImport}
										>
											{t("presetImportConfirm")}
										</button>
									</div>
								</fieldset>
							</div>
						)}
						{importing && <p role="status">{t("presetImportWorking")}</p>}
						{importDone && (
							<>
								<p className="preset-share-ok">{t("presetImportSaved", { name: importDone.name })}</p>
								{presetImport?.applied === true && <p className="preset-share-ok">{t("presetImportApplied")}</p>}
								{presetImport?.applyDeferred && <p className="set-note">{t("presetImportApplyDeferred")}</p>}
								{presetImport?.applyError && (
									<p className="preset-share-error">
										{t("presetImportApplyFailed", { error: presetImport.applyError })}
									</p>
								)}
							</>
						)}
						{dependencyPreview?.plugins && dependencyPreview.plugins.length > 0 && (
							<div className="preset-share-pick">
								<strong>{t("presetPluginsTitle")}</strong>
								<p className="set-note">{t("presetPluginsInstallHint")}</p>
								{dependencyPreview.plugins.map((dependency) => {
									const status = presetPluginStatus(dependency, plugins, disabledPlugins);
									const job =
										pluginJobs[installJobs[dependency.id]] ?? pendingPresetPluginJob(dependency.id, pluginJobs);
									const running = (!!installJobs[dependency.id] && !job) || (job && job.phase !== "done");
									return (
										<div className="preset-share-pick-item" key={dependency.id}>
											<strong>{dependency.name || dependency.id}</strong> <code>{dependency.id}</code>
											<p className="set-note">
												{status.missing
													? t("presetPluginsMissing")
													: status.disabled
														? t("presetPluginsDisabled")
														: t("presetPluginsInstalled")}
												{status.versionMismatch &&
													" · " +
														t("presetPluginsVersion", {
															installed: status.plugin?.version || "?",
															requested: dependency.version || "?",
														})}
											</p>
											<p className="set-note">
												{dependency.source || t("presetPluginsNoSource")}
												{dependency.version && " · " + dependency.version}
											</p>
											{status.plugin?.error && <p className="preset-share-error">{status.plugin.error}</p>}
											{job && (
												<p
													role="status"
													className={
														job.phase === "done" ? (job.ok ? "preset-share-ok" : "preset-share-error") : "set-note"
													}
												>
													{job.phase === "done"
														? job.ok
															? t("presetPluginsInstalledCode")
															: job.error || t("presetPluginsFailed")
														: t("presetPluginsInstalling")}
												</p>
											)}
											{job?.lines.length || job?.output ? (
												<pre className="preset-share-snippet">{job.output || job.lines.join("\n")}</pre>
											) : null}
											{status.missing && (
												<button
													type="button"
													className="btn"
													disabled={!dependency.source || !!running || job?.ok === true}
													onClick={() => installPlugin(dependency)}
												>
													{running
														? t("presetPluginsInstalling")
														: job?.ok === false
															? t("presetPluginsRetry")
															: t("presetPluginsInstall")}
												</button>
											)}
										</div>
									);
								})}
							</div>
						)}
					</div>
				)}

				{tab === "browse" && (
					<div className="preset-share-pane">
						<div className="preset-share-url-row">
							<input
								className="set-input"
								value={query}
								placeholder={t("presetBrowseSearch")}
								onChange={(e) => setQuery(e.target.value)}
							/>
							<button type="button" className="btn" onClick={refreshCatalog} disabled={browsing}>
								<FiRefreshCw className={browsing ? "preset-share-spin" : undefined} /> {t("presetBrowseRefresh")}
							</button>
						</div>
						{presetCatalog?.error && <p className="preset-share-error">{presetCatalog.error}</p>}
						{presetCatalog?.cached && presetCatalog.fetchedAt > 0 && (
							<p className="preset-share-hint">
								{t("presetBrowseCached", { time: shortDate(new Date(presetCatalog.fetchedAt).toISOString()) })}
							</p>
						)}
						{filtered.length === 0 ? (
							<p className="set-empty">
								{!presetCatalog || browsing ? t("presetBrowseLoading") : t("presetBrowseEmpty")}
							</p>
						) : (
							<ul className="preset-share-list">
								{filtered.map((e: UiPresetCatalogEntry) => (
									<li key={e.id} className="preset-share-item">
										<div className="preset-share-item-head">
											<strong>{e.name}</strong>
											{e.author && <span className="preset-share-item-author">{e.author}</span>}
											{e.updatedAt && <span className="preset-share-item-date">{shortDate(e.updatedAt)}</span>}
										</div>
										{e.description && <p className="preset-share-item-desc">{e.description}</p>}
										<div className="preset-share-item-tags">
											{e.tags.map((tag) => (
												<span key={tag} className="preset-share-tag">
													{tag}
												</span>
											))}
											{e.summary?.hasTemplate && <span className="preset-share-tag">{t("presetBadgeTemplate")}</span>}
											{e.summary?.hasReviewPrompt && <span className="preset-share-tag">{t("presetBadgeReview")}</span>}
										</div>
										<div className="preset-share-actions">
											<button
												type="button"
												className="btn primary"
												disabled={importing}
												onClick={() => {
													setTab("import");
													setUrl(e.url);
													previewUrl(e.url);
												}}
											>
												{t("presetBrowseImport")}
											</button>
											{e.issueUrl && (
												<button
													type="button"
													className="btn"
													title={t("presetBrowseIssue")}
													onClick={() => window.open(e.issueUrl, "_blank", "noopener,noreferrer")}
												>
													<FiExternalLink /> {t("presetBrowseIssue")}
												</button>
											)}
										</div>
									</li>
								))}
							</ul>
						)}
					</div>
				)}
			</div>
		</Modal>
	);
}
