import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import wechatPlugin, {
	stripInternalMarkers,
	peerAccountId,
	assistantTextOf,
	encodeClientVersion,
	inboundTextOf,
	inboundPartsOf,
	inboundMediaKind,
	checkCwdValid,
	aesEcbPaddedSize,
	encryptAesEcb,
	decryptAesEcb,
	parseAesKey,
	buildMediaRef,
	buildImageItem,
	buildFileItem,
	buildMediaItem,
	buildCdnUploadUrl,
	buildCdnDownloadUrl,
	mimeOfPath,
	mediaKindOfMime,
	sniffImageExt,
} from "../../plugins/wechat-ilink/index.mjs";

describe("wechat-ilink: stripInternalMarkers", () => {
	it("剥离各类 pi-web-ui 内部控制 marker", () => {
		const input = [
			"好的，这就为您安排任务：",
			"[[plan:new:1=调研,2=实现,active=1]]",
			"[[todo:new:开始调研]]",
			"[[conv:rename:微信重命名测试]]",
			"[[notify:info:后台任务已开始]]",
			"我们开始第一步调研。",
		].join("\n");

		const output = stripInternalMarkers(input);
		expect(output).not.toContain("[[plan:");
		expect(output).not.toContain("[[todo:");
		expect(output).not.toContain("[[conv:");
		expect(output).not.toContain("[[notify:");
		expect(output).toBe("好的，这就为您安排任务：\n\n我们开始第一步调研。");
	});

	it("保留普通 wikilink 与数组", () => {
		const input = "请参考 [[Obsidian Note]] 以及矩阵 [[1, 2], [3, 4]]。";
		expect(stripInternalMarkers(input)).toBe(input);
	});

	it("处理 Windows \\r\\n 换行符与多余空行", () => {
		const input = "前言\r\n\r\n[[notify:这是一条通知]]\r\n\r\n\r\n\r\n结语";
		const output = stripInternalMarkers(input);
		expect(output).toBe("前言\n\n结语");
	});

	it("纯 marker 文本清理后为空字符串", () => {
		const input = "[[todo:new:买菜]][[notify:info:done]]";
		expect(stripInternalMarkers(input)).toBe("");
	});
});

describe("wechat-ilink: peerAccountId", () => {
	it("相同 peer 映射出的 accountId 恒定一致", () => {
		const a1 = peerAccountId("user_12345");
		const a2 = peerAccountId("user_12345");
		expect(a1).toBe(a2);
	});

	it("传入 seq > 0 时实现会话隔离，且默认 seq=0 与不传保持向后兼容", () => {
		const aDefault = peerAccountId("user_12345");
		const aZero = peerAccountId("user_12345", 0);
		expect(aDefault).toBe(aZero);

		const aSeq1 = peerAccountId("user_12345", 1);
		const aSeq2 = peerAccountId("user_12345", 2);
		expect(aSeq1).not.toBe(aDefault);
		expect(aSeq1).not.toBe(aSeq2);
		expect(aSeq1).toMatch(/^wx_[a-f0-9]{16}$/);
	});

	it("不同 peer 映射出的 accountId 互不相同", () => {
		const a1 = peerAccountId("wx_user_alpha");
		const a2 = peerAccountId("wx_user_beta");
		expect(a1).not.toBe(a2);
	});

	it("输出格式符合合规键名，长度 <= 64 且仅含安全字符", () => {
		const id = peerAccountId("wx_user_test_@123#xyz");
		expect(id).toMatch(/^wx_[a-f0-9]{16}$/);
		expect(id.length).toBeLessThanOrEqual(64);
		expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
	});

	it("空值安全回退", () => {
		expect(peerAccountId("")).toBe("wx_default");
		expect(peerAccountId("   ")).toBe("wx_default");
		expect(peerAccountId(null)).toBe("wx_default");
		expect(peerAccountId(undefined)).toBe("wx_default");
	});
});

describe("wechat-ilink: assistantTextOf", () => {
	it("提取 assistant 文本并过滤 marker", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "任务开始：\n[[todo:new:第一步]]" },
				{ type: "text", text: "已完成调研。\n[[notify:success:ok]]" },
			],
		};
		const text = assistantTextOf(msg as never);
		expect(text).toBe("任务开始：\n\n已完成调研。");
	});

	it("非 assistant 角色或非 text 块返回空", () => {
		expect(assistantTextOf({ role: "user", content: [{ type: "text", text: "hi" }] } as never)).toBe("");
		expect(assistantTextOf({ role: "assistant", content: [{ type: "image", dataUrl: "..." }] } as never)).toBe("");
		expect(assistantTextOf(null as never)).toBe("");
	});
});

describe("wechat-ilink: 完整入站、隔离与无竞态回包（issue #345）", () => {
	it("隔离 accountId、剥离 marker，并在 early run_end 下可靠发包", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_alice"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		interface SendMessagePayload {
			msg?: {
				to_user_id?: string;
				item_list?: Array<{ text_item?: { text: string } }>;
			};
		}
		let sentPayload: SendMessagePayload | null = null;
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					// 第一轮长轮询模拟推一条来自 peer_alice 的入站消息
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_alice",
									context_token: "ctx_token_123",
									item_list: [{ type: 1, text_item: { text: "请制定计划" } }],
								},
							],
						}),
					} as Response;
				}
				// 模拟长轮询挂起，防止单测无限自旋
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				sentPayload = JSON.parse(String(init?.body ?? "{}"));
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			if (urlStr.includes("getconfig")) {
				return { ok: true, json: async () => ({ typing_ticket: "ticket_1" }) } as Response;
			}
			if (urlStr.includes("sendtyping") || urlStr.includes("msg/")) {
				return { ok: true, json: async () => ({}) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			let chatResolve: (val: { conversationId: string; clientId: string }) => void = () => {};
			const chatPromise = new Promise<{ conversationId: string; clientId: string }>((resolve) => {
				chatResolve = resolve;
			});

			const hostChatSpy = vi.fn((_req: unknown) => chatPromise);

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);

			// 等待 pollOnce 执行并调用 host.chat
			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});

			// 验证 accountId 隔离性：必须是基于 peer_alice 的 wx_${hash}，而不是硬编码的 "wx"
			const firstCall = hostChatSpy.mock.calls[0] as unknown[] | undefined;
			const req = (firstCall?.[0] ?? {}) as { accountId?: string; text?: string };
			expect(req.accountId).toBe(peerAccountId("peer_alice"));
			expect(req.accountId).not.toBe("wx");
			expect(req.text).toContain("[微信:peer_alice]");

			// 模拟微任务时序竞态：在 host.chat() 的 Promise resolve 之前，
			// 底层 agent 已经极快触发了 message 与 run_end 事件！
			const targetConvId = "conv_quick_test";
			expect(runHandler).toBeDefined();

			runHandler!({
				type: "message",
				conversationId: targetConvId,
				at: Date.now(),
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "计划已就绪：\n[[plan:new:1=方案,active=1]]\n[[todo:new:第一项]]\n请查阅方案详情。",
						},
					],
				},
			});

			runHandler!({
				type: "run_end",
				conversationId: targetConvId,
				at: Date.now(),
			});

			// 此时尚未回包（因为 host.chat 的 Promise 还没返回 conversationId）
			expect(sentPayload).toBeNull();

			// 随后 host.chat 完成，返回该 conversationId
			chatResolve({
				conversationId: targetConvId,
				clientId: `plugin:wechat-ilink:${req.accountId}`,
			});

			// 等待 trackRun 消费 earlyRuns 并发送回包
			await vi.waitFor(() => {
				expect(sentPayload).not.toBeNull();
			});

			// 验证回包内容与收件人
			const payload = sentPayload as unknown as SendMessagePayload;
			expect(payload?.msg?.to_user_id).toBe("peer_alice");
			const outText = payload?.msg?.item_list?.[0]?.text_item?.text ?? "";

			// 验证内部 marker 已被彻底剥离
			expect(outText).not.toContain("[[plan:");
			expect(outText).not.toContain("[[todo:");
			expect(outText).toBe("计划已就绪：\n\n请查阅方案详情。");

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("encodeClientVersion 与 inboundTextOf 正常运行", () => {
		expect(encodeClientVersion("0.1.0")).toBe(String(0x00000100));
		expect(inboundTextOf([{ text_item: { text: "你好" } }])).toBe("你好");
		expect(inboundTextOf([{ image_item: {} }])).toBe("[图片]");
	});
});

describe("wechat-ilink: checkCwdValid", () => {
	it("空路径与空白返回错误", () => {
		expect(checkCwdValid("").ok).toBe(false);
		expect(checkCwdValid("   ").ok).toBe(false);
	});

	it("不存在的目录返回错误", () => {
		const r = checkCwdValid("/non/existent/path/xyz-12345");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("不存在或不是");
	});

	it("存在的目录返回绝对路径", () => {
		const r = checkCwdValid(process.cwd());
		expect(r.ok).toBe(true);
		expect(typeof r.abs).toBe("string");
	});

	if (process.platform === "win32") {
		it("Windows 下拒绝在系统根目录执行", () => {
			const sysRoot = process.env.SystemRoot || "C:\\Windows";
			const r = checkCwdValid(sysRoot);
			expect(r.ok).toBe(false);
			expect(r.error).toContain("拒绝在系统目录执行");
		});
	}
});

describe("wechat-ilink: 斜杠快捷指令 (Slash Commands)", () => {
	it("支持 /help、/status、/cwd、/model、/clear、/new、/stop 及全角 ／ 容错", async () => {
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "wx_bot_tester", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["user_bob"]);

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token_slash" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const replies: string[] = [];
		const mockQueue: Array<{
			message_type: number;
			from_user_id: string;
			item_list: Array<{ type: number; text_item?: { text: string } }>;
		}> = [];
		let waitingResolver: (() => void) | null = null;
		function enqueueMsg(text: string) {
			mockQueue.push({
				message_type: 1,
				from_user_id: "user_bob",
				item_list: [{ type: 1, text_item: { text } }],
			});
			if (waitingResolver) {
				const r = waitingResolver;
				waitingResolver = null;
				r();
			}
		}

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				if (mockQueue.length === 0) {
					await new Promise<void>((r) => {
						waitingResolver = r;
						setTimeout(r, 2000);
					});
				}
				const msgs = mockQueue.splice(0, mockQueue.length);
				return { ok: true, json: async () => ({ ret: 0, msgs }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				const txt = body?.msg?.item_list?.[0]?.text_item?.text ?? "";
				replies.push(txt);
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		const hostChatSpy = vi.fn(async () => ({ conversationId: "conv_test_123", clientId: "client_test" }));
		const hostAbortSpy = vi.fn(async () => ({ ok: true }));
		const hostExecCommandSpy = vi.fn(async (name: string, args: string) => {
			if (name === "todo") return { ok: true, result: `✅ 已加入待办：${args}` };
			return { ok: false, error: "not found" };
		});
		const hostGetPluginCommandsSpy = vi.fn(() => [{ name: "todo", description: "加一条待办", argumentHint: "<内容>" }]);
		const hostReloadSpy = vi.fn(async () => {});

		const host = {
			getSettings: () => ({ autoDrive: true, typing: false, model: "gpt-4o" }),
			onSettingsChanged: () => () => {},
			storage: mockStorage,
			secrets: mockSecrets,
			cwd: process.cwd(),
			log: vi.fn(),
			notify: vi.fn(),
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			onRunEvent: () => () => {},
			onMessage: () => () => {},
			onAttach: () => () => {},
			registerAgentTool: vi.fn(),
			registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
			chat: hostChatSpy,
			abortRun: hostAbortSpy,
			execCommand: hostExecCommandSpy,
			getPluginCommands: hostGetPluginCommandsSpy,
			reload: hostReloadSpy,
		};

		const cleanup = wechatPlugin.activate(host as never);

		try {
			// 1. 测试 /help 指令及单独一个 "/" 或全角 "／" 或 "/?" 或 "/h" 作为 /help 别名，且包含精简序号
			enqueueMsg("/help");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(1));
			const lastHelp = replies[replies.length - 1];
			expect(lastHelp).toContain("可直接发送 /序号（如 /1 或 /2 <提示>）快捷操作：");
			expect(lastHelp).toContain("1/cwd : 查看或切换当前项目根目录");
			expect(lastHelp).toContain("2/new : 清空上下文开启全新会话 [提示]");
			expect(lastHelp).toContain("5/thinking : 设置思考强度");
			expect(lastHelp).toContain("6/plan : 开启或关闭计划模式");
			expect(lastHelp).toContain("11/todo : 加一条待办 <内容>");
			expect(hostChatSpy).not.toHaveBeenCalled();

			enqueueMsg("/h");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(2));
			const hReply = replies[replies.length - 1];
			expect(hReply).toContain("1/cwd : 查看或切换当前项目根目录");
			expect(hReply).toContain("10/help : 显示全部命令 (或发 /)");

			enqueueMsg("/");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(3));
			expect(replies[replies.length - 1]).toContain("1/cwd : 查看或切换当前项目根目录");

			enqueueMsg("／");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(4));
			expect(replies[replies.length - 1]).toContain("1/cwd : 查看或切换当前项目根目录");

			enqueueMsg("/?");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(5));
			expect(replies[replies.length - 1]).toContain("1/cwd : 查看或切换当前项目根目录");

			// 2. 测试全角 ／status 指令
			enqueueMsg("／status");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(6));
			const lastStatus = replies[replies.length - 1];
			expect(lastStatus).toContain("微信通道运行状态");
			expect(lastStatus).toContain("wx_bot_tester");
			expect(lastStatus).toContain("已接收消息：");
			expect(hostChatSpy).not.toHaveBeenCalled();

			// 3. 测试 /cwd 查询
			enqueueMsg("/cwd");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(7));
			expect(replies[replies.length - 1]).toContain("当前项目根目录：");

			// 4. 测试 /cwd 切换为有效目录
			enqueueMsg(`/cwd ${process.cwd()}`);
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(8));
			expect(replies[replies.length - 1]).toContain("已将项目根目录切换为：");

			// 5. 测试 /cwd default 恢复默认
			enqueueMsg("/cwd default");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(9));
			expect(replies[replies.length - 1]).toContain("已恢复跟随全局根目录");

			// 6. 测试 /model 查看与切换
			enqueueMsg("/model");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(10));
			expect(replies[replies.length - 1]).toContain("当前模型：");

			enqueueMsg("/model deepseek/deepseek-chat");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(11));
			expect(replies[replies.length - 1]).toContain("已将模型切换为：deepseek/deepseek-chat");

			// 7. 测试 /clear 清空上下文
			enqueueMsg("/clear");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(12));
			expect(replies[replies.length - 1]).toContain("对话上下文已清空，已为您开启全新会话！");

			// 8. 测试 /new 带 prompt 参数
			enqueueMsg("/new 请帮我写一段测试代码");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(13));
			expect(replies[replies.length - 1]).toContain("已为您开启全新会话，正在执行指令…");
			// 此时应该调用了 host.chat
			await vi.waitFor(() => expect(hostChatSpy).toHaveBeenCalled());
			const firstChatCall = hostChatSpy.mock.calls[0] as unknown[] | undefined;
			const chatArgs = (firstChatCall?.[0] ?? {}) as { text?: string; model?: string };
			expect(chatArgs.text).toContain("请帮我写一段测试代码");
			expect(chatArgs.model).toBe("deepseek/deepseek-chat");

			// 9. 测试 /stop 中止正在进行的任务
			enqueueMsg("/stop");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(14));
			expect(replies[replies.length - 1]).toContain("已中止当前正在执行的任务");
			expect(hostAbortSpy).toHaveBeenCalledWith("conv_test_123");

			// 10. 测试未知斜杠指令不被拦截，透传给 agent 执行
			hostChatSpy.mockClear();
			enqueueMsg("/unknown_magic_cmd 参数测试");
			await vi.waitFor(() => expect(hostChatSpy).toHaveBeenCalled());
			const unknownChatCall = hostChatSpy.mock.calls[0] as unknown[] | undefined;
			const unknownChatArgs = (unknownChatCall?.[0] ?? {}) as { text?: string };
			expect(unknownChatArgs.text).toContain("/unknown_magic_cmd 参数测试");

			// 11. 测试数字序号快捷指令 (/1 ~ /6 及 /一 别名)
			// /1 等同于 /cwd
			enqueueMsg("/1");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(15));
			expect(replies[replies.length - 1]).toContain("当前项目根目录：");

			// /一 也等同于 /cwd
			enqueueMsg("/一");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(16));
			expect(replies[replies.length - 1]).toContain("当前项目根目录：");

			// /2 等同于 /new
			enqueueMsg("/2");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(17));
			expect(replies[replies.length - 1]).toContain("对话上下文已清空，已为您开启全新会话！");

			// /3 等同于 /status
			enqueueMsg("/3");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(18));
			expect(replies[replies.length - 1]).toContain("微信通道运行状态");

			// /4 查看模型
			enqueueMsg("/4");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(19));
			expect(replies[replies.length - 1]).toContain("当前模型：");

			// 1/cwd 格式直接触发
			enqueueMsg("1/cwd");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(20));
			expect(replies[replies.length - 1]).toContain("当前项目根目录：");

			// /5 设置思考强度
			enqueueMsg("/5 high");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(21));
			expect(replies[replies.length - 1]).toContain("已将思考强度设置为：high");

			// /6 开启计划模式
			enqueueMsg("/6 on");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(22));
			expect(replies[replies.length - 1]).toContain("计划模式已开启");

			// /9 重载
			enqueueMsg("/9");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(23));
			expect(replies[replies.length - 1]).toContain("已重新加载扩展、技能与提示模板");
			expect(hostReloadSpy).toHaveBeenCalled();

			// /10 查看帮助
			enqueueMsg("/10");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(24));
			expect(replies[replies.length - 1]).toContain("1/cwd : 查看或切换当前项目根目录");

			// 12. 测试第三方插件命令执行 (/todo 及序号 /11)
			enqueueMsg("/todo 买菜 明天18:00");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(25));
			expect(replies[replies.length - 1]).toBe("✅ 已加入待办：买菜 明天18:00");

			enqueueMsg("/11 买水果");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(26));
			expect(replies[replies.length - 1]).toBe("✅ 已加入待办：买水果");
		} finally {
			cleanup?.();
			globalThis.fetch = origFetch;
		}
	});

	it("配对成功后自动向微信用户发送简洁命令使用指南", async () => {
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "wx_bot_tester", loginAt: Date.now() });
		storageMap.set("allowedPeers", []);
		storageMap.set("pendingPeers", ["new_user_charlie"]);
		storageMap.set("peerCtx", { new_user_charlie: "token_charlie_123" });

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		let messageHandler: ((payload: unknown, from?: string) => void) | undefined;
		interface SendMessagePayload {
			msg?: {
				to_user_id?: string;
				item_list?: Array<{ text_item?: { text: string } }>;
			};
		}
		let pairWelcomePayload: SendMessagePayload | null = null;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				pairWelcomePayload = JSON.parse(String(init?.body ?? "{}"));
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		const host = {
			getSettings: () => ({ autoDrive: true, typing: false }),
			onSettingsChanged: () => () => {},
			storage: mockStorage,
			secrets: mockSecrets,
			cwd: process.cwd(),
			log: vi.fn(),
			notify: vi.fn(),
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			onRunEvent: () => () => {},
			onMessage: (h: (payload: unknown, from?: string) => void) => {
				messageHandler = h;
				return () => {};
			},
			onAttach: () => () => {},
			registerAgentTool: vi.fn(),
			registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
			chat: vi.fn(),
		};

		const cleanup = wechatPlugin.activate(host as never);

		try {
			expect(messageHandler).toBeDefined();
			// 模拟在视图中点击“允许配对”
			messageHandler!({ action: "allow", peer: "new_user_charlie" });

			await vi.waitFor(() => {
				expect(pairWelcomePayload).not.toBeNull();
			});

			const sent = pairWelcomePayload as unknown as SendMessagePayload;
			expect(sent?.msg?.to_user_id).toBe("new_user_charlie");
			const text = sent?.msg?.item_list?.[0]?.text_item?.text ?? "";
			expect(text).toContain("🎉 配对成功！");
			expect(text).toContain("1/cwd : 查看或切换当前项目根目录");
			expect(text).toContain("2/new : 清空上下文开启全新会话");
			expect(text).toContain("8/stop : 中止当前正在执行的任务");
			expect(text).toContain("10/help : 显示全部命令 (或发 /)");
		} finally {
			cleanup?.();
			globalThis.fetch = origFetch;
		}
	});

	it("多客户端同名 conversationId 时严格基于 clientId 隔离，绝不串台发送其他会话的消息", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_bob"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const sentMessages: string[] = [];
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_bob",
									context_token: "ctx_bob_1",
									item_list: [{ type: 1, text_item: { text: "你好" } }],
								},
							],
						}),
					} as Response;
				}
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				const text = body?.msg?.item_list?.[0]?.text_item?.text ?? "";
				sentMessages.push(text);
				return { ok: true, json: async () => ({ ret: 0, message_id: "123456" }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			const targetConvId = "c1"; // 网页端与微信端均分配了局部同名 ID "c1"
			const wechatClientId = `plugin:wechat-ilink:${peerAccountId("peer_bob")}`;
			const browserClientId = "client_browser_tab1";

			const hostChatSpy = vi.fn(async (_req: unknown) => {
				return { conversationId: targetConvId, clientId: wechatClientId };
			});

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false, bindActive: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				cwd: process.cwd(),
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);

			// 等待微信入站调用 host.chat 完成登记
			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});

			expect(runHandler).toBeDefined();

			// 模拟同时运行的网页端会话（同为 c1，但属于 client_browser_tab1）产生了大段新功能代码输出
			runHandler!({
				type: "message",
				conversationId: targetConvId,
				clientId: browserClientId,
				at: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "这是电脑网页端正在处理项目新功能的大段代码与输出..." }],
				},
			});
			runHandler!({
				type: "run_end",
				conversationId: targetConvId,
				clientId: browserClientId,
				at: Date.now(),
			});

			// 等待微任务处理，断言微信此时绝不能把网页端的新功能消息发出去！
			await new Promise((r) => setTimeout(r, 50));
			expect(sentMessages.length).toBe(0);

			// 现在模拟微信会话自己的真实回复到达（属于 wechatClientId）
			runHandler!({
				type: "message",
				conversationId: targetConvId,
				clientId: wechatClientId,
				at: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "你好！我是微信助手，请问有什么可以帮您？" }],
				},
			});
			runHandler!({
				type: "run_end",
				conversationId: targetConvId,
				clientId: wechatClientId,
				at: Date.now(),
			});

			// 等待微信发出回复
			await vi.waitFor(() => {
				expect(sentMessages.length).toBe(1);
			});

			// 验证发出的内容是微信自己的回复，绝对没有网页端新功能的任何内容
			expect(sentMessages[0]).toBe("你好！我是微信助手，请问有什么可以帮您？");
			expect(sentMessages[0]).not.toContain("项目新功能");

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("对话被过户到网页端（clientId 变 + 撞 id 改名）后仍按 runId 认领回包", async () => {
		// 真实链路：微信无头会话 c1 跑到一半，用户在网页左栏点开这条 running 对话
		// → take_over_conversation 把对话搬到浏览器会话（clientId 变成对方的），
		// 目标会话已有同名 c1 → 对话被就地改名 c7。此时 clientId 与 conversationId
		// 双双失效，只有 host.chat 回执里的 runId 不变 —— 插件必须按它回包。
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_dave"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};
		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const sentMessages: string[] = [];
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_dave",
									context_token: "ctx_dave_1",
									item_list: [{ type: 1, text_item: { text: "查一下磁盘占用" } }],
								},
							],
						}),
					} as Response;
				}
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				sentMessages.push(body?.msg?.item_list?.[0]?.text_item?.text ?? "");
				return { ok: true, json: async () => ({ ret: 0, message_id: "123456" }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			const wechatClientId = `plugin:wechat-ilink:${peerAccountId("peer_dave")}`;
			const browserClientId = "client_browser_tab9";
			const runId = "pr-5f3c1a";

			const hostChatSpy = vi.fn(async (_req: unknown) => {
				return { conversationId: "c1", clientId: wechatClientId, runId };
			});

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false, bindActive: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				cwd: process.cwd(),
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);
			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});
			expect(runHandler).toBeDefined();

			// 过户之后：持有方换成浏览器标签页，对话 id 因撞车被改名 c1 → c7。
			runHandler!({
				type: "turn_end",
				conversationId: "c7",
				clientId: browserClientId,
				runId,
				at: Date.now(),
			});
			runHandler!({
				type: "message",
				conversationId: "c7",
				clientId: browserClientId,
				runId,
				at: Date.now(),
				message: { role: "assistant", content: [{ type: "text", text: "磁盘还剩 42GB。" }] },
			});
			runHandler!({
				type: "run_end",
				conversationId: "c7",
				clientId: browserClientId,
				runId,
				at: Date.now(),
			});

			await vi.waitFor(() => {
				expect(sentMessages.length).toBe(1);
			});
			expect(sentMessages[0]).toBe("磁盘还剩 42GB。");

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("runId 不同则不认领（不会把别处的运行回合错发给微信）", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_erin"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};
		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const sentMessages: string[] = [];
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_erin",
									context_token: "ctx_erin_1",
									item_list: [{ type: 1, text_item: { text: "在吗" } }],
								},
							],
						}),
					} as Response;
				}
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				sentMessages.push(body?.msg?.item_list?.[0]?.text_item?.text ?? "");
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			const wechatClientId = `plugin:wechat-ilink:${peerAccountId("peer_erin")}`;
			const hostChatSpy = vi.fn(async (_req: unknown) => {
				return { conversationId: "c1", clientId: wechatClientId, runId: "pr-mine" };
			});

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false, bindActive: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				cwd: process.cwd(),
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);
			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});
			expect(runHandler).toBeDefined();

			// 别人的运行（runId 不同、clientId 也不同、id 也被改过）：绝不认领。
			runHandler!({
				type: "message",
				conversationId: "c9",
				clientId: "client_browser_tab3",
				runId: "pr-someone-else",
				at: Date.now(),
				message: { role: "assistant", content: [{ type: "text", text: "不该发给微信的内容" }] },
			});
			runHandler!({
				type: "run_end",
				conversationId: "c9",
				clientId: "client_browser_tab3",
				runId: "pr-someone-else",
				at: Date.now(),
			});
			await new Promise((r) => setTimeout(r, 50));
			expect(sentMessages.length).toBe(0);

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});

describe("wechat-ilink: 媒体收发纯函数", () => {
	it("aesEcbPaddedSize 按 PKCS#7 向上对齐（含整块多一个字节）", () => {
		expect(aesEcbPaddedSize(0)).toBe(16);
		expect(aesEcbPaddedSize(1)).toBe(16);
		expect(aesEcbPaddedSize(15)).toBe(16);
		expect(aesEcbPaddedSize(16)).toBe(32);
		expect(aesEcbPaddedSize(1000)).toBe(1008);
	});

	it("AES-128-ECB 加解密可往返（密文长度 = 填充后长度）", () => {
		const key = randomBytes(16);
		const plain = Buffer.from("pi-web-ui 微信通道图片载荷", "utf8");
		const cipher = encryptAesEcb(plain, key);
		expect(cipher.length).toBe(aesEcbPaddedSize(plain.length));
		expect(decryptAesEcb(cipher, key).equals(plain)).toBe(true);
	});

	it("parseAesKey 兼容 hex 裸串 / base64(16 字节) / base64(hex 串) / 非法输入", () => {
		const key = randomBytes(16);
		const hex = key.toString("hex");
		// 裸 hex
		expect(parseAesKey(hex)?.equals(key)).toBe(true);
		// base64(16 字节原钥)
		expect(parseAesKey(key.toString("base64"))?.equals(key)).toBe(true);
		// base64(hex 串) —— upstream 发送侧口径
		expect(parseAesKey(Buffer.from(hex).toString("base64"))?.equals(key)).toBe(true);
		// 空 / 垃圾值不抛错，回 null（按明文处理）
		expect(parseAesKey("")).toBeNull();
		expect(parseAesKey("!!!")).toBeNull();
	});

	it("buildMediaRef / buildImageItem 与协议口径一致", () => {
		const hex = "00112233445566778899aabbccddeeff";
		const ref = buildMediaRef({ downloadParam: "dp-1", aeskeyHex: hex });
		expect(ref.encrypt_query_param).toBe("dp-1");
		expect(ref.aes_key).toBe(Buffer.from(hex).toString("base64"));
		expect(ref.encrypt_type).toBe(1);

		const item = buildImageItem({ downloadParam: "dp-2", aeskeyHex: hex, cipherSize: 2048 });
		expect(item.type).toBe(2);
		expect(item.image_item.media.encrypt_query_param).toBe("dp-2");
		expect(item.image_item.mid_size).toBe(2048);
	});

	it("buildFileItem 的 len 是明文字节数的十进制字符串", () => {
		const item = buildFileItem({ downloadParam: "dp", aeskeyHex: "00", fileName: "报告.pdf", rawSize: 12345 });
		expect(item.type).toBe(4);
		expect(item.file_item.len).toBe("12345");
		expect(item.file_item.file_name).toBe("报告.pdf");
	});

	it("buildMediaItem 按 kind 分流到 image/video/file", () => {
		const base = { downloadParam: "dp", aeskeyHex: "00", cipherSize: 16, fileName: "a.bin", rawSize: 3 };
		expect(buildMediaItem({ ...base, kind: "image" }).type).toBe(2);
		expect(buildMediaItem({ ...base, kind: "video" }).type).toBe(5);
		expect(buildMediaItem({ ...base, kind: "file" }).type).toBe(4);
	});

	it("CDN URL 拼接与 MIME / 扩展名分流", () => {
		expect(buildCdnUploadUrl({ cdnBase: "https://cdn.example/c2c/", uploadParam: "a b", filekey: "k1" })).toBe(
			"https://cdn.example/c2c/upload?encrypted_query_param=a%20b&filekey=k1",
		);
		expect(buildCdnDownloadUrl({ cdnBase: "https://cdn.example/c2c", encryptQueryParam: "x y" })).toBe(
			"https://cdn.example/c2c/download?encrypted_query_param=x%20y",
		);
		expect(mimeOfPath("/tmp/a.JPG")).toBe("image/jpeg");
		expect(mediaKindOfMime("image/jpeg")).toBe("image");
		expect(mediaKindOfMime("video/mp4")).toBe("video");
		expect(mediaKindOfMime("application/pdf")).toBe("file");
	});

	it("sniffImageExt 只认魔数，认不出回空串", () => {
		expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(".jpg");
		expect(sniffImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(".png");
		expect(sniffImageExt(Buffer.from("GIF89a"))).toBe(".gif");
		expect(sniffImageExt(Buffer.from("hello"))).toBe("");
	});

	it("inboundPartsOf 按 type 字段识别媒体，文本不被 JSON 嗅探误判", () => {
		const parts = inboundPartsOf([
			{ type: 1, text_item: { text: "看这张 image 图" } },
			{ type: 2, image_item: {} },
			{ image_item: { media: {} } },
			{ type: 4, file_item: { file_name: "a.pdf" } },
			{ type: 5, video_item: {} },
			{ type: 3, voice_item: {} },
			{ type: 99 },
		]);
		expect(parts.map((p) => p.kind)).toEqual(["text", "image", "image", "file", "video", "voice", "unknown"]);
		expect(inboundTextOf([{ type: 2 }, { type: 4 }])).toBe("[图片]\n[文件]");
		expect(inboundMediaKind({ type: 5 })).toBe("video");
		expect(inboundMediaKind({ file_item: {} })).toBe("file");
	});
});

describe("wechat-ilink: 媒体双向链路（CDN 上传/下载）", () => {
	it("出站发图：getuploadurl → AES 加密上传 → image_item；入站图片解密落地供 agent 读取", async () => {
		const { mkdtempSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const workdir = mkdtempSync(join(tmpdir(), "wx-media-"));

		// 一张 1x1 PNG（魔数正确即可）
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		const imgPath = join(workdir, "cat.png");
		writeFileSync(imgPath, png);

		const inboundKey = randomBytes(16);
		const inboundCipher = encryptAesEcb(png, inboundKey);

		const storageMap = new Map<string, unknown>();
		const mockStorage = {
			get: vi.fn((k: string, d: unknown) => (storageMap.has(k) ? storageMap.get(k) : d)),
			set: vi.fn((k: string, v: unknown) => storageMap.set(k, v)),
		};
		const mockSecrets = {
			get: vi.fn((k: string) => (k === "bot_token" ? "fake_token_media" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const uploadCalls: Array<{ url: string; body: unknown; raw: Buffer }> = [];
		const sendMessageItems: unknown[] = [];
		const chatPrompts: string[] = [];
		const registeredTools: Array<{ execute: (id: string, p: Record<string, unknown>) => Promise<string> }> = [];
		const inboundQueue: Array<Record<string, unknown>> = [];
		const ctl = { wake: null as (() => void) | null };

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				if (!inboundQueue.length) {
					await new Promise<void>((r) => {
						ctl.wake = r;
						setTimeout(r, 1500);
					});
				}
				const msgs = inboundQueue.splice(0, inboundQueue.length);
				return { ok: true, json: async () => ({ ret: 0, msgs }) } as Response;
			}
			if (urlStr.includes("getuploadurl")) {
				return {
					ok: true,
					json: async () => ({ upload_full_url: "https://cdn.test/upload/full" }),
				} as Response;
			}
			if (urlStr === "https://cdn.test/upload/full") {
				const raw = Buffer.from((init?.body as Uint8Array) ?? new Uint8Array());
				uploadCalls.push({ url: urlStr, body: init?.body, raw });
				return {
					status: 200,
					ok: true,
					headers: new Headers({ "x-encrypted-param": "dp-out-1" }),
					text: async () => "",
				} as unknown as Response;
			}
			if (urlStr.startsWith("https://cdn.test/download")) {
				return {
					ok: true,
					arrayBuffer: async () =>
						inboundCipher.buffer.slice(inboundCipher.byteOffset, inboundCipher.byteOffset + inboundCipher.byteLength),
				} as unknown as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				sendMessageItems.push(body?.msg?.item_list?.[0]);
				return { ok: true, json: async () => ({ ret: 0, message_id: "m1" }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		const host = {
			getSettings: () => ({ autoDrive: true, typing: false, allowFrom: "*", workspace: workdir }),
			onSettingsChanged: () => () => {},
			storage: mockStorage,
			secrets: mockSecrets,
			cwd: workdir,
			log: vi.fn(),
			notify: vi.fn(),
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			onRunEvent: () => () => {},
			onMessage: () => () => {},
			onAttach: () => () => {},
			registerAgentTool: vi.fn((tool: never) => {
				registeredTools.push(
					tool as unknown as { execute: (id: string, p: Record<string, unknown>) => Promise<string> },
				);
				return () => {};
			}),
			registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
			chat: vi.fn(async (req: { text: string }) => {
				chatPrompts.push(req.text);
				return { conversationId: "conv_media_1", clientId: "client_media_1" };
			}),
		};

		const cleanup = wechatPlugin.activate(host as never);
		try {
			await vi.waitFor(() => expect(registeredTools.length).toBeGreaterThan(0));

			// ---- 出站：AI 调 wechat_send 发图 ----
			const res = await registeredTools[0]!.execute("t1", { to: "peer_zed", text: "看猫", image: imgPath });
			expect(res).toContain("已发送给 peer_zed");

			expect(uploadCalls.length).toBe(1);
			// 上传体是 AES 密文：长度 = 填充后长度，且不等于明文
			expect(uploadCalls[0]!.raw.length).toBe(aesEcbPaddedSize(png.length));
			expect(uploadCalls[0]!.raw.equals(png)).toBe(false);

			const items = sendMessageItems.filter(Boolean) as Array<Record<string, never>>;
			const imageItem = items.find((it: Record<string, unknown>) => it.type === 2) as
				{ image_item: { media: { encrypt_query_param: string; aes_key: string }; mid_size: number } } | undefined;
			expect(imageItem).toBeTruthy();
			expect(imageItem!.image_item.media.encrypt_query_param).toBe("dp-out-1");
			// aes_key 是 hex 密钥串的 base64（32 字符 base64 → 解码后 32 字符 hex）
			const decodedKey = Buffer.from(imageItem!.image_item.media.aes_key, "base64").toString("latin1");
			expect(decodedKey).toMatch(/^[0-9a-f]{32}$/);
			expect(decryptAesEcb(uploadCalls[0]!.raw, Buffer.from(decodedKey, "hex")).equals(png)).toBe(true);
			expect(imageItem!.image_item.mid_size).toBe(aesEcbPaddedSize(png.length));

			// ---- 入站：微信发来图片 → 解密落地 → 提示里给路径 ----
			inboundQueue.push({
				message_type: 1,
				from_user_id: "peer_zed",
				item_list: [
					{
						type: 2,
						image_item: {
							media: { full_url: "https://cdn.test/download?x=1", aes_key: inboundKey.toString("base64") },
							aeskey: inboundKey.toString("hex"),
						},
					},
				],
			});
			ctl.wake?.();
			await vi.waitFor(() => expect(chatPrompts.length).toBe(1));

			const prompt = chatPrompts[0]!;
			expect(prompt).toContain("图片已保存");
			const savedPath = /图片已保存：(.+?)（/.exec(prompt)?.[1] ?? "";
			expect(savedPath).toContain(".pi-wechat-media");
			expect(existsSync(savedPath)).toBe(true);
			expect(readFileSync(savedPath).equals(png)).toBe(true);
		} finally {
			cleanup?.();
			globalThis.fetch = origFetch;
		}
	});
});
