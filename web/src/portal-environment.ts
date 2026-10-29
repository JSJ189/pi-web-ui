import { relayBase } from "./base-url";

/** Per-document fallback: opaque frames cannot persist browser storage. */
export function createMemoryStorage(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		clear() {
			entries.clear();
		},
		getItem(key) {
			return entries.get(String(key)) ?? null;
		},
		key(index) {
			return [...entries.keys()][Number(index) >>> 0] ?? null;
		},
		removeItem(key) {
			entries.delete(String(key));
		},
		setItem(key, value) {
			entries.set(String(key), String(value));
		},
	};
}

/** No application dependencies: this must evaluate before modules reading storage. */
export function installPortalEnvironment(target: Window): boolean {
	const base = relayBase(target.location.pathname);
	if (!base) return false;
	let opaque = false;
	for (const name of ["localStorage", "sessionStorage"] as const) {
		try {
			// Available storage belongs to the embedding environment; preserve it.
			void target[name];
		} catch {
			opaque = true;
			Object.defineProperty(target, name, {
				configurable: true,
				enumerable: true,
				value: createMemoryStorage(),
			});
		}
	}
	if (!opaque) return false;

	// location.origin describes the URL, not the sandbox's opaque security origin.
	// Only this frame's capability may have credentialed requests downgraded.
	const originalFetch = target.fetch;
	target.fetch = (input, init) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(href, target.document.baseURI || target.location.href);
		if (url.origin === target.location.origin && url.pathname.startsWith(base)) {
			return originalFetch.call(target, input, { ...init, credentials: "omit" });
		}
		return originalFetch.call(target, input, init);
	};
	return true;
}

export const opaquePortalEnvironment = typeof window !== "undefined" && installPortalEnvironment(window);
