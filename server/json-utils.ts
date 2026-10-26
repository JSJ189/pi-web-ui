/**
 * json-utils.ts — 跨模块共享 JSON 工具集。
 *
 * 统一收敛带注释 JSON（JSONC）的安全剥离与解析，消除跨模块重复手搓。
 */

/**
 * 剥离 JSON 字符串中的 // 单行注释与 /* *\/ 块级注释。
 * 保护字符串字面量内部内容（如 URL 中的 "https://..." 或包含引号/斜杠的内容）。
 */
export function stripJsonComments(src: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (inString) {
			out += c;
			if (c === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * 安全解析可能包含注释的 JSON 文本。
 */
export function parseJsonWithComments<T = unknown>(src: string): T {
	return JSON.parse(stripJsonComments(src)) as T;
}
