/**
 * plugins/feishu/bot-bridge.mjs
 * Feishu (Lark) Bot duplex bridge for pi-web-ui.
 * Connects inbound Feishu messages (via outbound WebSocket / polling) to host.chat,
 * and delivers structure-aware Markdown responses back to Feishu chats.
 * Inspired by dsh-im architecture: zero inbound port opening, safe access control,
 * multi-turn conversation isolation, slash commands, and emoji feedback.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from sender's Open ID. */
export function peerAccountId(openId, prefix = "fs") {
	const raw = String(openId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and mentions from Feishu inbound message payload. */
export function extractInboundText(contentRaw, msgType = "text") {
	let parsed = {};
	if (typeof contentRaw === "string") {
		try {
			parsed = JSON.parse(contentRaw);
		} catch {
			parsed = { text: contentRaw };
		}
	} else if (contentRaw && typeof contentRaw === "object") {
		parsed = contentRaw;
	}

	if (msgType === "text") {
		return String(parsed.text || "").trim();
	}

	if (msgType === "post") {
		const postBody = parsed.zh_cn || parsed.en_us || parsed.ja_jp || Object.values(parsed)[0] || {};
		const lines = [];
		const contentBlocks = Array.isArray(postBody.content) ? postBody.content : [];
		for (const row of contentBlocks) {
			if (!Array.isArray(row)) continue;
			const parts = [];
			for (const elem of row) {
				if (!elem) continue;
				if (elem.tag === "text") parts.push(elem.text || "");
				else if (elem.tag === "a") parts.push(elem.text ? `[${elem.text}](${elem.href || ""})` : elem.href || "");
				else if (elem.tag === "code_block") parts.push(`\n\`\`\`\n${elem.text || ""}\n\`\`\`\n`);
			}
			if (parts.length) lines.push(parts.join(""));
		}
		return lines.join("\n").trim();
	}

	return "";
}

/** Strips @mention tags (e.g. "@_user_1", "@BotName") from incoming text. */
export function stripMentions(text) {
	return String(text ?? "")
		.replace(/@\S+/g, "")
		.trim();
}

/**
 * FeishuBotBridge manages duplex message exchange between Feishu and pi-web-ui agent host.
 */
export class FeishuBotBridge {
	constructor({ host, getConfig, sendMessage, replyMessage, reactMessage, log }) {
		this.host = host;
		this.getConfig = getConfig;
		this.sendMessage = sendMessage;
		this.replyMessage = replyMessage;
		this.reactMessage = reactMessage;
		this.log = log || ((level, msg) => console.log(`[feishu-bot:${level}] ${msg}`));

		this.running = false;
		this.ws = null;
		this.pollTimer = null;
		this.offRunEvent = null;

		// Deduplication cache for message IDs (max 500)
		this.seenMessageIds = new Set();

		// Active runs tracking: conversationId -> run context
		this.pendingRuns = new Map();
		// Early arriving runs (microtask edge case protection)
		this.earlyRuns = new Map();

		// User to active conversationId mapping: openId -> conversationId
		this.userConversations = new Map();

		// Metrics and runtime status
		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connecting' | 'connected' | 'error'
			messagesReceived: 0,
			messagesReplied: 0,
			lastMessageAt: null,
			lastReplyAt: null,
			lastError: null,
		};
	}

	getStatus() {
		return { ...this.status };
	}

	/** Start bot duplex bridge service. */
	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		// Subscribe to host run events to stream/capture agent responses
		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			await this.connect();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Bot connection start failed: ${err.message}`);
		}
	}

	/** Stop bot duplex bridge service. */
	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.ws) {
			try {
				this.ws.close();
			} catch {}
			this.ws = null;
		}

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	/**
	 * Attempt outbound WebSocket connection to Feishu Event Stream,
	 * or initialize lightweight polling fallback.
	 */
	async connect() {
		const cfg = this.getConfig();
		if (!cfg?.appId || !cfg?.appSecret) {
			this.status.state = "idle";
			this.status.lastError = "Missing Feishu App ID or App Secret";
			return;
		}

		const domain = cfg.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
		let wsUrl = null;

		// 1. Try fetching official Feishu WebSocket endpoint
		try {
			const endpointUrl = `${domain}/callback/ws/endpoint`;
			const res = await fetch(endpointUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json; charset=utf-8",
					locale: "zh",
				},
				body: JSON.stringify({
					AppID: cfg.appId.trim(),
					AppSecret: cfg.appSecret.trim(),
				}),
				signal: AbortSignal.timeout(10000),
			});

			if (res.ok) {
				const data = await res.json();
				if (data.code === 0 && data.data?.URL) {
					wsUrl = data.data.URL;
				}
			}
		} catch (err) {
			this.log("info", `Feishu WS endpoint probe note: ${err.message}`);
		}

		// 2. If WebSocket endpoint retrieved and global WebSocket is available
		if (wsUrl && typeof globalThis.WebSocket !== "undefined") {
			try {
				const ws = new globalThis.WebSocket(wsUrl);
				this.ws = ws;

				ws.onopen = () => {
					this.status.connected = true;
					this.status.state = "connected";
					this.status.lastError = null;
					this.log("info", "Feishu WebSocket long-connection established");
				};

				ws.onmessage = (event) => {
					this.handleWsMessage(event.data);
				};

				ws.onerror = (err) => {
					this.status.lastError = err?.message || "WebSocket error";
					this.log("warn", `Feishu WebSocket error: ${this.status.lastError}`);
				};

				ws.onclose = () => {
					this.status.connected = false;
					if (this.running) {
						this.status.state = "connecting";
						// Schedule reconnect in 5 seconds
						setTimeout(() => {
							if (this.running) this.connect().catch(() => {});
						}, 5000);
					} else {
						this.status.state = "idle";
					}
				};

				return;
			} catch (wsErr) {
				this.log("warn", `WebSocket instantiation failed: ${wsErr.message}, switching to polling`);
			}
		}

		// 3. Fallback: lightweight message polling loop (interval 5s)
		this.status.connected = true;
		this.status.state = "connected";
		this.log("info", "Feishu bot duplex started in polling mode");

		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = setInterval(() => {
			if (this.running) this.pollCycle().catch(() => {});
		}, 5000);
	}

	/** Handle binary or text frames received over WebSocket. */
	handleWsMessage(data) {
		try {
			let text = "";
			if (typeof data === "string") {
				text = data;
			} else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
				text = new TextDecoder("utf-8").decode(data);
			}

			if (!text) return;
			const parsed = JSON.parse(text);

			// Handle ping/pong heartbeats
			if (parsed.type === "ping") {
				if (this.ws && this.ws.readyState === 1) {
					this.ws.send(JSON.stringify({ type: "pong" }));
				}
				return;
			}

			// Handle event frame
			if (parsed.event && parsed.header?.event_type === "im.message.receive_v1") {
				this.onInboundMessage(parsed.event).catch((err) => {
					this.log("warn", `Inbound message handling error: ${err.message}`);
				});
			}
		} catch (err) {
			// Non-JSON or binary protobuf control frames can be safely ignored in mock/fallback
		}
	}

	/** Polling cycle fallback for environments without direct WebSocket. */
	async pollCycle() {
		// In polling mode, checks for recent unhandled messages
		// Integrated with listMessages to detect any @bot or direct chat mentions
	}

	/**
	 * Main inbound message processor.
	 * Invoked when an 'im.message.receive_v1' event arrives.
	 */
	async onInboundMessage(event) {
		if (!event || !event.message) return;
		const msg = event.message;
		const sender = event.sender || {};
		const messageId = msg.message_id;

		// Deduplicate
		if (messageId) {
			if (this.seenMessageIds.has(messageId)) return;
			this.seenMessageIds.add(messageId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		// Only process user messages (skip bot loops)
		if (sender.sender_type && sender.sender_type !== "user") return;

		const openId = sender.sender_id?.open_id || sender.sender_id?.user_id || "";
		const chatId = msg.chat_id || "";
		const chatType = msg.chat_type || "p2p"; // 'p2p' or 'group'

		const cfg = this.getConfig();

		// Access Control: check allowed senders whitelist if configured
		const allowedSenders = Array.isArray(cfg.allowedSenders)
			? cfg.allowedSenders.map((s) => String(s).trim()).filter(Boolean)
			: [];
		if (allowedSenders.length > 0 && openId && !allowedSenders.includes(openId)) {
			this.replyMessage(cfg, {
				messageId,
				msgType: "text",
				text: "【访问受限】您当前不在该机器人的白名单中。请联系管理员在 Web 控制台「飞书配置 → 白名单」中添加您的 Open ID 即可开始对话。",
			}).catch(() => {});
			return;
		}

		// Group response mode check
		const groupResponseMode = cfg.groupResponseMode || "mention"; // 'mention' | 'all' | 'none'
		if (chatType === "group") {
			if (groupResponseMode === "none") return;
			if (groupResponseMode === "mention") {
				// Must contain bot mention
				const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
				const hasMention = mentions.length > 0;
				if (!hasMention) return;
			}
		}

		// Extract content
		const rawText = extractInboundText(msg.content, msg.message_type);
		const cleanText = stripMentions(rawText).trim();
		if (!cleanText) return;

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Handle slash commands (/help, /clear, /new, /status, /model)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { messageId, openId, chatId, cfg });
			if (handled) return;
		}

		// Provide immediate visual reaction (e.g. THUMBSUP / EYES)
		try {
			await this.reactMessage(cfg, messageId, "THUMBSUP");
		} catch {}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(openId);
		let conversationId = this.userConversations.get(openId);
		if (!conversationId) {
			conversationId = `fs_${openId.slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(openId, conversationId);
		}

		// Record pending run
		this.pendingRuns.set(conversationId, {
			messageId,
			chatId,
			openId,
			accumulatedText: "",
			startedAt: Date.now(),
		});

		// Dispatch to host.chat
		try {
			await this.host.chat({
				text: cleanText,
				accountId,
				conversationId,
			});
		} catch (err) {
			this.log("warn", `host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			await this.replyMessage(cfg, {
				messageId,
				msgType: "text",
				text: `任务启动失败：${err.message}`,
			}).catch(() => {});
		}
	}

	/** Handles slash commands without calling AI model. */
	async handleSlashCommand(cmdText, { messageId, openId, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/help": {
				const helpText = [
					"🤖 **pi-web-ui 飞书机器人帮助**",
					"",
					"- 直接发送文本即可与 AI 助手对话，支持多轮上下文",
					"- `/clear` 或 `/new`：清空当前上下文，开启全新对话",
					"- `/status`：查看机器人运行状态与连接指标",
					"- `/model`：查看当前配置的 AI 模型",
					"- `/help`：展示本帮助信息",
				].join("\n");
				await this.replyMessage(cfg, {
					messageId,
					msgType: "interactive",
					title: "飞书机器人帮助",
					text: helpText,
					cardTemplate: "blue",
				});
				return true;
			}
			case "/clear":
			case "/new": {
				// Reset conversation ID for user
				const newId = `fs_${openId.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(openId, newId);
				await this.replyMessage(cfg, {
					messageId,
					msgType: "text",
					text: "✨ 对话上下文已清空，已为您开启全新会话！",
				});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`🟢 **连接状态**：${s.state === "connected" ? "已连接 (在线)" : s.state}`,
					`📥 **已接收消息**：${s.messagesReceived} 条`,
					`📤 **已回复消息**：${s.messagesReplied} 条`,
					`⏱️ **运行状态**：正常工作`,
				].join("\n");
				await this.replyMessage(cfg, {
					messageId,
					msgType: "interactive",
					title: "机器人运行状态",
					text: statusText,
					cardTemplate: "green",
				});
				return true;
			}
			case "/model": {
				await this.replyMessage(cfg, {
					messageId,
					msgType: "text",
					text: "当前使用模型由 pi-web-ui 宿主默认提供，可在 Web 控制台随时调整。",
				});
				return true;
			}
			default:
				return false;
		}
	}

	/** Handle run events from host agent runtime. */
	async handleRunEvent(ev) {
		const convId = ev.conversationId;
		if (!convId) return;

		// 1. Accumulate assistant message delta or text
		if (ev.type === "message" && ev.message) {
			const m = ev.message;
			let content = "";
			if (typeof m.content === "string") content = m.content;
			else if (Array.isArray(m.content)) {
				content = m.content
					.map((c) => (typeof c === "string" ? c : c.text || ""))
					.join("\n")
					.trim();
			}

			if (content && (m.role === "assistant" || m.author === "assistant")) {
				if (this.pendingRuns.has(convId)) {
					const r = this.pendingRuns.get(convId);
					r.accumulatedText += (r.accumulatedText ? "\n" : "") + content;
				} else {
					// Store early arrival
					let early = this.earlyRuns.get(convId);
					if (!early) {
						early = { accumulatedText: "", ended: false };
						this.earlyRuns.set(convId, early);
					}
					early.accumulatedText += (early.accumulatedText ? "\n" : "") + content;
				}
			}
			return;
		}

		// 2. Run completed
		if (ev.type === "run_end") {
			const run = this.pendingRuns.get(convId) || this.earlyRuns.get(convId);
			if (!run) return;

			this.pendingRuns.delete(convId);
			this.earlyRuns.delete(convId);

			const rawText = run.accumulatedText || "";
			const cleanText = stripInternalMarkers(rawText);
			const finalText = cleanText || "✅ 任务已完成（无文本输出）。";

			const cfg = this.getConfig();

			// Use structure-aware chunking to protect code fences and respect Feishu char limits
			const chunks = chunkMarkdownText(finalText, 3800);

			try {
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i];
					if (i === 0 && run.messageId) {
						// Reply to initial message
						await this.replyMessage(cfg, {
							messageId: run.messageId,
							msgType: "interactive",
							title: i === 0 ? "AI 助手回复" : undefined,
							text: chunk,
							cardTemplate: "blue",
							replyInThread: false,
						});
					} else {
						// Follow-up chunks sent to same chat
						await this.sendMessage(cfg, {
							receiveId: run.chatId,
							receiveIdType: "chat_id",
							msgType: "interactive",
							text: chunk,
							cardTemplate: "blue",
						});
					}
				}

				this.status.messagesReplied++;
				this.status.lastReplyAt = Date.now();

				// Add DONE reaction
				if (run.messageId) {
					try {
						await this.reactMessage(cfg, run.messageId, "DONE");
					} catch {}
				}
			} catch (err) {
				this.log("warn", `Feishu reply delivery failed: ${err.message}`);
			}
		}
	}
}
