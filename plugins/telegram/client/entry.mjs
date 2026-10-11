/**
 * plugins/telegram/client/entry.mjs
 * Telegram workspace and bot control panel for pi-web-ui.
 */

export default {
	async mount(el, ctx) {
		const sendHost = async (type, payload = {}) => {
			return await ctx.send({ type, ...payload });
		};

		el.innerHTML = `
			<div class="telegram-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">✈️</span>
						<span style="font-weight: 600; font-size: 14px;">Telegram 机器人工作台</span>
						<span class="telegram-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">检测中...</span>
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="telegram-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">⚙️ 配置凭证</button>
					</div>
				</div>

				<!-- Main Container -->
				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- Bot Status Overview Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
							<div style="font-weight: 600; font-size: 14px;">🤖 Telegram Bot 双工长轮询状态</div>
							<div class="telegram-bot-toggle-wrap">
								<button class="telegram-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">切换机器人服务</button>
							</div>
						</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">双工状态</div>
								<div class="telegram-metric-state" style="font-size: 14px; font-weight: 600;">⚪ 未启动</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">机器人账号</div>
								<div class="telegram-metric-username" style="font-size: 14px; font-weight: 600;">--</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已接收消息</div>
								<div class="telegram-metric-recv" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已回复消息</div>
								<div class="telegram-metric-sent" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
						</div>
						<div style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							采用官方 <code>getUpdates</code> 出站长轮询，零公网 IP、免反代、免开放入站端口。支持在 Telegram 私聊或群聊（@机器人）双向对话，自动分配独立 AI 上下文。支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠指令。
						</div>
					</div>

					<!-- Send Message Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">📤 快捷向 Telegram 发送消息</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">目标 Chat ID / 频道用户名:</label>
								<input type="text" class="telegram-send-chatid" placeholder="如：123456789 或 @mychannel (留空使用默认)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">消息文本 (支持 Markdown):</label>
								<textarea class="telegram-send-text" rows="3" placeholder="输入要发送的消息内容..." style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="telegram-btn-send" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: #fff; cursor: pointer; font-weight: 500;">🚀 发送消息</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="telegram-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">✈️ Telegram 机器人凭证配置</span>
							<button class="telegram-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Bot Token (来自 @BotFather, 加密存储):</label>
								<input type="password" class="telegram-cfg-token" placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								<div style="margin-top: 4px; font-size: 11px; color: var(--text-dim);">在 Telegram 中向 @BotFather 发送 /newbot 即可快速申请 Bot Token</div>
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Telegram API 端点 (可选反代):</label>
								<input type="text" class="telegram-cfg-apibase" placeholder="https://api.telegram.org (默认官方接口)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">默认发送 Chat ID (可选):</label>
								<input type="text" class="telegram-cfg-default-chat" placeholder="如：123456789" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">🤖 机器人双工与白名单控制</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="telegram-cfg-bot-enabled" class="telegram-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="telegram-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">启用 Telegram 机器人双向对话服务 (长轮询接收消息并由 AI 回复)</label>
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">允许的用户白名单 (User ID，逗号分隔，留空不限制):</label>
									<input type="text" class="telegram-cfg-allowed-users" placeholder="12345678, 87654321 (留空允许所有用户)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="telegram-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔌 测试连接</button>
							<div style="display: flex; gap: 8px;">
								<button class="telegram-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">取消</button>
								<button class="telegram-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: #fff; cursor: pointer; font-weight: 500;">💾 保存配置</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const q = (sel) => el.querySelector(sel);
		const statusBadge = q(".telegram-status-badge");
		const metricState = q(".telegram-metric-state");
		const metricUsername = q(".telegram-metric-username");
		const metricRecv = q(".telegram-metric-recv");
		const metricSent = q(".telegram-metric-sent");
		const modal = q(".telegram-modal-settings");

		const cfgToken = q(".telegram-cfg-token");
		const cfgApiBase = q(".telegram-cfg-apibase");
		const cfgDefaultChat = q(".telegram-cfg-default-chat");
		const cfgBotEnabled = q(".telegram-cfg-bot-enabled");
		const cfgAllowedUsers = q(".telegram-cfg-allowed-users");

		let currentState = {};

		async function refresh() {
			const res = await sendHost("get_state");
			if (!res) return;
			currentState = res;

			const b = res.botStatus || {};
			if (b.state === "connected") {
				statusBadge.textContent = "🟢 在线";
				statusBadge.style.color = "var(--green, #22c55e)";
				metricState.textContent = "🟢 已连接 (在线)";
				metricState.style.color = "var(--green, #22c55e)";
			} else if (b.state === "connecting") {
				statusBadge.textContent = "🟡 连接中";
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = "🟡 正在连接...";
				metricState.style.color = "var(--amber, #eab308)";
			} else if (b.state === "error") {
				statusBadge.textContent = "🔴 错误";
				statusBadge.style.color = "var(--red, #ef4444)";
				metricState.textContent = "🔴 连接出错";
				metricState.style.color = "var(--red, #ef4444)";
			} else {
				statusBadge.textContent = "⚪ 未启动";
				statusBadge.style.color = "var(--text-dim)";
				metricState.textContent = "⚪ 未启动";
				metricState.style.color = "var(--text-dim)";
			}

			metricUsername.textContent = b.botUsername ? `@${b.botUsername}` : "--";
			metricRecv.textContent = `${b.messagesReceived || 0} 条`;
			metricSent.textContent = `${b.messagesReplied || 0} 条`;
		}

		q(".telegram-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgToken.value = "";
			cfgToken.placeholder = cfg.hasBotToken ? "●●●●●● (已加密保存，留空保持)" : "填入 Bot Token";
			cfgApiBase.value = cfg.apiBase || "https://api.telegram.org";
			cfgDefaultChat.value = cfg.defaultChatId || "";
			cfgBotEnabled.checked = Boolean(cfg.botEnabled);
			cfgAllowedUsers.value = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.join(", ") : "";

			modal.style.display = "flex";
		});

		q(".telegram-modal-close").addEventListener("click", () => (modal.style.display = "none"));
		q(".telegram-modal-cancel").addEventListener("click", () => (modal.style.display = "none"));

		q(".telegram-btn-test-cfg").addEventListener("click", async () => {
			const btn = q(".telegram-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = "测试中...";
			const testCfg = {
				botToken: cfgToken.value.trim(),
				apiBase: cfgApiBase.value.trim() || "https://api.telegram.org",
			};
			const res = await sendHost("test_config", { config: testCfg });
			btn.disabled = false;
			btn.textContent = "🔌 测试连接";
			alert?.(res?.message || (res?.success ? "连接测试通过！" : "测试失败"));
		});

		q(".telegram-btn-save-cfg").addEventListener("click", async () => {
			const btn = q(".telegram-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = "保存中...";

			const newCfg = {
				botToken: cfgToken.value.trim(),
				apiBase: cfgApiBase.value.trim() || "https://api.telegram.org",
				defaultChatId: cfgDefaultChat.value.trim(),
				botEnabled: Boolean(cfgBotEnabled.checked),
				allowedUsers: cfgAllowedUsers.value
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
			};

			const res = await sendHost("save_config", { config: newCfg });
			btn.disabled = false;
			btn.textContent = "💾 保存配置";

			if (res?.success) {
				modal.style.display = "none";
				refresh();
			} else {
				alert?.(`保存失败: ${res?.message || "未知错误"}`);
			}
		});

		q(".telegram-btn-toggle-bot").addEventListener("click", async () => {
			const isRunning = currentState.botStatus?.state === "connected";
			const action = isRunning ? "stop_bot" : "start_bot";
			await sendHost(action);
			refresh();
		});

		q(".telegram-btn-send").addEventListener("click", async () => {
			const chatInput = q(".telegram-send-chatid");
			const textInput = q(".telegram-send-text");
			const text = textInput.value.trim();
			if (!text) {
				alert?.("请输入要发送的消息文本");
				return;
			}

			const btn = q(".telegram-btn-send");
			btn.disabled = true;
			btn.textContent = "发送中...";
			try {
				const res = await sendHost("send_message", {
					chatId: chatInput.value.trim(),
					text,
				});
				if (res?.success) {
					alert?.("✅ Telegram 消息发送成功！");
					textInput.value = "";
				} else {
					alert?.(`发送失败: ${res?.message || "未知错误"}`);
				}
			} finally {
				btn.disabled = false;
				btn.textContent = "🚀 发送消息";
			}
		});

		await refresh();
	},
};
