import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import {
	sendMacOSIMessage,
	cleanIMessageText,
	peerAccountId,
	stripInternalMarkers,
	IMESSAGE_BOT_PREFIX,
} from "./index.mjs";
const execAsync = promisify(execFile);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

// Messages has no public inbound API. Read only the local database; never mutate it.
export class IMessageBotBridge {
	/** @param {{host?: any, getConfig?: any, log?: any, execFileImpl?: any, platform?: string}} options */
	constructor({ host, getConfig, log, execFileImpl, platform = process.platform } = {}) {
		Object.assign(this, { host, getConfig, execFileImpl, platform });
		this.log = log || (() => {});
		this.running = false;
		this.pollTimer = null;
		this.offRunEvent = null;
		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.dispatches = 0;
		this.generation = 0;
		this.userConversations = new Map();
		this.userWorkspaces = new Map();
		this.settings = new Map();
		this.sessionEpochs = new Map();
		this.cancelEpochs = new Map();
		this.queues = new Map();
		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			platform,
			messagesReceived: 0,
			messagesReplied: 0,
			lastError: null,
		};
	}
	getStatus() {
		return { ...this.status };
	}
	resolveWorkspace(key, cfg) {
		return this.userWorkspaces.get(key) || cfg.workspace || this.host.cwd || "";
	}
	async reply(target, text) {
		try {
			await sendMacOSIMessage(target, IMESSAGE_BOT_PREFIX + text, { execFileImpl: this.execFileImpl });
		} catch (error) {
			this.status.lastError = error.message;
			this.log("warn", `iMessage delivery failed: ${error.message}`);
			throw error;
		}
	}
	async query(sql) {
		const { stdout } = await (this.execFileImpl || execAsync)(
			"/usr/bin/sqlite3",
			["-readonly", "-json", join(homedir(), "Library/Messages/chat.db"), sql],
			{ timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
		);
		return JSON.parse(stdout || "[]");
	}
	async start() {
		if (this.running) return;
		this.status.enabled = true;
		if (this.platform !== "darwin") {
			this.status.state = "unsupported";
			this.status.lastError = `iMessage bridge requires macOS (current platform: ${this.platform}).`;
			return;
		}
		try {
			const rows = await this.query("SELECT COALESCE(MAX(ROWID),0) AS id FROM message");
			this.cursor = Number(rows[0]?.id || 0);
			this.running = true;
			this.offRunEvent = this.host.onRunEvent?.((ev) => this.handleRunEvent(ev));
			this.status.connected = true;
			this.status.state = "connected";
			this.pollTimer = setInterval(
				() =>
					this.poll().catch((error) => {
						this.status.lastError = error.message;
						this.status.connected = false;
						this.status.state = "error";
						this.log("warn", error.message);
					}),
				2000,
			);
			this.pollTimer.unref?.();
		} catch (error) {
			this.status.state = "error";
			this.status.lastError = `Cannot read Messages database. Grant Full Disk Access: ${error.message}`;
			throw error;
		}
	}
	async stop() {
		this.generation++;
		this.running = false;
		clearInterval(this.pollTimer);
		this.pollTimer = null;
		this.offRunEvent?.();
		this.offRunEvent = null;
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";
	}
	async poll() {
		if (!this.running || this.polling) return;
		this.polling = true;
		try {
			const rows = await this.query(
				`SELECT m.ROWID AS id,m.text,m.is_from_me,h.id AS sender,c.guid AS chatId,EXISTS(SELECT 1 FROM message_attachment_join j WHERE j.message_id=m.ROWID) AS hasAttachment FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id LEFT JOIN chat_message_join cm ON cm.message_id=m.ROWID LEFT JOIN chat c ON c.ROWID=cm.chat_id WHERE m.ROWID>${Number(this.cursor)} ORDER BY m.ROWID LIMIT 100`,
			);
			for (const row of rows) {
				if (!this.running) break;
				this.cursor = Math.max(this.cursor, Number(row.id));
				if (row.is_from_me) continue;
				if (row.hasAttachment)
					row.attachments = await this.query(
						`SELECT a.filename AS path,a.mime_type AS mimeType FROM attachment a JOIN message_attachment_join j ON j.attachment_id=a.ROWID WHERE j.message_id=${Number(row.id)}`,
					);
				void this.onInboundMessage(row).catch((error) => this.log("warn", error.message));
			}
			this.status.connected = true;
			this.status.state = "connected";
		} finally {
			this.polling = false;
		}
	}
	onInboundMessage(event) {
		const sender = String(event?.sender || event?.from || "").trim();
		if (!sender) return Promise.resolve();
		const room = String(event.chatId || event.chatGuid || event.groupId || sender),
			key = JSON.stringify([room, event.threadId || "", sender]);
		const target = event.chatId || event.chatGuid || event.groupId ? { chatId: room } : sender;
		if (/^\/(stop|abort)(?:\s|$)/i.test(String(event.text || event.content || "").trim())) {
			return this.receive(event, { sender, key, target });
		}
		const previous = this.queues.get(key) || Promise.resolve();
		const next = previous.catch(() => {}).then(() => this.receive(event, { sender, key, target }));
		this.queues.set(key, next);
		return next.finally(() => {
			if (this.queues.get(key) === next) this.queues.delete(key);
		});
	}
	async receive(event, { sender, key, target }) {
		const generation = this.generation;
		const id = event.id || event.guid;
		if (id) {
			if (this.seenMessageIds.has(id)) return;
			this.seenMessageIds.add(id);
			if (this.seenMessageIds.size > 1000) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
		}
		const cfg = this.getConfig() || {},
			allowed = cfg.allowedUsers || [];
		if (allowed.length && !allowed.includes(sender)) {
			await this.reply(target, "访问受限：您不在白名单中。");
			return;
		}
		const text = cleanIMessageText(event.text || event.content || "");
		if (String(event.text || event.content || "").startsWith(IMESSAGE_BOT_PREFIX)) return;
		this.status.messagesReceived++;
		if (text.startsWith("/")) {
			await this.command(text, { key, target, cfg });
			return;
		}
		const cancelEpoch = this.cancelEpochs.get(key) || 0;
		const attachments = [];
		let imageBytes = 0,
			imageCount = 0;
		for (const attachment of event.attachments || []) {
			const mime = String(attachment.mimeType || "");
			if (/^image\/(png|jpeg|gif|webp)$/.test(mime) && attachment.path) {
				try {
					const path = resolve(String(attachment.path).replace(/^~\//, homedir() + "/"));
					const info = await stat(path);
					if (info.size > 10 * 1024 * 1024) throw new Error("image exceeds 10 MiB");
					if (++imageCount > 8 || (imageBytes += info.size) > 20 * 1024 * 1024)
						throw new Error("images exceed 8 items or 20 MiB total");
					const data = await readFile(path);
					attachments.push({
						path: "",
						imageData: data.toString("base64"),
						mimeType: mime,
						name: path.split(/[\\/]/).pop(),
					});
				} catch (error) {
					await this.reply(target, `图片读取失败：${error.message}`);
					return;
				}
			} else if (attachment.path && /^(audio\/|video\/|text\/|application\/)/.test(mime)) {
				const path = resolve(String(attachment.path).replace(/^~\//, homedir() + "/"));
				try {
					const info = await stat(path);
					if (!info.isFile()) throw new Error("not a regular file");
					attachments.push({ path, mode: "reference", name: path.split(/[\\/]/).pop() });
					if (/^(audio|video)\//.test(mime))
						await this.reply(
							target,
							"已接收音视频文件，将作为附件交给模型；是否能转录或理解取决于模型与可用工具，不保证自动解码。",
						);
				} catch (error) {
					await this.reply(target, `附件读取失败：${error.message}`);
					return;
				}
			} else {
				await this.reply(
					target,
					`不支持或无法识别的附件类型：${mime || "未知类型"}。请发送文字、PNG/JPEG/GIF/WebP 图片或常见文件。`,
				);
			}
		}
		if (generation !== this.generation || cancelEpoch !== (this.cancelEpochs.get(key) || 0)) return;
		if (!text && !attachments.length) {
			if (!(event.attachments || []).length)
				await this.reply(target, "此消息无可读取正文（可能为 Apple 富文本），请重发为纯文本。");
			return;
		}
		if ([...this.pendingRuns.values()].some((r) => r.key === key)) {
			await this.reply(target, "当前会话仍在运行，请等待完成或使用 /stop。");
			return;
		}
		const run = { key, target, text: "", conversationId: this.userConversations.get(key), runId: null };
		this.dispatches++;
		try {
			const opts = this.settings.get(key) || {};
			const receipt = await this.host.chat({
				text: text || "请查看附件",
				accountId: peerAccountId(`${key}:${this.sessionEpochs.get(key) || 0}`),
				...(run.conversationId ? { conversationId: run.conversationId } : {}),
				cwd: this.resolveWorkspace(key, cfg),
				...(cfg.model ? { model: cfg.model } : {}),
				...(cfg.thinkingLevel ? { thinkingLevel: cfg.thinkingLevel } : {}),
				...opts,
				...(attachments.length ? { attachments } : {}),
			});
			if (generation !== this.generation) return;
			if (cancelEpoch !== (this.cancelEpochs.get(key) || 0)) {
				if (receipt?.conversationId) await this.host.abortRun?.(receipt.runId || receipt.conversationId);
				return;
			}
			if (!receipt?.conversationId) throw new Error("Host returned no conversation ID");
			run.conversationId = receipt.conversationId;
			run.runId = receipt.runId;
			this.userConversations.set(key, receipt.conversationId);
			const token = receipt.runId || receipt.conversationId;
			this.pendingRuns.set(token, run);
			const early = this.earlyRuns.get(token) || [];
			this.earlyRuns.delete(token);
			for (const ev of early) await this.handleRunEvent(ev);
		} catch (error) {
			if (generation !== this.generation) return;
			await this.reply(target, `任务启动失败：${error.message}`);
		} finally {
			this.dispatches--;
			if (!this.dispatches) this.earlyRuns.clear();
		}
	}
	async command(text, { key, target, cfg }) {
		const [raw, ...parts] = text.split(/\s+/),
			cmd = raw.toLowerCase(),
			arg = parts.join(" ").trim();
		const opts = this.settings.get(key) || {};
		switch (cmd) {
			case "/help":
				await this.reply(
					target,
					"/help /new /clear /status /stop (/abort) /model [provider/id] /thinking [off|minimal|low|medium|high|xhigh] /cwd [目录]。图片支持 PNG/JPEG/GIF/WebP；语音、视频及文件不自动转录。",
				);
				return;
			case "/model":
				if (arg) {
					if (!/^[^\s/]+\/\S+$/.test(arg)) {
						await this.reply(target, "用法：/model provider/id");
						return;
					}
					opts.model = arg;
					this.settings.set(key, opts);
				}
				await this.reply(target, `模型：${opts.model || cfg.model || "跟随宿主"}（下次运行生效）`);
				return;
			case "/thinking":
				if (arg) {
					if (!THINKING.has(arg)) {
						await this.reply(target, "思考强度应为 off|minimal|low|medium|high|xhigh");
						return;
					}
					opts.thinkingLevel = arg;
					this.settings.set(key, opts);
				}
				await this.reply(target, `思考强度：${opts.thinkingLevel || cfg.thinkingLevel || "跟随宿主"}（下次运行生效）`);
				return;
			case "/stop":
			case "/abort": {
				this.cancelEpochs.set(key, (this.cancelEpochs.get(key) || 0) + 1);
				const run = [...this.pendingRuns.values()].find((r) => r.key === key);
				if (!run) {
					await this.reply(target, "已取消正在准备的请求；当前没有已启动的任务。");
					return;
				}
				const result = await this.host.abortRun?.(run.runId || run.conversationId);
				await this.reply(target, result?.ok ? "已请求停止。" : `停止失败：${result?.error || "宿主不支持中止"}`);
				return;
			}
			case "/cwd":
			case "/workspace":
				if (!arg) {
					await this.reply(target, `工作目录：${this.resolveWorkspace(key, cfg)}`);
					return;
				}
				try {
					if (!(await stat(arg)).isDirectory()) throw new Error("不是目录");
				} catch (error) {
					await this.reply(target, `目录无效：${error.message}`);
					return;
				}
				break;
			case "/new":
			case "/clear":
				break;
			case "/status":
				await this.reply(
					target,
					`状态：${this.status.state}\n会话：${this.userConversations.get(key) || "尚未创建"}\n运行中：${[...this.pendingRuns.values()].some((r) => r.key === key)}\n最近错误：${this.status.lastError || "无"}`,
				);
				return;
			default:
				await this.reply(target, "未知命令。发送 /help 查看支持的命令。");
				return;
		}
		if ([...this.pendingRuns.values()].some((r) => r.key === key)) {
			await this.reply(target, "请先 /stop 并等待任务结束后再切换会话或目录。");
			return;
		}
		if (arg && (cmd === "/cwd" || cmd === "/workspace")) this.userWorkspaces.set(key, resolve(arg));
		this.userConversations.delete(key);
		this.sessionEpochs.set(key, (this.sessionEpochs.get(key) || 0) + 1);
		await this.reply(target, "已开启新会话（不删除历史）；将在下条消息创建。");
	}
	async handleRunEvent(ev) {
		const token = ev.runId || ev.conversationId;
		if (!token) return;
		const run = this.pendingRuns.get(token);
		if (!run) {
			if (this.dispatches) {
				if (!this.earlyRuns.has(token) && this.earlyRuns.size >= 64) return;
				const list = this.earlyRuns.get(token) || [];
				if (list.length < 256) {
					list.push(ev);
					this.earlyRuns.set(token, list);
				}
			}
			return;
		}
		if (ev.conversationId) run.conversationId = ev.conversationId;
		if (ev.type === "message" && (ev.message?.role === "assistant" || ev.message?.author === "assistant")) {
			const content = ev.message.content;
			run.text +=
				(run.text ? "\n" : "") +
				(typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((c) => c.type === "text" || typeof c === "string")
								.map((c) => (typeof c === "string" ? c : c.text || ""))
								.join("\n")
						: "");
		}
		if (ev.type !== "run_end") return;
		this.pendingRuns.delete(token);
		this.userConversations.set(run.key, run.conversationId);
		const text =
			stripInternalMarkers(run.text) ||
			(ev.error
				? `任务失败：${ev.error}`
				: ev.stopReason === "aborted"
					? "任务已停止。"
					: "任务完成，无文本输出。附件不会自动发送，请使用 imessage 工具的 file 参数。");
		for (const chunk of chunkMarkdownText(text, 3000)) await this.reply(run.target, chunk);
		this.status.messagesReplied++;
	}
}
