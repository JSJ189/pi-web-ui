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
import type { UiPresetCatalogEntry } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { saveDownloadBlob } from "../download";
import { randomUuid } from "../uuid";
import { Modal } from "./Modal";
import type { PresetCatalogState, PresetExportState, PresetImportState, PresetShareState } from "../use-chat";

interface PresetShareModalProps {
	/** 本地预设名（设置状态里的预设列表视图）。 */
	presets: string[];
	presetExport: PresetExportState | null;
	presetImport: PresetImportState | null;
	presetCatalog: PresetCatalogState | null;
	presetShare: PresetShareState | null;
	/** 打开时预选的预设名（"" = 当前设置）。 */
	initialPreset?: string;
	onClose: () => void;
}

type Tab = "export" | "import" | "browse";
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
	presetExport,
	presetImport,
	presetCatalog,
	presetShare,
	initialPreset = "",
	onClose,
}: PresetShareModalProps) {
	const t = useT();
	const [tab, setTab] = useState<Tab>("export");

	// ---- 导出/分享页签 -----------------------------------------------------
	const [shareName, setShareName] = useState(initialPreset);
	const [description, setDescription] = useState("");
	const [tags, setTags] = useState("");
	const [author, setAuthor] = useState("");
	const [copied, setCopied] = useState(false);

	// ---- 导入页签 ----------------------------------------------------------
	const [text, setText] = useState("");
	const [url, setUrl] = useState("");
	/** 最后一次预览请求的来源载荷（确认导入时原样重发）。 */
	const [pending, setPending] = useState<{ source: ImportSource; json?: string; url?: string } | null>(null);
	const [applyAfter, setApplyAfter] = useState(false);
	const fileRef = useRef<HTMLInputElement | null>(null);

	// ---- 浏览页签 ----------------------------------------------------------
	const [query, setQuery] = useState("");
	const [browsing, setBrowsing] = useState(false);

	// 打开时先把目录拉一遍（列表是这一页的主内容，早拉早显示）。
	useEffect(() => {
		appSend({ type: "preset_catalog", requestId: `catalog:${randomUuid()}` });
	}, []);

	// 目录回执到达 = 不再加载中。
	const lastCatalog = useRef(0);
	useEffect(() => {
		if (!presetCatalog || presetCatalog.receivedAt === lastCatalog.current) return;
		lastCatalog.current = presetCatalog.receivedAt;
		setBrowsing(false);
	}, [presetCatalog]);

	// 分享回执：gh 成功直接开 Issue；回落路径先复制 JSON 再开预填页面。
	const lastShare = useRef(0);
	useEffect(() => {
		if (!presetShare || presetShare.receivedAt === lastShare.current) return;
		lastShare.current = presetShare.receivedAt;
		if (presetShare.method === "browser") {
			if (presetShare.json) void navigator.clipboard?.writeText(presetShare.json).catch(() => {});
			if (presetShare.url) window.open(presetShare.url, "_blank", "noopener,noreferrer");
			return;
		}
		if (presetShare.ok && presetShare.url) window.open(presetShare.url, "_blank", "noopener,noreferrer");
	}, [presetShare]);

	// 导入回执：非 dryRun 成功 = 这一单已经落盘（清掉预览，避免重复点）。
	const lastImport = useRef(0);
	useEffect(() => {
		if (!presetImport || presetImport.receivedAt === lastImport.current) return;
		lastImport.current = presetImport.receivedAt;
		if (presetImport.ok && !presetImport.dryRun) {
			setText("");
			setUrl("");
			setPending(null);
		}
	}, [presetImport]);

	const shareArgs = useMemo(() => {
		const list = tags
			.split(/[,，]/)
			.map((s) => s.trim())
			.filter(Boolean);
		return {
			source: shareName ? ("preset" as const) : ("current" as const),
			name: shareName,
			...(description.trim() ? { description: description.trim() } : {}),
			...(author.trim() ? { author: author.trim() } : {}),
			...(list.length > 0 ? { tags: list } : {}),
		};
	}, [shareName, description, tags, author]);

	const doExport = () => appSend({ type: "preset_export", ...shareArgs, requestId: `export:${randomUuid()}` });
	const doShare = () => appSend({ type: "preset_share", ...shareArgs, requestId: `share:${randomUuid()}` });

	const downloadExport = () => {
		if (!presetExport?.json) return;
		void saveDownloadBlob(
			new Blob([presetExport.json], { type: "application/json" }),
			presetExport.fileName || `${presetExport.name || "preset"}.json`,
		);
	};
	const copyExport = () => {
		if (!presetExport?.json) return;
		void navigator.clipboard
			?.writeText(presetExport.json)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {});
	};

	/** 发一次 dryRun 预览（粘贴/文件 → preset_import；网址 → preset_import_url）。 */
	const previewText = (json: string, src: ImportSource) => {
		if (!json.trim()) return;
		setPending({ source: src, json });
		appSend({ type: "preset_import", json, dryRun: true, requestId: reqId(src) });
	};
	const previewUrl = (target: string, src: ImportSource = "url") => {
		if (!target.trim()) return;
		setPending({ source: src, url: target });
		appSend({ type: "preset_import_url", url: target, dryRun: true, requestId: reqId(src) });
	};

	/** 确认导入：把预览用的载荷原样重发（dryRun:false），可选导入后立即应用。 */
	const confirmImport = () => {
		if (!pending) return;
		const base = {
			dryRun: false,
			name: presetImport?.preview?.name,
			apply: applyAfter,
			requestId: reqId(pending.source),
		};
		if (pending.url) appSend({ type: "preset_import_url", url: pending.url, ...base });
		else if (pending.json) appSend({ type: "preset_import", json: pending.json, ...base });
	};

	const pickFile = (file: File | undefined) => {
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => previewText(String(reader.result ?? ""), "file");
		reader.readAsText(file);
	};

	const refreshCatalog = () => {
		setBrowsing(true);
		appSend({ type: "preset_catalog", refresh: true, requestId: `catalog:${randomUuid()}` });
	};

	const entries = presetCatalog?.entries ?? [];
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter((e) =>
			[e.name, e.description, e.author, e.tags.join(" ")].some((s) => s.toLowerCase().includes(q)),
		);
	}, [entries, query]);

	const preview = presetImport?.dryRun ? presetImport.preview : undefined;
	const importDone = presetImport?.ok && !presetImport.dryRun ? presetImport.preview : undefined;

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
					<div className="preset-share-pane">
						<label className="preset-share-field">
							<span>{t("presetShareSource")}</span>
							<select className="set-input" value={shareName} onChange={(e) => setShareName(e.target.value)}>
								<option value="">{t("presetShareSourceCurrent")}</option>
								{presets.map((n) => (
									<option key={n} value={n}>
										{n}
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
						<div className="preset-share-actions">
							<button type="button" className="btn" onClick={doExport}>
								<FiDownload /> {t("presetExportJson")}
							</button>
							<button type="button" className="btn primary" onClick={doShare}>
								<FiShare2 /> {t("presetShareSubmit")}
							</button>
						</div>
						<p className="preset-share-hint">{t("presetShareHint")}</p>
						{presetShare?.error && presetShare.method === "browser" && (
							<p className="preset-share-warn">
								{t("presetShareBrowserCopied")}
								{presetShare.error ? ` — ${presetShare.error}` : ""}
							</p>
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
										{copied ? t("copied") : t("copy")}
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
								onChange={(e) => setText(e.target.value)}
								onBlur={() => previewText(text, "paste")}
							/>
						</label>
						<div className="preset-share-actions">
							<button type="button" className="btn" onClick={() => previewText(text, "paste")} disabled={!text.trim()}>
								<FiUploadCloud /> {t("preview")}
							</button>
							<button type="button" className="btn" onClick={() => fileRef.current?.click()}>
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
								onChange={(e) => setUrl(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") previewUrl(url);
								}}
							/>
							<button type="button" className="btn" onClick={() => previewUrl(url)} disabled={!url.trim()}>
								<FiGlobe /> {t("presetImportFromUrl")}
							</button>
						</div>

						{presetImport?.ok === false && presetImport.error && (
							<p className="preset-share-error">{presetImport.error}</p>
						)}
						{preview && (
							<div className="preset-share-preview">
								<div className="preset-share-preview-head">
									<strong>{t("presetImportPreview")}</strong>
									<span className="preset-share-preview-name">{preview.name}</span>
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
									<p className="preset-share-warn">{t("presetImportIgnored", { list: preview.ignored.join(", ") })}</p>
								)}
								{preview.rejected.length > 0 && (
									<p className="preset-share-warn">
										{t("presetImportRejected", { list: preview.rejected.join(", ") })}
									</p>
								)}
								{preview.customSystemPrompt && <pre className="preset-share-snippet">{preview.customSystemPrompt}</pre>}
								{preview.reviewPrompt && <pre className="preset-share-snippet">{preview.reviewPrompt}</pre>}
								{preview.replaces && <p className="preset-share-warn">{t("presetImportReplaces")}</p>}
								<label className="preset-share-check">
									<input type="checkbox" checked={applyAfter} onChange={(e) => setApplyAfter(e.target.checked)} />
									{t("presetImportApply")}
								</label>
								<div className="preset-share-actions">
									<button type="button" className="btn primary" onClick={confirmImport}>
										{t("presetImportConfirm")}
									</button>
								</div>
							</div>
						)}
						{importDone && <p className="preset-share-ok">{t("presetImportImported", { name: importDone.name })}</p>}
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
							<p className="set-empty">{browsing ? t("loading") : t("presetBrowseEmpty")}</p>
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
