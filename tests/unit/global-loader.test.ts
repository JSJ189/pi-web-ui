import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	getCandidateNodeModulesRoots,
	probeGlobalPackage,
	resolvePackageEntryFile,
	resolvePackageRoot,
	dynamicImportGlobalPackage,
} from "../../server/global-loader.js";

describe("通用全局环境动态解析与穿透加载器（Universal Global Package Loader）", () => {
	it("getCandidateNodeModulesRoots 自动收集系统多环境候选目录", () => {
		const roots = getCandidateNodeModulesRoots();
		expect(Array.isArray(roots)).toBe(true);
		expect(roots.length).toBeGreaterThan(0);

		// 所有收集到的候选根都应是规范绝对路径且非空
		for (const r of roots) {
			expect(typeof r).toBe("string");
			expect(r.length).toBeGreaterThan(0);
		}
	});

	it("resolvePackageRoot 精准定位本地与全局包根路径", () => {
		// 1. 定位本地存在的 SDK 包
		const piRoot = resolvePackageRoot("@earendil-works/pi-coding-agent");
		expect(piRoot).toBeTruthy();
		expect(existsSync(piRoot!)).toBe(true);

		// 2. 定位全局安装的 pi-durable 包
		const durableRoot = resolvePackageRoot("@earendil-works/pi-durable");
		expect(durableRoot).toBeTruthy();
		expect(existsSync(durableRoot!)).toBe(true);

		// 3. 不存在的包安全返回 null
		const nonExistent = resolvePackageRoot("@nonexistent/package-never-exists");
		expect(nonExistent).toBeNull();
	});

	it("probeGlobalPackage 准确探测安装状态与版本号", () => {
		const probeDurable = probeGlobalPackage("@earendil-works/pi-durable");
		expect(probeDurable.installed).toBe(true);
		expect(probeDurable.version).toBeDefined();
		expect(typeof probeDurable.version).toBe("string");
		expect(probeDurable.packagePath).toBeDefined();

		const probeFake = probeGlobalPackage("@nonexistent/package-never-exists");
		expect(probeFake.installed).toBe(false);
		expect(probeFake.version).toBeUndefined();
	});

	it("resolvePackageEntryFile 遵循 exports 条件导出规范解析物理入口文件", () => {
		// 1. 主包入口解析
		const mainEntry = resolvePackageEntryFile("@earendil-works/pi-durable");
		expect(mainEntry).toBeTruthy();
		expect(existsSync(mainEntry!)).toBe(true);
		expect(mainEntry!.endsWith(".js")).toBe(true);

		// 2. 子路径 tools 入口解析
		const toolsEntry = resolvePackageEntryFile("@earendil-works/pi-durable", "tools");
		expect(toolsEntry).toBeTruthy();
		expect(existsSync(toolsEntry!)).toBe(true);

		// 3. 子路径 storage/sqlite/node 入口解析
		const sqliteEntry = resolvePackageEntryFile("@earendil-works/pi-durable", "storage/sqlite/node");
		expect(sqliteEntry).toBeTruthy();
		expect(existsSync(sqliteEntry!)).toBe(true);
	});

	it("dynamicImportGlobalPackage 成功跨环境穿透动态导入 ESM 模块", async () => {
		// 动态加载主包
		const durableMod = await dynamicImportGlobalPackage("@earendil-works/pi-durable");
		expect(durableMod).toBeDefined();
		expect(typeof durableMod.Harness).toBe("object");

		// 动态加载子包 tools
		const toolsMod = await dynamicImportGlobalPackage("@earendil-works/pi-durable", "tools");
		expect(toolsMod).toBeDefined();
		expect(toolsMod.CodingTools).toBeDefined();

		// 动态加载子包 storage/sqlite/node
		const sqliteMod = await dynamicImportGlobalPackage("@earendil-works/pi-durable", "storage/sqlite/node");
		expect(sqliteMod).toBeDefined();
		expect(typeof sqliteMod.openNodeSqliteStorage).toBe("function");

		// 加载不存在的包安全抛错
		await expect(dynamicImportGlobalPackage("@nonexistent/package-never-exists")).rejects.toThrow();
	});
});
