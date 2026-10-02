/**
 * desktop preload — 只暴露最小只读信息 + 更新通道。业务全部走 HTTP/WS，
 * 不走 IPC，避免和 web/ 现有协议分叉；唯独应用内自动更新（issue #180）是
 * 主进程（electron-updater）的事，server sidecar 够不着，所以单开这三个
 * invoke（check/download/quit-install）+ 一个 event 订阅。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/** 与 desktop/main.ts 的 DesktopUpdaterEvent 同构（JSON 过 IPC，字段只增不改）。 */
export interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

contextBridge.exposeInMainWorld("piDesktop", {
	isDesktop: true as const,
	updater: {
		check: () => ipcRenderer.invoke("pi-desktop-updater:check"),
		download: () => ipcRenderer.invoke("pi-desktop-updater:download"),
		quitAndInstall: () => ipcRenderer.invoke("pi-desktop-updater:quit-install"),
		onEvent: (cb: (msg: DesktopUpdaterEvent) => void) => {
			const listener = (_event: IpcRendererEvent, msg: DesktopUpdaterEvent) => cb(msg);
			ipcRenderer.on("pi-desktop-updater:event", listener);
			return () => ipcRenderer.removeListener("pi-desktop-updater:event", listener);
		},
	},
});
