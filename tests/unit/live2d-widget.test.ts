/**
 * Live2D 看板娘挂件隐藏与交互穿透守卫测试
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LIVE2D_DIR = join(ROOT, "plugins", "live2d");

describe("plugins/live2d 挂件隐藏与穿透守卫", () => {
	it("manifest.json 版本号已正确声明", () => {
		const manifest = JSON.parse(readFileSync(join(LIVE2D_DIR, "manifest.json"), "utf-8"));
		expect(manifest.id).toBe("live2d");
		expect(manifest.version).toBe("0.1.8");
	});

	it("styles.mjs 中隐藏状态必须对容器及所有子元素强制 visibility: hidden 与 pointer-events: none", () => {
		const stylesSrc = readFileSync(join(LIVE2D_DIR, "client", "styles.mjs"), "utf-8");

		// 容器自身隐藏声明
		expect(stylesSrc).toMatch(/#pi-live2d-companion\.pi-l2d-hidden\s*\{[^}]*pointer-events:\s*none\s*!important/);
		expect(stylesSrc).toMatch(/#pi-live2d-companion\.pi-l2d-hidden\s*\{[^}]*visibility:\s*hidden\s*!important/);

		// 所有后代子元素深度穿透与隐藏（防止子元素 pointer-events: auto 覆盖）
		expect(stylesSrc).toMatch(
			/#pi-live2d-companion\.pi-l2d-hidden\s*,\s*#pi-live2d-companion\.pi-l2d-hidden\s*\*\s*\{[^}]*pointer-events:\s*none\s*!important/,
		);
		expect(stylesSrc).toMatch(
			/#pi-live2d-companion\.pi-l2d-hidden\s*,\s*#pi-live2d-companion\.pi-l2d-hidden\s*\*\s*\{[^}]*visibility:\s*hidden\s*!important/,
		);
	});

	it("widget.mjs 中必须包含拖拽终止与隐藏显示安全控制", () => {
		const widgetSrc = readFileSync(join(LIVE2D_DIR, "client", "widget.mjs"), "utf-8");

		// hide() 方法必须停止舞台并中止拖拽
		expect(widgetSrc).toContain("_abortDragging()");
		expect(widgetSrc).toContain("this.stage?.stop()");
		expect(widgetSrc).toContain('this.container.style.display = "none"');

		// onPointerDown 必须校验 visible 与透明像素
		expect(widgetSrc).toMatch(/if\s*\(!this\.visible\s*\|\|\s*this\.config\.clickThrough\)\s*return;/);
		expect(widgetSrc).toMatch(/isPixelTransparent\(e\.clientX,\s*e\.clientY\)/);

		// contextmenu / dblclick / wheel 必须有 visible 与透明背景守卫
		expect(widgetSrc).toContain('this.canvas.addEventListener("contextmenu"');
		expect(widgetSrc).toContain('this.canvas.addEventListener("dblclick"');
		expect(widgetSrc).toContain('this.container.addEventListener(\n\t\t\t"wheel"');
	});

	it("engine.mjs 必须实现 start/stop 渲染控制以及 isPixelTransparent 尺寸守卫", () => {
		const engineSrc = readFileSync(join(LIVE2D_DIR, "client", "engine.mjs"), "utf-8");

		expect(engineSrc).toContain("stop()");
		expect(engineSrc).toContain("this.app.ticker.stop()");
		expect(engineSrc).toContain("start()");
		expect(engineSrc).toContain("this.app.ticker.start()");
		expect(engineSrc).toContain("rect.width <= 0 || rect.height <= 0");
	});
});
