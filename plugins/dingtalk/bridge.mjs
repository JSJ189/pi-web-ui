import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { chunkMarkdownText } from "./markdown-chunks.mjs";
import { dingJson, receiveMedia } from "./media.mjs";

const hash = (value) => `dt_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
const strip = (text) =>
	String(text || "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.trim();
const HELP =
	"钉钉机器人帮助\n/help 帮助\n/new 或 /clear 新会话\n/status 状态\n/stop 或 /abort 停止\n/model [provider/id|default] 模型\n/thinking [off|minimal|low|medium|high|xhigh|default] 思考强度\n/cwd [绝对路径|default] 工作目录\n支持图片、语音、文件、视频；语音/视频作为原文件，不保证自动转写或解码。";

export class DingtalkBotBridge {
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || (() => {});
		this.running = false;
		this.generation = 0;
		this.seenMessageIds = new Set();
		this.sessions = new Map();
		this.pendingRuns = new Map(); // stable runId only
		this.earlyRuns = new Map();
		this.dispatching = 0;
		this.status = {
			enabled: false,
			connected: false,
			state: "idle",
			messagesReceived: 0,
			messagesReplied: 0,
			lastError: null,
		};
	}
	getStatus() {
		return { ...this.status };
	}
	async start() {
		if (this.running) return;
		this.running = true;
		Object.assign(this.status, { enabled: true, connected: true, state: "connected" });
		this.offRunEvent = this.host.onRunEvent?.((event) => this.handleRunEvent(event));
	}
	async stop() {
		this.running = false;
		this.generation++;
		this.offRunEvent?.();
		this.offRunEvent = null;
		this.pendingRuns.clear();
		this.earlyRuns.clear();
		this.sessions.clear();
		Object.assign(this.status, { enabled: false, connected: false, state: "idle" });
	}
	error(error) {
		this.status.lastError = String(error?.message || error);
		this.log("warn", this.status.lastError);
	}
	async reply(url, text, markdown = false) {
		if (!url) throw new Error("缺少 sessionWebhook，无法回复原会话");
		try {
			return await dingJson(url, {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8" },
				body: JSON.stringify(
					markdown
						? { msgtype: "markdown", markdown: { title: "AI 回复", text } }
						: { msgtype: "text", text: { content: text } },
				),
			});
		} catch (error) {
			this.error(error);
			throw error;
		}
	}
	scope(event) {
		return JSON.stringify([
			event.chatbotCorpId || event.corpId || "",
			event.conversationId || event.openConversationId || "direct",
			event.threadId || event.rootMessageId || event.thread?.id || "",
			event.senderStaffId || event.senderId || "",
		]);
	}
	async onInboundMessage(event) {
		if (!event) return;
		const sender = event.senderStaffId || event.senderId || "";
		const scope = this.scope(event);
		const cfg = this.getConfig() || {};
		const url = event.sessionWebhook || "";
		const id = event.msgId || event.messageId;
		if (id) {
			const key = `${scope}:${id}`;
			if (this.seenMessageIds.has(key)) return;
			this.seenMessageIds.add(key);
			if (this.seenMessageIds.size > 500) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
		}
		try {
			const allowed = (cfg.allowedSenders || []).map(String).filter(Boolean);
			if (!sender || (allowed.length && !allowed.includes(sender))) {
				await this.reply(url, "【访问受限】您当前不在该机器人的白名单中，或消息缺少发送者标识。");
				return;
			}
			if (!url) throw new Error("缺少 sessionWebhook，已拒绝投递以防结果无法回送");
			this.status.messagesReceived++;
			this.status.lastMessageAt = Date.now();
			let session = this.sessions.get(scope);
			if (!session) {
				session = { accountId: hash(`${scope}:${randomUUID()}`), revision: 0 };
				this.sessions.set(scope, session);
			}
			const text = String(event.text?.content || (typeof event.text === "string" ? event.text : "") || "").trim();
			if (text.startsWith("/")) {
				await this.command(text, { session, cfg, url });
				return;
			}
			if (session.dispatching || session.runId) {
				await this.reply(url, "当前会话仍在运行，请等待完成或先发送 /stop。");
				return;
			}
			session.dispatching = true;
			session.stopRequested = false;
			const revision = session.revision;
			const generation = this.generation;
			try {
				const media = await receiveMedia(event, cfg);
				if (generation !== this.generation || revision !== session.revision || session.stopRequested) return;
				const input =
					[text, media.text, media.notice].filter(Boolean).join("\n") ||
					(media.attachments.length ? "请处理附件。无法读取或解码时请明确告知。" : "");
				if (!input) return;
				if (media.notice) await this.reply(url, media.notice);
				const req = { text: input, accountId: session.accountId };
				if (session.conversationId) req.conversationId = session.conversationId;
				const cwd = session.cwd || cfg.workspace || this.host.cwd;
				if (cwd) req.cwd = cwd;
				const model = session.model === null ? undefined : session.model || cfg.model;
				const thinking = session.thinkingLevel === null ? undefined : session.thinkingLevel || cfg.thinkingLevel;
				if (model) req.model = model;
				if (thinking) req.thinkingLevel = thinking;
				if (media.attachments.length) req.attachments = media.attachments;
				if (session.stopRequested) return;
				this.dispatching++;
				try {
					const receipt = await this.host.chat(req);
					if (generation !== this.generation || revision !== session.revision) return;
					if (!receipt?.conversationId || !receipt?.runId)
						throw new Error("宿主未返回真实 conversationId/runId，请升级宿主；无法安全关联回复");
					session.conversationId = receipt.conversationId;
					if (session.stopRequested) {
						const stopped = await this.host.abortRun?.(receipt.runId || receipt.conversationId);
						if (!stopped?.ok) {
							session.runId = receipt.runId;
							throw new Error(stopped?.error || "延迟中止失败，请重新 /stop");
						}
						await this.reply(url, "投递已返回，当前任务已停止。");
						return;
					}
					session.runId = receipt.runId;
					const run = { session, url, text: "", bytes: 0, revision, generation };
					this.pendingRuns.set(receipt.runId, run);
					const early = this.earlyRuns.get(receipt.runId) || [];
					this.earlyRuns.delete(receipt.runId);
					for (const ev of early) await this.handleRunEvent(ev);
				} finally {
					this.dispatching--;
					if (!this.dispatching) this.earlyRuns.clear();
				}
			} finally {
				session.dispatching = false;
			}
		} catch (error) {
			this.error(error);
			if (url) await this.reply(url, `处理失败：${error.message || error}`).catch(() => {});
		}
	}
	async command(text, { session, cfg, url }) {
		const [raw, ...rest] = text.split(/\s+/);
		const cmd = raw.toLowerCase();
		const arg = rest.join(" ").trim();
		let response;
		switch (cmd) {
			case "/help":
				response = HELP;
				break;
			case "/status":
				response = `会话：${session.conversationId || "尚未创建"}\n运行：${session.runId || (session.dispatching ? "投递中" : "空闲")}\n模型：${session.model || cfg.model || "跟随全局"}\n思考：${session.thinkingLevel || cfg.thinkingLevel || "跟随全局"}\n目录：${session.cwd || cfg.workspace || this.host.cwd || "默认"}\n最近错误：${this.status.lastError || "无"}`;
				break;
			case "/abort":
			case "/stop": {
				if (session.dispatching) {
					session.stopRequested = true;
					response = "已收到停止请求；媒体准备完成后不再投递，若已调用宿主则回执到达后立即中止。";
					break;
				}
				if (!session.runId) {
					response = "当前没有运行中的任务。";
					break;
				}
				if (!this.host.abortRun) throw new Error("宿主不支持 abortRun，请升级宿主");
				const result = await this.host.abortRun(session.runId || session.conversationId);
				if (!result?.ok) throw new Error(result?.error || "中止失败");
				this.pendingRuns.delete(session.runId);
				session.runId = undefined;
				response = "已停止当前任务。";
				break;
			}
			case "/new":
			case "/clear":
				if (session.dispatching || session.runId) throw new Error("请先 /stop 再创建新会话");
				session.conversationId = undefined;
				session.accountId = hash(randomUUID());
				session.revision++;
				response = "✨ 已开启全新会话，上下文已重置。";
				break;
			case "/model":
				if (!arg) {
					response = `当前模型：${session.model === null ? "跟随全局" : session.model || cfg.model || "跟随全局"}\n用法：/model provider/id 或 /model default`;
					break;
				}
				if (session.dispatching || session.runId) throw new Error("请先 /stop 再修改模型");
				if (arg !== "default" && !/^[^\s/]+\/\S+$/.test(arg)) throw new Error("模型格式应为 provider/id，或 default");
				session.model = arg === "default" ? null : arg;
				session.conversationId = undefined;
				session.accountId = hash(randomUUID());
				response = `模型偏好已设置：${arg}；下次投递由宿主验证，若不可用会明确报错。`;
				break;
			case "/thinking":
				if (!arg) {
					response = `当前思考强度：${session.thinkingLevel === null ? "跟随全局" : session.thinkingLevel || cfg.thinkingLevel || "跟随全局"}`;
					break;
				}
				if (session.dispatching || session.runId) throw new Error("请先 /stop 再修改思考强度");
				if (!["off", "minimal", "low", "medium", "high", "xhigh", "default"].includes(arg))
					throw new Error("思考强度支持 off/minimal/low/medium/high/xhigh/default");
				session.thinkingLevel = arg === "default" ? null : arg;
				session.conversationId = undefined;
				session.accountId = hash(randomUUID());
				response = `思考强度偏好已设置：${arg}；下次投递由宿主验证。`;
				break;
			case "/workspace":
			case "/cwd": {
				if (!arg) {
					response = `当前项目根目录：${session.cwd || cfg.workspace || this.host.cwd || "默认"}`;
					break;
				}
				if (session.dispatching || session.runId) throw new Error("请先 /stop 再切换目录");
				const path = arg === "default" ? cfg.workspace || this.host.cwd : arg;
				if (!path || !isAbsolute(path) || !(await stat(path)).isDirectory())
					throw new Error("目录必须是存在的绝对路径");
				session.cwd = path;
				session.conversationId = undefined;
				session.accountId = hash(randomUUID());
				session.revision++;
				response = `已设置目录：${path}；已开启新会话，下次投递由宿主校验目录权限。`;
				break;
			}
			default:
				response = `未知命令：${raw}，发送 /help 查看支持的命令。`;
		}
		await this.reply(url, response);
	}
	async handleRunEvent(ev) {
		const rid = String(ev?.runId || "");
		if (!rid || !["message", "run_end"].includes(ev.type)) return;
		const run = this.pendingRuns.get(rid);
		if (!run) {
			if (this.dispatching && this.earlyRuns.size < 64) {
				const events = this.earlyRuns.get(rid) || [];
				if (events.length < 64 && JSON.stringify(ev).length <= 64_000) events.push(ev);
				this.earlyRuns.set(rid, events);
			}
			return;
		}
		if (run.generation !== this.generation || run.revision !== run.session.revision) return;
		if (ev.conversationId) run.session.conversationId = ev.conversationId;
		if (ev.type === "message") {
			if (ev.message?.role !== "assistant" && ev.message?.author !== "assistant") return;
			const content = ev.message.content;
			const value =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content.map((part) => (typeof part === "string" ? part : part.text || "")).join("\n")
						: "";
			run.text = (run.text + "\n" + value).slice(0, 100_000);
			return;
		}
		this.pendingRuns.delete(rid);
		if (run.session.runId === rid) run.session.runId = undefined;
		const failure = ev.isError || ["error", "aborted"].includes(ev.stopReason);
		const final =
			[strip(run.text), failure ? `任务${ev.stopReason === "aborted" ? "已停止" : "执行失败"}。` : ""]
				.filter(Boolean)
				.join("\n") || "任务已完成（无文本输出）。";
		try {
			for (const chunk of chunkMarkdownText(final, 3500)) await this.reply(run.url, chunk, true);
			this.status.messagesReplied++;
			this.status.lastReplyAt = Date.now();
		} catch (error) {
			this.error(error);
		}
	}
}
