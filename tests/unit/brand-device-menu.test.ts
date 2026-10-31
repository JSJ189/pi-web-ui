// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrandDeviceMenu } from "../../web/src/components/BrandDeviceMenu.js";
import { LanguageProvider } from "../../web/src/i18n.js";

it.each(["unpaired", "paired", "local"])("shows device shortcuts only for an external binding (%s)", async (mode) => {
	const paired = mode === "paired";
	const fetchMock = vi.fn(async (url: unknown) => ({
		ok: true,
		json: async () =>
			String(url).includes("/chat-status")
				? paired
					? { hubUrl: "https://hub.example.com", deviceId: "win" }
					: mode === "local"
						? { hubUrl: "http://127.0.0.1:8999", deviceId: "local-device", local: true }
						: {}
				: { devices: [{ id: "mac", name: "Mac", online: true }] },
	}));
	vi.stubGlobal("fetch", fetchMock);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				createElement(LanguageProvider, null, createElement(BrandDeviceMenu, { label: "Custom brand", barItem: true })),
			),
		);
		expect(host.textContent).toContain("Custom brand");
		const trigger = host.querySelector<HTMLButtonElement>("button");
		if (!paired) {
			expect(trigger).toBeNull();
			expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/device-center/devices"))).toBe(false);
			return;
		}
		expect(trigger?.dataset.barItem).toBe("host:brand");
		await act(async () => trigger!.click());
		const panel = document.body.querySelector('[role="dialog"]');
		expect(panel).not.toBeNull();
		expect(host.contains(panel)).toBe(false);
		expect(panel?.textContent).toContain("Mac");
		expect([...panel!.querySelectorAll<HTMLAnchorElement>(".dd-device a")].map((link) => link.href)).toEqual([
			"https://hub.example.com/device/mac",
			"https://hub.example.com/device/mac/desktop",
		]);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => trigger!.click());
		await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
	} finally {
		act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
