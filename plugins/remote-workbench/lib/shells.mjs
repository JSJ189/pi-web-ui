import { id, integer, text, profile, quote, STOP_GUARANTEE } from "./runtime.mjs";

const TTL = 30 * 60 * 1000,
	WINDOW = 65536,
	TAIL = 262144;
export class Shells {
	constructor(host, svc, commands) {
		this.host = host;
		this.svc = svc;
		this.commands = commands;
		this.sessions = new Map();
		this.opens = new Map();
		this.disposed = false;
	}
	send(to, payload) {
		if (to && !this.disposed) this.host.sendTo(to, payload.action ? { ...payload, event: payload.action } : payload);
	}
	view(s) {
		return {
			shellId: s.id,
			host: s.host,
			username: s.username,
			attached: !!s.owner,
			expiresAt: s.expiresAt,
			tmux: s.tmux,
			tmuxSession: s.tmuxSession,
			closed: !!s.ended,
		};
	}
	reply(from, reqId, data) {
		this.send(from, { res: true, reqId, ok: true, ...data });
	}
	owned(from, shellId) {
		const s = this.sessions.get(shellId);
		if (!s || s.owner !== from) throw new Error("Terminal owner mismatch");
		return s;
	}
	close(s, reason = "Closed", code = null) {
		if (!this.sessions.has(s.id)) return;
		this.flush(s);
		this.sessions.delete(s.id);
		try {
			s.close();
		} catch {}
		const tail = Buffer.concat(s.tail.filter((p) => p.seq > s.sent).map((p) => p.data));
		this.send(s.owner, {
			action: "shell_close",
			shellId: s.id,
			code,
			reason,
			tailB64: tail.toString("base64"),
			droppedBytes: s.dropped,
			stopGuarantee: STOP_GUARANTEE,
		});
	}
	detach(s) {
		s.owner = null;
		s.expiresAt = Date.now() + TTL;
		s.inflight.clear();
		s.stream.resume?.();
		s.stream.stderr?.resume?.();
	}
	pump(s) {
		if (!s.owner) return;
		let bytes = [...s.inflight.values()].reduce((a, b) => a + b, 0);
		for (const part of s.tail) {
			if (part.seq <= s.sent) continue;
			if (bytes + part.data.length > WINDOW) break;
			s.sent = part.seq;
			s.inflight.set(part.seq, part.data.length);
			bytes += part.data.length;
			this.send(s.owner, {
				action: "shell_data",
				shellId: s.id,
				b64: part.data.toString("base64"),
				seq: part.seq,
				bytes: part.data.length,
			});
		}
		if (bytes >= WINDOW || s.tail.some((p) => p.seq > s.sent)) {
			s.stream.pause?.();
			s.stream.stderr?.pause?.();
		} else {
			s.stream.resume?.();
			s.stream.stderr?.resume?.();
		}
	}
	flush(s) {
		if (!s.pendingBytes) return;
		const buffer = Buffer.concat(s.pending);
		s.pending = [];
		s.pendingBytes = 0;
		for (let offset = 0; offset < buffer.length; offset += 16384) {
			const data = Buffer.from(buffer.subarray(offset, offset + 16384));
			s.tail.push({ seq: ++s.seq, data });
			s.tailBytes += data.length;
		}
		while (s.tailBytes > TAIL) {
			const old = s.tail.shift();
			s.tailBytes -= old.data.length;
			s.dropped += old.data.length;
		}
		this.pump(s);
	}
	async message(msg, from) {
		if (!from || this.disposed || !msg?.action?.startsWith("shell_")) return;
		const { action, reqId } = msg;
		try {
			if (action === "shell_cancel") {
				const p = this.opens.get(`${from}:${msg.openReqId}`);
				if (p) {
					p.cancelled = true;
					p.controller.abort();
				}
				this.reply(from, reqId, { cancelled: true });
				return;
			}
			if (action === "shell_open") {
				text(String(reqId ?? ""), "reqId", 128);
				if (this.sessions.size + this.opens.size >= 32) throw new Error("Terminal capacity reached");
				const key = `${from}:${reqId}`;
				if (this.opens.has(key)) throw new Error("Duplicate open request");
				const pending = { cancelled: false, controller: new AbortController() };
				this.opens.set(key, pending);
				let rejectOpen;
				const cancelled = new Promise((_, reject) => {
					rejectOpen = reject;
				});
				const abortOpen = () => {
					pending.cancelled = true;
					rejectOpen(new Error("Open cancelled or timed out"));
				};
				pending.controller.signal.addEventListener("abort", abortOpen, { once: true });
				const timer = setTimeout(() => pending.controller.abort(), 15000);
				timer.unref?.();
				const opening = (async () => {
					const target = msg.hostName
						? await profile(this.svc(), text(msg.hostName, "hostName", 256))
						: {
								host: text(msg.host, "host", 256),
								port: integer(msg.port, 22, 1, 65535),
								username: text(msg.username, "username", 256),
							};
					const cols = integer(msg.cols, 80, 2, 1000),
						rows = integer(msg.rows, 24, 2, 1000);
					const remotePath = msg.remotePath ? text(msg.remotePath, "remotePath") : undefined;
					const tmux = msg.tmux === true;
					let tmuxSession;
					if (tmux) {
						tmuxSession = msg.tmuxSession ?? `pi_${id()}`;
						if (typeof tmuxSession !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tmuxSession))
							throw new Error("Invalid tmux session");
						const profiles = await this.svc().listProfiles();
						const p = profiles.find(
							(p) => p.host === target.host && p.port === target.port && p.username === target.username,
						);
						if (!p) throw new Error("tmux requires a saved profile");
						const check = await this.commands.run(
							{ host: p.name, cmd: "command -v tmux", timeout: 10 },
							pending.controller.signal,
						);
						if (!check.ok) throw new Error("tmux unavailable or connection cancelled");
					}
					if (pending.cancelled || this.disposed) throw new Error("Open cancelled");
					const shell = await this.svc().openShell({ ...target, remotePath }, { cols, rows });
					if (pending.cancelled || this.disposed) {
						shell.close();
						throw new Error("Open cancelled");
					}
					const s = {
						...shell,
						id: id(),
						token: id(),
						owner: from,
						host: target.host,
						username: target.username,
						tmux,
						tmuxSession,
						expiresAt: Date.now() + TTL,
						heartbeat: Date.now(),
						seq: 0,
						sent: 0,
						inflight: new Map(),
						tail: [],
						tailBytes: 0,
						pending: [],
						pendingBytes: 0,
						dropped: 0,
					};
					this.sessions.set(s.id, s);
					const receive = (chunk) => {
						if (!this.sessions.has(s.id)) return;
						const b = Buffer.from(chunk);
						if (b.length > TAIL) {
							s.dropped += b.length - TAIL;
							s.pending.push(Buffer.from(b.subarray(-TAIL)));
							s.pendingBytes += TAIL;
						} else {
							s.pending.push(b);
							s.pendingBytes += b.length;
						}
						if (s.pendingBytes >= 16384) this.flush(s);
					};
					s.stream.on("data", receive);
					s.stream.stderr?.on("data", receive);
					s.stream.on("error", (e) => this.close(s, e.message));
					s.stream.stderr?.on("error", (e) => this.close(s, e.message));
					s.stream.on("close", (code) => {
						this.flush(s);
						if (!s.owner) {
							s.ended = true;
							s.exitCode = code ?? null;
						} else this.close(s, "SSH channel exited", code ?? null);
					});
					this.reply(from, reqId, { ...this.view(s), resumeToken: s.token, action: "shell_open" });
					if (tmux) s.stream.write(`tmux new-session -A -s ${quote(tmuxSession)}\r`);
				})();
				try {
					await Promise.race([opening, cancelled]);
				} finally {
					clearTimeout(timer);
					pending.controller.signal.removeEventListener("abort", abortOpen);
					this.opens.delete(key);
				}
				return;
			}
			if (action === "shell_list") {
				if (!Array.isArray(msg.resumeTokens) || msg.resumeTokens.length > 64) throw new Error("Invalid resumeTokens");
				this.reply(from, reqId, {
					sessions: [...this.sessions.values()]
						.filter((s) => msg.resumeTokens.includes(s.token))
						.map((s) => this.view(s)),
				});
				return;
			}
			if (action === "shell_attach") {
				const s = [...this.sessions.values()].find((s) => s.token === msg.resumeToken && s.expiresAt > Date.now());
				if (!s) throw new Error("Terminal expired or invalid token");
				const cols = integer(msg.cols, 80, 2, 1000),
					rows = integer(msg.rows, 24, 2, 1000);
				if (s.owner && s.owner !== from)
					this.send(s.owner, {
						action: "shell_close",
						shellId: s.id,
						reason: "Session attached elsewhere",
						stopGuarantee: "Channel remains open for new owner.",
					});
				s.owner = from;
				s.heartbeat = Date.now();
				s.expiresAt = Date.now() + TTL;
				s.inflight.clear();
				s.sent = s.tail[0] ? s.tail[0].seq - 1 : s.seq;
				if (!s.ended) s.stream.setWindow(rows, cols, 0, 0);
				this.reply(from, reqId, { ...this.view(s), resumeToken: s.token, action: "shell_attach" });
				if (s.dropped) this.send(from, { action: "shell_gap", shellId: s.id, droppedBytes: s.dropped });
				this.pump(s);
				if (s.ended) this.close(s, "SSH channel exited while detached", s.exitCode);
				return;
			}
			const s = this.owned(from, msg.shellId);
			if (action === "shell_input") {
				if (typeof msg.b64 !== "string" || msg.b64.length > 21848 || !/^[A-Za-z0-9+/]*={0,2}$/.test(msg.b64))
					throw new Error("Invalid terminal input");
				if (s.inputBlocked) throw new Error("Terminal input backpressure; retry after shell_drain");
				const writable = s.stream.write(Buffer.from(msg.b64, "base64"));
				if (!writable) {
					s.inputBlocked = true;
					s.stream.once("drain", () => {
						s.inputBlocked = false;
						this.send(s.owner, { action: "shell_drain", shellId: s.id });
					});
				}
				this.reply(from, reqId, { accepted: true, writable });
				return;
			} else if (action === "shell_ack") {
				const seq = integer(msg.seq, 0, 0, s.sent);
				s.heartbeat = Date.now();
				s.expiresAt = Date.now() + TTL;
				for (const key of s.inflight.keys()) if (key <= seq) s.inflight.delete(key);
				this.pump(s);
			} else if (action === "shell_resize")
				s.stream.setWindow(integer(msg.rows, 24, 2, 1000), integer(msg.cols, 80, 2, 1000), 0, 0);
			else if (action === "shell_detach") {
				this.detach(s);
				this.reply(from, reqId, { detached: true, expiresAt: s.expiresAt });
				return;
			} else if (action === "shell_close") this.close(s);
			else throw new Error("Unknown shell action");
			if (reqId !== undefined) this.reply(from, reqId, {});
		} catch (e) {
			this.send(from, { res: true, reqId, ok: false, accepted: false, error: String(e.message ?? e) });
		}
	}
	tick() {
		const now = Date.now();
		for (const s of this.sessions.values()) {
			this.flush(s);
			if (s.owner && now - s.heartbeat > 45000) this.detach(s);
			if (!s.owner && s.expiresAt <= now) this.close(s, "Detached session expired");
		}
	}
	dispose() {
		this.disposed = true;
		for (const p of this.opens.values()) {
			p.cancelled = true;
			p.controller.abort();
		}
		for (const s of this.sessions.values()) this.close(s, "Plugin unloaded");
	}
}
