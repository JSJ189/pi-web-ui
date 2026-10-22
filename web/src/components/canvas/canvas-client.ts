/**
 * canvas-client.ts — Canvas Studio 独立 WebSocket 客户端。
 *
 * 绕行主 use-chat.ts，独立持有与服务端的专用事件与状态通道。
 */
import { appUrl } from "../../base-url";
import { PROTOCOL_VERSION } from "../../protocol-version";
import type { ClientMessage, ServerMessage } from "../../types";
import { randomUuid } from "../../uuid";

type CanvasMessageListener = (msg: ServerMessage) => void;

export class CanvasClient {
	private ws: WebSocket | null = null;
	private readonly clientId = `canvas:${randomUuid().slice(0, 8)}`;
	private readonly listeners = new Set<CanvasMessageListener>();
	private disposed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	connect(): void {
		if (this.disposed || this.ws) return;
		try {
			const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = `${wsProtocol}//${location.host}${appUrl("/ws")}`;
			const ws = new WebSocket(wsUrl);
			this.ws = ws;

			ws.onopen = () => {
				if (this.ws !== ws) return;
				this.send({
					type: "hello",
					clientId: this.clientId,
					protocolVersion: PROTOCOL_VERSION,
				});
				this.send({ type: "canvas_list" });
				this.send({ type: "canvas_load", id: "default" });
			};

			ws.onmessage = (ev) => {
				if (this.ws !== ws) return;
				try {
					const msg = JSON.parse(ev.data as string) as ServerMessage;
					for (const l of this.listeners) {
						l(msg);
					}
				} catch {
					// 忽略格式错误
				}
			};

			ws.onclose = () => {
				if (this.ws === ws) {
					this.ws = null;
				}
				if (!this.disposed && !this.reconnectTimer) {
					this.reconnectTimer = setTimeout(() => {
						this.reconnectTimer = null;
						this.connect();
					}, 2000);
				}
			};
		} catch {
			// 忽略网络初始化错误
		}
	}

	send(msg: ClientMessage): boolean {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
			return true;
		}
		return false;
	}

	subscribe(fn: CanvasMessageListener): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	dispose(): void {
		this.disposed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.listeners.clear();
	}
}
