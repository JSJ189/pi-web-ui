/**
 * sdk-builtin-extensions.ts — 动态装配与筛选 @earendil-works/pi-coding-agent SDK 内置扩展。
 *
 * 职责：
 * 1. 继承 SDK 原生内置扩展（如 builtin:llama.cpp、builtin:codemode、builtin:tool-search）；
 * 2. 精准隔离 SDK 内置 MCP 扩展（pi-web-ui 统一使用专属 McpBridge 管理，防止 MCP 进程双重派生）；
 * 3. 严格保留 builtin: true 与 replaceable 等元数据，确保 SDK DefaultResourceLoader 正确建立
 *    builtin:<name> 字典索引（解决 Issue #755：GUI 无法发现和使用 llama.cpp 本地模型的问题）；
 * 4. 遵循与 resolve-global-sdk / patch-remote-catalog 相同的事实源，兼容全局 SDK 与自带副本。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";

export interface SdkExtensionFactoryEntry {
	name: string;
	factory: (pi: any) => void | Promise<void>;
	builtin?: boolean;
	replaceable?: boolean;
	hidden?: boolean;
}

let cachedEntries: SdkExtensionFactoryEntry[] | null = null;

/**
 * 解析当前生效 SDK 的 extensions/index.js 文件绝对路径。
 */
export function resolveSdkExtensionsIndexPath(): string | null {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const candidate = join(dirname(entry), "extensions", "index.js");
		if (existsSync(candidate)) return candidate;
	} catch {
		/* ignore resolve failure */
	}
	return null;
}

/**
 * 获取经过宿主门禁过滤后的 SDK 内置扩展工厂列表（带内存缓存）。
 * - 包含：llama.cpp、codemode、tool-search（以及未来 SDK 官方新增的提供商扩展）
 * - 剔除：mcp（由 WebUI 独立 McpBridge 接管）
 */
export async function getSdkBuiltinExtensionFactories(): Promise<SdkExtensionFactoryEntry[]> {
	if (cachedEntries) return cachedEntries;

	const factories: SdkExtensionFactoryEntry[] = [];
	const indexPath = resolveSdkExtensionsIndexPath();

	if (indexPath) {
		try {
			const mod = (await import(pathToFileURL(indexPath).href)) as {
				builtInExtensions?: Array<{
					name: string;
					factory: (pi: any) => void | Promise<void>;
					builtin?: boolean;
					replaceable?: boolean;
				}>;
			};

			if (Array.isArray(mod.builtInExtensions)) {
				for (const ext of mod.builtInExtensions) {
					// 严格屏蔽 SDK 内置 mcp：避免与宿主 McpBridge 重复连接和拉起 stdio 进程
					if (ext.name === "mcp") continue;

					factories.push({
						name: ext.name,
						factory: ext.factory,
						builtin: ext.builtin ?? true,
						replaceable: ext.replaceable ?? false,
						hidden: true,
					});
				}
			}
		} catch {
			/* dynamic load failed, fall back below */
		}
	}

	// 兜底回退：若未成功加载任何工厂，保证核心基础设施扩展可用
	if (factories.length === 0) {
		factories.push(
			{
				name: "codemode",
				hidden: true,
				replaceable: true,
				builtin: true,
				factory: createCodemodeExtension(),
			},
			{
				name: "tool-search",
				hidden: true,
				replaceable: true,
				builtin: true,
				factory: createToolSearchExtension(),
			},
		);
	}

	cachedEntries = factories;
	return factories;
}

/**
 * 宿主层需禁用的 SDK 内置扩展名称清单（双保险，传给 disabledBuiltinExtensions）。
 */
export const SDK_DISABLED_BUILTIN_EXTENSIONS: string[] = ["mcp"];
