/**
 * 会话搜索标题与品牌徽标样式测试（issue #644）。
 *
 * 覆盖：
 * 1. 标题回退链：displayName > name > firstMessage > basename 无 .jsonl 后缀，未命名会话不应暴露裸文件名。
 * 2. 静态检查 styles.css 中 .bar-item-brand-logo 的样式，确保其具有纯白前景色且不被 var(--accent) 覆盖。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../server/protocol";
import { UniversalSession } from "../../server/universal/universal-session";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 前端 GlobalSearchModal / LeftPanel 统一采用的标题解析逻辑
 */
function resolveDisplayTitle(s: Partial<SessionSummary> & { path: string }): string {
	return (
		s.displayName ||
		s.name ||
		s.firstMessage?.trim() ||
		(s.path.split(/[\\/]/).pop() || s.path).replace(/\.jsonl$/i, "")
	);
}

describe("会话标题回退规则（issue #644）", () => {
	it("优先使用权威 displayName", () => {
		const session = {
			path: "/path/to/2026-03-12-abc.jsonl",
			displayName: "权威计算的标题",
			name: "手动设置的名字",
			firstMessage: "用户的第一句话",
		};
		expect(resolveDisplayTitle(session)).toBe("权威计算的标题");
	});

	it("无 displayName 时优先使用显式 name", () => {
		const session = {
			path: "/path/to/2026-03-12-abc.jsonl",
			name: "手动设置的名字",
			firstMessage: "用户的第一句话",
		};
		expect(resolveDisplayTitle(session)).toBe("手动设置的名字");
	});

	it("绝大多数未手动重命名的历史会话，优先展示 firstMessage，而非裸文件名", () => {
		const session = {
			path: "/path/to/2026-03-12-abc.jsonl",
			firstMessage: "帮我实现一个快速排序",
		};
		expect(resolveDisplayTitle(session)).toBe("帮我实现一个快速排序");
	});

	it("全部为空时，回退到去除 .jsonl 的文件名", () => {
		const session = {
			path: "/path/to/2026-03-12-abc.jsonl",
		};
		expect(resolveDisplayTitle(session)).toBe("2026-03-12-abc");
	});

	it("Windows 路径分隔符也能正确处理文件名回退", () => {
		const session = {
			path: "C:\\Users\\user\\.pi\\sessions\\2026-03-12-xyz.jsonl",
		};
		expect(resolveDisplayTitle(session)).toBe("2026-03-12-xyz");
	});
});

describe("Universal 引擎 resolveSessionDisplayName", () => {
	it("用户显式命名优先", () => {
		const session = Object.assign(Object.create(UniversalSession.prototype), {
			lang: "zh",
		});
		const conv: any = { title: "自定义分析方案", messages: [] };
		expect(session.resolveSessionDisplayName(conv, "第一句话")).toBe("自定义分析方案");
	});

	it("未重命名时取 firstMessage 并截断", () => {
		const session = Object.assign(Object.create(UniversalSession.prototype), {
			lang: "zh",
		});
		const conv: any = { title: "新对话", messages: [] };
		const longMsg = "这是一条非常长非常长非常长非常长非常长非常长非常长非常长的用户提问消息内容";
		const res = session.resolveSessionDisplayName(conv, longMsg);
		expect(res.endsWith("…")).toBe(true);
		expect(res.length).toBeLessThanOrEqual(32);
	});
});

describe("品牌徽标 .bar-item-brand-logo 对比度防灾难守护（issue #644）", () => {
	it("styles.css 中的 .bar-item-brand-logo 必须使用 #fff 且不能使用 var(--accent)", () => {
		const css = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");
		// 截取 .bar-item-brand-logo 规则块
		const match = /\.bar-item-brand-logo\s*\{([^}]+)\}/.exec(css);
		expect(match).not.toBeNull();
		const block = match![1];
		expect(block).toContain("color: #fff");
		expect(block).not.toContain("var(--accent)");
	});
});
