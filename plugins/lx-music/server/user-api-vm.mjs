/**
 * 洛雪自定义音源 (User API) 脚本沙箱执行器
 * 完整模拟 lx 官方运行时环境：lx.request、lx.utils (crypto, buffer, zlib)、lx.on、lx.send
 */
import vm from "node:vm";
import crypto from "node:crypto";
import zlib from "node:zlib";

/** 模拟 needle / 回调风格的 HTTP 请求客户端 */
function createLxRequest() {
	return function lxRequest(url, options = {}, callback) {
		const method = (options.method || "GET").toUpperCase();
		const headers = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
			...options.headers,
		};
		let body = options.body;

		if (options.form) {
			headers["content-type"] = "application/x-www-form-urlencoded";
			body = typeof options.form === "string" ? options.form : new URLSearchParams(options.form).toString();
		}

		const timeoutMs = typeof options.timeout === "number" && options.timeout > 0 ? options.timeout : 15000;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		fetch(url, {
			method,
			headers,
			body: ["GET", "HEAD"].includes(method) ? undefined : body,
			signal: controller.signal,
		})
			.then(async (res) => {
				clearTimeout(timer);
				const buf = Buffer.from(await res.arrayBuffer());
				let rawStr = buf.toString("utf8");
				let parsedBody = rawStr;
				try {
					parsedBody = JSON.parse(rawStr);
				} catch {}

				const resp = {
					statusCode: res.status,
					statusMessage: res.statusText,
					headers: Object.fromEntries(res.headers.entries()),
					bytes: buf.length,
					raw: buf,
					body: parsedBody,
				};
				if (typeof callback === "function") {
					callback(null, resp, parsedBody);
				}
			})
			.catch((err) => {
				clearTimeout(timer);
				if (typeof callback === "function") {
					callback(err, null, null);
				}
			});

		return () => {
			controller.abort();
		};
	};
}

export class UserApiEngine {
	constructor(options = {}) {
		this.apis = new Map(); // id -> { id, meta, handler, script }
		this.activeId = null;
		this.log = options.log || console.log;
	}

	/** 导入并初始化自定义音源脚本 */
	importScript(id, scriptContent) {
		let requestHandler = null;

		// 尝试从头注释解析元数据
		const nameMatch = scriptContent.match(/@name\s+(.+)/);
		const verMatch = scriptContent.match(/@version\s+(.+)/);
		const descMatch = scriptContent.match(/@description\s+(.+)/);
		const authorMatch = scriptContent.match(/@author\s+(.+)/);

		let apiMeta = {
			name: nameMatch ? nameMatch[1].trim() : "自定义音源",
			version: verMatch ? verMatch[1].trim() : "1.0.0",
			description: descMatch ? descMatch[1].trim() : "",
			author: authorMatch ? authorMatch[1].trim() : "",
		};

		const lx = {
			EVENT_NAMES: {
				request: "request",
				inited: "inited",
				updateAlert: "updateAlert",
			},
			on: (eventName, handler) => {
				if (eventName === "request") {
					requestHandler = handler;
				}
			},
			send: (eventName, data) => {
				if (eventName === "inited") {
					if (data?.name) apiMeta.name = data.name;
					if (data?.version) apiMeta.version = data.version;
					if (data?.description) apiMeta.description = data.description;
				}
			},
			request: createLxRequest(),
			utils: {
				crypto: {
					aesEncrypt(buffer, mode, key, iv) {
						const cipher = crypto.createCipheriv(mode, key, iv);
						return Buffer.concat([cipher.update(buffer), cipher.final()]);
					},
					rsaEncrypt(buffer, key) {
						buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
						return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
					},
					randomBytes(size) {
						return crypto.randomBytes(size);
					},
					md5(str) {
						return crypto.createHash("md5").update(str).digest("hex");
					},
				},
				buffer: {
					from(...args) {
						return Buffer.from(...args);
					},
					bufToString(buf, format) {
						return Buffer.from(buf, "binary").toString(format);
					},
				},
				zlib: {
					inflate(buf) {
						return new Promise((resolve, reject) => {
							zlib.inflate(buf, (err, data) => (err ? reject(err) : resolve(data)));
						});
					},
					deflate(data) {
						return new Promise((resolve, reject) => {
							zlib.deflate(data, (err, buf) => (err ? reject(err) : resolve(buf)));
						});
					},
				},
			},
			currentScriptInfo: {
				name: apiMeta.name,
				version: apiMeta.version,
			},
			version: "2.0.0",
			env: "desktop",
		};

		const context = {
			console: {
				log: (...args) => this.log(`[UserApi:${id}]`, ...args),
				error: (...args) => console.error(`[UserApi:${id}]`, ...args),
				warn: (...args) => console.warn(`[UserApi:${id}]`, ...args),
			},
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			Buffer,
			fetch: globalThis.fetch,
			URL,
			URLSearchParams,
			Math,
			Date,
			JSON,
			RegExp,
			encodeURIComponent,
			decodeURIComponent,
			lx,
		};

		context.globalThis = context;
		context.window = context;

		try {
			vm.createContext(context);
			vm.runInContext(scriptContent, context, { timeout: 6000 });

			this.apis.set(id, {
				id,
				meta: apiMeta,
				handler: requestHandler,
				script: scriptContent,
			});

			this.activeId = id;
			return { ok: true, meta: apiMeta };
		} catch (err) {
			return { ok: false, error: String(err?.message || err) };
		}
	}

	setActive(id) {
		if (this.apis.has(id) || id === null) {
			this.activeId = id;
			return true;
		}
		return false;
	}

	removeScript(id) {
		this.apis.delete(id);
		if (this.activeId === id) {
			const keys = [...this.apis.keys()];
			this.activeId = keys.length ? keys[0] : null;
		}
	}

	listApis() {
		const list = [];
		for (const [id, item] of this.apis.entries()) {
			list.push({
				id,
				name: item.meta.name,
				version: item.meta.version,
				description: item.meta.description,
				active: id === this.activeId,
			});
		}
		return list;
	}

	/** 解析播放真实链接 */
	async resolveUrl(source, rawMusicInfo, quality = "128k") {
		if (!this.activeId) return null;
		const target = this.apis.get(this.activeId);
		if (!target || !target.handler) return null;

		// 组装符合洛雪规范的 musicInfo
		const songId = rawMusicInfo.id || rawMusicInfo.songmid || rawMusicInfo.hash;
		const musicInfo = {
			...rawMusicInfo,
			id: songId,
			songmid: songId,
			hash: rawMusicInfo.hash || songId,
			source,
			meta: {
				songId,
				albumId: rawMusicInfo.albumId,
			},
		};

		try {
			const res = await target.handler({
				action: "musicUrl",
				source,
				info: {
					type: quality,
					musicInfo,
				},
			});
			if (typeof res === "string" && res.startsWith("http")) return res;
			if (res?.url && typeof res.url === "string") return res.url;
			return null;
		} catch (err) {
			this.log(`[UserApi:${this.activeId}] resolveUrl error: ${err.message}`);
			return null;
		}
	}
}
