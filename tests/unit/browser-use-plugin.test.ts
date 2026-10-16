import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import browserUsePlugin from "../../plugins/browser-use/index.mjs";
import { validatePluginManifest } from "../../server/plugin-manifest-validate.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN_DIR = join(ROOT, "plugins", "browser-use");

describe("browser-use 插件单元测试", () => {
	it("manifest.json 合法且包含完整元数据", () => {
		const raw = readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8");
		const manifest = JSON.parse(raw);
		const val = validatePluginManifest(manifest, "browser-use");
		expect(val.errors).toEqual([]);
		expect(manifest.id).toBe("browser-use");
		expect(manifest.version).toBe("0.3.2");
		expect(manifest.view).toBe(false);
		expect(manifest.permissions).toContain("tools");
		expect(manifest.description).toBeTruthy();
		expect(manifest.descriptionEn).toBeTruthy();
		expect(Array.isArray(manifest.settings)).toBe(true);
		const idleSetting = manifest.settings.find((s: any) => s.key === "idleTimeoutMinutes");
		expect(idleSetting).toBeDefined();
		expect(idleSetting.type).toBe("number");
		expect(idleSetting.default).toBe(15);
		expect(idleSetting.min).toBe(0);
		expect(idleSetting.max).toBe(180);
	});

	it("catalog.json 正确收录 browser-use 插件", () => {
		const raw = readFileSync(join(ROOT, "plugins", "catalog.json"), "utf8");
		const catalog = JSON.parse(raw);
		const item = catalog.find((p: any) => p.id === "browser-use");
		expect(item).toBeDefined();
		expect(item.name).toBe("browser-use");
		expect(item.source).toContain("browser-use");
		expect(item.icon).toBe("🌐");
	});

	it("index.mjs 正确注册 browser_use 工具且符合提示词规范", () => {
		const registeredTools: any[] = [];
		let bgTaskEntry: any = null;
		const mockHost = {
			dataDir: join(ROOT, ".tmp-test-data"),
			dir: PLUGIN_DIR,
			registerAgentTool: vi.fn((tool: any) => {
				registeredTools.push(tool);
			}),
			registerBackgroundTask: vi.fn((task: any) => {
				bgTaskEntry = task;
				return {
					update: vi.fn(),
					unregister: vi.fn(),
				};
			}),
		};

		const plugin =
			typeof browserUsePlugin === "function"
				? (browserUsePlugin as any)(mockHost)
				: browserUsePlugin.activate(mockHost as any);
		expect(plugin).toBeDefined();
		expect(mockHost.registerAgentTool).toHaveBeenCalledTimes(1);

		const tool = registeredTools[0];
		expect(tool.name).toBe("browser_use");
		expect(tool.description).toBeTruthy();
		// AGENTS.md 规范：description <= 600 字符
		expect(tool.description.length).toBeLessThanOrEqual(600);
		// promptSnippet <= 80 字符
		expect(tool.promptSnippet.length).toBeLessThanOrEqual(80);
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);

		const actionProp = tool.parameters?.properties?.action;
		expect(actionProp).toBeDefined();
		expect(actionProp.enum).toContain("open");
		expect(actionProp.enum).toContain("new");
		expect(actionProp.enum).toContain("tabs");
		expect(actionProp.enum).toContain("switch");
		expect(actionProp.enum).toContain("close");
		expect(actionProp.enum).toContain("snapshot");
		expect(actionProp.enum).toContain("click");
		expect(actionProp.enum).toContain("input");
		expect(actionProp.enum).toContain("select");
		expect(actionProp.enum).toContain("scroll");
		expect(actionProp.enum).toContain("press");
		expect(actionProp.enum).toContain("screenshot");
		expect(actionProp.enum).toContain("quit");

		// deactivate 清理测试
		expect(typeof plugin).toBe("function");
		expect(() => (plugin as () => void)()).not.toThrow();
	});
});
