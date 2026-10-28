import { describe, it, expect } from "vitest";
import {
	isLoopbackAccess,
	isExternalOrProtocolLink,
	normalizeTargetFilePath,
	isHtmlDocumentPath,
	resolveWorkspaceFileUrl,
} from "../../web/src/workspace-file-url";

describe("workspace-file-url", () => {
	describe("isLoopbackAccess", () => {
		it("detects loopback hosts", () => {
			expect(isLoopbackAccess("localhost")).toBe(true);
			expect(isLoopbackAccess("127.0.0.1")).toBe(true);
			expect(isLoopbackAccess("127.1.2.3")).toBe(true);
			expect(isLoopbackAccess("::1")).toBe(true);
			expect(isLoopbackAccess("[::1]")).toBe(true);
			expect(isLoopbackAccess("foo.localhost")).toBe(true);
		});

		it("detects remote hosts", () => {
			expect(isLoopbackAccess("192.168.1.100")).toBe(false);
			expect(isLoopbackAccess("10.0.0.2")).toBe(false);
			expect(isLoopbackAccess("ai.example.com")).toBe(false);
		});
	});

	describe("isExternalOrProtocolLink", () => {
		it("identifies external and protocol links", () => {
			expect(isExternalOrProtocolLink("https://github.com")).toBe(true);
			expect(isExternalOrProtocolLink("http://example.com/foo")).toBe(true);
			expect(isExternalOrProtocolLink("mailto:test@example.com")).toBe(true);
			expect(isExternalOrProtocolLink("tel:123456")).toBe(true);
			expect(isExternalOrProtocolLink("#section")).toBe(true);
			expect(isExternalOrProtocolLink("pi-file://test.txt")).toBe(true);
		});

		it("identifies relative or local file paths", () => {
			expect(isExternalOrProtocolLink("./foo.html")).toBe(false);
			expect(isExternalOrProtocolLink("docs/readme.md")).toBe(false);
			expect(isExternalOrProtocolLink("/var/log/app.log")).toBe(false);
			expect(isExternalOrProtocolLink("C:\\Users\\admin\\file.txt")).toBe(false);
			expect(isExternalOrProtocolLink("file:///C:/test.png")).toBe(false);
		});
	});

	describe("normalizeTargetFilePath", () => {
		it("cleans file:// protocols and Windows backslashes", () => {
			expect(normalizeTargetFilePath("file:///C:/path/to/file.txt")).toBe("C:/path/to/file.txt");
			expect(normalizeTargetFilePath("file:///D:\\data\\report.pdf")).toBe("D:/data/report.pdf");
			expect(normalizeTargetFilePath("sub\\dir\\image.png")).toBe("sub/dir/image.png");
		});

		it("strips workspace root if absolute path is inside current cwd", () => {
			const cwd = "E:/pi-web-ui";
			expect(normalizeTargetFilePath("E:/pi-web-ui/dist/report.html", cwd)).toBe("dist/report.html");
			expect(normalizeTargetFilePath("E:\\pi-web-ui\\web\\src\\index.ts", cwd)).toBe("web/src/index.ts");
		});
	});

	describe("isHtmlDocumentPath", () => {
		it("detects html documents", () => {
			expect(isHtmlDocumentPath("report.html")).toBe(true);
			expect(isHtmlDocumentPath("dist/index.htm?foo=1")).toBe(true);
			expect(isHtmlDocumentPath("preview.xhtml#bar")).toBe(true);
			expect(isHtmlDocumentPath("report.pdf")).toBe(false);
			expect(isHtmlDocumentPath("image.png")).toBe(false);
		});
	});

	describe("resolveWorkspaceFileUrl", () => {
		it("routes html files to /api/preview with sandbox", () => {
			const url = resolveWorkspaceFileUrl("sub/index.html");
			expect(url).toContain("/api/preview/sub/index.html");
			expect(url).toContain("allowJs=1");
		});

		it("routes normal files to /api/file", () => {
			const url = resolveWorkspaceFileUrl("sub/data.csv");
			expect(url).toContain("/api/file?");
			expect(url).toContain("path=sub%2Fdata.csv");
		});
	});
});
