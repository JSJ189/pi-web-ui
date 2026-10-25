import { describe, expect, it, vi } from "vitest";
import { extractSubagentConclusion, formatSubagentsCompletionNotice } from "../../server/subagent-notify.js";
import { ClientSession, type Conversation } from "../../server/agent-service.js";

function makeMockConv(opts: {
	id: string;
	title?: string;
	type?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	output?: string;
	error?: string;
	canceled?: boolean;
}): Conversation {
	const messages: any[] = [];
	if (opts.error) {
		messages.push({ role: "assistant", errorMessage: opts.error });
	} else if (opts.canceled) {
		messages.push({ role: "assistant", stopReason: "aborted" });
	} else if (opts.output !== undefined) {
		messages.push({ role: "assistant", stopReason: "end_turn" });
	}

	return {
		id: opts.id,
		title: opts.title ?? "测试任务",
		subagentType: opts.type ?? "explore",
		isSubagent: true,
		session: {
			model: opts.model ?? { provider: "anthropic", id: "claude-3-7-sonnet" },
			thinkingLevel: opts.thinkingLevel ?? "high",
			getLastAssistantText: () => opts.output ?? "",
			getSessionStats: () => ({ totalMessages: messages.length }),
			agent: {
				state: {
					messages,
				},
			},
		} as any,
	} as Conversation;
}

describe("subagent-notify (Issue #713)", () => {
	describe("extractSubagentConclusion", () => {
		it("空文本时返回可读占位符", () => {
			expect(extractSubagentConclusion("", "zh")).toBe("（无输出结果）");
			expect(extractSubagentConclusion("   ", "en")).toBe("(no output produced)");
		});

		it("不超过 20 行时完整返回", () => {
			const lines = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join("\n");
			expect(extractSubagentConclusion(lines)).toBe(lines);
		});

		it("超过 20 行时保留前 3 行与后 15 行，中间折叠", () => {
			const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n");
			const outZh = extractSubagentConclusion(lines, "zh");
			expect(outZh).toContain("Line 1\nLine 2\nLine 3");
			expect(outZh).toContain("Line 30");
			expect(outZh).toContain("Line 16");
			expect(outZh).toContain("… [中间省略 12 行过程日志");

			const outEn = extractSubagentConclusion(lines, "en");
			expect(outEn).toContain("12 lines omitted");
		});
	});

	describe("formatSubagentsCompletionNotice", () => {
		it("空列表返回空串", () => {
			expect(formatSubagentsCompletionNotice([])).toBe("");
		});

		it("正常完成单子代理生成结构化汇报（中文）", () => {
			const conv = makeMockConv({
				id: "sa-12345678-abcd",
				title: "排查数据库死锁",
				type: "investigate",
				output: "已发现事务未提交导致死锁，建议在 finally 中统一释放连接。",
			});

			const text = formatSubagentsCompletionNotice([conv], "zh");
			expect(text).toContain("[子代理执行完成通知] 共有 1 个子代理已完成：");
			expect(text).toContain("- **sa-12345**（investigate · anthropic/claude-3-7-sonnet:high）— ✅ 正常完成");
			expect(text).toContain("目标: 排查数据库死锁");
			expect(text).toContain("已发现事务未提交导致死锁");
			expect(text).toContain('subagent(action="get_result", runId="<id>")');
		});

		it("报错子代理显示运行失败标签（英文）", () => {
			const conv = makeMockConv({
				id: "sa-err-1234",
				title: "构建前端",
				error: "Out of memory",
			});

			const text = formatSubagentsCompletionNotice([conv], "en");
			expect(text).toContain("[Subagent Completion Notice] 1 subagent(s) completed:");
			expect(text).toContain("❌ Failed (Out of memory)");
		});

		it("中止子代理显示已中止标签", () => {
			const conv = makeMockConv({
				id: "sa-aborted-1234",
				canceled: true,
			});

			const text = formatSubagentsCompletionNotice([conv], "zh");
			expect(text).toContain("⚠️ 已中止");
		});

		it("多个子代理合成聚合通知", () => {
			const c1 = makeMockConv({ id: "sa-1111", title: "任务1", output: "完成1" });
			const c2 = makeMockConv({ id: "sa-2222", title: "任务2", output: "完成2" });

			const text = formatSubagentsCompletionNotice([c1, c2], "zh");
			expect(text).toContain("共有 2 个子代理已完成：");
			expect(text).toContain("sa-1111");
			expect(text).toContain("sa-2222");
		});

		it("带有父对话回落标记时显示兜底提示", () => {
			const conv = makeMockConv({ id: "sa-1111", output: "完成" });
			const text = formatSubagentsCompletionNotice([conv], "zh", "parent-orig-9999");
			expect(text).toContain("原父对话 parent-o 已不在，转至当前活跃对话继续");
		});
	});

	describe("ClientSession subagent completion batching & debounce", () => {
		it("400ms 内多个子代理结束合并为一条通知唤醒父对话", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: false,
					isCompacting: false,
				},
				autonomousTurnsWithoutUser: 0,
			};

			const cs: any = {
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
			};

			const sa1: any = {
				id: "sa-11111111",
				parentId: "parent-c1",
				title: "任务1",
				subagentType: "explore",
				session: {
					model: { provider: "mock", id: "m1" },
					thinkingLevel: "low",
					getLastAssistantText: () => "结论1",
					agent: { state: { messages: [{ role: "assistant", stopReason: "end_turn" }] } },
				},
			};
			const sa2: any = {
				id: "sa-22222222",
				parentId: "parent-c1",
				title: "任务2",
				subagentType: "implement",
				session: {
					model: { provider: "mock", id: "m1" },
					thinkingLevel: "high",
					getLastAssistantText: () => "结论2",
					agent: { state: { messages: [{ role: "assistant", stopReason: "end_turn" }] } },
				},
			};

			cs.scheduleSubagentCompletionNotice(sa1);
			cs.scheduleSubagentCompletionNotice(sa2);

			expect(sendUserMessage).not.toHaveBeenCalled();

			await new Promise((r) => setTimeout(r, 450));

			expect(sendUserMessage).toHaveBeenCalledTimes(1);
			const deliveredText = sendUserMessage.mock.calls[0][0];
			expect(deliveredText).toContain("共有 2 个子代理已完成：");
			expect(deliveredText).toContain("sa-11111");
			expect(deliveredText).toContain("sa-22222");
			expect(sa1.subagentDoneNotified).toBe(true);
			expect(sa2.subagentDoneNotified).toBe(true);
		});

		it("已消费或已通知的子代理跳过通知", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: false,
				},
			};

			const cs: any = {
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
			};

			const sa1: any = {
				id: "sa-1",
				parentId: "parent-c1",
				subagentConsumedByParent: true,
			};
			cs.scheduleSubagentCompletionNotice(sa1);

			await new Promise((r) => setTimeout(r, 450));
			expect(sendUserMessage).not.toHaveBeenCalled();
		});

		it("父对话在流式输出中使用 { deliverAs: 'steer' } 投递", async () => {
			const sendUserMessage = vi.fn().mockResolvedValue(undefined);
			const parentConv: any = {
				id: "parent-c1",
				cwd: "/test",
				session: {
					sendUserMessage,
					isStreaming: true,
				},
			};

			const cs: any = {
				cwd: "/test",
				getLang: () => "zh",
				subagentOwnerOf: () => cs,
				convs: new Map([["parent-c1", parentConv]]),
				pendingSubagentNotices: new Map(),
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				scheduleSubagentCompletionNotice: (ClientSession.prototype as any).scheduleSubagentCompletionNotice,
				flushSubagentCompletionNotice: (ClientSession.prototype as any).flushSubagentCompletionNotice,
			};

			const sa: any = {
				id: "sa-steer",
				parentId: "parent-c1",
				session: {
					model: { provider: "mock", id: "m1" },
					getLastAssistantText: () => "ok",
					agent: { state: { messages: [] } },
				},
			};
			cs.scheduleSubagentCompletionNotice(sa);

			await new Promise((r) => setTimeout(r, 450));
			expect(sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "steer" });
		});
	});
});
