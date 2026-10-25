import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("office plugin verification (plugins/office)", () => {
	const pluginDir = join(process.cwd(), "plugins", "office");

	it("manifest.json 与 package.json 声明版本号保持一致且符合规范", () => {
		const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
		const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));

		expect(manifest.version).toBe("0.3.3");
		expect(pkg.version).toBe("0.3.3");
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.permissions).toContain("tools");
		expect(manifest.permissions).toContain("http");
		expect(manifest.permissions).toContain("fs");
		expect(Array.isArray(manifest.fileHandlers)).toBe(true);
	});

	it("assertInWorkspace 纯函数工作区边界防护（无 ReferenceError 且拦截越界路径）", async () => {
		const { assertInWorkspace } = await import(join(pluginDir, "index.mjs"));
		const mockCwd = resolve("/fake/workspace");

		// 正常工作区内文件与工作区根路径放行
		const normalFile = join(mockCwd, "sub", "test.xlsx");
		expect(assertInWorkspace(normalFile, mockCwd)).toBe(normalFile);
		expect(assertInWorkspace(mockCwd, mockCwd)).toBe(mockCwd);

		// 恶意遍历路径越界：应抛出 403 异常且绝不抛 ReferenceError
		expect(() => {
			assertInWorkspace(resolve(mockCwd, "../../etc/passwd"), mockCwd);
		}).toThrowError(/工作区/);

		try {
			assertInWorkspace(resolve(mockCwd, "../secret.docx"), mockCwd);
			expect.unreachable();
		} catch (err: any) {
			expect(err.statusCode).toBe(403);
			expect(err.message).toContain("工作区");
		}
	});
});
