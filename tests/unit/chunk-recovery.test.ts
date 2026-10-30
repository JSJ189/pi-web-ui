import { describe, expect, it, vi } from "vitest";
import { createChunkRecovery, isChunkLoadError } from "../../web/src/chunk-recovery";

const failure = new TypeError(
	"Failed to fetch dynamically imported module: http://localhost/assets/FilePreview-old.js",
);

function environment() {
	const values = new Map<string, string>();
	return {
		storage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		},
		reload: vi.fn(),
		now: () => 100_000,
	};
}

describe("chunk recovery", () => {
	it("recognizes resource failures across browsers without hiding application errors", () => {
		for (const message of [
			failure.message,
			"error loading dynamically imported module",
			"Importing a module script failed.",
			"Unable to preload CSS for /assets/a.css",
			"Loading chunk 12 failed.",
		]) {
			expect(isChunkLoadError(new Error(message))).toBe(true);
		}
		expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
	});

	it("reloads once and persists its guard across document replacement", () => {
		const env = environment();
		const recover = createChunkRecovery("build-a", env);
		expect(recover(failure)).toBe(true);
		expect(recover(failure)).toBe(true);
		expect(env.reload).toHaveBeenCalledTimes(1);
		expect(createChunkRecovery("build-a", env)(failure)).toBe(false);
		expect(createChunkRecovery("build-b", env)(failure)).toBe(false);
		expect(createChunkRecovery("build-b", { ...env, now: () => 160_001 })(failure)).toBe(true);
	});

	it("does not reload unrelated errors or loop when session storage is unavailable", () => {
		const env = environment();
		expect(createChunkRecovery("a", env)(new Error("render failed"))).toBe(false);
		expect(
			createChunkRecovery("a", {
				...env,
				storage: {
					getItem() {
						throw new Error("denied");
					},
					setItem() {},
				},
			})(failure),
		).toBe(false);
		expect(env.reload).not.toHaveBeenCalled();
	});
});
