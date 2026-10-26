/**
 * shared-utils-hygiene.test.ts — 跨端与插件共享工具收敛与防回潮守卫。
 *
 * 对应 Issue #730：防止通用工具（esc, formatBytes, markdown-chunks, stripJsonComments, 原子写盘, 复制反馈）
 * 散落手写、反复内联扩散。
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

function walkFiles(dir: string, extFilter: (name: string) => boolean, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e === "node_modules" || e === ".git" || e === "dist" || e === "vendor") continue;
		const full = join(dir, e);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walkFiles(full, extFilter, out);
		} else if (extFilter(e)) {
			out.push(full);
		}
	}
	return out;
}

describe("共享工具收敛与防回潮守卫 (Issue #730)", () => {
	it("1. HTML 转义守卫：插件 client 与 web 组件严禁内联手写 esc/escapeHtml", () => {
		const files = [
			...walkFiles(join(ROOT, "plugins"), (n) => n.endsWith(".mjs") && !n.includes(".test.")),
			...walkFiles(join(ROOT, "web", "src"), (n) => n.endsWith(".ts") || n.endsWith(".tsx")),
		];

		const violations: string[] = [];
		for (const f of files) {
			// 跳过 SDK 事实源、vendor SDK 副本以及第三方大型 bundle 产物
			if (
				f.includes("plugin-sdk") ||
				f.includes("vendor") ||
				f.includes("dist") ||
				f.includes(join("sdk", "client-utils.mjs")) ||
				f.includes(join("vscode-editor", "client", "entry.mjs")) ||
				f.includes(join("db-client", "client", "entry.mjs"))
			) {
				continue;
			}
			const content = readFileSync(f, "utf8");
			// 检查内联定义 function esc( 或 function escapeHtml(
			if (/(?:function\s+(?:esc|escapeHtml)\s*\()/.test(content)) {
				// 检查是否为插件客户端或 web 组件
				if (f.includes("client") || f.includes("web/src")) {
					violations.push(f.replace(ROOT, "").replace(/^[\\/]/, ""));
				}
			}
		}

		expect(
			violations,
			`发现插件客户端或前端内联手写 esc/escapeHtml，请统一改为 import { esc } from "@pi-web-ui/plugin-sdk/client":\n${violations.join("\n")}`,
		).toEqual([]);
	});

	it("2. JSON 注释剥离守卫：服务端严禁手搓 stripJsonComments，必须从 json-utils 导入", () => {
		const serverFiles = walkFiles(join(ROOT, "server"), (n) => n.endsWith(".ts"));
		const violations: string[] = [];

		for (const f of serverFiles) {
			if (f.endsWith("json-utils.ts")) continue;
			const content = readFileSync(f, "utf8");
			// 匹配自行实现的函数声明 function stripJsonComments(
			if (/function\s+stripJsonComments\s*\(/.test(content)) {
				violations.push(f.replace(ROOT, "").replace(/^[\\/]/, ""));
			}
		}

		expect(
			violations,
			`发现服务端重复实现 stripJsonComments，请统一从 server/json-utils.js 导入:\n${violations.join("\n")}`,
		).toEqual([]);
	});

	it("3. 原子写盘守卫：服务端严禁裸写 writeFileSync(tmp) + renameSync，必须使用 atomic-file", () => {
		const serverFiles = walkFiles(join(ROOT, "server"), (n) => n.endsWith(".ts"));
		const violations: string[] = [];

		for (const f of serverFiles) {
			if (f.endsWith("atomic-file.ts")) continue;
			const content = readFileSync(f, "utf8");
			// 匹配临时文件写盘特征：writeFileSync + .tmp + renameSync
			if (content.includes("renameSync") && content.includes("writeFileSync") && /\.tmp/i.test(content)) {
				violations.push(f.replace(ROOT, "").replace(/^[\\/]/, ""));
			}
		}

		expect(
			violations,
			`发现服务端存在裸写 tmp+renameSync，请改用 server/atomic-file.js 的 writeAtomicSync / writeJsonAtomicSync:\n${violations.join("\n")}`,
		).toEqual([]);
	});

	it("4. Markdown Chunks 守卫：官方插件 markdown-chunks.mjs 必须是委托转发（行数 ≤ 10）", () => {
		const pluginFiles = walkFiles(join(ROOT, "plugins"), (n) => n === "markdown-chunks.mjs");
		const violations: string[] = [];

		for (const f of pluginFiles) {
			const lines = readFileSync(f, "utf8").trim().split("\n");
			if (lines.length > 10) {
				violations.push(`${f.replace(ROOT, "").replace(/^[\\/]/, "")} (${lines.length} lines)`);
			}
		}

		expect(
			violations,
			`发现重复拷贝的 markdown-chunks.mjs 全量实现，请统一委托转发至 plugin-sdk/client-utils.mjs:\n${violations.join("\n")}`,
		).toEqual([]);
	});

	it("5. 复制反馈守卫：Web 组件严禁同时手写 clipboard.writeText + setCopied + setTimeout", () => {
		const componentFiles = walkFiles(join(ROOT, "web", "src", "components"), (n) => n.endsWith(".tsx"));
		const violations: string[] = [];

		for (const f of componentFiles) {
			// 跳过纯二进制图片复制对话框（ClipboardItem 机制）
			if (f.endsWith("SaveImageDialog.tsx")) continue;
			const content = readFileSync(f, "utf8");
			// 检查是否包含手写的 clipboard 复制反馈三件套：writeText + setCopied + setTimeout
			if (
				content.includes("navigator.clipboard") &&
				/setCopied\w*\s*\(\s*true\s*\)/.test(content) &&
				/setTimeout\s*\(\s*\(\)\s*=>\s*setCopied\w*\s*\(\s*false\s*\)/.test(content)
			) {
				violations.push(f.replace(ROOT, "").replace(/^[\\/]/, ""));
			}
		}

		expect(
			violations,
			`发现组件存在内联复制反馈三件套，请统一使用 web/src/use-copy-feedback.ts 的 useCopyFeedback:\n${violations.join("\n")}`,
		).toEqual([]);
	});
});
