/**
 * 音频流 Range 代理与文件下载 —— 解决第三方音源防盗链、跨域、Seek (HTTP 206) 及文件一键下载
 */
import http from "node:http";
import https from "node:https";

const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export function proxyAudioStream(req, res, targetUrl, referer = "", downloadFilename = "") {
	let parsedUrl;
	try {
		parsedUrl = new URL(targetUrl);
	} catch {
		res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid audio URL");
		return;
	}

	const client = parsedUrl.protocol === "https:" ? https : http;
	const headers = {
		"User-Agent": DEFAULT_UA,
		Accept: "*/*",
		"Accept-Encoding": "identity",
	};

	if (referer) {
		headers["Referer"] = referer;
	} else if (parsedUrl.hostname.includes("kuwo.cn")) {
		headers["Referer"] = "http://www.kuwo.cn/";
	} else if (parsedUrl.hostname.includes("kugou.com")) {
		headers["Referer"] = "http://www.kugou.com/";
	} else if (parsedUrl.hostname.includes("163.com") || parsedUrl.hostname.includes("126.net")) {
		headers["Referer"] = "https://music.163.com/";
	}

	if (req.headers.range && !downloadFilename) {
		headers["Range"] = req.headers.range;
	}

	const proxyReq = client.request(
		targetUrl,
		{
			method: "GET",
			headers,
			timeout: 15000,
		},
		(proxyRes) => {
			if (
				(proxyRes.statusCode === 301 || proxyRes.statusCode === 302 || proxyRes.statusCode === 307) &&
				proxyRes.headers.location
			) {
				return proxyAudioStream(req, res, proxyRes.headers.location, referer, downloadFilename);
			}

			const resHeaders = {
				"Content-Type": proxyRes.headers["content-type"] || "audio/mpeg",
				"Accept-Ranges": "bytes",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "Range",
				"Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
			};

			if (downloadFilename) {
				const encodedName = encodeURIComponent(downloadFilename);
				resHeaders["Content-Disposition"] = `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`;
			}

			if (proxyRes.headers["content-length"]) {
				resHeaders["Content-Length"] = proxyRes.headers["content-length"];
			}
			if (proxyRes.headers["content-range"]) {
				resHeaders["Content-Range"] = proxyRes.headers["content-range"];
			}

			res.writeHead(proxyRes.statusCode || 200, resHeaders);
			proxyRes.pipe(res);
		},
	);

	proxyReq.on("timeout", () => {
		proxyReq.destroy();
		if (!res.headersSent) res.writeHead(504).end("Audio stream gateway timeout");
	});

	proxyReq.on("error", (err) => {
		if (!res.headersSent) res.writeHead(502).end(`Audio proxy error: ${err.message}`);
	});

	req.on("close", () => {
		proxyReq.destroy();
	});

	proxyReq.end();
}
