/**
 * read-tool.ts —— 覆盖 SDK 内置 read：路径是目录时列出目录条目。
 *
 * 背景：SDK 内置 `read` 只处理文件，`read('server')` 直接抛
 * `EISDIR: illegal operation on a directory, read`；模型想「看一眼这个目录」
 * 只能改用 bash（`ls`）。SDK 自带的 `ls` 工具不在默认活跃集里
 * （默认 `["read","bash","edit","write"]`），模型并不总能想到它。
 *
 * 做法（与 bash 覆盖同一机制）：customTools 按 name 覆盖内置定义 —— 用
 * `createReadToolDefinition(cwd)` 拿原实现当基底，只在「路径确实是目录」时
 * 分流到 `createLsToolDefinition(cwd)`（排序、目录 `/` 后缀、条目/字节截断
 * 与 SDK ls 完全一致）；其余情况（文件、图片、路径不存在、读取报错）原样
 * 转发基底，行为与内置完全一致。
 *
 * 开关：`readDirEnabled`（设置面板「工具」页，默认开）。**行为开关**不是
 * ActiveSet 开关（read 本体不可关，关了 agent 就残了），因此不进
 * tool-manager 的 AGENT_TOOL_CATALOG；每次调用实时读设置，改动即时生效。
 *
 * 文案约定：工具 definition（description/promptSnippet/promptGuidelines）为纯英文；per-call
 * 返回文本（目录头）按 lang 取 pick(lang, zh, en, key)，缺表回落英文内联。
 *
 * DSH 引擎无 customTool 注册面（工具来自 shipped preset），本覆盖只服务 pi 引擎。
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createLsToolDefinition,
	createReadToolDefinition,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { pick, type ServerLang } from "./i18n.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * 目录判定用的路径归一：~ / @ 前缀、Unicode 空格、相对 → 绝对（对齐 SDK
 * resolveToCwd 的主要语义）。这里只是「猜」，猜不中（例如 macOS 截图名的
 * 变体路径）就走内置实现，不会比现状更差。
 */
export function resolvePathForDirCheck(input: string, cwd: string): string {
	let p = String(input ?? "").replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return isAbsolute(p) ? p : nodeResolve(cwd, p);
}

/** 路径是不是目录（不存在/无权限/非目录一律 false → 交回内置实现）。 */
export async function isDirectoryPath(absolutePath: string): Promise<boolean> {
	try {
		const st = await stat(absolutePath);
		return st.isDirectory();
	} catch {
		return false;
	}
}

export interface ReadDirToolOptions {
	/** 行为开关（每次调用实时读取）：关 → 目录参数原样交回内置 read（报 EISDIR）。 */
	dirEnabled?: () => boolean;
	/** 服务端语言取值器（每次调用时读取，默认英文，issue #91）。 */
	getLang?: () => ServerLang;
}

/** read 的入参（与内置 read schema 一致，外加 path 的别名 file_path）。 */
interface ReadDirInput {
	path?: string;
	/** `path` 的别名：部分模型（Claude 风格）习惯发 file_path。 */
	file_path?: string;
	offset?: number;
	limit?: number;
}

/** 覆盖定义的参数 schema：内置的 path/offset/limit + file_path 别名。 */
const readDirSchema = Type.Object(
	{
		path: Type.String({
			description: "Path to the file (or directory) to read (relative or absolute)",
		}),
		file_path: Type.Optional(
			Type.String({
				description: "Alias of `path` — some clients/models emit file_path; if both are given, `path` wins",
			}),
		),
		offset: Type.Optional(
			Type.Number({
				description: "Line number to start reading from (1-indexed)",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum number of lines to read (for a directory path: maximum number of entries)",
			}),
		),
	},
	{},
);

/**
 * 校验前归一（SDK 的 prepareArguments 在 schema 校验前执行）：只有 file_path 时
 * 把它当 path（path 在 schema 里仍必填），两者都给时以 path 为准。
 */
export function prepareReadArguments(raw: unknown): Static<typeof readDirSchema> {
	const args: Record<string, unknown> =
		raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
	const primary = typeof args.path === "string" ? args.path : "";
	const alias = typeof args.file_path === "string" ? args.file_path : "";
	if (!primary.trim() && alias.trim()) args.path = alias;
	// 两者都没给时这里仍缺 path（静态类型是谎，运行时交给 schema 校验报错）。
	return args as unknown as Static<typeof readDirSchema>;
}

/**
 * 生成「read 读目录」覆盖定义。cwd 仅供创建时固定；执行时优先 ctx.cwd
 * （会话工作区）。
 */
export function makeReadDirTool(fallbackCwd: string, options: ReadDirToolOptions = {}) {
	const base = createReadToolDefinition(fallbackCwd);
	const ls = createLsToolDefinition(fallbackCwd);
	const dirEnabled = options.dirEnabled ?? ((): boolean => true);
	const getLang = options.getLang ?? ((): ServerLang => "en");

	return defineTool({
		...base,
		description:
			`${base.description} Also accepts \`file_path\` as an alias of \`path\`. ` +
			"If the path is a directory, its entries are listed instead (one per line, directories suffixed with '/'); `limit` caps the entries and `offset` is ignored.",
		promptSnippet: "Read file contents (a directory path lists its entries)",
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			"Use read on a directory to list its entries — no need to shell out to `ls`",
		],
		parameters: readDirSchema,
		prepareArguments: prepareReadArguments,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const input = (params ?? {}) as ReadDirInput;
			// 兜底（不依赖 prepareArguments 一定跑过）：path 缺省/空时用 file_path。
			const rawPath = typeof input.path === "string" && input.path.trim() ? input.path : input.file_path;
			const path = typeof rawPath === "string" ? rawPath : "";
			if (path && dirEnabled()) {
				const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : fallbackCwd;
				if (await isDirectoryPath(resolvePathForDirCheck(path, cwd))) {
					const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : undefined;
					// 列目录本体完全复用 SDK 的 ls（排序/`/` 后缀/截断提示口径一致）。
					const listed = await ls.execute(
						toolCallId,
						{ path, ...(limit !== undefined ? { limit } : {}) },
						signal,
						onUpdate as never,
						ctx,
					);
					const header = pick(getLang(), `[目录：${path}]`, `[Directory: ${path}]`, "read.dir.header", { path });
					// 只取列出来的正文：截断/条目上限提示已在正文末尾，read 卡片的
					// details 不需要 ls 的字段。
					const content = listed.content.map((part, index) =>
						index === 0 && part.type === "text" ? { ...part, text: `${header}\n${part.text}` } : part,
					);
					return { content, details: undefined };
				}
			}
			// 转发内置实现时带上归一后的 path（模型可能只给了 file_path）。
			return base.execute(toolCallId, { ...input, path }, signal, onUpdate, ctx);
		},
	});
}
