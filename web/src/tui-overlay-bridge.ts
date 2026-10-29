/** Direct ANSI streaming, with a bounded handoff while the terminal chunk loads. */
type TuiOverlayRenderListener = (id: number, ansi: string) => void;

const listeners = new Set<TuiOverlayRenderListener>();
const MAX_PENDING_CHARS = 1024 * 1024;
let pendingId: number | null = null;
let pending: string[] = [];
let pendingChars = 0;

/** A new overlay (or close/disconnect) invalidates any previous pending output. */
export function resetTuiOverlayRender(id: number | null = null): void {
	pendingId = id;
	pending = [];
	pendingChars = 0;
}

export function subscribeTuiOverlayRender(listener: TuiOverlayRenderListener): () => void {
	listeners.add(listener);
	if (pendingId !== null && pending.length) {
		const id = pendingId;
		const frames = pending;
		pending = [];
		pendingChars = 0;
		for (const ansi of frames) listener(id, ansi);
	}
	return () => {
		listeners.delete(listener);
	};
}

export function emitTuiOverlayRender(id: number, ansi: string): void {
	if (id !== pendingId) return;
	if (!listeners.size) {
		// Keep complete frames only; the terminal requests a fresh screen on mount.
		if (pendingChars + ansi.length > MAX_PENDING_CHARS) {
			pending = [];
			pendingChars = 0;
		}
		if (ansi.length <= MAX_PENDING_CHARS) {
			pending.push(ansi);
			pendingChars += ansi.length;
		}
		return;
	}
	for (const listener of listeners) {
		try {
			listener(id, ansi);
		} catch (err) {
			console.error("[tui-overlay-bridge] listener error:", err);
		}
	}
}
