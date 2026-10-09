/**
 * SSH / SFTP 连接管理 —— 连接池 + 配置指纹重连 + 空闲回收 + 远端 exec。
 *
 * 依赖 `ssh2` 不随插件分发：首次用到时经 `host.ensureDeps(["ssh2"])` 自动装到插件
 * 目录（宿主做单飞合并，并发调用只装一次）。装完再 `import("ssh2")` —— 裸 ESM
 * 说明符会从本文件所在目录向上找 node_modules，正好命中插件目录里刚装的那份。
 *
 * 连接键 = `cwd \u0000 连接名`：切换工作区/换 profile 各用各的，互不串台。
 * 指纹 = 影响连接的字段（host/port/username/凭据）；用户改完配置保存，下一次
 * 取连接自动断开重连，不需要重载插件。
 */

import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRef } from "./refs.mjs";

const IDLE_CLOSE_MS = 5 * 60 * 1000; // 空闲多久断开（远端 sshd 一般 10 分钟掐 idle，留点余量）
const READY_TIMEOUT_MS = 20_000;
const MAX_EXEC_BYTES = 256 * 1024;

/** `~` 展开（配置文件里写 `~/.ssh/id_ed25519` 是通行习惯）。 */
export function expandHome(p) {
	const s = String(p ?? "").trim();
	if (!s) return s;
	if (s === "~") return os.homedir();
	if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
	return s;
}

/** `$SSH_AUTH_SOCK` 占位符展开（vscode-sftp 的习惯写法）。 */
function expandAgent(a) {
	return String(a ?? "").replace(/\$SSH_AUTH_SOCK\b/g, () => process.env.SSH_AUTH_SOCK || "");
}

/**
 * @param {{ host: any, log?: (msg: string, level?: string) => void, secrets: { get(n: string): string | undefined } }} deps
 */
export function createSshManager({ host, log = () => {}, secrets }) {
	/** @type {any} */
	let mod = null;
	let loading = null;
	/** 依赖状态：idle | installing | ready | failed（前端读它画 ⚠ 提示）。 */
	const dep = { status: "idle", error: "" };
	/** key → { client, sftp, fp, lastUsed, timer, alive } */
	const pool = new Map();

	/** 惰性加载 ssh2；缺了就装上。并发调用共享同一个 Promise。 */
	function library() {
		if (mod) return Promise.resolve(mod);
		if (loading) return loading;
		loading = (async () => {
			try {
				const m = await import("ssh2");
				mod = m.default ?? m;
				dep.status = "ready";
				return mod;
			} catch {
				/* 没装，下面补装 */
			}
			dep.status = "installing";
			log("ssh2 未就绪，开始安装到插件目录…");
			try {
				if (typeof host.ensureDeps === "function") {
					const ok = await host.ensureDeps(["ssh2"], { onProgress: (m) => log(`install: ${m}`) });
					if (!ok) throw new Error("ensureDeps 返回失败");
				}
				const m = await import("ssh2");
				mod = m.default ?? m;
				dep.status = "ready";
				dep.error = "";
				log("ssh2 就绪");
				return mod;
			} catch (err) {
				dep.status = "failed";
				dep.error = String(err?.message ?? err);
				log(`ssh2 安装失败：${dep.error}`, "error");
				throw new Error(`ssh2 依赖未就绪（${dep.error}）。请在插件目录手动执行 npm install ssh2 后重试。`);
			}
		})();
		loading
			.catch(() => {})
			.finally(() => {
				loading = null;
			});
		return loading;
	}

	/** 把连接上的凭据引用解析成真实值（明文原样返回，但记录来源用于告警）。 */
	async function resolveAuth(conn) {
		const a = conn.auth ?? {};
		const [password, passphrase, privateKey, agent] = await Promise.all([
			resolveRef(a.password, { secrets, label: `${conn.name}.auth.password` }),
			resolveRef(a.passphrase, { secrets, label: `${conn.name}.auth.passphrase` }),
			resolveRef(a.privateKey, { secrets, label: `${conn.name}.auth.privateKey` }),
			resolveRef(a.agent, { secrets, label: `${conn.name}.auth.agent` }),
		]);
		let key = privateKey.value;
		if (!key && a.privateKeyPath) {
			const file = expandHome(a.privateKeyPath);
			try {
				key = await fs.readFile(file, "utf8");
			} catch (err) {
				throw new Error(`私钥文件读不到（${file}）：${err?.code ?? err?.message ?? err}`);
			}
		}
		return {
			password: password.value,
			passphrase: passphrase.value,
			privateKey: key,
			agent: expandAgent(agent.value),
			sources: {
				password: password.source,
				passphrase: passphrase.source,
				privateKey: privateKey.source,
				agent: agent.source,
			},
		};
	}

	/** 影响连接的字段指纹 —— 变了就重连。 */
	function fingerprint(conn, auth) {
		return JSON.stringify([
			conn.host,
			conn.port,
			conn.username,
			auth.password,
			auth.passphrase,
			auth.privateKey ? auth.privateKey.length : 0,
			auth.agent,
		]);
	}

	function drop(key) {
		const entry = pool.get(key);
		if (!entry) return;
		pool.delete(key);
		clearTimeout(entry.timer);
		entry.alive = false;
		try {
			entry.client.end();
		} catch {
			/* 关不掉的连接交给 OS */
		}
	}

	function dropAll() {
		// Map 迭代中删除当前项是安全的（不会跳过未访问的项）
		for (const key of pool.keys()) drop(key);
	}

	function shorten(entry) {
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			if (entry.alive) log(`空闲回收连接 ${entry.key}`);
			drop(entry.key);
		}, IDLE_CLOSE_MS);
		if (typeof entry.timer.unref === "function") entry.timer.unref();
	}

	/**
	 * 取一条可用的 SFTP 通道（必要时新建连接）。
	 * @returns {Promise<{ client: any, sftp: any, key: string }>}
	 */
	async function getSftp(conn) {
		const { Client } = await library();
		if (!conn?.host) throw new Error("尚未配置连接（缺 host）——先在 .pi/sftp.json 或界面里配好");
		const auth = await resolveAuth(conn);
		const fp = fingerprint(conn, auth);
		const key = `${conn.__cwd ?? ""}\u0000${conn.name}`;
		const existing = pool.get(key);
		if (existing && existing.fp === fp && existing.alive) {
			existing.lastUsed = Date.now();
			shorten(existing);
			return { client: existing.client, sftp: existing.sftp, key };
		}
		if (existing) drop(key);

		const opened = await new Promise((resolve, reject) => {
			const client = new Client();
			const opts = {
				host: conn.host,
				port: conn.port || 22,
				username: conn.username || "root",
				readyTimeout: READY_TIMEOUT_MS,
				keepaliveInterval: 10_000,
				keepaliveCountMax: 3,
			};
			if (auth.password) opts.password = auth.password;
			else if (auth.agent) opts.agent = auth.agent;
			else if (auth.privateKey) {
				opts.privateKey = auth.privateKey;
				if (auth.passphrase) opts.passphrase = auth.passphrase;
			} else {
				return reject(
					new Error(
						`${conn.name}: 没有任何可用凭据 —— 配 auth.password / auth.privateKeyPath / auth.agent 之一（建议用 \${secret:名} 引用，明文会让密码进配置文件）`,
					),
				);
			}
			let settled = false;
			const fail = (err) => {
				if (settled) return;
				settled = true;
				try {
					client.end();
				} catch {
					/* ignore */
				}
				reject(err);
			};
			client.on("error", fail);
			client.on("close", () => {
				const cur = pool.get(key);
				if (cur?.client === client) drop(key);
			});
			client.on("ready", () => {
				client.sftp((err, sftp) => {
					if (err) return fail(err);
					settled = true;
					resolve({ client, sftp });
				});
			});
			try {
				client.connect(opts);
			} catch (err) {
				fail(err);
			}
		});

		const entry = { ...opened, fp, key, lastUsed: Date.now(), alive: true, conn };
		entry.timer = null;
		pool.set(key, entry);
		shorten(entry);
		return { client: opened.client, sftp: opened.sftp, key };
	}

	/**
	 * 在远端跑一条命令，收集输出（截断保护）与退出码。
	 *
	 * - `inputStream`：把流（AsyncIterable / Readable）喂进 stdin 再关掉，**带背压**。
	 *   打包上传靠它 —— 不必先在内存里攒出整包再一次 `end()`。
	 * - `binary`：stdout 按字节收（`tar -czf -` 的 gzip 流一旦过 UTF-8 解码就整包全坏）。
	 * - `signal`：中止就断开这条执行通道（命令真被掐掉，不会留在远端跑完）。
	 */
	async function exec(
		conn,
		cmd,
		{ timeoutMs = 120_000, maxBytes = MAX_EXEC_BYTES, binary = false, inputStream, signal } = {},
	) {
		const { client } = await getSftp(conn);
		return new Promise((resolve, reject) => {
			let out = "";
			/** @type {Buffer[]} */
			const outChunks = [];
			let outBytes = 0;
			let errOut = "";
			let truncated = false;
			/** @type {any} */
			let chan = null;
			let settled = false;
			const abortErr = () => (signal?.reason instanceof Error ? signal.reason : new Error("已取消"));
			const stop = () => {
				clearTimeout(timer);
				signal?.removeEventListener?.("abort", onAbort);
			};
			const fail = (err) => {
				if (settled) return;
				settled = true;
				stop();
				try {
					chan?.destroy();
				} catch {
					/* 关不掉的交给 OS */
				}
				reject(err);
			};
			const onAbort = () => fail(abortErr());
			const timer = setTimeout(
				() => fail(new Error(`远端命令超时（${Math.round(timeoutMs / 1000)}s）：${String(cmd).slice(0, 120)}`)),
				timeoutMs,
			);
			const push = (buf, which) => {
				if (which === "err") {
					const e = buf.toString("utf8");
					if (outBytes + out.length + errOut.length + e.length > maxBytes) {
						truncated = true;
						return;
					}
					errOut += e;
					return;
				}
				if (binary) {
					if (outBytes + buf.length > maxBytes) {
						truncated = true;
						return;
					}
					outChunks.push(Buffer.from(buf)); // 拷贝一份：ssh2 的接收缓冲不保证可长期持有
					outBytes += buf.length;
					return;
				}
				const s = buf.toString("utf8");
				if (out.length + errOut.length + s.length > maxBytes) {
					truncated = true;
					return;
				}
				out += s;
			};
			if (signal) {
				if (signal.aborted) return fail(abortErr());
				signal.addEventListener("abort", onAbort, { once: true });
			}
			client.exec(String(cmd), (err, stream) => {
				if (err) return fail(err);
				chan = stream;
				stream.on("data", (b) => push(b, "out"));
				stream.stderr.on("data", (b) => push(b, "err"));
				stream.on("close", (c) => {
					if (settled) return;
					settled = true;
					stop();
					resolve({
						code: typeof c === "number" ? c : null,
						stdout: binary ? Buffer.concat(outChunks) : out,
						stderr: errOut,
						truncated,
					});
				});
				stream.on("error", fail);
				if (inputStream) {
					// 背压喂 stdin：`for await` + write() 的返回值决定要不要等 drain
					(async () => {
						for await (const chunk of inputStream) {
							if (settled) return;
							if (!stream.write(chunk)) await once(stream, "drain");
						}
						stream.end();
					})().catch(fail);
				}
			});
		});
	}

	/**
	 * 跑一条命令，把 stdout 当**流**交给调用方（下载方向的 `tar -czf -` 靠它）：
	 * 调用方边消费边落盘，内存只留一个 chunk，不攒整包。stderr 照旧收集，退出码在流结束后给出。
	 *
	 * 注意：`consume` **不能用 `.on("data")`**（那会切到 flowing 模式把数据抢走），要用
	 * `for await` 迭代传进来的可读流。
	 *
	 * @param {{ consume: (out: any) => Promise<void>, signal?: AbortSignal, timeoutMs?: number, maxStderrBytes?: number }} o
	 * @returns {Promise<{ code: number|null, stderr: string, stderrTruncated: boolean }>}
	 */
	async function execStream(conn, cmd, { consume, signal, timeoutMs = 120_000, maxStderrBytes = 64 * 1024 } = {}) {
		const { client } = await getSftp(conn);
		return new Promise((resolve, reject) => {
			let errOut = "";
			let stderrTruncated = false;
			let code = null;
			let consumed = false;
			let closed = false;
			let settled = false;
			/** @type {any} */
			let chan = null;
			const abortErr = () => (signal?.reason instanceof Error ? signal.reason : new Error("已取消"));
			const stop = () => {
				clearTimeout(timer);
				signal?.removeEventListener?.("abort", onAbort);
			};
			const fail = (err) => {
				if (settled) return;
				settled = true;
				stop();
				try {
					chan?.destroy();
				} catch {
					/* 关不掉的交给 OS */
				}
				reject(err);
			};
			const onAbort = () => fail(abortErr());
			const done = () => {
				if (settled || !consumed || !closed) return;
				settled = true;
				stop();
				resolve({ code, stderr: errOut, stderrTruncated });
			};
			const timer = setTimeout(
				() => fail(new Error(`远端命令超时（${Math.round(timeoutMs / 1000)}s）：${String(cmd).slice(0, 120)}`)),
				timeoutMs,
			);
			if (signal) {
				if (signal.aborted) return fail(abortErr());
				signal.addEventListener("abort", onAbort, { once: true });
			}
			client.exec(String(cmd), (err, stream) => {
				if (err) return fail(err);
				chan = stream;
				stream.stderr.on("data", (b) => {
					if (errOut.length >= maxStderrBytes) {
						stderrTruncated = true;
						return;
					}
					errOut += b.toString("utf8");
				});
				stream.on("close", (c) => {
					code = typeof c === "number" ? c : null;
					closed = true;
					done();
				});
				stream.on("error", fail);
				Promise.resolve()
					.then(() => consume(stream))
					.then(
						() => {
							consumed = true;
							done();
						},
						(e) => fail(e),
					);
			});
		});
	}

	/** 连通性探测：连接 + 远端根可达 + 可写（写一个探针文件再删掉）。 */
	async function probe(conn, { sftpCalls }) {
		const { sftp } = await getSftp(conn);
		const dir = conn.remotePath || "/";
		const existsProbe = await sftpCalls.stat(sftp, dir);
		const probeFile = `${dir.replace(/\/+$/, "")}/.sftp-tmp-probe-${process.pid}`;
		let writable = true;
		let writeError = "";
		try {
			await sftpCalls.writeFile(sftp, probeFile, Buffer.from("ok"));
			await sftpCalls.unlink(sftp, probeFile);
		} catch (err) {
			writable = false;
			writeError = String(err?.message ?? err);
		}
		return {
			remoteExists: Boolean(existsProbe),
			writable,
			writeError,
			authSources: (await resolveAuth(conn)).sources,
		};
	}

	return {
		library,
		getSftp,
		exec,
		execStream,
		probe,
		resolveAuth,
		drop,
		dropAll,
		depState: () => ({ ...dep }),
		poolState: () =>
			[...pool.values()].map((e) => ({
				key: e.key,
				name: e.conn?.name ?? "",
				host: e.conn?.host ?? "",
				idleMs: Date.now() - e.lastUsed,
			})),
	};
}
