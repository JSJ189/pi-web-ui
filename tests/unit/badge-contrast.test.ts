import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");
const THEMES_DIR = join(ROOT, "themes");

describe("顶栏/底栏角标徽标对比度与样式防护", () => {
	it("styles.css 中后台任务计数角标 (.bar-item-badge.bg-task-badge) 保持红色告警底与白字，不被通用 bar-item-badge 冲刷", () => {
		const css = readFileSync(STYLES_PATH, "utf8");
		expect(css).toMatch(/\.bar-item-badge\.bg-task-badge\s*\{[^}]*background:\s*var\(--red\)[^}]*color:\s*#fff/);
	});

	it("纯白 --accent 主题（如 flow/wallpaper-flow）必须声明 bar-item-badge 文字深色反色，杜绝白底白字", () => {
		const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
		for (const file of files) {
			const css = readFileSync(join(THEMES_DIR, file), "utf8");
			const isPureWhiteAccent = /--accent\s*:\s*#ffffff\b/i.test(css);
			if (isPureWhiteAccent) {
				const hasBadgeContrastRule = /\.bar-item-badge[^}]*color:\s*#000000/i.test(css);
				expect(
					hasBadgeContrastRule,
					`${file} 将 --accent 设为纯白色，但未对 .bar-item-badge 显式设置深色文字，会导致徽标白底白字隐形`,
				).toBe(true);
			}
		}
	});
});
