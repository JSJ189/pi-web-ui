// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CanvasClient } from "../../web/src/components/canvas/canvas-client";
class Socket {
	static OPEN = 1;
	static instances: Socket[] = [];
	readyState = 1;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	sent: string[] = [];
	constructor(_url: string) {
		Socket.instances.push(this);
	}
	send(text: string) {
		this.sent.push(text);
	}
	close() {
		this.onclose?.();
	}
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	localStorage.clear();
	Socket.instances = [];
});
it("notifies socket loss and reconnects with a fresh correlated load for the selected graph", () => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", Socket);
	const client = new CanvasClient(),
		states: boolean[] = [],
		loads: { id: string; requestId?: string }[] = [];
	const unsubscribe = client.subscribeConnection((connected) => states.push(connected));
	client.onLoadRequest = (request) => loads.push(request);
	client.connect();
	Socket.instances[0].onopen?.();
	client.setCurrentGraphId("selected");
	Socket.instances[0].close();
	expect(states).toEqual([true, false]);
	vi.advanceTimersByTime(2000);
	Socket.instances[1].onopen?.();
	expect(states).toEqual([true, false, true]);
	expect(loads[1].id).toBe("selected");
	expect(loads[1].requestId).toBeTruthy();
	expect(loads[1].requestId).not.toBe(loads[0].requestId);
	expect(Socket.instances[1].sent.map((raw) => JSON.parse(raw)).find((msg) => msg.type === "canvas_load")).toEqual(
		loads[1],
	);
	unsubscribe();
	client.dispose();
	expect(states).toEqual([true, false, true]);
});
