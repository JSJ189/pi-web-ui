import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHAT_INPUT_SRC = readFileSync(join(ROOT, "web/src/components/ChatInput.tsx"), "utf8");

describe("输入框高度自适应与手动拉高交互规则", () => {
	it("COMPOSER_MAX_H 必须是有安全保护的紧凑值（<=360px），绝不能是 720px 遮挡正文", () => {
		const match = /const\s+COMPOSER_MAX_H\s*=\s*(\d+);/.exec(CHAT_INPUT_SRC);
		expect(match, "ChatInput.tsx 中必须定义 COMPOSER_MAX_H").not.toBeNull();
		const maxH = Number(match![1]);
		expect(maxH).toBeLessThanOrEqual(360);
		expect(maxH).toBeGreaterThanOrEqual(240);
	});

	it("必须定义安全视口截断函数 getComposerSafeMaxH() 防止在大屏或小屏上遮蔽正文", () => {
		expect(CHAT_INPUT_SRC).toContain("function getComposerSafeMaxH()");
		expect(CHAT_INPUT_SRC).toContain("window.innerHeight");
	});

	it("手动拖拽拉高后必须固定高度（不自适应），最低高度开始写才自适应", () => {
		// 校验 isManualFixed 分支与最低高度自适应分支
		expect(CHAT_INPUT_SRC).toContain("isManualFixed");
		expect(CHAT_INPUT_SRC).toMatch(
			/if\s*\(isManualFixed\)\s*\{\s*\/\/[^\n]*\s*h\s*=\s*Math\.min\(composerH,\s*maxCap\);/,
		);
		expect(CHAT_INPUT_SRC).toMatch(/h\s*=\s*Math\.min\(Math\.max\(naturalH,\s*COMPOSER_MIN_H\),\s*maxCap\);/);
	});

	it("拖拽回最低高度时必须自动解除固定，恢复最低高度自适应并清除持久化", () => {
		expect(CHAT_INPUT_SRC).toContain("next <= COMPOSER_MIN_H + 4");
		expect(CHAT_INPUT_SRC).toContain("localStorage.removeItem(COMPOSER_H_KEY)");
	});

	it("手柄必须具备悬浮提示（.composer-resize-tip），提示双击复位自适应与状态区分", () => {
		expect(CHAT_INPUT_SRC).toContain('className="composer-resize-tip"');
		expect(CHAT_INPUT_SRC).toContain('t("composerResizeFixed")');
		expect(CHAT_INPUT_SRC).toContain('t("composerResize")');
	});

	it("纯函数高度计算模型验证：手动拉高 vs 最低高度自适应", () => {
		const COMPOSER_MIN_H = 40;
		const COMPOSER_MAX_H = 320;
		const maxCap = 300;

		function computeHeight(composerH: number | null, naturalScrollH: number) {
			const isManualFixed = composerH != null && composerH > COMPOSER_MIN_H + 4;
			if (isManualFixed) {
				return Math.min(composerH, maxCap);
			}
			return Math.min(Math.max(naturalScrollH, COMPOSER_MIN_H), maxCap);
		}

		// 1. 最低高度自适应模式（composerH 为 null）
		// 单行短文本
		expect(computeHeight(null, 38)).toBe(40);
		// 3行内容
		expect(computeHeight(null, 120)).toBe(120);
		// 超长内容（500px）：被 maxCap (300px) 截断，保护正文可见
		expect(computeHeight(null, 500)).toBe(300);

		// 2. 手动拉高固定模式（用户拉到了 240px）
		// 即使内容只有单行（38px），输入框固定为拉高的高度（不自适应乱跳）
		expect(computeHeight(240, 38)).toBe(240);
		// 即使内容多行（180px），依然保持固定的 240px
		expect(computeHeight(240, 180)).toBe(240);
		// 超长内容（500px）：依然固定为 240px（超出部分内部滚动），绝不继续向上挤爆正文
		expect(computeHeight(240, 500)).toBe(240);

		// 3. 用户拉到了极限（400px）：被 maxCap 截断
		expect(computeHeight(400, 100)).toBe(300);
	});
});
