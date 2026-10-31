import { useEffect, useState } from "react";
import { FiExternalLink, FiMonitor, FiRefreshCw } from "react-icons/fi";
import { appUrl } from "../base-url";
import { openDeviceAccess } from "../device-access";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";

type Device = { id: string; name: string; online: boolean; alias?: string };
export function DeviceDirectory({ hubUrl, currentDeviceId }: { hubUrl: string; currentDeviceId: string }) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [devices, setDevices] = useState<Device[]>([]);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		let stopped = false;
		let controller: AbortController | undefined;
		let timer: ReturnType<typeof setTimeout>;
		async function load() {
			controller = new AbortController();
			try {
				const response = await fetch(withToken(appUrl("/api/device-center/devices")), {
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
					credentials: "same-origin",
				});
				if (!response.ok)
					throw new Error(
						response.status === 409
							? zh
								? "请重新绑定本机以读取设备列表。"
								: "Pair this computer again to read the device list."
							: zh
								? "无法读取设备列表，请重试。"
								: "Could not load devices. Try again.",
					);
				const data = await response.json();
				if (!Array.isArray(data.devices)) throw new Error(zh ? "设备列表格式异常。" : "Invalid device list.");
				if (!stopped) {
					setDevices(data.devices);
					setError("");
				}
			} catch (cause) {
				if (!stopped) {
					setDevices([]);
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			} finally {
				if (!stopped) timer = setTimeout(load, 5000);
			}
		}
		void load();
		return () => {
			stopped = true;
			controller?.abort();
			clearTimeout(timer);
		};
	}, [hubUrl, currentDeviceId, refresh, zh]);
	function target(id: string): string | undefined {
		try {
			const base = new URL(hubUrl);
			if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return;
			return new URL(`/device/${encodeURIComponent(id)}`, base).href;
		} catch {
			return;
		}
	}
	async function openDevice(event: React.MouseEvent<HTMLAnchorElement>, id: string, desktop = false) {
		event.preventDefault();
		try {
			await openDeviceAccess(id, hubUrl, desktop, zh);
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}
	return (
		<section className="dc-card" aria-label={zh ? "所有设备" : "All devices"}>
			<div className="dc-card-header">
				<span className="dc-icon">
					<FiMonitor aria-hidden />
				</span>
				<div>
					<h2>
						{zh ? "所有设备" : "All devices"} · {devices.length}
					</h2>
					<p>
						{zh
							? "同一账号下的设备，使用本机绑定授权直接访问。"
							: "Devices in your account. Access is authorized through this computer's pairing."}
					</p>
				</div>
				<button
					type="button"
					className="dc-icon-button"
					aria-label={zh ? "刷新设备" : "Refresh devices"}
					onClick={() => setRefresh((n) => n + 1)}
				>
					<FiRefreshCw />
				</button>
			</div>
			{error && (
				<p className="dc-notice is-error" role="alert">
					{error}
				</p>
			)}
			<div className="dd-list">
				{devices.map((device) => (
					<div className="dd-device" key={device.id}>
						<span className="dc-device-icon">
							<FiMonitor aria-hidden />
						</span>
						<div className="dd-identity">
							<strong>{device.name}</strong>
							<span>{device.id === currentDeviceId ? (zh ? "本机" : "This device") : device.id}</span>
						</div>
						<span className={`dc-status ${device.online ? "is-online" : "is-offline"}`}>
							{device.online ? (zh ? "在线" : "Online") : zh ? "离线" : "Offline"}
						</span>
						{target(device.id) && (
							<div className="dc-actions">
								<a
									className="dc-button"
									href={target(device.id)}
									target="_blank"
									rel="noopener noreferrer"
									onClick={(event) => void openDevice(event, device.id)}
								>
									<FiExternalLink aria-hidden />
									{zh ? "打开设备" : "Open device"}
								</a>
								<a
									className="dc-button"
									href={`${target(device.id)}/desktop`}
									target="_blank"
									rel="noopener noreferrer"
									onClick={(event) => void openDevice(event, device.id, true)}
								>
									<FiMonitor aria-hidden />
									{zh ? "远程桌面" : "Remote desktop"}
								</a>
							</div>
						)}
					</div>
				))}
			</div>
		</section>
	);
}
