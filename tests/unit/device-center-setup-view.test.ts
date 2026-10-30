// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n";
import { DeviceCenterSetup } from "../../web/src/components/DeviceCenterSetup";
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups
		.splice(0)
		.reverse()
		.forEach((fn) => fn());
	vi.unstubAllGlobals();
});
async function mount(installation: unknown, status = 200) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: status === 200,
			status,
			json: async () => ({
				platform: "linux",
				nodeVersion: "22",
				defaultPort: 8790,
				defaultPublicUrl: "http://127.0.0.1:8790",
				dataDir: "/data/hub",
				cliPath: "/bin/pi",
				busy: false,
				installation,
			}),
		})),
	);
	localStorage.setItem("pi-web-ui:lang", "en");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const connect = vi.fn();
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	await act(async () =>
		root.render(createElement(LanguageProvider, null, createElement(DeviceCenterSetup, { onConnect: connect }))),
	);
	await act(async () =>
		Array.from(container.querySelectorAll("button"))
			.find((button) => button.textContent === "Create my own center")!
			.click(),
	);
	return { container, connect };
}
it("restores the installed address and continues pairing without offering reinstall", async () => {
	const { container, connect } = await mount({
		installed: true,
		running: true,
		owned: true,
		publicUrl: "https://hub.example.com",
		host: "0.0.0.0",
		port: 8790,
		dataDir: "/data/hub",
	});
	expect(container.querySelector('a[href="https://hub.example.com"]')).not.toBeNull();
	expect(container.textContent).not.toContain("Install and connect");
	await act(async () =>
		Array.from(container.querySelectorAll("button"))
			.find((button) => button.textContent === "Use this center URL to start pairing")!
			.click(),
	);
	expect(connect).toHaveBeenCalledWith("https://hub.example.com");
});
it("offers diagnostics rather than reinstall for unhealthy installations", async () => {
	const { container } = await mount({
		installed: true,
		running: false,
		owned: true,
		publicUrl: null,
		host: null,
		port: null,
		dataDir: null,
	});
	expect(container.textContent).toContain("pi-web-ui hub status --json");
	expect(container.textContent).not.toContain("Install and connect");
});
it("status lookup failure cannot authorize installation", async () => {
	const { container } = await mount(null, 503);
	const install = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Install and connect",
	)!;
	expect(install.disabled).toBe(true);
});

it("shows pending deployment, blocks duplicate clicks and restores retry after failure", async () => {
	let complete: ((ok: boolean) => void) | undefined;
	const startChat = vi.fn((options: { onResult?: (ok: boolean) => void }) => {
		complete = options.onResult;
		return true;
	});
	vi.stubGlobal("__piWebUiHost", { startChat });
	const { container } = await mount({
		installed: false,
		running: false,
		owned: false,
		publicUrl: null,
		host: null,
		port: null,
		dataDir: null,
	});
	const button = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Ask AI to help deploy",
	)!;
	await act(async () => {
		button.click();
		button.click();
	});
	expect(startChat).toHaveBeenCalledTimes(1);
	expect(button.disabled).toBe(true);
	expect(container.textContent).toContain("Creating the deployment conversation");
	await act(async () => complete!(false));
	expect(button.disabled).toBe(false);
	expect(container.querySelector("[role=alert]")?.textContent).toContain("Could not create or send");
	await act(async () => button.click());
	expect(startChat).toHaveBeenCalledTimes(2);
});
