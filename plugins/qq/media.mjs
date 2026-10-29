/**
 * plugins/qq/media.mjs
 * QQBot 富媒体（图片/视频/语音/文件）纯函数 + 上传链路。
 *
 * 官方 API（https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html）：
 *   1) 先上传拿 file_info：
 *      - 公网 URL：`POST /v2/{users|groups}/{openid}/files {file_type, url}`
 *      - 小文件（≤5MB）：同上带 `file_data`（base64）
 *      - 大文件：`upload_prepare` → 逐片 `PUT presigned_url` → `upload_part_finish`
 *        → `POST .../files {upload_id}`
 *   2) 再发消息：`msg_type=7` + `media.file_info`（文件 ttl 有限，用完即弃）。
 *
 * 这里只做「怎么传」，不碰 token/网络细节：调用方注入 `api(method, path, body)`
 * 与 `put(url, chunk)`，单测可以完全离线（与 wechat-ilink 的媒体单测同思路）。
 */

import { createHash } from "node:crypto";

/** 软限制：超过按文件类型上传（官方文档：图片 20MB / 视频 30MB / 语音 20MB / 文件 200MB）。 */
export const QQ_SOFT_LIMITS = {
	image: 20 * 1024 * 1024,
	video: 30 * 1024 * 1024,
	voice: 20 * 1024 * 1024,
	file: 200 * 1024 * 1024,
};

/** 硬限制：超过直接报错，不浪费带宽。 */
export const QQ_HARD_LIMIT = 200 * 1024 * 1024;

/** file_data（base64）上限：超过就必须走分片上传。 */
export const QQ_FILE_DATA_MAX = 5 * 1024 * 1024;

/** 收图/收文件落盘的单件上限（腾讯 CDN 下载）。 */
export const QQ_INBOUND_MAX = 25 * 1024 * 1024;

/** 秒传判定用的前缀长度（官方：文件前 10002432 字节，约 9.54MB 的 MD5）。 */
export const QQ_MD5_10M_BYTES = 10002432;

const IMAGE_MIME = {
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/bmp": ".bmp",
};

const MIME_BY_EXT = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".mp4": "video/mp4",
	".silk": "audio/silk",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".flac": "audio/flac",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".amr": "audio/amr",
	".opus": "audio/ogg",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".avif": "image/avif",
};

/** 附件 content_type（MIME 或 `voice`/`file` 标记）→ 媒体种类。 */
export function mediaKindOfContentType(contentType) {
	const ct = String(contentType ?? "")
		.trim()
		.toLowerCase()
		.split(";")[0]
		.trim();
	if (!ct) return "file";
	if (ct.startsWith("image/")) return "image";
	if (ct.startsWith("video/")) return "video";
	if (ct.startsWith("audio/") || ct === "voice" || ct.startsWith("voice/")) return "voice";
	return "file";
}

/** 媒体种类 → QQ 上传接口的 file_type（1 图片 / 2 视频 / 3 语音 / 4 文件）。 */
export function qqFileTypeOfKind(kind) {
	switch (kind) {
		case "image":
			return 1;
		case "video":
			return 2;
		case "voice":
			return 3;
		default:
			return 4;
	}
}

/** 扩展名（带点，小写）；未知返回空串。 */
export function extOfMedia({ contentType = "", filename = "", url = "" } = {}) {
	const ct = String(contentType ?? "")
		.trim()
		.toLowerCase()
		.split(";")[0]
		.trim();
	if (IMAGE_MIME[ct]) return IMAGE_MIME[ct];
	if (ct === "video/mp4") return ".mp4";
	if (ct === "audio/mp4") return ".m4a";
	if (ct === "audio/x-wav") return ".wav";
	if (ct.startsWith("audio/")) {
		const sub = ct.slice("audio/".length).replace(/[^a-z0-9]/g, "");
		if (sub) return `.${sub === "mpeg" ? "mp3" : sub}`;
	}
	const nameExt = /\.[A-Za-z0-9]{1,8}$/.exec(String(filename ?? "").trim());
	if (nameExt) return nameExt[0].toLowerCase();
	try {
		const urlExt = /\.[A-Za-z0-9]{1,8}$/.exec(new URL(String(url ?? "")).pathname);
		if (urlExt) return urlExt[0].toLowerCase();
	} catch {
		/* 非法 URL 就按未知处理 */
	}
	return "";
}

/** MIME（按扩展名猜，未知回 application/octet-stream）。 */
export function mimeOfPath(filePath) {
	const m = /\.[A-Za-z0-9]{1,8}$/.exec(String(filePath ?? "").trim());
	return (m && MIME_BY_EXT[m[0].toLowerCase()]) || "application/octet-stream";
}

/** 文件路径/URL → 媒体种类（用扩展名猜；图片/视频/语音/文件）。 */
export function mediaKindOfPath(spec) {
	const s = String(spec ?? "").trim();
	if (!s) return "file";
	if (/^https?:\/\//i.test(s)) {
		const bare = s.split("?")[0].split("#")[0];
		const kind = mediaKindOfContentType(mimeOfPath(bare));
		return kind;
	}
	return mediaKindOfContentType(mimeOfPath(s));
}

/** 收下来的附件落盘用的文件名（保留扩展名，去掉危险字符）。 */
export function inboundFileName({
	contentType = "",
	filename = "",
	url = "",
	index = 0,
	at = Date.now(),
	peer = "",
} = {}) {
	const ext = extOfMedia({ contentType, filename, url }) || "";
	const peerTag = String(peer ?? "")
		.replace(/[^A-Za-z0-9]/g, "")
		.slice(-8);
	const stamp = new Date(at)
		.toISOString()
		.replace(/[-:TZ.]/g, "")
		.slice(0, 14);
	const base = `qq-${peerTag || "peer"}-${stamp}-${index + 1}${ext}`;
	return base.replace(/[\\/:*?"<>|]/g, "_");
}

/** 附件种类中文标签（拼给 agent 的正文用）。 */
export function mediaLabel(kind) {
	switch (kind) {
		case "image":
			return "图片";
		case "video":
			return "视频";
		case "voice":
			return "语音";
		default:
			return "文件";
	}
}

/**
 * 拼「附件」提示行给 agent。落盘成功给绝对路径（agent 用 read 工具直接看），
 * 下载失败/超限则降级为占位文字，绝不吞掉消息。
 */
export function formatInboundMediaLines(items = []) {
	const lines = [];
	for (const it of items) {
		const label = mediaLabel(it.kind);
		const asr = it.asrText ? `（语音转写：${it.asrText}）` : "";
		if (it.path) {
			lines.push(`[${label}] 已保存到：${it.path}${asr}`);
		} else {
			const reason = it.reason ? `（${it.reason}）` : "";
			const name = it.filename ? ` ${it.filename}` : "";
			lines.push(`[${label}${name}]${reason}${asr}`);
		}
		if (it.kind === "voice" && !it.asrText)
			lines.push(
				"未获得平台语音转写；当前插件不提供 ASR，音频路径不代表已理解内容，请用户补充文字或使用可用的转写工具。",
			);
		if (it.kind === "video") lines.push("视频尚未解析；文件路径不代表已理解画面或声音。");
	}
	return lines.join("\n");
}

/** 上传场景端点分段：单聊 /v2/users/{openid}，群聊 /v2/groups/{openid}。 */
export function mediaScopePath(scope) {
	const type = String(scope?.type ?? "").toLowerCase();
	const openid = String(scope?.openid ?? "").trim();
	if (!openid) throw new Error("缺少目标 openid（单聊 user_openid / 群聊 group_openid）");
	if (type === "user" || type === "c2c") return `/v2/users/${encodeURIComponent(openid)}`;
	if (type === "group") return `/v2/groups/${encodeURIComponent(openid)}`;
	throw new Error(`未知上传场景：${type}（只支持 user / group）`);
}

/**
 * 上传一份媒体，返回 file_info 字符串。
 * @param {object} opts
 * @param {(method: string, path: string, body?: unknown) => Promise<any>} opts.api 已带鉴权的 API 调用
 * @param {{type: "user"|"group", openid: string}} opts.scope
 * @param {{url?: string, buffer?: Buffer}} opts.source 公网 URL 或本地字节
 * @param {string} [opts.fileName]
 * @param {"image"|"video"|"voice"|"file"} [opts.kind]
 * @param {(url: string, chunk: Buffer, index: number) => Promise<void>} [opts.put] 分片 PUT（默认走 fetch）
 * @param {(buf: Buffer) => {md5: string, sha1: string, md5_10m: string}} [opts.digests]
 * @param {number} [opts.fileDataMax] base64 直传上限（测试可调小）
 * @param {number} [opts.hardLimit] 硬限制（超过直接拒绝）
 */
export async function uploadQqMedia({
	api,
	scope,
	source,
	fileName = "",
	kind = "file",
	put,
	digests,
	fileDataMax = QQ_FILE_DATA_MAX,
	hardLimit = QQ_HARD_LIMIT,
}) {
	if (typeof api !== "function") throw new Error("uploadQqMedia: 缺少 api 注入");
	const base = mediaScopePath(scope);
	const fileType = qqFileTypeOfKind(kind);
	const name = String(fileName ?? "").trim() || (source?.url ? source.url.split("/").pop() || "file" : "file");

	// 1) 公网 URL：平台自己下载转存，最省事。
	if (source?.url) {
		const r = await api("POST", `${base}/files`, {
			file_type: fileType,
			url: String(source.url),
			file_name: name,
			srv_send_msg: false,
		});
		return fileInfoOf(r);
	}

	const buf = source?.buffer;
	if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error("没有可上传的媒体内容");
	if (buf.length > hardLimit) {
		throw new Error(`文件超过 QQ 硬限制 ${Math.round(hardLimit / 1024 / 1024)}MB，无法发送`);
	}

	// 2) 小文件：base64 直传（免分片，一次请求）。
	if (buf.length <= fileDataMax) {
		const r = await api("POST", `${base}/files`, {
			file_type: effectiveFileType(fileType, buf.length),
			file_data: buf.toString("base64"),
			file_name: name,
			srv_send_msg: false,
		});
		return fileInfoOf(r);
	}

	// 3) 大文件：预上传 → 逐片 PUT → 片确认 → 合并。
	const sum = (digests ?? defaultDigests)(buf);
	const prep = await api("POST", `${base}/upload_prepare`, {
		file_type: effectiveFileType(fileType, buf.length),
		file_size: buf.length,
		file_name: name,
		md5: sum.md5,
		sha1: sum.sha1,
		md5_10m: sum.md5_10m,
	});
	const uploadId = String(prep?.upload_id ?? "").trim();
	if (!uploadId) throw new Error("预上传未返回 upload_id");
	const parts = Array.isArray(prep?.parts) ? [...prep.parts] : [];
	if (parts.length === 0) throw new Error("预上传未返回分片列表");
	parts.sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
	const doPut = put ?? defaultPut;

	for (const part of parts) {
		const index = Number(part?.index ?? 0);
		const offset = Number(part?.offset ?? index * Number(prep?.block_size ?? 0));
		const blockSize = Number(part?.block_size ?? prep?.block_size ?? 0) || buf.length - offset;
		const chunk = buf.subarray(offset, offset + blockSize);
		if (chunk.length === 0) continue;
		await doPut(String(part?.presigned_url ?? part?.url ?? ""), chunk, index);
		await api("POST", `${base}/upload_part_finish`, {
			upload_id: uploadId,
			part_index: index,
			block_size: chunk.length,
			md5: md5hex(chunk),
		});
	}

	const done = await api("POST", `${base}/files`, {
		file_type: effectiveFileType(fileType, buf.length),
		file_name: name,
		upload_id: uploadId,
		srv_send_msg: false,
	});
	return fileInfoOf(done);
}

/**
 * 发一条富媒体消息（msg_type=7）。带 msg_id = 被动回复；不带 = 主动消息（受频次限制）。
 * @param {{api: (method: string, path: string, body?: unknown) => Promise<any>, scope: {type: "user"|"group", openid: string}, fileInfo: string, msgId?: string, msgSeq?: number, content?: string}} args
 */
export async function sendQqMediaMessage({
	api,
	scope,
	fileInfo,
	msgId = "",
	/** @type {number|undefined} */ msgSeq = undefined,
	content = "",
}) {
	const info = String(fileInfo ?? "").trim();
	if (!info) throw new Error("缺少 file_info，无法发送富媒体消息");
	const base = mediaScopePath(scope);
	const payload = { msg_type: 7, media: { file_info: info }, content: String(content ?? "") };
	if (msgSeq !== undefined && msgSeq !== null) payload.msg_seq = msgSeq;
	const id = String(msgId ?? "").trim();
	if (id) payload.msg_id = id;
	return api("POST", `${base}/messages`, payload);
}

/** 超过软限制时降级为「文件」类型（官方行为：图片 20MB 以上按文件卡片发）。 */
export function effectiveFileType(fileType, size) {
	const limit = QQ_SOFT_LIMITS[["", "image", "video", "voice", "file"][fileType] ?? "file"] ?? QQ_HARD_LIMIT;
	return size > limit ? 4 : fileType;
}

function fileInfoOf(res) {
	const info = String(res?.file_info ?? res?.fileInfo ?? "").trim();
	if (!info) throw new Error("上传未返回 file_info");
	return info;
}

function md5hex(buf) {
	return createHash("md5").update(buf).digest("hex");
}

function defaultDigests(buf) {
	return {
		md5: md5hex(buf),
		sha1: createHash("sha1").update(buf).digest("hex"),
		md5_10m: md5hex(buf.subarray(0, QQ_MD5_10M_BYTES)),
	};
}

async function defaultPut(url, chunk) {
	if (!url) throw new Error("分片缺少 presigned_url");
	const res = await fetch(url, { method: "PUT", body: chunk });
	if (!res.ok) throw new Error(`分片上传失败：HTTP ${res.status}`);
}
