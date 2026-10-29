import { basename, isAbsolute } from "node:path";

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export function imageMime(data) {
	if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (/^GIF8[79]a/.test(data.toString("ascii", 0, 6))) return "image/gif";
	if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return "";
}

async function boundedBody(response) {
	if (!response.ok) throw new Error(`飞书媒体请求失败 HTTP ${response.status}`);
	if (Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES) throw new Error("媒体超过 10MiB");
	const chunks = [];
	let size = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_MEDIA_BYTES) throw new Error("媒体超过 10MiB");
			chunks.push(Buffer.from(value));
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks);
}

export function createMedia({ host, getToken, getBaseUrl, request = fetch }) {
	return {
		async download(cfg, { messageId, key, type, name }) {
			const response = await request(
				`${getBaseUrl(cfg)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${type}`,
				{
					headers: { Authorization: `Bearer ${await getToken(cfg)}` },
					signal: AbortSignal.timeout(60000),
					redirect: "error",
				},
			);
			const data = await boundedBody(response);
			const mimeType =
				type === "image"
					? imageMime(data)
					: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
			if (type === "image" && !mimeType) throw new Error("图片格式不支持或无法解码");
			return { data, mimeType, name };
		},
		async upload(cfg, { filePath, msgType, duration }) {
			if (!["image", "audio", "file", "media"].includes(msgType)) throw new Error("不支持的媒体类型");
			const stat = await (isAbsolute(filePath) ? host.fs.statPath(filePath) : host.fs.stat(filePath));
			if (stat.type !== "file" || stat.size > MAX_MEDIA_BYTES) throw new Error("媒体必须是小于 10MiB 的文件");
			const data = Buffer.from(await (isAbsolute(filePath) ? host.fs.readPath(filePath) : host.fs.read(filePath)));
			if (!data.length || data.length > MAX_MEDIA_BYTES) throw new Error("媒体为空或超过 10MiB");
			const name = basename(filePath);
			if (msgType === "audio" && !/\.opus$/i.test(name))
				throw new Error("飞书语音消息仅支持 opus，请转码或作为 file 发送");
			if (msgType === "media" && !/\.mp4$/i.test(name))
				throw new Error("飞书视频消息仅支持 mp4，请转码或作为 file 发送");
			if (["audio", "media"].includes(msgType) && (!Number.isFinite(duration) || duration <= 0))
				throw new Error("音视频必须提供真实 duration（毫秒）");
			const mime = msgType === "image" ? imageMime(data) : "application/octet-stream";
			if (!mime) throw new Error("图片无法解码或格式不支持");
			const form = new FormData();
			if (msgType === "image") {
				form.set("image_type", "message");
				form.set("image", new Blob([data], { type: mime }), name);
			} else {
				form.set("file_type", msgType === "audio" ? "opus" : msgType === "media" ? "mp4" : "stream");
				form.set("file_name", name);
				if (duration) form.set("duration", String(duration));
				form.set("file", new Blob([data]), name);
			}
			const response = await request(`${getBaseUrl(cfg)}/open-apis/im/v1/${msgType === "image" ? "images" : "files"}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${await getToken(cfg)}` },
				body: form,
				signal: AbortSignal.timeout(60000),
				redirect: "error",
			});
			if (!response.ok) throw new Error(`飞书上传失败 HTTP ${response.status}`);
			const result = await response.json();
			const key = result.data?.[msgType === "image" ? "image_key" : "file_key"];
			if (result.code !== 0 || !key) throw new Error(`飞书上传失败：${result.msg || "缺少资源标识"}`);
			return { msg_type: msgType, content: JSON.stringify({ [msgType === "image" ? "image_key" : "file_key"]: key }) };
		},
	};
}
