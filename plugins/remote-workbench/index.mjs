/**
 * plugins/remote-workbench/index.mjs — 远程工作台服务端入口。
 *
 * 核心机制（对标 Termcp）：
 * 1. 唯一事实源：直接读取宿主服务 remoteSshService（<dataDir>/global-hosts.json），
 *    与「远程工作区 (SSH)」和「SFTP 插件」完全共享主机资产，零重复配置；
 * 2. 交互式 PTY Web SSH：基于 remoteSshService.openShell 建立流式双向通道，
 *    通过 host.sendTo / host.onMessage 提供极低延迟的终端交互；
 * 3. AI 批处理执行工具：注册 remote_term 工具，集成 Termcp 式 ANSI 噪音折叠与 98% Token 压缩；
 * 4. 端口转发引擎：支持在任意主机上建立本地端口转发（-L tunnel）。
 */

import net from "node:net";
import path from "node:path";
import { compact } from "./client/lib/compact.mjs";
import { scanLocalSshConfig } from "./client/lib/ssh-config.mjs";

export default {
	async activate(host) {
		const log = (msg, level = "info") => {
			try {
				host.log?.(level, `[remote-workbench] ${msg}`);
			} catch {}
		};

		const getRemoteSsh = () => {
			const svc = typeof host.services?.get === "function" ? host.services.get("remoteSsh") : null;
			if (!svc) {
				throw new Error("宿主远程 SSH 服务（remoteSsh）未就绪，请确保 pi-web-ui 为最新版本");
			}
			return svc;
		};

		/** 活动终端表：shellId → { stream, from, close } */
		const activeShells = new Map();
		/** 活动端口转发隧道表：tunnelId → { id, hostName, localPort, targetHost, targetPort, server, startedAt } */
		const activeTunnels = new Map();

		// ── HTTP 路由 ────────────────────────────────────────────────────────
		const route = (method, p, fn) => {
			host.route(method, p, async (req, res) => {
				try {
					const data = await fn(req);
					res.json({ ok: true, data: data ?? null });
				} catch (err) {
					const msg = String(err?.message ?? err);
					log(`${method} ${p} 失败: ${msg}`, "warn");
					res.status(400).json({ ok: false, error: msg });
				}
			});
		};

		// 获取所有全局主机
		route("GET", "/hosts", async () => {
			const remoteSsh = getRemoteSsh();
			const list = await remoteSsh.listProfiles();
			return { hosts: list };
		});

		// 新增或更新全局主机
		route("POST", "/hosts", async (req) => {
			const remoteSsh = getRemoteSsh();
			const b = req.body ?? {};
			const hostAddr = String(b.host ?? "").trim();
			const username = String(b.username ?? "").trim() || "root";
			const port = Number(b.port) || 22;
			const name = String(b.name ?? "").trim() || `${username}@${hostAddr}`;
			if (!hostAddr) throw new Error("主机地址（host）不能为空");

			const auth = b.auth ?? {};
			const authType = auth.type === "key" ? "key" : auth.type === "agent" ? "agent" : "password";

			await remoteSsh.saveProfile(
				name,
				{
					host: hostAddr,
					port,
					username,
					auth: {
						type: authType,
						password: authType === "password" ? String(auth.password ?? "") : undefined,
						privateKeyPath: authType === "key" ? String(auth.privateKeyPath ?? "") : undefined,
						passphrase: authType === "key" && auth.passphrase ? String(auth.passphrase) : undefined,
					},
				},
				{
					remotePath: b.remotePath ? String(b.remotePath).trim() : undefined,
					description: b.description ? String(b.description).trim() : undefined,
					reviewMode: Boolean(b.reviewMode),
				},
			);

			const list = await remoteSsh.listProfiles();
			return { hosts: list, savedName: name };
		});

		// 删除全局主机
		route("POST", "/hosts/delete", async (req) => {
			const remoteSsh = getRemoteSsh();
			const name = String(req.body?.name ?? "").trim();
			if (!name) throw new Error("未指定要删除的主机名称");
			await remoteSsh.deleteProfile(name);
			const list = await remoteSsh.listProfiles();
			return { hosts: list };
		});

		// 探测并测试连接
		route("POST", "/hosts/probe", async (req) => {
			const remoteSsh = getRemoteSsh();
			const b = req.body ?? {};
			const hostAddr = String(b.host ?? "").trim();
			const username = String(b.username ?? "").trim() || "root";
			const port = Number(b.port) || 22;
			const name = b.name ? String(b.name).trim() : undefined;
			const auth = b.auth ?? {};
			const authType = auth.type === "key" ? "key" : auth.type === "agent" ? "agent" : "password";

			const res = await remoteSsh.probe({
				host: hostAddr,
				port,
				username,
				profileName: name,
				auth: {
					type: authType,
					password: authType === "password" && auth.password ? String(auth.password) : undefined,
					privateKeyPath: authType === "key" && auth.privateKeyPath ? String(auth.privateKeyPath) : undefined,
					passphrase: authType === "key" && auth.passphrase ? String(auth.passphrase) : undefined,
				},
			});

			if (!res.ok) {
				return {
					...res,
					connected: false,
				};
			}

			const system = { ...(res.system || {}) };
			// 若宿主当前运行版本尚未包含物理硬件指标，通过活跃连接无缝补齐真实的发行版、CPU核数与内存大小
			if (!system.cores || !system.totalMemMb || system.totalMemMb === 0) {
				try {
					const conn = await remoteSsh.getOrConnectHost(hostAddr, port, username);
					const rawHw = await new Promise((resolve, reject) => {
						const hwCmd = `. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s; (nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1); (awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || free -m 2>/dev/null | awk '/Mem:/ {print $2}' || echo 0)`;
						conn.client.exec(hwCmd, (err, stream) => {
							if (err) return reject(err);
							let out = "";
							stream.on("data", (d) => {
								out += d.toString("utf8");
							});
							stream.on("close", () => resolve(out.trim()));
							stream.on("error", reject);
						});
					});
					const lines = rawHw
						.split(/\r?\n/)
						.map((l) => l.trim())
						.filter(Boolean);
					if (lines[0]) system.distro = lines[0];
					if (lines[1]) system.cores = parseInt(lines[1], 10) || system.cores || 1;
					if (lines[2]) system.totalMemMb = parseInt(lines[2], 10) || system.totalMemMb || 0;
				} catch {
					// 补齐失败保持原样
				}
			}

			return {
				...res,
				connected: true,
				system,
			};
		});

		// ── ~/.ssh/config 发现与导入 ─────────────────────────────────────────
		route("GET", "/sshconfig", async () => {
			const remoteSsh = getRemoteSsh();
			const scanned = await scanLocalSshConfig();
			const existing = await remoteSsh.listProfiles();
			const existingNames = new Set(existing.map((h) => h.name));
			const list = scanned.list.map((h) => ({
				...h,
				imported: existingNames.has(h.alias) || existingNames.has(`${h.username}@${h.host}`),
			}));
			return { exists: scanned.exists, path: scanned.path, list };
		});

		route("POST", "/sshconfig/import", async (req) => {
			const remoteSsh = getRemoteSsh();
			const items = Array.isArray(req.body?.items) ? req.body.items : [];
			let importedCount = 0;
			for (const h of items) {
				if (!h.host || !h.alias) continue;
				await remoteSsh.saveProfile(
					h.alias,
					{
						host: h.host,
						port: Number(h.port) || 22,
						username: h.username || "root",
						auth: {
							type: "key",
							privateKeyPath: h.privateKeyPath,
						},
					},
					{
						description: `Imported from ~/.ssh/config (${h.alias})`,
					},
				);
				importedCount++;
			}
			const list = await remoteSsh.listProfiles();
			return { hosts: list, importedCount };
		});

		// ── 轻量 SFTP 远程文件浏览 ──────────────────────────────────────────
		route("POST", "/files/list", async (req) => {
			const remoteSsh = getRemoteSsh();
			const hostName = String(req.body?.hostName ?? "").trim();
			const reqPath = String(req.body?.path ?? "").trim();
			if (!hostName) throw new Error("未指定主机");

			const profiles = await remoteSsh.listProfiles();
			const targetProf = profiles.find((p) => p.name === hostName || p.host === hostName);
			if (!targetProf) throw new Error(`主机「${hostName}」未找到`);

			const conn = await remoteSsh.getOrConnectHost(targetProf.host, targetProf.port, targetProf.username);
			const sftp = await remoteSsh.getSftp(conn);

			const homeDir = conn.system?.homeDir || "/";
			let targetPath = reqPath || targetProf.remotePath || homeDir;
			if (targetPath === "~") targetPath = homeDir;
			else if (targetPath.startsWith("~/")) targetPath = path.posix.join(homeDir, targetPath.slice(2));
			if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;

			return new Promise((resolve, reject) => {
				sftp.readdir(targetPath, (err, list) => {
					if (err) return reject(new Error(`无法读取目录「${targetPath}」: ${err.message}`));
					const items = (list || []).map((it) => ({
						name: it.filename,
						path: path.posix.join(targetPath, it.filename),
						isDirectory: (it.attrs.mode & 0o170000) === 0o040000,
						size: it.attrs.size,
						mtime: it.attrs.mtime * 1000,
					}));
					items.sort((a, b) => {
						if (a.isDirectory && !b.isDirectory) return -1;
						if (!a.isDirectory && b.isDirectory) return 1;
						return a.name.localeCompare(b.name);
					});
					const parentPath = targetPath === "/" ? null : path.posix.dirname(targetPath);
					resolve({ path: targetPath, parentPath, items });
				});
			});
		});

		route("POST", "/files/read", async (req) => {
			const remoteSsh = getRemoteSsh();
			const hostName = String(req.body?.hostName ?? "").trim();
			const remotePath = String(req.body?.path ?? "").trim();
			const maxBytes = Math.min(512 * 1024, Number(req.body?.maxBytes) || 256 * 1024);
			if (!hostName || !remotePath) throw new Error("缺 hostName 或 path");

			const profiles = await remoteSsh.listProfiles();
			const targetProf = profiles.find((p) => p.name === hostName || p.host === hostName);
			if (!targetProf) throw new Error(`主机「${hostName}」未找到`);

			const conn = await remoteSsh.getOrConnectHost(targetProf.host, targetProf.port, targetProf.username);
			const sftp = await remoteSsh.getSftp(conn);

			return new Promise((resolve, reject) => {
				sftp.open(remotePath, "r", (err, handle) => {
					if (err) return reject(err);
					const buf = Buffer.alloc(maxBytes);
					sftp.read(handle, buf, 0, maxBytes, 0, (readErr, bytesRead) => {
						sftp.close(handle, () => {});
						if (readErr) return reject(readErr);
						const slice = buf.subarray(0, bytesRead);
						let isBinary = false;
						for (let i = 0; i < Math.min(slice.length, 512); i++) {
							if (slice[i] === 0) {
								isBinary = true;
								break;
							}
						}
						resolve({
							path: remotePath,
							size: bytesRead,
							isBinary,
							content: isBinary ? "" : slice.toString("utf8"),
						});
					});
				});
			});
		});

		route("POST", "/files/upload", async (req) => {
			const remoteSsh = getRemoteSsh();
			const hostName = String(req.body?.hostName ?? "").trim();
			const targetDir = String(req.body?.targetDir ?? "").trim() || "/";
			const fileName = String(req.body?.fileName ?? "").trim();
			const b64 = String(req.body?.b64 ?? "");
			if (!hostName || !fileName) throw new Error("缺 hostName 或 fileName");

			const profiles = await remoteSsh.listProfiles();
			const targetProf = profiles.find((p) => p.name === hostName || p.host === hostName);
			if (!targetProf) throw new Error(`主机「${hostName}」未找到`);

			const conn = await remoteSsh.getOrConnectHost(targetProf.host, targetProf.port, targetProf.username);
			const sftp = await remoteSsh.getSftp(conn);
			const fullPath = path.posix.join(targetDir, fileName);

			return new Promise((resolve, reject) => {
				const stream = sftp.createWriteStream(fullPath);
				stream.on("error", (err) => reject(err));
				stream.on("close", () => resolve({ ok: true, path: fullPath }));
				stream.end(Buffer.from(b64, "base64"));
			});
		});

		// ── 端口转发路由（-L 隧道） ──────────────────────────────────────────
		route("GET", "/tunnels", () => {
			return {
				tunnels: Array.from(activeTunnels.values()).map((t) => ({
					id: t.id,
					hostName: t.hostName,
					localPort: t.localPort,
					targetHost: t.targetHost,
					targetPort: t.targetPort,
					startedAt: t.startedAt,
				})),
			};
		});

		route("POST", "/tunnels/start", async (req) => {
			const remoteSsh = getRemoteSsh();
			const b = req.body ?? {};
			const hostName = String(b.hostName ?? "").trim();
			const localPort = Number(b.localPort);
			const targetHost = String(b.targetHost ?? "127.0.0.1").trim() || "127.0.0.1";
			const targetPort = Number(b.targetPort);

			if (!hostName) throw new Error("未指定目标主机");
			if (!localPort || localPort < 1 || localPort > 65535) throw new Error("本地端口无效 (1-65535)");
			if (!targetPort || targetPort < 1 || targetPort > 65535) throw new Error("远端目标端口无效 (1-65535)");

			const profiles = await remoteSsh.listProfiles();
			const targetProf = profiles.find((p) => p.name === hostName || p.host === hostName);
			if (!targetProf) throw new Error(`主机「${hostName}」在 global-hosts.json 中不存在`);

			const conn = await remoteSsh.getOrConnectHost(targetProf.host, targetProf.port, targetProf.username);

			const server = net.createServer((socket) => {
				conn.client.forwardOut("127.0.0.1", localPort, targetHost, targetPort, (err, stream) => {
					if (err) {
						socket.destroy();
						return;
					}
					socket.pipe(stream).pipe(socket);
					socket.on("error", () => stream.destroy());
					stream.on("error", () => socket.destroy());
				});
			});

			await new Promise((resolve, reject) => {
				server.listen(localPort, "127.0.0.1", () => resolve(null));
				server.on("error", reject);
			});

			const tunnelId = `tun_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
			const entry = {
				id: tunnelId,
				hostName: targetProf.name,
				localPort,
				targetHost,
				targetPort,
				server,
				startedAt: Date.now(),
			};
			activeTunnels.set(tunnelId, entry);

			return {
				tunnel: {
					id: tunnelId,
					hostName: targetProf.name,
					localPort,
					targetHost,
					targetPort,
					startedAt: entry.startedAt,
				},
			};
		});

		route("POST", "/tunnels/stop", (req) => {
			const id = String(req.body?.tunnelId ?? "").trim();
			const t = activeTunnels.get(id);
			if (!t) throw new Error("隧道不存在或已关闭");
			try {
				t.server.close();
			} catch {}
			activeTunnels.delete(id);
			return { stopped: true };
		});

		// ── AI 批处理执行工具（remote_term） ────────────────────────────────
		if (typeof host.registerTool === "function") {
			host.registerTool({
				name: "remote_term",
				description:
					"Execute commands or inspect status on configured remote SSH servers from global-hosts.json with ANSI compaction.",
				promptSnippet: "Execute commands on configured remote SSH servers",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["run", "list", "probe"],
							description: "Action to perform: run (exec command), list (list saved hosts), probe (inspect env)",
						},
						host: {
							type: "string",
							description: "Target host name from global-hosts.json (required for run and probe)",
						},
						cmd: {
							type: "string",
							description: "Shell command line to execute on remote host (required for run)",
						},
						cwd: {
							type: "string",
							description: "Optional working directory on remote host",
						},
						timeout: {
							type: "number",
							description: "Execution timeout in seconds (default 15, max 120)",
						},
					},
					required: ["action"],
				},
				execute: async (_toolCallId, params) => {
					const remoteSsh = getRemoteSsh();
					const action = String(params?.action ?? "").trim();

					if (action === "list") {
						const hostsList = await remoteSsh.listProfiles();
						return JSON.stringify({ ok: true, hosts: hostsList }, null, 2);
					}

					const hostName = String(params?.host ?? "").trim();
					if (!hostName) {
						return JSON.stringify({ ok: false, error: "Missing required parameter 'host'" });
					}

					const profiles = await remoteSsh.listProfiles();
					const targetProf = profiles.find((p) => p.name === hostName || p.host === hostName);
					if (!targetProf) {
						return JSON.stringify({
							ok: false,
							error: `Host '${hostName}' not found in global-hosts.json. Available: ${profiles.map((p) => p.name).join(", ")}`,
						});
					}

					if (action === "probe") {
						const probeRes = await remoteSsh.probe({
							host: targetProf.host,
							port: targetProf.port,
							username: targetProf.username,
							auth: { type: targetProf.authType },
						});
						return JSON.stringify({ ok: true, host: targetProf.name, probe: probeRes }, null, 2);
					}

					if (action === "run") {
						const cmd = String(params?.cmd ?? "").trim();
						if (!cmd) return JSON.stringify({ ok: false, error: "Missing required parameter 'cmd'" });

						// 审阅模式危险指令过滤（对标 Termcp approval gate）
						const DANGEROUS_PATTERNS = [
							/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force|-[a-zA-Z]*f[a-zA-Z]*r)\s+[\/\*]/i,
							/\bmkfs\b/i,
							/\bdd\s+if=/i,
							/\b(shutdown|reboot|poweroff|init\s+0)\b/i,
							/\bdrop\s+(database|schema|table)\b/i,
							/:\(\)\{\s*:\|:&\s*\};:/,
						];
						if (targetProf.reviewMode && DANGEROUS_PATTERNS.some((p) => p.test(cmd))) {
							return JSON.stringify(
								{
									ok: false,
									host: targetProf.name,
									error: `[Approval Gate] Command rejected on review-mode host '${targetProf.name}': contains potentially destructive pattern. Manual review required.`,
								},
								null,
								2,
							);
						}

						const timeoutMs = Math.min(120_000, Math.max(1_000, (Number(params?.timeout) || 15) * 1000));
						const targetDir = params?.cwd ? String(params.cwd).trim() : targetProf.remotePath;

						const fullCmd = targetDir && targetDir !== "~" ? `cd ${targetDir} && ${cmd}` : cmd;
						const conn = await remoteSsh.getOrConnectHost(targetProf.host, targetProf.port, targetProf.username);

						return new Promise((resolve) => {
							let output = "";
							let timedOut = false;
							const timer = setTimeout(() => {
								timedOut = true;
								resolve(
									JSON.stringify({
										ok: false,
										host: targetProf.name,
										error: `Command timed out after ${timeoutMs / 1000}s`,
										partialOutput: compact(output),
									}),
								);
							}, timeoutMs);

							conn.client.exec(fullCmd, (err, stream) => {
								if (err) {
									clearTimeout(timer);
									return resolve(JSON.stringify({ ok: false, host: targetProf.name, error: err.message }));
								}
								stream.on("data", (chunk) => {
									output += chunk.toString("utf8");
								});
								stream.stderr?.on("data", (chunk) => {
									output += chunk.toString("utf8");
								});
								stream.on("close", (code) => {
									clearTimeout(timer);
									if (timedOut) return;
									const cleaned = compact(output);
									resolve(
										JSON.stringify(
											{
												ok: code === 0,
												exitCode: typeof code === "number" ? code : 0,
												host: targetProf.name,
												output: cleaned,
											},
											null,
											2,
										),
									);
								});
							});
						});
					}

					return JSON.stringify({ ok: false, error: `Unknown action: ${action}` });
				},
			});
		}

		// ── WebSocket 终端消息通道 ──────────────────────────────────────────
		const unmsg = host.onMessage(async (msg, from) => {
			if (!msg || typeof msg !== "object") return;
			const action = msg.action;

			// 开启远程终端 Shell
			if (action === "shell_open") {
				const reqId = msg.reqId;
				try {
					const remoteSsh = getRemoteSsh();
					const hostAddr = String(msg.host ?? "").trim();
					const port = Number(msg.port) || 22;
					const username = String(msg.username ?? "").trim() || "root";
					const remotePath = msg.remotePath ? String(msg.remotePath).trim() : undefined;
					const cols = Number(msg.cols) || 80;
					const rows = Number(msg.rows) || 24;

					const { stream, close } = await remoteSsh.openShell(
						{ host: hostAddr, port, username, remotePath },
						{ cols, rows },
					);

					const shellId = `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
					activeShells.set(shellId, { stream, from, close });

					stream.on("data", (chunk) => {
						if (from) {
							host.sendTo(from, {
								event: "shell_data",
								shellId,
								b64: Buffer.from(chunk).toString("base64"),
							});
						}
					});

					stream.stderr?.on("data", (chunk) => {
						if (from) {
							host.sendTo(from, {
								event: "shell_data",
								shellId,
								b64: Buffer.from(chunk).toString("base64"),
							});
						}
					});

					stream.on("close", (code) => {
						activeShells.delete(shellId);
						if (from) {
							host.sendTo(from, {
								event: "shell_close",
								shellId,
								code: typeof code === "number" ? code : 0,
							});
						}
					});

					stream.on("error", (err) => {
						if (from) {
							host.sendTo(from, {
								event: "shell_data",
								shellId,
								b64: Buffer.from(`\r\n\x1b[31m[SSH Shell Error: ${err.message}]\x1b[0m\r\n`).toString("base64"),
							});
						}
					});

					if (from) {
						host.sendTo(from, {
							res: true,
							reqId,
							ok: true,
							shellId,
							host: hostAddr,
							username,
						});
					}
				} catch (err) {
					if (from) {
						host.sendTo(from, {
							res: true,
							reqId,
							ok: false,
							error: err?.message ?? String(err),
						});
					}
				}
				return;
			}

			// 终端输入数据
			if (action === "shell_input") {
				const item = activeShells.get(msg.shellId);
				if (item && msg.b64) {
					try {
						item.stream.write(Buffer.from(msg.b64, "base64"));
					} catch {}
				}
				return;
			}

			// 终端窗口尺寸变更 (Resize)
			if (action === "shell_resize") {
				const item = activeShells.get(msg.shellId);
				if (item && msg.cols && msg.rows) {
					try {
						item.stream.setWindow(Number(msg.rows), Number(msg.cols), 0, 0);
					} catch {}
				}
				return;
			}

			// 关闭终端
			if (action === "shell_close") {
				const item = activeShells.get(msg.shellId);
				if (item) {
					item.close();
					activeShells.delete(msg.shellId);
				}
				return;
			}
		});

		return () => {
			unmsg?.();
			for (const item of activeShells.values()) {
				try {
					item.close();
				} catch {}
			}
			activeShells.clear();
			for (const t of activeTunnels.values()) {
				try {
					t.server.close();
				} catch {}
			}
			activeTunnels.clear();
		};
	},
};
