import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSoundSettings, playSound, saveSoundSettings } from "../../web/src/sounds.js";

afterEach(() => vi.unstubAllGlobals());

function storage(value: unknown = null) {
	const getItem = vi.fn(() => (value === null ? null : JSON.stringify(value)));
	const setItem = vi.fn<(key: string, value: string) => void>();
	vi.stubGlobal("localStorage", { getItem, setItem });
	return { setItem };
}

describe("subagent completion sounds", () => {
	it("inherits the old completion preference on upgrade", () => {
		storage({ done: false });
		expect(loadSoundSettings().subagentDone).toBe(false);
	});

	it("persists an independent preference", () => {
		const { setItem } = storage({ done: true, subagentDone: false });
		const settings = loadSoundSettings();
		expect(settings.done).toBe(true);
		expect(settings.subagentDone).toBe(false);
		saveSoundSettings(settings);
		expect(JSON.parse(setItem.mock.calls[0][1])).toMatchObject({ done: true, subagentDone: false });
	});

	it("sanitizes corrupt preferences", () => {
		storage({ subagentDone: "off" });
		expect(loadSoundSettings().subagentDone).toBe(true);
	});

	it("honors both the subagent switch and master switch before accessing audio", () => {
		storage();
		const audioConstructor = vi.fn();
		vi.stubGlobal("window", { AudioContext: audioConstructor });
		playSound("subagentDone", { ...loadSoundSettings(), subagentDone: false });
		playSound("subagentDone", { ...loadSoundSettings(), enabled: false });
		expect(audioConstructor).not.toHaveBeenCalled();
	});
});
