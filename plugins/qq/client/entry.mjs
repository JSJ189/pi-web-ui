/**
 * plugins/qq/client/entry.mjs
 * QQ Bot workspace and bot control panel for pi-web-ui.
 */

export default {
	async mount(el, ctx) {
		const sendHost = async (type, payload = {}) => {
			return await ctx.send({ type, ...payload });
		};

		el.innerHTML = `
			<div class="qq-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">🐧</span>
						<span style="font-weight: 600; font-size: 14px;">QQ 机器人 (QQBot) 工作台</span>
						<span class="qq-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">检测中...</span>
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="qq-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">⚙️ 配置凭证</button>
					</div>
				</div>

				<!-- Main Container -->
				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- Bot Status Overview Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
							<div style="font-weight: 600; font-size: 14px;">🤖 QQBot 官方 WebSocket 双工长连接</div>
							<div class="qq-bot-toggle-wrap">
								<button class="qq-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">切换机器人服务</button>
							</div>
						</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">双工状态</div>
								<div class="qq-metric-state" style="font-size: 14px; font-weight: 600;">⚪ 未启动</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">机器人账号</div>
								<div class="qq-metric-username" style="font-size: 14px; font-weight: 600;">--</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已接收消息</div>
								<div class="qq-metric-recv" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已回复消息</div>
								<div class="qq-metric-sent" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
						</div>
						<div style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							基于腾讯官方开放平台 QQBot WebSocket 长连接，零公网 IP、免域名备案、免反向代理。支持在 QQ 频道、QQ 群（@机器人）或单聊双向对话，自动分配独立会话上下文。支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠指令。
						</div>
					</div>

					<!-- Send Message Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">📤 快捷向 QQ 频道子频道发送消息</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">目标子频道 Channel ID:</label>
								<input type="text" class="qq-send-channelid" placeholder="如：12345678 (留空使用默认频道)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">消息文本内容:</label>
								<textarea class="qq-send-text" rows="3" placeholder="输入要发送的消息内容..." style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="qq-btn-send" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: #fff; cursor: pointer; font-weight: 500;">🚀 发送消息</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="qq-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">🐧 QQ 机器人凭证配置</span>
							<button class="qq-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">AppID (来自 QQ 开放平台):</label>
								<input type="text" class="qq-cfg-appid" placeholder="如：102030405" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">ClientSecret (机器人密钥, 加密存储):</label>
								<input type="password" class="qq-cfg-clientsecret" placeholder="留空保持不变" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="display: flex; align-items: center; gap: 8px;">
								<input type="checkbox" id="qq-cfg-sandbox" class="qq-cfg-sandbox" style="cursor: pointer;" />
								<label for="qq-cfg-sandbox" style="font-size: 12px; cursor: pointer; user-select: none;">使用沙箱测试环境 (sandbox.api.sgroup.qq.com)</label>
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">默认发送子频道 Channel ID (可选):</label>
								<input type="text" class="qq-cfg-default-channel" placeholder="如：12345678" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">🤖 机器人双工与白名单控制</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="qq-cfg-bot-enabled" class="qq-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="qq-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">启用 QQ 机器人双向会话对话服务 (WebSocket 出站长连接)</label>
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">允许的用户白名单 (用户 ID / OpenID，逗号分隔，留空不限制):</label>
									<input type="text" class="qq-cfg-allowed-users" placeholder="123456, 789012 (留空允许所有用户)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="qq-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔌 测试连接</button>
							<div style="display: flex; gap: 8px;">
								<button class="qq-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">取消</button>
								<button class="qq-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: #fff; cursor: pointer; font-weight: 500;">💾 保存配置</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const q = (sel) => el.querySelector(sel);
		const statusBadge = q(".qq-status-badge");
		const metricState = q(".qq-metric-state");
		const metricUsername = q(".qq-metric-username");
		const metricRecv = q(".qq-metric-recv");
		const metricSent = q(".qq-metric-sent");
		const modal = q(".qq-modal-settings");

		const cfgAppId = q(".qq-cfg-appid");
		const cfgClientSecret = q(".qq-cfg-clientsecret");
		const cfgSandbox = q(".qq-cfg-sandbox");
		const cfgDefaultChannel = q(".qq-cfg-default-channel");
		const cfgBotEnabled = q(".qq-cfg-bot-enabled");
		const cfgAllowedUsers = q(".qq-cfg-allowed-users");

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

			metricUsername.textContent = b.botUsername ? `${b.botUsername}` : "--";
			metricRecv.textContent = `${b.messagesReceived || 0} 条`;
			metricSent.textContent = `${b.messagesReplied || 0} 条`;
		}

		q(".qq-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgAppId.value = cfg.appId || "";
			cfgClientSecret.value = "";
			cfgClientSecret.placeholder = cfg.hasClientSecret ? "●●●●●● (已加密保存，留空保持)" : "填入 ClientSecret";
			cfgSandbox.checked = Boolean(cfg.useSandbox);
			cfgDefaultChannel.value = cfg.defaultChannelId || "";
			cfgBotEnabled.checked = Boolean(cfg.botEnabled);
			cfgAllowedUsers.value = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.join(", ") : "";

			modal.style.display = "flex";
		});

		q(".qq-modal-close").addEventListener("click", () => (modal.style.display = "none"));
		q(".qq-modal-cancel").addEventListener("click", () => (modal.style.display = "none"));

		q(".qq-btn-test-cfg").addEventListener("click", async () => {
			const btn = q(".qq-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = "测试中...";
			const testCfg = {
				appId: cfgAppId.value.trim(),
				clientSecret: cfgClientSecret.value.trim(),
				useSandbox: Boolean(cfgSandbox.checked),
			};
			const res = await sendHost("test_config", { config: testCfg });
			btn.disabled = false;
			btn.textContent = "🔌 测试连接";
			alert?.(res?.message || (res?.success ? "连接测试通过！" : "测试失败"));
		});

		q(".qq-btn-save-cfg").addEventListener("click", async () => {
			const btn = q(".qq-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = "保存中...";

			const newCfg = {
				appId: cfgAppId.value.trim(),
				clientSecret: cfgClientSecret.value.trim(),
				useSandbox: Boolean(cfgSandbox.checked),
				defaultChannelId: cfgDefaultChannel.value.trim(),
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

		q(".qq-btn-toggle-bot").addEventListener("click", async () => {
			const isRunning = currentState.botStatus?.state === "connected";
			const action = isRunning ? "stop_bot" : "start_bot";
			await sendHost(action);
			refresh();
		});

		q(".qq-btn-send").addEventListener("click", async () => {
			const channelInput = q(".qq-send-channelid");
			const textInput = q(".qq-send-text");
			const text = textInput.value.trim();
			if (!text) {
				alert?.("请输入要发送的消息文本");
				return;
			}

			const btn = q(".qq-btn-send");
			btn.disabled = true;
			btn.textContent = "发送中...";
			try {
				const res = await sendHost("send_message", {
					channelId: channelInput.value.trim(),
					text,
				});
				if (res?.success) {
					alert?.("✅ QQ 消息发送成功！");
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
