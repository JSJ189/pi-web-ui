import { appUrl } from "./base-url";
import { withToken } from "./auth-token";

/** Obtain a device ticket and open it in the isolated desktop window or a browser tab. */
export async function openDeviceAccess(id: string, hubUrl: string, desktop: boolean, zh: boolean) {
	const shell = (window as unknown as { piDesktop?: { openHub?: (url: string) => Promise<boolean> } }).piDesktop;
	const tab = shell?.openHub ? null : window.open("about:blank", "_blank");
	if (!shell?.openHub && !tab) throw new Error(zh ? "请允许弹出窗口后重试。" : "Allow popups and try again.");
	if (tab) tab.opener = null;
	try {
		const response = await fetch(withToken(appUrl(`/api/device-center/devices/${encodeURIComponent(id)}/open`)), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			credentials: "same-origin",
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok)
			throw new Error(
				zh
					? "无法打开设备，请确认设备在线且本机绑定有效。"
					: "Could not open the device. Check connectivity and local pairing.",
			);
		const data = await response.json();
		const url = new URL(data.url);
		const hub = new URL(hubUrl);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.hostname !== hub.hostname ||
			url.username ||
			url.password ||
			!(
				url.pathname === "/__device/open" ||
				(url.origin === hub.origin && url.pathname === `/device/${encodeURIComponent(id)}/__open`)
			)
		)
			throw new Error("Invalid device access URL");
		url.searchParams.delete("next");
		if (desktop) url.searchParams.set("next", "/desktop");
		if (shell?.openHub) {
			if (!(await shell.openHub(url.href)))
				throw new Error(zh ? "无法打开设备窗口。" : "Could not open device window.");
		} else if (tab) tab.location.replace(url.href);
	} catch (error) {
		tab?.close();
		throw error;
	}
}
