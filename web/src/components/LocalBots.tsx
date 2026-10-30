import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type { ModelInfo } from "../types";
import { resolveBotCwd } from "../local-bot-path";
import { UniversalPathPicker } from "./UniversalPathPicker";
import { UniversalModelPicker } from "./UniversalModelPicker";
import { LocalBotCatalogPicker, type BotCatalogEntry } from "./LocalBotCatalogPicker";

type Bot = {
	id: string;
	revision: number;
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	tools: string[];
	skills: string[];
	mcpServers: string[];
	enabled: boolean;
};
type Options = {
	cwd: string;
	defaultCwd: string;
	defaultModel?: string;
	models: ModelInfo[];
	tools: BotCatalogEntry[];
	skills: BotCatalogEntry[];
	mcpServers: BotCatalogEntry[];
	projects: { path: string }[];
};
const modelId = (model: ModelInfo) =>
	model.id.startsWith(`${model.provider}/`) ? model.id.slice(model.provider.length + 1) : model.id;
const blank = (): Omit<Bot, "id" | "revision"> => ({
	name: "",
	description: "",
	systemPrompt: "",
	cwd: "",
	tools: [],
	skills: [],
	mcpServers: [],
	enabled: true,
});
async function request(path: string, signal: AbortSignal, body?: object) {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal,
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || String(response.status));
	return data;
}
export function LocalBots({
	pathCompletions = [],
}: {
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
}) {
	const t = useT();
	const [bots, setBots] = useState<Bot[]>([]);
	const [draft, setDraft] = useState<(ReturnType<typeof blank> & Partial<Pick<Bot, "id" | "revision">>) | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [options, setOptions] = useState<Options | null>(null);
	const [optionsError, setOptionsError] = useState("");
	const [loading, setLoading] = useState(false);
	const [reload, setReload] = useState(0);
	const [modelOpen, setModelOpen] = useState(false);
	const controller = useRef<AbortController | null>(null);
	const baseCwd = useRef("");
	useEffect(() => {
		const current = new AbortController();
		void request("local-bots", current.signal)
			.then((data) => {
				if (current.signal.aborted) return;
				if (!Array.isArray(data.bots)) throw new Error("Invalid Bot list");
				setBots(data.bots);
			})
			.catch((cause) => {
				if (!current.signal.aborted) setError(String(cause));
			});
		return () => {
			current.abort();
			controller.current?.abort();
		};
	}, []);
	const cwd = draft?.cwd;
	useEffect(() => {
		if (cwd === undefined) return;
		const current = new AbortController();
		setLoading(true);
		setOptionsError("");
		setOptions(null);
		void request(cwd ? `local-bot-options?cwd=${encodeURIComponent(cwd)}` : "local-bot-options", current.signal)
			.then((data: Options) => {
				if (current.signal.aborted) return;
				if (
					![data.models, data.tools, data.skills, data.mcpServers, data.projects].every(Array.isArray) ||
					!data.defaultCwd ||
					!data.cwd
				)
					throw new Error(t("localBotOptionsInvalid"));
				baseCwd.current = data.defaultCwd;
				setOptions(data);
				if (!cwd) setDraft((old) => (old && !old.cwd ? { ...old, cwd: data.cwd } : old));
			})
			.catch((cause) => {
				if (!current.signal.aborted) setOptionsError(String(cause));
			})
			.finally(() => {
				if (!current.signal.aborted) setLoading(false);
			});
		return () => current.abort();
	}, [cwd, reload]);
	useEffect(() => {
		if (!modelOpen) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") setModelOpen(false);
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [modelOpen]);
	async function mutate(remove = false) {
		if (!draft || busy) return;
		const current = new AbortController();
		controller.current = current;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const data = await request(
				remove ? `local-bots/${encodeURIComponent(draft.id!)}/delete` : "local-bots",
				current.signal,
				remove ? { revision: draft.revision } : draft,
			);
			if (current.signal.aborted) return;
			setBots((old) =>
				remove ? old.filter((b) => b.id !== draft.id) : [...old.filter((b) => b.id !== data.bot.id), data.bot],
			);
			setDraft(null);
			setModelOpen(false);
			setNotice(data.synced === false ? t("localBotSyncFailed") : t("localBotSaved"));
		} catch (cause) {
			if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!current.signal.aborted) setBusy(false);
		}
	}
	const chosenModel = options?.models.find(
		(model) => model.provider === draft?.model?.provider && modelId(model) === draft?.model?.modelId,
	);
	return (
		<section className="dc-card dc-bots" aria-label={t("localBotTitle")}>
			<div className="dg-heading">
				<h2>{t("localBotTitle")}</h2>
				<button
					className="dc-button"
					type="button"
					disabled={busy}
					onClick={() => {
						setDraft(blank());
						setError("");
						setModelOpen(false);
					}}
				>
					{t("localBotCreate")}
				</button>
			</div>
			<p>{t("localBotHint")}</p>
			{error && <p role="alert">{error}</p>}
			{notice && <p role="status">{notice}</p>}
			<div className="dc-bot-list">
				{bots.map((bot) => (
					<button
						className="dc-button"
						key={bot.id}
						disabled={busy}
						onClick={() => {
							setDraft(structuredClone(bot));
							setError("");
							setModelOpen(false);
						}}
					>
						<span>
							{bot.name} · {bot.enabled ? t("localBotEnabled") : t("localBotDisabled")}
						</span>
						<small>
							{bot.id} · r{bot.revision}
						</small>
					</button>
				))}
			</div>
			{draft && (
				<form
					className="dc-bot-editor"
					onSubmit={(event) => {
						event.preventDefault();
						void mutate();
					}}
				>
					{draft.id && (
						<small>
							{draft.id} · r{draft.revision}
						</small>
					)}
					<fieldset className="dc-bot-section" disabled={busy}>
						<legend>{t("localBotIdentity")}</legend>
						<label className="dc-field">
							{t("localBotName")}
							<input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
						</label>
						<label className="dc-field">
							{t("localBotDescription")}
							<textarea
								rows={2}
								value={draft.description}
								onChange={(e) => setDraft({ ...draft, description: e.target.value })}
							/>
						</label>
						<label className="dc-field">
							{t("localBotSystemPrompt")}
							<textarea
								rows={3}
								value={draft.systemPrompt}
								onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
							/>
						</label>
					</fieldset>
					<fieldset className="dc-bot-section" disabled={busy}>
						<legend>{t("localBotRuntime")}</legend>
						<div className="dc-field">
							<label htmlFor="local-bot-cwd">{t("localBotCwd")}</label>
							<UniversalPathPicker
								inputId="local-bot-cwd"
								localOnly
								commitOnBlur
								pathCompletions={pathCompletions}
								cwd={draft.cwd}
								baseCwd={baseCwd.current || draft.cwd}
								projects={options?.projects.map((project) => ({ ...project, lastUsed: 0 })) ?? []}
								disabled={busy}
								onSelectCwd={(value) => setDraft({ ...draft, cwd: resolveBotCwd(value, baseCwd.current || draft.cwd) })}
							/>
						</div>
						<div className="dc-field">
							<span>{t("localBotModel")}</span>
							<div className="dc-actions">
								<button className="dc-button" type="button" aria-haspopup="dialog" onClick={() => setModelOpen(true)}>
									{draft.model
										? (chosenModel?.name ?? `${draft.model.provider}/${draft.model.modelId}`)
										: t("localBotInheritModel")}
								</button>
								{draft.model && (
									<button className="dc-button" type="button" onClick={() => setDraft({ ...draft, model: undefined })}>
										{t("localBotInheritModel")}
									</button>
								)}
							</div>
							{draft.model && !chosenModel && (
								<small>{loading ? t("localBotUnverified") : t("localBotUnavailable")}</small>
							)}
						</div>
					</fieldset>
					<div className="dc-bot-options-status" aria-live="polite">
						{loading && <span>{t("localBotOptionsLoading")}</span>}
						{optionsError && <span role="alert">{optionsError}</span>}
						<button
							className="dc-button"
							type="button"
							disabled={loading || busy}
							onClick={() => setReload((value) => value + 1)}
						>
							{optionsError ? t("deviceHubRetry") : t("localBotReload")}
						</button>
					</div>
					<div className="dc-bot-permissions">
						{(
							[
								["tools", t("localBotTools")],
								["skills", t("localBotSkills")],
								["mcpServers", t("localBotMcpServers")],
							] as const
						).map(([key, title]) => (
							<LocalBotCatalogPicker
								key={key}
								title={title}
								entries={options?.[key] ?? []}
								selected={draft[key]}
								disabled={busy}
								pending={loading || !!optionsError}
								onChange={(ids) => setDraft({ ...draft, [key]: ids })}
							/>
						))}
					</div>
					<label className="dc-bot-enabled">
						<input
							type="checkbox"
							disabled={busy}
							checked={draft.enabled}
							onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
						/>
						{t("localBotEnable")}
					</label>
					<div className="dc-actions">
						<button className="dc-button" disabled={busy || !draft.cwd || !draft.name.trim()}>
							{t("localBotSave")}
						</button>
						<button
							className="dc-button"
							type="button"
							disabled={busy}
							onClick={() => {
								setDraft(null);
								setModelOpen(false);
							}}
						>
							{t("localBotCancel")}
						</button>
						{draft.id && (
							<button
								className="dc-button is-danger"
								type="button"
								disabled={busy}
								onClick={() => {
									if (window.confirm(t("localBotDeleteConfirm"))) void mutate(true);
								}}
							>
								{t("localBotDelete")}
							</button>
						)}
					</div>
				</form>
			)}
			{draft &&
				modelOpen &&
				createPortal(
					<div
						className="modal-backdrop dc-bot-model-backdrop"
						onClick={(event) => {
							if (event.target === event.currentTarget) setModelOpen(false);
						}}
					>
						<div
							className="dc-bot-model-modal dd-menu-model"
							role="dialog"
							aria-modal="true"
							aria-label={t("localBotModel")}
						>
							<div className="dg-heading">
								<h3>{t("localBotModel")}</h3>
								<button type="button" className="dc-button" onClick={() => setModelOpen(false)}>
									{t("localBotCancel")}
								</button>
							</div>
							<UniversalModelPicker
								models={options?.models ?? []}
								modelsLoading={loading}
								defaultModel={options?.defaultModel}
								currentModelId={draft.model ? `${draft.model.provider}/${draft.model.modelId}` : null}
								active
								onEnsureModels={() => {}}
								onRefresh={() => setReload((value) => value + 1)}
								onPickModel={(model) => {
									setDraft({ ...draft, model: { provider: model.provider, modelId: modelId(model) } });
									setModelOpen(false);
								}}
								isRowActive={(model) =>
									model.provider === draft.model?.provider && modelId(model) === draft.model.modelId
								}
								extraTopRow={
									<button
										type="button"
										className="dc-button"
										onClick={() => {
											setDraft({ ...draft, model: undefined });
											setModelOpen(false);
										}}
									>
										{t("localBotInheritModel")}
									</button>
								}
								autoFocusSearch
								hideTitle
								bodyStyle={{ flex: 1, minHeight: 0 }}
								scrollStyle={{ overflowY: "auto", minHeight: 0 }}
							/>
							{optionsError && <p role="alert">{optionsError}</p>}
						</div>
					</div>,
					document.body,
				)}
		</section>
	);
}
