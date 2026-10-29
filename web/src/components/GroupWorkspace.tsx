import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { appUrl, relayBase } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";

type Binding = { roomId: string; root: string; revision: number };
type Workspace = { binding?: Binding; defaultRoot: string };
const words = {
	zh: {
		title: "本机项目",
		unbound: "未绑定本机项目",
		loading: "加载中…",
		hint: "选择本机项目后此设备才能执行本群任务",
		local: "仅保存到本机；其他设备使用各自的项目路径。",
		remote: "远程访问仅查看已绑定项目；请在这台设备本机打开 pi-web-ui 修改路径。",
		path: "本机项目绝对路径",
		save: "保存",
		saving: "保存中…",
		refresh: "刷新",
		useDefault: "使用服务默认项目",
		busy: "本群任务正在运行，请在任务结束后再修改本机项目。",
		failed: "本机项目请求失败",
		saved: "已保存，后续任务立即使用此项目。",
		close: "关闭",
	},
	en: {
		title: "Local project",
		unbound: "No local project",
		loading: "Loading…",
		hint: "Select a local project before this device can execute tasks in this group.",
		local: "Saved only on this device. Other devices use their own project paths.",
		remote: "Remote access shows the saved project. Open pi-web-ui locally on this device to change its path.",
		path: "Absolute local project path",
		save: "Save",
		saving: "Saving…",
		refresh: "Refresh",
		useDefault: "Use server default project",
		busy: "A task is running in this group. Change the local project after it finishes.",
		failed: "Local project request failed",
		saved: "Saved. Subsequent tasks use this project immediately.",
		close: "Close",
	},
};
class WorkspaceError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = "",
	) {
		super(message);
	}
}
async function request<T>(roomId: string, signal: AbortSignal, path?: string): Promise<T> {
	const response = await fetch(
		withToken(
			appUrl(`/api/device-center/workspaces${path === undefined ? `?roomId=${encodeURIComponent(roomId)}` : ""}`),
		),
		{
			method: path === undefined ? "GET" : "POST",
			credentials: "same-origin",
			signal,
			...(path === undefined
				? {}
				: { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, path }) }),
		},
	);
	const data = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new WorkspaceError(
			response.status,
			typeof data.error === "string" ? data.error : String(response.status),
			typeof data.code === "string" ? data.code : "",
		);
	return data as T;
}

export function GroupWorkspace({ roomId, active = true }: { roomId: string; active?: boolean }) {
	return <WorkspacePanel key={roomId} roomId={roomId} active={active} />;
}
function WorkspacePanel({ roomId, active }: { roomId: string; active: boolean }) {
	const { locale } = useI18n();
	const remote = !!relayBase(globalThis.location?.pathname);
	const w = words[isZhLocale(locale) ? "zh" : "en"];
	const labels = useRef(w);
	labels.current = w;
	const [workspace, setWorkspace] = useState<Workspace | null>(null);
	const [draft, setDraft] = useState("");
	const dirty = useRef(false);
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const generation = useRef(0);
	const reading = useRef<AbortController | null>(null);
	const mutation = useRef<AbortController | null>(null);
	const anchor = useRef<HTMLButtonElement>(null);
	const id = useId();
	const floating = useFloatingPanel({ open: open && active, anchor, onClose: () => setOpen(false) });
	function explain(cause: unknown) {
		return cause instanceof WorkspaceError && cause.status === 409 && (!cause.code || cause.code === "WORKSPACE_BUSY")
			? labels.current.busy
			: `${labels.current.failed}: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
	useEffect(() => {
		const token = ++generation.current;
		if (!active) {
			setOpen(false);
			return;
		}
		const controller = new AbortController();
		reading.current = controller;
		setLoading(true);
		void request<Workspace>(roomId, controller.signal)
			.then((next) => {
				if (controller.signal.aborted || generation.current !== token) return;
				setWorkspace(next);
				if (!dirty.current) setDraft(next.binding?.root ?? "");
				setError("");
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted && generation.current === token) setError(explain(cause));
			})
			.finally(() => {
				if (!controller.signal.aborted && generation.current === token) setLoading(false);
			});
		return () => {
			controller.abort();
			++generation.current;
		};
	}, [roomId, active, refresh]);
	useEffect(() => {
		return () => {
			mutation.current?.abort();
			mutation.current = null;
		};
	}, [active]);
	useEffect(() => {
		if (!active) setBusy(false);
	}, [active]);
	async function save(path: string) {
		if (remote || !active || mutation.current || !path.trim()) return;
		reading.current?.abort();
		const token = ++generation.current;
		const controller = new AbortController();
		mutation.current = controller;
		setLoading(false);
		setBusy(true);
		setError("");
		setSaved(false);
		try {
			const { binding } = await request<{ binding: Binding }>(roomId, controller.signal, path.trim());
			if (controller.signal.aborted || generation.current !== token) return;
			setWorkspace((old) => ({ defaultRoot: old?.defaultRoot ?? "", binding }));
			setDraft(binding.root);
			dirty.current = false;
			setSaved(true);
			window.dispatchEvent(new CustomEvent("pi-web-ui:group-workspace-changed", { detail: { roomId } }));
		} catch (cause) {
			if (!controller.signal.aborted && generation.current === token) setError(explain(cause));
		} finally {
			if (mutation.current === controller) {
				mutation.current = null;
				setBusy(false);
			}
		}
	}
	const status = workspace?.binding?.root ?? (loading ? w.loading : w.unbound);
	return (
		<div className="gw-root">
			<button
				ref={anchor}
				type="button"
				className="btn gw-trigger"
				disabled={!active}
				aria-expanded={open && active}
				aria-controls={id}
				onClick={() => setOpen((value) => !value)}
				title={`${w.title}: ${status}`}
			>
				<span>{w.title}</span>
				<span className="gw-status">{status}</span>
				<span aria-hidden="true">▾</span>
			</button>
			{open &&
				active &&
				createPortal(
					<div
						id={id}
						ref={floating.panelRef}
						style={floating.style}
						className="gw-panel"
						role="region"
						aria-label={w.title}
					>
						<div className="gw-heading">
							<strong>{w.title}</strong>
							<button type="button" className="btn" onClick={() => setOpen(false)}>
								{w.close}
							</button>
						</div>
						<p className="gw-current" title={workspace?.binding?.root}>
							{workspace?.binding?.root ?? w.hint}
						</p>
						<p className="gw-note">{remote ? w.remote : w.local}</p>
						{error && (
							<p className="gw-error" role="alert">
								{error}
							</p>
						)}
						{saved && (
							<p className="gw-note" role="status">
								{w.saved}
							</p>
						)}
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void save(draft);
							}}
						>
							<label htmlFor={`${id}-path`}>{w.path}</label>
							<input
								id={`${id}-path`}
								value={draft}
								disabled={busy || remote}
								placeholder="C:\\projects\\app / /Users/me/projects/app"
								autoComplete="off"
								spellCheck={false}
								onChange={(event) => {
									dirty.current = true;
									setDraft(event.target.value);
									setSaved(false);
								}}
							/>
							<div className="gw-actions">
								<button type="submit" className="btn primary" disabled={remote || busy || !draft.trim()}>
									{busy ? w.saving : w.save}
								</button>
								<button
									type="button"
									className="btn"
									disabled={busy || loading}
									onClick={() => {
										setSaved(false);
										setRefresh((value) => value + 1);
									}}
								>
									{loading ? w.loading : w.refresh}
								</button>
							</div>
						</form>
						<button
							type="button"
							className="btn gw-default"
							disabled={remote || busy || loading || !workspace?.defaultRoot}
							title={workspace?.defaultRoot}
							onClick={() => void save(workspace!.defaultRoot)}
						>
							{w.useDefault}
						</button>
					</div>,
					document.body,
				)}
		</div>
	);
}
