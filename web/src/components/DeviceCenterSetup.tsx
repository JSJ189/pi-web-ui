import { useEffect, useRef, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type { createPluginHostApi } from "../plugin-host";
import {
	buildHubDeploymentPrompt,
	HUB_INSTALL_EXAMPLE,
	isLocalSetupOrigin,
	validateHubSetup,
	type DeviceCenterSetupInfo,
} from "../device-center-setup";

export function DeviceCenterSetup({
	onConnect,
	initialHubUrl = "",
}: {
	onConnect: (url: string) => void;
	initialHubUrl?: string;
}) {
	const t = useT();
	const [existingUrl, setExistingUrl] = useState(initialHubUrl);
	const [detail, setDetail] = useState("");
	const [assistBusy, setAssistBusy] = useState(false);
	const [assistError, setAssistError] = useState(false);
	const assistPending = useRef(false);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [mode, setMode] = useState<"connect" | "create" | null>(null);
	const [target, setTarget] = useState<"current" | "remote" | "none">("current");
	const [info, setInfo] = useState<DeviceCenterSetupInfo | null>(null);
	const [host, setHost] = useState("127.0.0.1");
	const [port, setPort] = useState("8790");
	const [publicUrl, setPublicUrl] = useState("http://127.0.0.1:8790");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [metadataError, setMetadataError] = useState(false);
	const [result, setResult] = useState<{ publicUrl: string; output: string } | null>(null);
	const controller = useRef<AbortController | null>(null);
	const locked = useRef(false);
	const local = isLocalSetupOrigin(window.location.origin);
	useEffect(() => () => controller.current?.abort(), []);
	const load = async () => {
		if (locked.current) return;
		controller.current?.abort();
		const request = new AbortController();
		controller.current = request;
		setError(false);
		setLoaded(false);
		setMetadataError(false);
		try {
			const response = await fetch(withToken(appUrl("/api/device-center/setup")), {
				credentials: "same-origin",
				signal: request.signal,
			});
			if (!response.ok) throw new Error();
			const data = (await response.json()) as DeviceCenterSetupInfo;
			if (
				!data ||
				typeof data.platform !== "string" ||
				typeof data.nodeVersion !== "string" ||
				typeof data.dataDir !== "string" ||
				typeof data.cliPath !== "string" ||
				!validateHubSetup({ host: "127.0.0.1", port: data.defaultPort, publicUrl: data.defaultPublicUrl })
			)
				throw new Error();
			if (request.signal.aborted) return;
			setInfo(data);
			if (data.installation?.installed) {
				setHost(data.installation.host ?? "127.0.0.1");
				setPort(String(data.installation.port));
				setPublicUrl(data.installation.publicUrl ?? "");
				setExistingUrl(data.installation.publicUrl ?? "");
			} else if (!info) {
				setPort(String(data.defaultPort));
				setPublicUrl(data.defaultPublicUrl);
			}
		} catch {
			if (!request.signal.aborted) {
				setError(true);
				setMetadataError(true);
			}
		} finally {
			if (!request.signal.aborted) setLoaded(true);
		}
	};
	const install = async () => {
		const input = { host, port: Number(port), publicUrl };
		if (
			locked.current ||
			!local ||
			!info ||
			!loaded ||
			metadataError ||
			info.busy ||
			info.installation?.installed ||
			!validateHubSetup(input)
		)
			return;
		locked.current = true;
		controller.current?.abort();
		setBusy(true);
		setError(false);
		setDetail("");
		const request = new AbortController();
		controller.current = request;
		try {
			const response = await fetch(withToken(appUrl("/api/device-center/setup")), {
				credentials: "same-origin",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...input, allowRegistration: true }),
				signal: request.signal,
			});
			if (response.status === 409) {
				setInfo((previous) => (previous ? { ...previous, busy: true } : previous));
				locked.current = false;
				setBusy(false);
				await load();
				return;
			}
			if (!response.ok) {
				const failure = await response.json().catch(() => ({}));
				throw new Error(typeof failure.error === "string" ? failure.error.slice(0, 4096) : `HTTP ${response.status}`);
			}
			const data = (await response.json()) as { publicUrl: string; output: string };
			if (!validateHubSetup({ ...input, publicUrl: data.publicUrl }) || typeof data.output !== "string")
				throw new Error();
			if (!request.signal.aborted) setResult(data);
		} catch (cause) {
			if (!request.signal.aborted) {
				setError(true);
				setDetail(cause instanceof Error ? cause.message.slice(0, 4096) : "");
			}
		} finally {
			locked.current = false;
			if (!request.signal.aborted) setBusy(false);
		}
	};
	const installation = info?.installation;
	const installed = !!installation?.installed;
	const healthy = installed && installation.running && installation.owned;
	const input = { host, port: Number(port), publicUrl };
	const valid = validateHubSetup(input);
	const assist = () => {
		if (!valid || target === "none" || assistPending.current) return;
		assistPending.current = true;
		setAssistBusy(true);
		setAssistError(false);
		const complete = (ok: boolean) => {
			assistPending.current = false;
			if (!mounted.current) return;
			setAssistBusy(false);
			setAssistError(!ok);
		};
		const api = (window as unknown as { __piWebUiHost?: ReturnType<typeof createPluginHostApi> }).__piWebUiHost;
		try {
			if (!api?.startChat({ newChat: true, prompt: buildHubDeploymentPrompt(input, info, target), onResult: complete }))
				complete(false);
		} catch {
			complete(false);
		}
	};
	return (
		<section className="dc-onboarding">
			<h3>{t("deviceSetupWelcome")}</h3>
			<p>{t("deviceSetupIntro")}</p>
			<div className="dc-actions">
				<button
					className="dc-button"
					disabled={busy}
					aria-pressed={mode === "connect"}
					onClick={() => setMode("connect")}
				>
					{t("deviceSetupConnect")}
				</button>
				<button
					className="dc-button"
					disabled={busy}
					aria-pressed={mode === "create"}
					onClick={() => {
						setMode("create");
						if (!info && local) void load();
					}}
				>
					{t("deviceSetupCreate")}
				</button>
			</div>
			{mode === "connect" && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						onConnect(existingUrl.trim());
					}}
				>
					<label className="dc-field">
						<span>{t("deviceHubHubUrl")}</span>
						<input
							type="url"
							required
							maxLength={2048}
							value={existingUrl}
							onChange={(e) => setExistingUrl(e.target.value)}
							placeholder="https://hub.example.com"
						/>
					</label>
					<button
						className="dc-button is-primary"
						disabled={!validateHubSetup({ host: "localhost", port: 8790, publicUrl: existingUrl.trim() })}
					>
						{t("deviceSetupPair")}
					</button>
				</form>
			)}
			{mode === "create" && (
				<>
					<label className="dc-field">
						<span>{t("deviceSetupTarget")}</span>
						<select disabled={busy} value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
							<option value="current">{t("deviceSetupCurrent")}</option>
							<option value="remote">{t("deviceSetupRemote")}</option>
							<option value="none">{t("deviceSetupNoServer")}</option>
						</select>
					</label>
					{target === "none" ? (
						<p>{t("deviceSetupNoServerHint")}</p>
					) : (
						<>
							<p>{t(target === "current" ? "deviceSetupCurrentHint" : "deviceSetupRemoteHint")}</p>
							{target === "current" && (
								<div className="dc-setup-plan">
									<strong>{t("deviceSetupPlan")}</strong>
									<p>{t("deviceSetupPlanHint")}</p>
									{info && (
										<dl>
											<dt>{t("deviceSetupEnvironment")}</dt>
											<dd>
												{info.platform} · Node {info.nodeVersion}
											</dd>
											<dt>{t("deviceSetupDataDir")}</dt>
											<dd>{info.dataDir}</dd>
											<dt>{t("deviceSetupCli")}</dt>
											<dd>{info.cliPath}</dd>
										</dl>
									)}
									{!local && <p role="status">{t("deviceSetupLocalOnly")}</p>}
									<p>{t("deviceSetupBackground")}</p>
									{installed && (
										<div role="status">
											<h4>{t(healthy ? "deviceSetupRestored" : "deviceSetupUnhealthy")}</h4>
											<p>{installation.publicUrl}</p>
											{healthy && valid && installation.publicUrl ? (
												<div className="dc-actions">
													<a
														className="dc-button"
														href={installation.publicUrl}
														target="_blank"
														rel="noopener noreferrer"
													>
														{t("deviceHubOpenHub")}
													</a>
													<button className="dc-button" onClick={() => onConnect(installation.publicUrl!)}>
														{t("deviceSetupPair")}
													</button>
												</div>
											) : (
												<>
													<p>{t("deviceSetupRecovery")}</p>
													<pre className="dc-setup-output">{"pi-web-ui hub status --json\npi-web-ui hub --help"}</pre>
												</>
											)}
										</div>
									)}
									{info?.busy && <p role="status">{t("deviceSetupBusy")}</p>}
									{local && (
										<button className="dc-button" disabled={busy || !loaded} onClick={() => void load()}>
											{t(loaded ? "deviceSetupRetry" : "deviceHubWorking")}
										</button>
									)}
								</div>
							)}
							<div className="dc-setup-fields">
								<label className="dc-field">
									<span>{t("deviceSetupHost")}</span>
									<input
										disabled={busy || !!result}
										maxLength={253}
										value={host}
										onChange={(e) => setHost(e.target.value)}
									/>
								</label>
								<label className="dc-field">
									<span>{t("deviceSetupPort")}</span>
									<input
										disabled={busy || !!result}
										type="number"
										min={1024}
										max={65535}
										value={port}
										onChange={(e) => setPort(e.target.value)}
									/>
								</label>
								<label className="dc-field">
									<span>{t("deviceHubHubUrl")}</span>
									<input
										disabled={busy || !!result}
										maxLength={2048}
										value={publicUrl}
										onChange={(e) => setPublicUrl(e.target.value)}
									/>
								</label>
							</div>
							<p className="dc-setup-warning">{t("deviceSetupReachable")}</p>
							<p>{t("deviceSetupRegistration")}</p>
							{!valid && <p role="alert">{t("deviceSetupInvalid")}</p>}
							{target === "remote" && (
								<>
									<p>{t("deviceSetupCliHint")}</p>
									<pre className="dc-setup-output">{HUB_INSTALL_EXAMPLE}</pre>
								</>
							)}
							<div className="dc-actions">
								{target === "current" && !result && !installed && (
									<button
										className="dc-button is-primary"
										disabled={busy || !local || !info || !loaded || metadataError || !!info.busy || !valid}
										onClick={() => void install()}
									>
										{t(busy ? "deviceSetupInstalling" : "deviceSetupInstall")}
									</button>
								)}
								<button className="dc-button" disabled={busy || assistBusy || !valid} onClick={assist}>
									{t("deviceSetupAi")}
								</button>
							</div>
							<p>{t("deviceSetupAiHint")}</p>
							{assistBusy && <p role="status">{t("deviceSetupAiCreating")}</p>}
							{assistError && <p role="alert">{t("deviceSetupAiFailed")}</p>}
						</>
					)}
				</>
			)}
			{error && (
				<div role="alert">
					<p>{t("deviceSetupFailed")}</p>
					{detail && <pre className="dc-setup-output">{detail}</pre>}
				</div>
			)}
			{result && (
				<div role="status">
					<h4>{t("deviceSetupSuccess")}</h4>
					<pre className="dc-setup-output">{result.output.slice(0, 16000)}</pre>
					<div className="dc-actions">
						<a className="dc-button" href={result.publicUrl} target="_blank" rel="noopener noreferrer">
							{t("deviceHubOpenHub")}
						</a>
						<button className="dc-button is-primary" onClick={() => onConnect(result.publicUrl)}>
							{t("deviceSetupPair")}
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
