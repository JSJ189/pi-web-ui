import { useEffect, useRef, useState } from "react";
import {
	FiCheck,
	FiCopy,
	FiExternalLink,
	FiHelpCircle,
	FiLink,
	FiMessageSquare,
	FiMonitor,
	FiRefreshCw,
	FiShield,
} from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { DeviceGroups } from "./DeviceGroups";
import { DeviceDirectory } from "./DeviceDirectory";
import { useDeviceGroupNavigation } from "../device-group-navigation";

type DeviceStatus = { name: string; hubUrl?: string; deviceId?: string; allowExecution: boolean; connected: boolean };
type Pairing = { code: string; expiresAt: number; hubUrl: string };
class DeviceRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
function safeHub(value: string): string | null {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

export function DeviceCenter() {
	const t = useT();
	const navigation = useDeviceGroupNavigation();
	const [view, setView] = useState<"overview" | "groups" | "settings">(navigation.revision ? "groups" : "overview");
	useEffect(() => {
		if (navigation.revision) setView("groups");
	}, [navigation.revision]);
	const [status, setStatus] = useState<DeviceStatus | null>(null);
	const [hubUrl, setHubUrl] = useState("");
	const [name, setName] = useState("");
	const [pairing, setPairing] = useState<Pairing | null>(null);
	const [now, setNow] = useState(Date.now());
	const [busy, setBusy] = useState<"pair" | "permission" | "disconnect" | null>(null);
	const [error, setError] = useState("");
	const [statusError, setStatusError] = useState("");
	const [notice, setNotice] = useState("");
	const [localOnly, setLocalOnly] = useState(false);
	const [loading, setLoading] = useState(true);
	const alive = useRef(false);
	const generation = useRef(0);
	const controllers = useRef(new Set<AbortController>());
	const action = useRef(false);
	const dirty = useRef(false);
	const currentStatus = useRef<DeviceStatus | null>(null);
	const translate = useRef(t);
	translate.current = t;

	async function request<T>(path: string, body?: object): Promise<T> {
		const controller = new AbortController();
		controllers.current.add(controller);
		try {
			const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
				method: body ? "POST" : "GET",
				credentials: "same-origin",
				signal: controller.signal,
				...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok)
				throw new DeviceRequestError(
					response.status,
					typeof data.error === "string"
						? data.error
						: translate.current("deviceHubRequestFailed", { status: response.status }),
				);
			return data as T;
		} finally {
			controllers.current.delete(controller);
		}
	}
	function valid(token: number) {
		return alive.current && generation.current === token;
	}
	function explain(cause: unknown): string {
		if (cause instanceof DeviceRequestError && cause.status === 403) {
			setLocalOnly(true);
			return translate.current("deviceHubLocalOnly");
		}
		return cause instanceof Error ? cause.message : translate.current("deviceHubNetworkError");
	}
	function applyStatus(next: DeviceStatus) {
		currentStatus.current = next;
		setStatus(next);
		if (!dirty.current) {
			setName(next.name);
			setHubUrl(next.hubUrl ?? "");
		}
	}
	async function refresh() {
		const token = generation.current;
		try {
			const next = await request<DeviceStatus>("status");
			if (!valid(token) || action.current) return;
			applyStatus(next);
			setStatusError("");
			setLocalOnly(false);
		} catch (cause) {
			if (valid(token)) setStatusError(explain(cause));
		} finally {
			if (valid(token)) setLoading(false);
		}
	}
	useEffect(() => {
		alive.current = true;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			await refresh();
			if (!stopped && alive.current) timer = setTimeout(tick, 5000);
		};
		void tick();
		return () => {
			stopped = true;
			alive.current = false;
			generation.current++;
			clearTimeout(timer);
			for (const controller of controllers.current) controller.abort();
		};
	}, []);
	useEffect(() => {
		if (!pairing) return;
		const token = generation.current;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const clock = setInterval(() => setNow(Date.now()), 1000);
		const poll = async () => {
			if (stopped || !valid(token) || Date.now() >= pairing.expiresAt) return;
			try {
				const result = await request<{ pending?: boolean; paired?: boolean }>("poll", {});
				if (stopped || !valid(token)) return;
				if (result.paired) {
					const next = await request<DeviceStatus>("status");
					if (stopped || !valid(token)) return;
					dirty.current = false;
					applyStatus(next);
					setPairing(null);
					setError("");
					setNotice("");
					return;
				}
				setError("");
			} catch (cause) {
				if (!stopped && valid(token)) setError(`${translate.current("deviceHubPollError")} ${explain(cause)}`);
			}
			if (!stopped && valid(token)) timer = setTimeout(poll, 2000);
		};
		timer = setTimeout(poll, 2000);
		return () => {
			stopped = true;
			clearTimeout(timer);
			clearInterval(clock);
		};
	}, [pairing]);
	async function pair() {
		if (action.current) return;
		const url = safeHub(hubUrl.trim());
		if (!url) {
			setError(t("deviceHubInvalidUrl"));
			return;
		}
		if (!name.trim() || name.trim().length > 80) {
			setError(t("deviceHubInvalidName"));
			return;
		}
		const token = ++generation.current;
		action.current = true;
		setBusy("pair");
		setError("");
		setNotice("");
		setPairing(null);
		try {
			const result = await request<Pairing>("pair", { hubUrl: url, name: name.trim() });
			if (!valid(token)) return;
			if (!result.code || !Number.isFinite(result.expiresAt) || !safeHub(result.hubUrl))
				throw new Error(t("deviceHubPairError"));
			setNow(Date.now());
			setPairing(result);
		} catch (cause) {
			if (valid(token)) setError(`${t("deviceHubPairError")} ${explain(cause)}`);
		} finally {
			if (valid(token)) {
				action.current = false;
				setBusy(null);
			}
		}
	}
	async function togglePermission() {
		const captured = currentStatus.current;
		if (!captured?.deviceId || action.current) return;
		const token = ++generation.current;
		action.current = true;
		setBusy("permission");
		setError("");
		setNotice("");
		applyStatus({ ...captured, allowExecution: !captured.allowExecution });
		try {
			await request("execution", { allowExecution: !captured.allowExecution });
			if (valid(token)) setNotice(t("deviceHubSaved"));
		} catch (cause) {
			if (valid(token)) {
				applyStatus(captured);
				setError(`${t("deviceHubPermissionError")} ${explain(cause)}`);
			}
		} finally {
			if (valid(token)) {
				action.current = false;
				setBusy(null);
			}
		}
	}
	async function disconnect() {
		const captured = currentStatus.current;
		if (
			!captured?.deviceId ||
			action.current ||
			!window.confirm(t("deviceHubDisconnectConfirm", { name: captured.name }))
		)
			return;
		const token = ++generation.current;
		action.current = true;
		setBusy("disconnect");
		setError("");
		setNotice("");
		try {
			await request("disconnect", {});
			if (!valid(token)) return;
			dirty.current = false;
			applyStatus({ name: captured.name, allowExecution: false, connected: false });
			setPairing(null);
		} catch (cause) {
			if (valid(token)) setError(`${t("deviceHubDisconnectError")} ${explain(cause)}`);
		} finally {
			if (valid(token)) {
				action.current = false;
				setBusy(null);
			}
		}
	}
	async function copyCode() {
		if (!pairing) return;
		const token = generation.current;
		try {
			await navigator.clipboard.writeText(pairing.code);
			if (valid(token)) setNotice(t("deviceHubCopied"));
		} catch {
			if (valid(token)) setError(t("deviceHubCopyFailed"));
		}
	}
	const bound = !!status?.deviceId;
	const link = safeHub(bound ? (status?.hubUrl ?? "") : (pairing?.hubUrl ?? ""));
	const seconds = Math.max(0, Math.ceil(((pairing?.expiresAt ?? 0) - now) / 1000));
	const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	const hubLink = link ? (
		<a className="dc-button" href={link} target="_blank" rel="noopener noreferrer">
			<FiExternalLink aria-hidden />
			{t("deviceHubOpenHub")}
		</a>
	) : null;

	return (
		<section className="dc-page" aria-label={t("deviceHubTitle")}>
			<header className="dc-header">
				<div className="dc-heading">
					<span className="dc-eyebrow">
						<FiMonitor aria-hidden />
						{t("deviceHubTitle")}
					</span>
					<h1>{t("deviceHubTitle")}</h1>
					<p>{t("deviceHubSubtitle")}</p>
				</div>
				<span className={`dc-status ${bound ? (status?.connected ? "is-online" : "is-offline") : "is-unpaired"}`}>
					<span className="dc-status-dot" />
					{t(bound ? (status?.connected ? "deviceHubOnline" : "deviceHubOffline") : "deviceHubUnpaired")}
				</span>
			</header>
			<div className="dc-layout">
				<nav className="dc-sidebar" aria-label={t("deviceHubTitle")}>
					<button
						type="button"
						className={`dc-nav-item${view === "overview" ? " is-active" : ""}`}
						aria-current={view === "overview" ? "page" : undefined}
						onClick={() => setView("overview")}
					>
						<FiMonitor aria-hidden />
						{t("deviceHubOverview")}
					</button>
					<button
						type="button"
						className={`dc-nav-item${view === "groups" ? " is-active" : ""}`}
						aria-current={view === "groups" ? "page" : undefined}
						onClick={() => setView("groups")}
					>
						<FiMessageSquare aria-hidden />
						{t("deviceHubGroups")}
					</button>
					<button
						type="button"
						className={`dc-nav-item${view === "settings" ? " is-active" : ""}`}
						aria-current={view === "settings" ? "page" : undefined}
						onClick={() => setView("settings")}
					>
						<FiLink aria-hidden />
						{t("deviceHubSettings")}
					</button>
				</nav>
				<main className="dc-content">
					{loading && (
						<div className="dc-loading" role="status">
							<FiRefreshCw aria-hidden />
							{t("deviceHubLoading")}
						</div>
					)}
					{(localOnly || statusError) && (
						<div className="dc-notice is-error" role="alert">
							<span>{localOnly ? t("deviceHubLocalOnly") : `${t("deviceHubStatusError")} ${statusError}`}</span>
							<button type="button" className="dc-button" onClick={() => void refresh()}>
								<FiRefreshCw aria-hidden />
								{t("deviceHubRetry")}
							</button>
						</div>
					)}
					{error && !localOnly && (
						<div className="dc-notice is-error" role="alert">
							{error}
						</div>
					)}
					{notice && (
						<div className="dc-notice is-success" role="status">
							<FiCheck aria-hidden />
							{notice}
						</div>
					)}
					{status && !localOnly && !bound && view === "overview" && (
						<section className="dc-card">
							<div className="dc-device-summary">
								<span className="dc-device-icon">
									<FiMonitor aria-hidden />
								</span>
								<div>
									<h2>{status.name}</h2>
									<p>{t("deviceHubUnpaired")}</p>
								</div>
							</div>
							<p className="dc-permission-state">{t("deviceHubPairHint")}</p>
							<div className="dc-actions">
								<button type="button" className="dc-button is-primary" onClick={() => setView("settings")}>
									<FiLink aria-hidden />
									{t("deviceHubPairTitle")}
								</button>
							</div>
						</section>
					)}
					{status && !localOnly && !bound && view === "settings" && (
						<section className="dc-card">
							<div className="dc-card-header">
								<span className="dc-icon">
									<FiLink aria-hidden />
								</span>
								<div>
									<h2>{t("deviceHubPairTitle")}</h2>
									<p>{t("deviceHubPairHint")}</p>
								</div>
							</div>
							<ol className="dc-steps">
								{["deviceHubStepDetails", "deviceHubStepApprove", "deviceHubStepWait"].map((key, index) => (
									<li
										key={key}
										className={pairing ? (index === 0 ? "is-complete" : "is-active") : index === 0 ? "is-active" : ""}
									>
										<span className="dc-step-number">
											{pairing && index === 0 ? <FiCheck aria-hidden /> : index + 1}
										</span>
										<span>{t(key as "deviceHubStepDetails")}</span>
									</li>
								))}
							</ol>
							<form
								className="dc-form"
								onSubmit={(event) => {
									event.preventDefault();
									void pair();
								}}
							>
								<div className="dc-field">
									<label htmlFor="dc-hub-url">{t("deviceHubHubUrl")}</label>
									<input
										id="dc-hub-url"
										type="url"
										autoComplete="url"
										required
										placeholder={t("deviceHubHubPlaceholder")}
										value={hubUrl}
										disabled={!!pairing || !!busy}
										onChange={(event) => {
											dirty.current = true;
											setHubUrl(event.target.value);
										}}
									/>
								</div>
								<div className="dc-field">
									<label htmlFor="dc-device-name">{t("deviceHubName")}</label>
									<input
										id="dc-device-name"
										maxLength={80}
										required
										autoComplete="off"
										placeholder={t("deviceHubNamePlaceholder")}
										value={name}
										disabled={!!pairing || !!busy}
										onChange={(event) => {
											dirty.current = true;
											setName(event.target.value);
										}}
									/>
								</div>
								{!pairing && (
									<div className="dc-actions">
										<button className="dc-button is-primary" type="submit" disabled={!!busy}>
											<FiLink aria-hidden />
											{t(busy ? "deviceHubWorking" : "deviceHubGetCode")}
										</button>
									</div>
								)}
							</form>
							{pairing && (
								<div className="dc-pairing">
									<span className="dc-code-label">{t("deviceHubCode")}</span>
									<div className="dc-code-row">
										<code className="dc-code">{pairing.code}</code>
										<button
											className="dc-icon-button"
											type="button"
											aria-label={t("deviceHubCopy")}
											onClick={() => void copyCode()}
										>
											<FiCopy aria-hidden />
										</button>
									</div>
									<div className="dc-pair-meta">
										{t(seconds ? "deviceHubExpires" : "deviceHubExpired", { time: remaining })}
									</div>
									<div className="dc-actions">
										{hubLink}
										<button
											type="button"
											className="dc-button"
											disabled={!!busy}
											onClick={() => {
												++generation.current;
												setPairing(null);
												setError("");
												setNotice("");
											}}
										>
											<FiRefreshCw aria-hidden />
											{t("deviceHubNewCode")}
										</button>
									</div>
									{seconds > 0 && (
										<p className="dc-progress" role="status">
											<FiRefreshCw aria-hidden />
											{t("deviceHubWaiting")}
										</p>
									)}
								</div>
							)}
						</section>
					)}
					{bound && status && !localOnly && (
						<>
							{view === "overview" && (
								<section className="dc-card">
									<div className="dc-device-summary">
										<span className="dc-device-icon">
											<FiMonitor aria-hidden />
										</span>
										<div>
											<h2>{status.name}</h2>
											<p>{t("deviceHubDeviceTitle")}</p>
										</div>
									</div>
									<dl className="dc-details">
										<div>
											<dt>{t("deviceHubDeviceId")}</dt>
											<dd>{status.deviceId}</dd>
										</div>
										<div>
											<dt>{t("deviceHubHubUrl")}</dt>
											<dd>{status.hubUrl}</dd>
										</div>
									</dl>
									<div className="dc-actions">{hubLink}</div>
								</section>
							)}
							{view === "settings" && (
								<section className="dc-card">
									<div className="dc-card-header">
										<span className="dc-icon">
											<FiShield aria-hidden />
										</span>
										<div>
											<h2>{t("deviceHubPermissions")}</h2>
										</div>
									</div>
									<div className="dc-permission-row">
										<div>
											<h3 id="dc-permission-label">{t("deviceHubPermissionLabel")}</h3>
											<p id="dc-permission-hint">{t("deviceHubPermissionHint")}</p>
										</div>
										<button
											type="button"
											className={`dc-toggle${status.allowExecution ? " is-on" : ""}`}
											role="switch"
											aria-checked={status.allowExecution}
											aria-labelledby="dc-permission-label"
											aria-describedby="dc-permission-hint"
											disabled={!!busy}
											onClick={() => void togglePermission()}
										>
											<span className="dc-toggle-thumb" />
										</button>
									</div>
									<p className="dc-permission-state" role="status">
										{t(
											busy === "permission"
												? "deviceHubSaving"
												: status.allowExecution
													? "deviceHubEnabled"
													: "deviceHubReadOnly",
										)}
									</p>
								</section>
							)}
							{view === "settings" && (
								<details className="dc-advanced">
									<summary>{t("deviceHubAdvanced")}</summary>
									<div className="dc-danger-zone">
										<h3>{t("deviceHubDisconnect")}</h3>
										<p>{t("deviceHubDisconnectHint")}</p>
										<button
											type="button"
											className="dc-button is-danger"
											disabled={!!busy}
											onClick={() => void disconnect()}
										>
											{t(busy === "disconnect" ? "deviceHubWorking" : "deviceHubDisconnect")}
										</button>
									</div>
								</details>
							)}
						</>
					)}
					{bound && status?.hubUrl && status.deviceId && !localOnly && view !== "groups" && (
						<DeviceDirectory
							key={`${status.hubUrl}:${status.deviceId}`}
							hubUrl={status.hubUrl}
							currentDeviceId={status.deviceId}
						/>
					)}
					{view === "groups" && <DeviceGroups navigation={navigation} />}
					<aside className="dc-help">
						<FiHelpCircle className="dc-help-icon" aria-hidden />
						<div>
							<h3>{t("deviceHubHelpTitle")}</h3>
							<p>{t("deviceHubHelpText")}</p>
						</div>
					</aside>
				</main>
			</div>
		</section>
	);
}
