import { appUrl } from "./base-url";
import { withToken } from "./auth-token";
import { getClientId } from "./use-chat";

/**
 * 判断 host 是否为本地回环（localhost / 127.0.0.1 / ::1 等）。
 * 用于前端判断当前用户是否通过远程网络访问本服务。
 */
export function isLoopbackAccess(
	host: string = typeof window !== "undefined" ? window.location.hostname : "",
): boolean {
	if (!host) return false;
	const h = host.toLowerCase().trim();
	if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]") return true;
	if (h.startsWith("127.")) return true;
	return false;
}

/**
 * 判断一个 URL 目标是否属于非文件外链（http:, https:, mailto:, tel:, #hash, pi-file: 等）。
 */
export function isExternalOrProtocolLink(target: string): boolean {
	if (!target) return true;
	const t = target.trim();
	if (t.startsWith("#") || t.startsWith("pi-file://")) return true;
	return /^(https?:|mailto:|tel:)/i.test(t);
}

/**
 * 规范化可能来自 Windows 绝对路径、file:// 协议或普通相对路径的文件路径字符串。
 */
export function normalizeTargetFilePath(raw: string, currentCwd?: string): string {
	let p = raw.trim();
	// 清洗 file:/// 前缀
	if (p.startsWith("file:///")) {
		p = p.slice("file:///".length);
		// Windows 盘符路径（如 C:/...）由 file:/// 剥离后可能不需要最前方的斜杠
		if (/^[a-zA-Z]:[/\\]/.test(p)) {
			// e.g. C:/foo
		} else if (/^\/[a-zA-Z]:[/\\]/.test(p)) {
			p = p.slice(1);
		}
	} else if (p.startsWith("file://")) {
		p = p.slice("file://".length);
	}

	// 统一斜杠
	p = p.replace(/\\/g, "/");

	// 若匹配当前工作区绝对路径（且有 currentCwd），尝试剥离为工作区相对路径
	if (currentCwd) {
		const normCwd = currentCwd.replace(/\\/g, "/").replace(/\/+$/, "");
		if (p.toLowerCase().startsWith(normCwd.toLowerCase() + "/")) {
			p = p.slice(normCwd.length + 1);
		}
	}

	return p;
}

/**
 * 是否是 HTML 类文档（需要走沙箱目录映射 preview 路由）
 */
export function isHtmlDocumentPath(filePath: string): boolean {
	const lower = filePath.split("?")[0]?.split("#")[0]?.toLowerCase() ?? "";
	return lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
}

/**
 * 生成在浏览器新标签页中直接安全访问该文件的 URL。
 * - HTML 文档：走 /api/preview/*splat（支持同目录相对资源引用的沙箱预览）
 * - 其它文件（图片、音频、视频、PDF、Markdown、文本等）：走 /api/file
 */
export function resolveWorkspaceFileUrl(filePath: string, currentCwd?: string): string {
	const clean = normalizeTargetFilePath(filePath, currentCwd);
	const cid = getClientId();

	if (isHtmlDocumentPath(clean)) {
		const isAbs = /^[A-Za-z]:\//.test(clean) || clean.startsWith("/");
		const segs = clean
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/");
		const base = isAbs ? `/api/preview/__abs__/${segs}` : `/api/preview/${segs}`;
		return withToken(appUrl(`${base}?clientId=${encodeURIComponent(cid)}&allowJs=1`));
	}

	const qs = new URLSearchParams({
		clientId: cid,
		path: clean,
	});
	return withToken(appUrl(`/api/file?${qs}`));
}
