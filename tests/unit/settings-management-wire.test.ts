import { describe, expect, it, vi } from "vitest";
import { handleSettingsMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/index.js";
import type { ClientMessage } from "../../server/protocol.js";

describe("management settings wire", () => {
	it("forwards skill catalog and code mode preferences without losing explicit false or zero", () => {
		const setSettings = vi.fn();
		const patch = {
			skillsCatalogMaxDesc: 0,
			skillsCatalogShowLocation: false,
			skillsCatalogBudget: 1600,
			codemodeMode: "only" as const,
			codemodeInlineBudget: 800,
		};
		const msg: ClientMessage = { type: "set_settings", ...patch };
		expect(handleSettingsMessage(msg, { setSettings } as unknown as DispatchSession)).toBe(true);
		expect(setSettings).toHaveBeenCalledWith(expect.objectContaining(patch));
	});
});
