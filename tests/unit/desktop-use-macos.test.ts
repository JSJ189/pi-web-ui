import { afterEach, describe, expect, it, vi } from "vitest";

const { runMac } = vi.hoisted(() => ({ runMac: vi.fn() }));
vi.mock("../../plugins/desktop-use/mac-backend.mjs", () => ({ runMac }));
import plugin from "../../plugins/desktop-use/index.mjs";
import { parseShortcut } from "../../plugins/desktop-use/actions.mjs";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	vi.resetAllMocks();
});

function activate() {
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	const tools = new Map<string, any>();
	const host = {
		registerAgentTool: (tool: any) => {
			tools.set(tool.name, tool);
			return () => {};
		},
		log: vi.fn(),
		notify: vi.fn(),
	};
	const runtime = plugin.activate(host);
	return { tools, runtime, host };
}

describe("desktop-use native macOS routing", () => {
	it("registers the existing tools without starting npm dependency installation", () => {
		const { tools, runtime, host } = activate();
		expect(tools.size).toBe(8);
		expect(host.notify).not.toHaveBeenCalled();
		runtime.deactivate();
	});
	it("queries native elements and uses the snapshot rectangle for clicks", async () => {
		const { tools, runtime } = activate();
		runMac.mockResolvedValueOnce({
			ok: true,
			count: 1,
			nodes: [{ id: "0", type: "Button", name: "Send", rect: { x: 20, y: 40, w: 100, h: 20 } }],
		});
		const result = await tools.get("desktop_elements").execute("1", { scope: "foreground" });
		runMac.mockResolvedValueOnce({ ok: true });
		await tools.get("desktop_click").execute("2", { dump: result.details.dump, id: "0" });
		expect(runMac.mock.calls[0][0]).toBe("elements");
		expect(runMac.mock.calls[1]).toEqual(["click", expect.objectContaining({ X: 70, Y: 50 }), expect.any(Object)]);
		runtime.deactivate();
	});
	it("routes Unicode input and Command shortcuts without Windows or clipboard helpers", async () => {
		const { tools, runtime } = activate();
		runMac.mockResolvedValue({ ok: true });
		await tools.get("desktop_type").execute("1", { text: "中文😀" });
		await tools.get("desktop_key").execute("2", { keys: "cmd+c" });
		expect(runMac.mock.calls[0]).toEqual(["paste", expect.objectContaining({ Text: "中文😀" }), expect.any(Object)]);
		expect(runMac.mock.calls[1]).toEqual(["key", expect.objectContaining({ Keys: "win+c" }), expect.any(Object)]);
		expect(parseShortcut("option+command+c")).toEqual(["alt", "win", "c"]);
		expect(() => parseShortcut("cmd+win+c")).toThrow();
		runtime.deactivate();
	});
	it("propagates native permission errors instead of falling back to physical input", async () => {
		const { tools, runtime } = activate();
		runMac.mockRejectedValue(new Error("Accessibility permission required"));
		await expect(tools.get("desktop_elements").execute("1", {})).rejects.toThrow("Accessibility permission required");
		expect(runMac).toHaveBeenCalledTimes(1);
		runtime.deactivate();
	});
});
