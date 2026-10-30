// @vitest-environment jsdom
import React, { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeviceGroups } from "../../web/src/components/DeviceGroups";
import { openDeviceGroup, useDeviceGroupNavigation } from "../../web/src/device-group-navigation";

vi.mock("../../web/src/i18n", () => ({ useI18n: () => ({ locale: "en" }), isZhLocale: () => false }));

it("consumes group navigation without dispatching another open request", async () => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ bots: [], rooms: [] }) }));
	const events = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	function Host() {
		const navigation = useDeviceGroupNavigation();
		useEffect(() => {
			const open = (event: Event) => {
				events();
				// Bound the old feedback loop so a regression fails without hanging React.
				if (events.mock.calls.length < 4) openDeviceGroup((event as CustomEvent).detail);
			};
			window.addEventListener("pi-web-ui:device-group-open", open);
			return () => window.removeEventListener("pi-web-ui:device-group-open", open);
		}, []);
		return React.createElement(DeviceGroups, { navigation });
	}
	try {
		await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(Host))));
		await act(async () => openDeviceGroup({ roomId: "room-a" }));
		expect(events).not.toHaveBeenCalled();
		await act(async () => openDeviceGroup({ roomId: "room-b", manage: true }));
		expect(events).not.toHaveBeenCalled();
		await act(async () => openDeviceGroup({ create: true }));
		expect(events).not.toHaveBeenCalled();
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
