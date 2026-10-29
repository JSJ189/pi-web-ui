// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeviceDirectory } from "../../web/src/components/DeviceDirectory.js";
import { LanguageProvider } from "../../web/src/i18n.js";
it("lists account devices and links each stable ID through the configured hub", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({
				devices: [
					{ id: "win", name: "Windows", online: true },
					{ id: "mac", name: "Mac", online: false },
				],
			}),
		})),
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(DeviceDirectory, { hubUrl: "http://82.156.246.55:50001", currentDeviceId: "win" }),
				),
			),
		);
		expect(host.querySelectorAll(".dd-device")).toHaveLength(2);
		const links = [...host.querySelectorAll<HTMLAnchorElement>(".dd-device a")];
		expect(links.map((link) => link.href)).toEqual([
			"http://82.156.246.55:50001/device/win",
			"http://82.156.246.55:50001/device/mac",
		]);
		expect(links.every((link) => link.rel.includes("noopener"))).toBe(true);
		expect(host.querySelectorAll(".is-online")).toHaveLength(1);
	} finally {
		act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
