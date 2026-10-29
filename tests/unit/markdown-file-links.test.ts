// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownBody } from "../../web/src/components/Markdown";
import { LanguageProvider } from "../../web/src/i18n";
import { registerFilePreviewHost, resetFilePreviewHost } from "../../web/src/file-preview-bridge";

let root: Root | undefined;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	resetFilePreviewHost();
	document.body.replaceChildren();
});
function render(text: string) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root!.render(createElement(LanguageProvider, null, createElement(MarkdownBody, { text }))));
	return container;
}

describe("Markdown file links through the real rendering pipeline", () => {
	it.each([
		[
			"C:/Users/c/AppData/Local/Temp/pi-web-ui-design-review.md",
			"C:/Users/c/AppData/Local/Temp/pi-web-ui-design-review.md",
		],
		["file:///C:/Temp/design%20review.md", "C:/Temp/design review.md"],
		["file:///tmp/review.md", "/tmp/review.md"],
		["/E:/pi-web-ui/server/index.ts:42", "E:/pi-web-ui/server/index.ts"],
		["output/review.md", "output/review.md"],
	])("opens %s with the real filename", (href, path) => {
		const open = vi.fn();
		registerFilePreviewHost({ open });
		const container = render(`[设计审查报告](${href})`);
		const link = container.querySelector("a")!;
		expect(link.getAttribute("href")).toContain("/api/file?");
		const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
		act(() => link.dispatchEvent(click));
		expect(click.defaultPrevented).toBe(true);
		expect(open).toHaveBeenCalledWith({ path, name: path.split("/").pop() });
	});
	it("keeps dangerous schemes blocked", () => {
		const container = render("[bad](javascript:alert%281%29) [bad](data:text/html,test) [bad](vbscript:msgbox)");
		for (const link of container.querySelectorAll("a")) expect(link.getAttribute("href")).toBe("");
	});
	it("preserves external and protocol-relative links", () => {
		const container = render("[web](https://example.com/a) [cdn](//example.com/a) [anchor](#section)");
		expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
			"https://example.com/a",
			"//example.com/a",
			"#section",
		]);
	});
	it("rewrites Windows image paths before browser rendering", () => {
		const container = render("![image](C:/Temp/screenshot.png)");
		expect(container.querySelector("img")?.getAttribute("src")).toContain("path=C%3A%2FTemp%2Fscreenshot.png");
	});
});
