import { describe, expect, it } from "vitest";
import { compact, stripAnsi } from "../../plugins/remote-workbench/client/lib/compact.mjs";

describe("remote-workbench ansi compact (Termcp 移植)", () => {
	it("剥离 ANSI 颜色与光标控制符", () => {
		const raw = "\x1b[31mError:\x1b[0m \x1b[1;32mEverything failed\x1b[0m";
		expect(stripAnsi(raw)).toBe("Error: Everything failed");
		expect(compact(raw)).toBe("Error: Everything failed");
	});

	it("将 \\r 覆盖进度条压缩至最终一行（类似 curl / git 进度条）", () => {
		const progress = "Downloading: 10%\rDownloading: 25%\rDownloading: 50%\rDownloading: 75%\rDownloading: 100%\nDone.";
		const compacted = compact(progress);
		expect(compacted).toBe("Downloading: 100%\nDone.");
	});

	it("去除尾随空格并折叠多余连续空行", () => {
		const raw = "Line 1   \nLine 2\t\t\n\n\n\n\nLine 3\n\n\n";
		const compacted = compact(raw);
		expect(compacted).toBe("Line 1\nLine 2\n\nLine 3");
	});

	it("空串或纯空白安全处理", () => {
		expect(compact("")).toBe("");
		expect(compact("   \n\n  \t  ")).toBe("");
	});
});
