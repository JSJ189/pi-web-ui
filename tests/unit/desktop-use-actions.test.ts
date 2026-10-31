import { describe, expect, it, vi } from "vitest";
import { matchOcr, screenshotPoint, parseShortcut, scrollInput, tapKeys } from "../../plugins/desktop-use/actions.mjs";

describe("desktop OCR targeting", () => {
	const items = [
		{ text: "发送", cx: 10, cy: 20 },
		{ text: "发送", cx: 90, cy: 20 },
		{ text: "取消 (Esc)", cx: 50, cy: 60 },
	];
	it("requires disambiguation instead of clicking the first identical label", () => {
		expect(() => matchOcr(items, "发送")).toThrow("匹配 2 处");
		expect(matchOcr(items, "发送", 2)).toEqual(items[1]);
		expect(() => matchOcr(items, "发送", 3)).toThrow("超出");
	});
	it("normalizes spaces and case and supports label substrings", () => {
		expect(matchOcr(items, "取消(esc)")).toEqual(items[2]);
		expect(matchOcr(items, "取消")).toEqual(items[2]);
	});
	it("does not match a short OCR fragment to a longer requested label", () => {
		expect(() => matchOcr(items, "发送给所有人")).toThrow("未找到");
	});
});

describe("desktop screenshot coordinates", () => {
	const shot = { winX: -1920, winY: 100, winW: 1920, winH: 1080, imgW: 1280, imgH: 720 };
	it("maps scaled images on monitors left of the primary display", () => {
		expect(screenshotPoint(shot, 640, 360)).toEqual({ x: -960, y: 640 });
	});
	it("rejects off-image and nonfinite coordinates and broken dimensions", () => {
		for (const [x, y] of [
			[-1, 20],
			[1280, 20],
			[20, 720],
			[NaN, 20],
			[20, Infinity],
		]) {
			expect(() => screenshotPoint(shot, x, y)).toThrow();
		}
		expect(() => screenshotPoint({ ...shot, imgW: 0 }, 0, 0)).toThrow();
	});
});

describe("desktop input", () => {
	it("rejects malformed shortcuts before injecting any keys", () => {
		for (const input of ["", "ctrl+", "ctrl+a+b", "ctrl+ctrl+c", "ctrl+unknown"])
			expect(() => parseShortcut(input)).toThrow();
		expect(parseShortcut(" Ctrl + C ")).toEqual(["ctrl", "c"]);
		expect(parseShortcut("escape")).toEqual(["esc"]);
		expect(parseShortcut("F24")).toEqual(["f24"]);
	});
	it("releases keys in reverse order even when pressing partially fails", async () => {
		const keyboard = {
			pressKey: vi.fn().mockRejectedValue(new Error("input failed")),
			releaseKey: vi.fn().mockResolvedValue(undefined),
		};
		await expect(tapKeys(keyboard, [1, 2])).rejects.toThrow("input failed");
		expect(keyboard.releaseKey).toHaveBeenCalledWith(2, 1);
	});
	it("releases keys on successful shortcuts", async () => {
		const keyboard = {
			pressKey: vi.fn().mockResolvedValue(undefined),
			releaseKey: vi.fn().mockResolvedValue(undefined),
		};
		await tapKeys(keyboard, [1, 2]);
		expect(keyboard.releaseKey).toHaveBeenCalledWith(2, 1);
	});
	it("maps wheel directions without accepting unbounded amounts", () => {
		expect(scrollInput("up", 2)).toEqual({ Horizontal: 0, Delta: 240 });
		expect(scrollInput("down", 2)).toEqual({ Horizontal: 0, Delta: -240 });
		expect(scrollInput("left", 1)).toEqual({ Horizontal: 1, Delta: -120 });
		expect(scrollInput("right", 1)).toEqual({ Horizontal: 1, Delta: 120 });
		for (const amount of [0, -1, 101, NaN, 1.5]) expect(() => scrollInput("down", amount)).toThrow();
	});
});
