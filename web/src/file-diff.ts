/**
 * file-diff.ts —— 文件编辑与写入工具（edit, write, edit_soft, patch）的可视化数据模型与 Diff 解析器。
 *
 * 核心职责：
 * 1. 结构化解析 `edit` / `write` 的参数（argumentsText）与 SDK 执行结果（details.patch / details.diff）；
 * 2. 具备流式阶段半截 JSON 容错解析能力（使用正则提取路径与首批改动，流式期绝不抛错白屏）；
 * 3. 将统一差异文本（Unified Patch / Display Diff / Git Diff）或 edits 替换对转换为分块（Hunk）模型；
 * 4. 提供轻量高效的行内词级（Word-level）差异高亮；
 * 5. 提取文件增删统计（+N -M）供卡头胶囊使用；
 * 6. 多重兜底（patch -> diff -> edits 数组），确保永远有内容可看，绝不出现卡体空白。
 */

export interface DiffWordToken {
	type: "same" | "add" | "del";
	text: string;
}

export interface DiffLine {
	type: "add" | "del" | "context" | "header";
	oldLineNum?: number;
	newLineNum?: number;
	content: string;
	tokens?: DiffWordToken[];
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface FileDiffStats {
	additions: number;
	deletions: number;
	totalLines?: number;
	isNewFile?: boolean;
}

export interface FileDiffData {
	filePath: string;
	toolName: string;
	isWrite: boolean;
	language: string;
	stats: FileDiffStats;
	hunks: DiffHunk[];
	/** 针对 write 工具的写入原始内容（若有） */
	content?: string;
	/** 是否处于参数尚未完整闭合的流式阶段 */
	isStreamingPartial?: boolean;
}

/** 常见文件扩展名到语言标识符的轻量映射 */
const EXT_LANG_MAP: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	less: "less",
	py: "python",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	md: "markdown",
	sql: "sql",
	xml: "xml",
	svg: "svg",
};

export function detectLanguage(filePath?: string): string {
	if (!filePath) return "plaintext";
	const ext = filePath.split(".").pop()?.toLowerCase();
	return (ext && EXT_LANG_MAP[ext]) || "plaintext";
}

/** 词切分正则：匹配单词、连续空白或特殊标点符号 */
const TOKEN_SPLIT_REGEX = /\s+|[a-zA-Z0-9_$]+|[^\s\w]/g;

/**
 * 健壮的 JSON 字符串解转义器：将带有 \n, \t, \", \\ 的转义字符还原为真实换行与缩进。
 * 即使字符串半截或被截断，也能 100% 安全还原，杜绝大段未解义的字符挤在一行。
 */
export function unescapeJsonString(text: string): string {
	if (!text) return "";
	return text.replace(/\\([nrtbfv\\/"]|u[0-9a-fA-F]{4})/g, (_, escapeSeq: string) => {
		switch (escapeSeq) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "v":
				return "\v";
			case "\\":
				return "\\";
			case "/":
				return "/";
			case '"':
				return '"';
			default:
				if (escapeSeq.startsWith("u")) {
					try {
						return String.fromCharCode(parseInt(escapeSeq.slice(1), 16));
					} catch {
						return `\\${escapeSeq}`;
					}
				}
				return `\\${escapeSeq}`;
		}
	});
}

/**
 * 轻量 LCS（最长公共子序列）词级差异计算：
 * 当一行删除与一行新增成对出现时，对比具体被替换的词汇。
 * 针对长文本（>800字符）自动降级直接返回整块，防卡死。
 */
export function computeWordDiff(
	oldText: string,
	newText: string,
): { oldTokens: DiffWordToken[]; newTokens: DiffWordToken[] } {
	if (!oldText || !newText || oldText.length > 800 || newText.length > 800) {
		return {
			oldTokens: [{ type: "del", text: oldText }],
			newTokens: [{ type: "add", text: newText }],
		};
	}

	const oldWords = oldText.match(TOKEN_SPLIT_REGEX) || [oldText];
	const newWords = newText.match(TOKEN_SPLIT_REGEX) || [newText];

	const n = oldWords.length;
	const m = newWords.length;

	// 词数过多时也直接降级
	if (n * m > 4000) {
		return {
			oldTokens: [{ type: "del", text: oldText }],
			newTokens: [{ type: "add", text: newText }],
		};
	}

	// DP 表计算 LCS 长度
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			if (oldWords[i - 1] === newWords[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	// 相似度阈值检查：如果公共部分过少（< 25%），词级高亮容易显得杂乱，直接整行高亮
	const commonCount = dp[n][m];
	const maxLen = Math.max(n, m);
	if (maxLen > 0 && commonCount / maxLen < 0.25) {
		return {
			oldTokens: [{ type: "del", text: oldText }],
			newTokens: [{ type: "add", text: newText }],
		};
	}

	// 回溯还原词列表
	const oldTokens: DiffWordToken[] = [];
	const newTokens: DiffWordToken[] = [];

	let i = n;
	let j = m;
	const oldAcc: DiffWordToken[] = [];
	const newAcc: DiffWordToken[] = [];

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
			oldAcc.push({ type: "same", text: oldWords[i - 1] });
			newAcc.push({ type: "same", text: newWords[j - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			newAcc.push({ type: "add", text: newWords[j - 1] });
			j--;
		} else if (i > 0) {
			oldAcc.push({ type: "del", text: oldWords[i - 1] });
			i--;
		}
	}

	oldAcc.reverse();
	newAcc.reverse();

	// 合并连续相同类型的 token
	for (const token of oldAcc) {
		const last = oldTokens[oldTokens.length - 1];
		if (last && last.type === token.type) {
			last.text += token.text;
		} else {
			oldTokens.push({ ...token });
		}
	}
	for (const token of newAcc) {
		const last = newTokens[newTokens.length - 1];
		if (last && last.type === token.type) {
			last.text += token.text;
		} else {
			newTokens.push({ ...token });
		}
	}

	return { oldTokens, newTokens };
}

/** 匹配 SDK Display Diff 的行：首字符为 +, -, 或空格，紧接可选行号与正文内容 */
const SDK_DISPLAY_DIFF_RE = /^([+\- ])(\s*\d+)?\s(.*)$/;

/**
 * 解析任意形式的 Diff 文本（支持标准 Unified Patch、SDK 带行号 Display Diff、标准 Git Diff 等）
 */
export function parseUnifiedDiffText(diffText: string): { hunks: DiffHunk[]; stats: FileDiffStats } {
	const hunks: DiffHunk[] = [];
	let currentHunk: DiffHunk | null = null;
	let additions = 0;
	let deletions = 0;

	let oldLine = 1;
	let newLine = 1;

	const rawLines = diffText.split("\n");

	// 暂存待配对计算词级差异的 del / add 缓存
	let pendingDels: DiffLine[] = [];
	let pendingAdds: DiffLine[] = [];

	const flushWordDiff = () => {
		if (pendingDels.length === 1 && pendingAdds.length === 1) {
			const { oldTokens, newTokens } = computeWordDiff(pendingDels[0].content, pendingAdds[0].content);
			pendingDels[0].tokens = oldTokens;
			pendingAdds[0].tokens = newTokens;
		}
		pendingDels = [];
		pendingAdds = [];
	};

	const ensureHunk = (header = "@@ Changes @@") => {
		if (!currentHunk) {
			currentHunk = {
				header,
				lines: [],
			};
			hunks.push(currentHunk);
		}
		return currentHunk;
	};

	for (const raw of rawLines) {
		// 跳过 diff 头部 --- / +++ / === / Index:
		if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("===") || raw.startsWith("Index:")) {
			continue;
		}

		// 标准 Hunk 头：@@ -from,len +to,len @@ [header]
		if (raw.startsWith("@@")) {
			flushWordDiff();
			const match = /@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@(.*)/.exec(raw);
			if (match) {
				oldLine = parseInt(match[1], 10);
				newLine = parseInt(match[2], 10);
			}
			currentHunk = {
				header: raw.trim(),
				lines: [],
			};
			hunks.push(currentHunk);
			continue;
		}

		// 检查是否为 SDK display diff 的上下文折叠标识（如 "   ..." 或 "       ..."）
		if (/^\s+\.\.\.\s*$/.test(raw)) {
			flushWordDiff();
			currentHunk = {
				header: "@@ ... @@",
				lines: [],
			};
			hunks.push(currentHunk);
			continue;
		}

		// 尝试匹配 SDK Display Diff（首字符为 +, -, ' '，后接可选行号与内容）
		const sdkMatch = SDK_DISPLAY_DIFF_RE.exec(raw);
		if (sdkMatch) {
			const prefix = sdkMatch[1];
			const numStr = sdkMatch[2] ? sdkMatch[2].trim() : undefined;
			const explicitLineNum = numStr ? parseInt(numStr, 10) : undefined;
			const text = sdkMatch[3];

			const hunk = ensureHunk();

			if (prefix === "+") {
				additions++;
				const lineNum = explicitLineNum ?? newLine++;
				const line: DiffLine = {
					type: "add",
					newLineNum: lineNum,
					content: text,
				};
				hunk.lines.push(line);
				pendingAdds.push(line);
			} else if (prefix === "-") {
				deletions++;
				const lineNum = explicitLineNum ?? oldLine++;
				const line: DiffLine = {
					type: "del",
					oldLineNum: lineNum,
					content: text,
				};
				hunk.lines.push(line);
				pendingDels.push(line);
			} else {
				flushWordDiff();
				const lineNum = explicitLineNum ?? oldLine++;
				if (!explicitLineNum) newLine++;
				const line: DiffLine = {
					type: "context",
					oldLineNum: lineNum,
					newLineNum: lineNum,
					content: text,
				};
				hunk.lines.push(line);
			}
			continue;
		}

		// 普通 Unified Diff 行（无行号前缀，仅单字符 +/-/空格）
		if (raw.length > 0) {
			const prefix = raw[0];
			const text = raw.slice(1);
			const hunk = ensureHunk();

			if (prefix === "+") {
				additions++;
				const line: DiffLine = {
					type: "add",
					newLineNum: newLine++,
					content: text,
				};
				hunk.lines.push(line);
				pendingAdds.push(line);
			} else if (prefix === "-") {
				deletions++;
				const line: DiffLine = {
					type: "del",
					oldLineNum: oldLine++,
					content: text,
				};
				hunk.lines.push(line);
				pendingDels.push(line);
			} else if (prefix === " ") {
				flushWordDiff();
				const line: DiffLine = {
					type: "context",
					oldLineNum: oldLine++,
					newLineNum: newLine++,
					content: text,
				};
				hunk.lines.push(line);
			}
		}
	}

	flushWordDiff();

	return {
		hunks,
		stats: { additions, deletions },
	};
}

/**
 * 当没有 details.diff / details.patch 时，从 `edits: [{ oldText, newText }]` 直接构造 DiffHunk
 */
export function buildHunksFromEdits(edits: Array<{ oldText?: string; newText?: string }>): {
	hunks: DiffHunk[];
	stats: FileDiffStats;
} {
	const hunks: DiffHunk[] = [];
	let additions = 0;
	let deletions = 0;

	edits.forEach((edit, idx) => {
		const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
		const newText = typeof edit.newText === "string" ? edit.newText : "";

		const oldLines = oldText ? oldText.split("\n") : [];
		const newLines = newText ? newText.split("\n") : [];

		deletions += oldLines.length;
		additions += newLines.length;

		const lines: DiffLine[] = [];

		if (oldLines.length === 1 && newLines.length === 1) {
			const { oldTokens, newTokens } = computeWordDiff(oldLines[0], newLines[0]);
			lines.push({
				type: "del",
				content: oldLines[0],
				tokens: oldTokens,
			});
			lines.push({
				type: "add",
				content: newLines[0],
				tokens: newTokens,
			});
		} else {
			for (const line of oldLines) {
				lines.push({ type: "del", content: line });
			}
			for (const line of newLines) {
				lines.push({ type: "add", content: line });
			}
		}

		hunks.push({
			header: `@@ Hunk #${idx + 1} (${oldLines.length} lines -> ${newLines.length} lines) @@`,
			lines,
		});
	});

	return {
		hunks,
		stats: { additions, deletions },
	};
}

/**
 * 解析各种文件修改工具（edit, edit_soft, write, patch）的数据模型
 */
export function parseFileMutationArgs(
	toolName: string,
	argsText?: string,
	details?: unknown,
	output?: string,
): FileDiffData | null {
	const isWrite = toolName === "write";
	const isEdit = toolName === "edit" || toolName === "edit_soft" || toolName === "patch";

	if (!isWrite && !isEdit) {
		return null;
	}

	let path = "";
	let isStreamingPartial = false;

	// 1. 尝试完整 JSON 解析
	let parsedArgs: Record<string, unknown> | null = null;
	if (argsText) {
		try {
			parsedArgs = JSON.parse(argsText) as Record<string, unknown>;
			if (typeof parsedArgs.path === "string") {
				path = parsedArgs.path;
			} else if (typeof parsedArgs.file_path === "string") {
				path = parsedArgs.file_path;
			}
		} catch {
			isStreamingPartial = true;
			// 流式半截 JSON 容错：正则扫路径
			const match = /"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\\n]|\\.){0,2000})"/.exec(argsText);
			if (match) {
				try {
					path = JSON.parse(`"${match[1]}"`) as string;
				} catch {
					path = match[1];
				}
			}
		}
	}

	// 若参数内未提取到路径（如 content 在前面且超长被截断），从执行输出中提取路径兜底
	if (!path && output) {
		const outMatch =
			/(?:Successfully (?:wrote to|replaced \d+ block\(s\) in)|written to|Created)\s+([^\s\n\r"']+)/i.exec(output);
		if (outMatch) {
			path = outMatch[1].trim();
		}
	}

	const language = detectLanguage(path);

	// 2. 如果是 write 工具
	if (isWrite) {
		let content = "";
		if (parsedArgs && typeof parsedArgs.content === "string") {
			content = parsedArgs.content;
		} else if (argsText) {
			// 流式半截或截断 JSON 容错提取 content，并安全解转义
			const contentMatch = /"content"\s*:\s*"/i.exec(argsText);
			if (contentMatch) {
				const start = contentMatch.index + contentMatch[0].length;
				let rawSlice = argsText.slice(start);
				const nextKeyMatch = /",\s*"(?:path|file_path|filePath)"/i.exec(rawSlice);
				if (nextKeyMatch) {
					rawSlice = rawSlice.slice(0, nextKeyMatch.index);
				} else {
					rawSlice = rawSlice.replace(/\s*(?:\.\.\.\s*\[truncated\])?\s*"?\s*}?\s*$/, "");
				}
				content = unescapeJsonString(rawSlice);
			} else {
				content = unescapeJsonString(argsText);
			}
		}

		const totalLines = content ? content.split("\n").length : 0;
		return {
			filePath: path,
			toolName,
			isWrite: true,
			language,
			content,
			isStreamingPartial,
			stats: {
				additions: totalLines,
				deletions: 0,
				totalLines,
				isNewFile: true,
			},
			hunks: [],
		};
	}

	// 3. 如果是 edit 类工具
	// 3.1 优先检查 SDK details.patch（标准 unified patch，带 @@ 和完整上下文）
	const detailsPatch =
		details && typeof details === "object" && typeof (details as { patch?: unknown }).patch === "string"
			? (details as { patch: string }).patch
			: undefined;

	if (detailsPatch) {
		const res = parseUnifiedDiffText(detailsPatch);
		if (res.hunks.length > 0 && res.hunks.some((h) => h.lines.length > 0)) {
			return {
				filePath: path,
				toolName,
				isWrite: false,
				language,
				stats: res.stats,
				hunks: res.hunks,
				isStreamingPartial: false,
			};
		}
	}

	// 3.2 其次检查 SDK details.diff（展示型 display diff，带行号）
	const detailsDiff =
		details && typeof details === "object" && typeof (details as { diff?: unknown }).diff === "string"
			? (details as { diff: string }).diff
			: undefined;

	if (detailsDiff) {
		const res = parseUnifiedDiffText(detailsDiff);
		if (res.hunks.length > 0 && res.hunks.some((h) => h.lines.length > 0)) {
			return {
				filePath: path,
				toolName,
				isWrite: false,
				language,
				stats: res.stats,
				hunks: res.hunks,
				isStreamingPartial: false,
			};
		}
	}

	// 3.3 降级从 edits 数组生成（完全不依赖 details，从参数自身还原）
	let edits: Array<{ oldText?: string; newText?: string }> = [];
	if (parsedArgs && Array.isArray(parsedArgs.edits)) {
		edits = parsedArgs.edits as Array<{ oldText?: string; newText?: string }>;
	}

	if (edits.length > 0) {
		const { hunks, stats } = buildHunksFromEdits(edits);
		return {
			filePath: path,
			toolName,
			isWrite: false,
			language,
			stats,
			hunks,
			isStreamingPartial,
		};
	}

	// 3.4 若处于流式早期且尚未解析出完整 edits
	return {
		filePath: path,
		toolName,
		isWrite: false,
		language,
		stats: { additions: 0, deletions: 0 },
		hunks: [],
		isStreamingPartial: true,
	};
}
