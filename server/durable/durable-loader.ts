/**
 * durable-loader.ts — Pi Durable 运行环境加载门面（基于 server/global-loader.ts）。
 *
 * 统一委托给通用全局加载器，消除代码冗余。
 */

import { dynamicImportGlobalPackage } from "../global-loader.js";

const DURABLE_PKG = "@earendil-works/pi-durable";

/**
 * 动态加载 @earendil-works/pi-durable 核心模块或其子路径模块。
 * @param subpath 子路径标识，如 ""（主包）、"tools"、"storage/sqlite/node"、"storage/memory"
 */
export async function loadDurableModule<T = any>(subpath = ""): Promise<T> {
	return dynamicImportGlobalPackage<T>(DURABLE_PKG, subpath);
}

/**
 * 动态加载关联的 @earendil-works/* 兄弟包（如 chord/context、pi-ai/models）。
 */
export async function loadDurablePeerModule<T = any>(packageName: string, subpath = ""): Promise<T | null> {
	try {
		return await dynamicImportGlobalPackage<T>(packageName, subpath);
	} catch {
		return null;
	}
}
