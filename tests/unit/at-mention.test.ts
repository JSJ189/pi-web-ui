/**
 * matchAtToken 单测（web/src/at-mention.ts）：`@` 提及词元判定。
 * 锁住三条不变量：邮箱不误弹 / CJK 无空格可触发 / 空格关闭。
 */
import { describe, expect, it } from "vitest";
import { mapFileHits, mapPageHits, matchAtToken, normalizeAtHits } from "../../web/src/at-mention.js";

describe("matchAtToken", () => {
	it("行首 @ + 空 query 也触发（列出全部）", () => {
		expect(matchAtToken("@", 1)).toEqual({ start: 0, query: "" });
	});

	it("空白后触发，query 取到光标", () => {
		expect(matchAtToken("请看 @文", 5)).toEqual({ start: 3, query: "文" });
	});

	it("CJK 无空格书写可触发（看不是 ASCII 单词字符）", () => {
		expect(matchAtToken("请看@文件", 5)).toEqual({ start: 2, query: "文件" });
	});

	it("邮箱不触发（@ 前是 ASCII 字母）", () => {
		expect(matchAtToken("mail@test", 9)).toBeNull();
		expect(matchAtToken("a@b", 3)).toBeNull();
	});

	it("数字下划线之后不触发", () => {
		expect(matchAtToken("v2@test", 7)).toBeNull();
		expect(matchAtToken("a_@b", 4)).toBeNull();
	});

	it("空白隔开的第二个 @ 只认后一个；紧贴字母的 @ 按邮箱拒", () => {
		expect(matchAtToken("@a @b", 5)).toEqual({ start: 3, query: "b" });
		expect(matchAtToken("@a@b", 4)).toBeNull();
	});

	it("query 含空格即关闭（trailing space 回车发送）", () => {
		expect(matchAtToken("@ab ", 4)).toBeNull();
		expect(matchAtToken("@a b", 4)).toBeNull();
	});

	it("光标不在词元后即无触发", () => {
		expect(matchAtToken("hi @ab", 3)).toBeNull();
		expect(matchAtToken("no at here", 5)).toBeNull();
	});

	it("括号引号后可触发", () => {
		expect(matchAtToken("(@x", 3)).toEqual({ start: 1, query: "x" });
		expect(matchAtToken("「@y」", 3)).toEqual({ start: 1, query: "y" });
		expect(matchAtToken("（@z", 3)).toEqual({ start: 1, query: "z" });
	});

	describe("normalizeAtHits", () => {
		it("坏字段逐条丢弃，好条目保留", () => {
			const out = normalizeAtHits("p", "P", [
				{ title: "a", hint: "h", text: "A ", attachments: [{ path: "/x", mode: "inline" }] },
				{ title: "  " },
				"nope",
				{ title: "b", attachments: [{ nope: 1 }, { path: "/y", mode: "bogus" }] },
			]);
			expect(out).toHaveLength(2);
			expect(out[0]).toMatchObject({ providerId: "p", title: "a", text: "A " });
			expect(out[0]?.attachments).toHaveLength(1);
			expect(out[1]?.attachments?.[0]).toMatchObject({ path: "/y" });
			expect(out[1]?.attachments?.[0]).not.toHaveProperty("mode");
		});

		it("非数组/超限截断", () => {
			expect(normalizeAtHits("p", "P", null)).toEqual([]);
			expect(normalizeAtHits("p", "P", [1, 2, 3], 2)).toEqual([]);
		});
	});

	describe("mapFileHits", () => {
		it("文件/目录映射为引用 chip 命中", () => {
			const out = mapFileHits("文件", [
				{ path: "src/a.ts", name: "a.ts", type: "file" },
				{ path: "src", name: "src", type: "dir" },
				{ path: "", name: "x", type: "file" },
			]);
			expect(out).toHaveLength(2);
			expect(out[0]).toMatchObject({ providerId: "host:files", title: "a.ts", text: "@a.ts" });
			expect(out[0]?.attachments?.[0]).toMatchObject({ path: "src/a.ts", mode: "reference" });
			expect(out[0]?.attachments?.[0]).not.toHaveProperty("isDir");
			expect(out[1]?.attachments?.[0]).toMatchObject({ isDir: true });
		});
	});

	describe("mapPageHits", () => {
		it("标题/origin 双字段过滤，无标题回落 origin", () => {
			const pages = [
				{ origin: "https://example.com", title: "Example", open: true },
				{ origin: "https://closed.dev", title: "", open: false },
				{ origin: "", title: "坏" },
			];
			const out = mapPageHits("浏览器操作", pages, "exam");
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({ providerId: "host:pages", title: "page · Example", text: "Example" });
			expect(out[0]?.attachments?.[0]).toMatchObject({ path: "https://example.com", mode: "page" });
			// 关掉的页不收录（模型读不到）。
			const all = mapPageHits("浏览器操作", pages, "");
			expect(all).toHaveLength(1);
			expect(all[0]?.hint).toBe("https://example.com");
			// 前缀词精确命中即列出全部；前缀仍走过滤。
			expect(mapPageHits("浏览器操作", pages, "page")).toHaveLength(1);
			expect(mapPageHits("浏览器操作", pages, "页面")).toHaveLength(1);
			expect(mapPageHits("浏览器操作", pages, "pag")).toHaveLength(0);
			expect(mapPageHits("浏览器操作", pages, "CLOSED")).toHaveLength(0);
		});
	});

	it("cursor 越界钳制不抛错", () => {
		expect(matchAtToken("@ab", 99)).toEqual({ start: 0, query: "ab" });
		expect(matchAtToken("@ab", -5)).toBeNull();
		expect(matchAtToken("", 0)).toBeNull();
	});
});
