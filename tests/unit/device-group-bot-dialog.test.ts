// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceGroupBotDialog } from "../../web/src/components/DeviceGroupBotDialog";
import { LanguageProvider } from "../../web/src/i18n";
vi.mock("../../web/src/components/LocalBots", () => ({
	LocalBots: ({ onCreated }: any) =>
		createElement("button", { onClick: () => onCreated({ id: "new", enabled: true }, true) }, "Save new Bot"),
}));
afterEach(() => vi.unstubAllGlobals());
async function mount() {
	const fetchMock = vi.fn(async (raw: unknown, options?: RequestInit) => ({
		ok: true,
		json: async () =>
			options?.method === "POST"
				? {}
				: String(raw).endsWith("bots")
					? {
							bots: [
								{ id: "old", name: "Existing", enabled: true },
								{ id: "add", name: "Available", enabled: true },
							],
						}
					: { room: { id: "room", botIds: ["old", "concurrent"] } },
	}));
	vi.stubGlobal("fetch", fetchMock);
	const close = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(DeviceGroupBotDialog, {
					room: { id: "room", name: "Team", botIds: ["old"] },
					onClose: close,
				}),
			),
		),
	);
	return {
		fetchMock,
		close,
		cleanup: () => {
			act(() => root.unmount());
			host.remove();
		},
	};
}
const button = (text: RegExp) =>
	[...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => text.test(item.textContent || ""))!;
it("adds existing Bots while retaining the latest group members", async () => {
	const test = await mount();
	try {
		expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
		await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await act(async () => button(/添加到群组|Add to group/).click());
		const write = test.fetchMock.mock.calls.find(([, options]) => options?.method === "POST")!;
		expect(JSON.parse(write[1]!.body as string).botIds).toEqual(["old", "concurrent", "add"]);
		expect(test.close).toHaveBeenCalledOnce();
	} finally {
		test.cleanup();
	}
});
it("creates a Bot with the shared editor and automatically adds it to the group", async () => {
	const test = await mount();
	try {
		await act(async () => button(/新建 Bot|Create Bot/).click());
		await act(async () => button(/Save new Bot/).click());
		const write = test.fetchMock.mock.calls.find(([, options]) => options?.method === "POST")!;
		expect(JSON.parse(write[1]!.body as string).botIds).toEqual(["old", "concurrent", "new"]);
		expect(test.close).toHaveBeenCalledOnce();
	} finally {
		test.cleanup();
	}
});
