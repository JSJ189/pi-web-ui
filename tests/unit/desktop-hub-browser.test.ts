import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock("electron", () => ({
	Menu: { buildFromTemplate: (value: unknown) => value },
	BrowserWindow: class {
		options: any;
		handlers: Record<string, (...args: any[]) => void> = {};
		destroyed = false;
		webContents = {
			session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
			on: vi.fn((event, handler) => {
				this.handlers[event] = handler;
			}),
			setWindowOpenHandler: vi.fn(),
			navigationHistory: { canGoBack: () => false, canGoForward: () => false },
		};
		constructor(options: any) {
			this.options = options;
			state.windows.push(this);
		}
		loadURL = vi.fn(async () => {});
		setMenu = vi.fn();
		setTitle = vi.fn();
		on = vi.fn();
		show = vi.fn();
		focus = vi.fn();
		restore = vi.fn();
		isDestroyed() {
			return this.destroyed;
		}
		isMinimized() {
			return false;
		}
		destroy() {
			this.destroyed = true;
		}
	},
}));
import { createHubBrowser } from "../../desktop/hub-browser.js";
describe("isolated Hub browser", () => {
	beforeEach(() => {
		state.windows.length = 0;
	});
	it("opens device and desktop views separately and consumes fresh tickets on reuse", async () => {
		const open = createHubBrowser();
		const device = "https://hub.example.com/device/mac/__open?ticket=first";
		await open("https://hub.example.com/");
		await open(device);
		await open(`${device}&next=/desktop`);
		await open("https://hub.example.com/device/win/__open?ticket=win");
		expect(state.windows).toHaveLength(4);
		await open(device.replace("first", "fresh"));
		expect(state.windows).toHaveLength(4);
		expect(state.windows[1].loadURL).toHaveBeenLastCalledWith(device.replace("first", "fresh"));
		expect(state.windows[2].loadURL).toHaveBeenCalledOnce();
		expect(state.windows[1].options.webPreferences.partition).toBe(state.windows[0].options.webPreferences.partition);
	});
	it("reuses each origin while keeping Hub pages outside the local session and preload", async () => {
		const open = createHubBrowser();
		await open("http://hub.example.com:8790/");
		await open("http://hub.example.com:8790/pair");
		expect(state.windows).toHaveLength(1);
		const win = state.windows[0];
		expect(win.focus).toHaveBeenCalledOnce();
		expect(win.options.webPreferences).toMatchObject({
			sandbox: true,
			nodeIntegration: false,
			contextIsolation: true,
			webSecurity: true,
		});
		expect(win.options.webPreferences.preload).toBeUndefined();
		await open("https://other.example.com");
		expect(state.windows[1].options.webPreferences.partition).not.toBe(win.options.webPreferences.partition);
		for (const event of ["will-navigate", "will-redirect"]) {
			const preventDefault = vi.fn();
			win.handlers[event]({ preventDefault }, "https://evil.example.com");
			expect(preventDefault).toHaveBeenCalledOnce();
		}
		const callback = vi.fn();
		win.webContents.session.setPermissionRequestHandler.mock.calls[0][0]({}, "media", callback);
		expect(callback).toHaveBeenCalledWith(false);
		await expect(open("file:///etc/passwd")).rejects.toThrow();
	});
});
