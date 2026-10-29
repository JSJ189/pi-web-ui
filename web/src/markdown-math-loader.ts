import type { default as rehypeKatex } from "rehype-katex";

type MathRenderer = typeof rehypeKatex;
let renderer: MathRenderer | undefined;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** Dynamic import boundary, including the renderer's CSS. */
export const mathRendererImport = {
	load: () => import("./markdown-math-renderer"),
};

export function getMathRenderer() {
	return renderer;
}

export function subscribeMathRenderer(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Share in-flight requests. A failure permits a later request, without notifying
 * subscribers (which would cause mounted candidates to retry indefinitely). */
export function loadMathRenderer(): Promise<void> {
	if (renderer) return Promise.resolve();
	if (!pending) {
		pending = mathRendererImport.load().then(
			(module) => {
				renderer = module.default;
				pending = undefined;
				for (const listener of listeners) listener();
			},
			() => {
				pending = undefined;
			},
		);
	}
	return pending;
}
