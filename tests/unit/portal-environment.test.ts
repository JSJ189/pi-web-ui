import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { relayBase, resolveBase, withAppBase } from "../../web/src/base-url.js";
import { createMemoryStorage, installPortalEnvironment } from "../../web/src/portal-environment.js";

afterEach(() => vi.unstubAllGlobals());

function frame(path = "/device/dev/__relay/cap/index.html?token=auth", blocked = true) {
	const fetch = vi.fn().mockResolvedValue({ ok: true });
	const location = new URL(path, "http://hub:50001");
	const target = { location, document: { baseURI: location.href }, fetch };
	for (const name of ["localStorage", "sessionStorage"]) {
		Object.defineProperty(target, name, {
			configurable: true,
			get: blocked
				? () => {
						throw new DOMException("Opaque origin", "SecurityError");
					}
				: () => storage[name],
		});
	}
	const storage: Record<string, ReturnType<typeof createMemoryStorage>> = {
		localStorage: createMemoryStorage(),
		sessionStorage: createMemoryStorage(),
	};
	return { target: target as unknown as Parameters<typeof installPortalEnvironment>[0], fetch, storage };
}

describe("opaque portal environment", () => {
	it("implements the Storage API with string coercion and insertion order", () => {
		const storage = createMemoryStorage();
		expect(storage.length).toBe(0);
		expect(storage.getItem("missing")).toBeNull();
		expect(storage.key(0)).toBeNull();
		storage.setItem("a", "1");
		storage.setItem("b", "2");
		storage.setItem("a", "3");
		storage.setItem(42 as any, false as any);
		expect(storage.length).toBe(3);
		expect(storage.key(0)).toBe("a");
		expect(storage.key(1)).toBe("b");
		expect(storage.key(-1)).toBeNull();
		expect(storage.getItem("a")).toBe("3");
		expect(storage.getItem("42")).toBe("false");
		storage.removeItem("a");
		storage.removeItem("missing");
		expect(storage.key(0)).toBe("b");
		storage.clear();
		expect(storage.length).toBe(0);
	});

	it("replaces throwing getters before existing storage consumers run, with isolated stores", () => {
		const { target } = frame();
		expect(installPortalEnvironment(target)).toBe(true);
		target.localStorage.setItem("theme", "dark");
		expect(target.localStorage.getItem("theme")).toBe("dark");
		expect(target.sessionStorage.getItem("theme")).toBeNull();
		const another = frame();
		installPortalEnvironment(another.target);
		expect(another.target.localStorage.getItem("theme")).toBeNull();
		const fetch = target.fetch;
		expect(installPortalEnvironment(target)).toBe(false);
		expect(target.fetch).toBe(fetch);
	});

	it("preserves available storage and fetch in a normal relay document", () => {
		const { target, fetch, storage } = frame(undefined, false);
		expect(installPortalEnvironment(target)).toBe(false);
		expect(target.localStorage).toBe(storage.localStorage);
		expect(target.sessionStorage).toBe(storage.sessionStorage);
		expect(target.fetch).toBe(fetch);
	});

	it("preserves an accessible store when only the other getter is blocked", () => {
		const { target, storage } = frame();
		Object.defineProperty(target, "sessionStorage", { value: storage.sessionStorage });
		expect(installPortalEnvironment(target)).toBe(true);
		expect(target.sessionStorage).toBe(storage.sessionStorage);
		expect(target.localStorage.length).toBe(0);
	});

	it.each(["/", "/pi/", "/device/dev/", "/device/dev/__relay/", "/other/device/dev/__relay/cap/"])(
		"does not access blocked storage outside the exact relay route: %s",
		(path) => {
			const { target, fetch } = frame(path);
			expect(installPortalEnvironment(target)).toBe(false);
			expect(() => target.localStorage).toThrow("Opaque origin");
			expect(target.fetch).toBe(fetch);
		},
	);

	it("omits credentials only for this capability, preserving request options", async () => {
		const { target, fetch } = frame();
		installPortalEnvironment(target);
		const options = { method: "POST", body: "payload", credentials: "include" as const };
		await target.fetch("/device/dev/__relay/cap/api/save", options);
		expect(fetch).toHaveBeenLastCalledWith("/device/dev/__relay/cap/api/save", {
			...options,
			credentials: "omit",
		});
		expect(options.credentials).toBe("include");
		await target.fetch(new URL("./api/health?x=1", target.location.href));
		expect(fetch.mock.lastCall?.[1]).toEqual({ credentials: "omit" });
		const request = new Request("http://hub:50001/device/dev/__relay/cap/api/save", options);
		await target.fetch(request);
		expect(fetch).toHaveBeenLastCalledWith(request, { credentials: "omit" });
		for (const url of [
			"/api/health",
			"/device/dev/__relay/other/api/health",
			"/device/dev/__relay/cap-extra/api/health",
			"http://elsewhere/device/dev/__relay/cap/api/health",
		]) {
			await target.fetch(url, options);
			expect(fetch).toHaveBeenLastCalledWith(url, options);
		}
	});

	it("resolves relative fetch against document base metadata", async () => {
		const { target, fetch } = frame();
		Object.defineProperty(target.document, "baseURI", { value: "http://hub:50001/" });
		installPortalEnvironment(target);
		await target.fetch("api/health");
		expect(fetch).toHaveBeenLastCalledWith("api/health", undefined);
	});

	it("evaluates the environment before application imports in the entry point", () => {
		const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
		expect(main.match(/^import .*$/m)?.[0]).toContain('from "./portal-environment"');
	});
});

describe("relay base URLs", () => {
	it("keeps the capability root for index, nested paths, query and base metadata", () => {
		const path = "/device/dev/__relay/cap/";
		expect(relayBase(`${path}index.html`)).toBe(path);
		expect(resolveBase(`${path}nested/view`)).toBe(path);
		vi.stubGlobal("location", new URL(`http://hub:50001${path}?token=auth&base=/wrong/`));
		vi.stubGlobal("document", { baseURI: "http://hub:50001/wrong/" });
		expect(resolveBase()).toBe(path);
		const ws = new URL(withAppBase("/ws", resolveBase()), "http://hub:50001");
		expect(ws.href).toBe(`http://hub:50001${path}ws`);
	});

	it("retains document base behavior for regular deployments", () => {
		vi.stubGlobal("location", new URL("http://hub:50001/pi/"));
		vi.stubGlobal("document", { baseURI: "http://hub:50001/custom/index.html?x=1" });
		expect(resolveBase()).toBe("/custom/");
	});
});
