/**
 * Live2D 看板娘心声 Marker 单元测试
 */
import { describe, expect, it } from "vitest";
import { registerMarker, unregisterMarker } from "../../server/markers/registry.js";
import { stripMarkers } from "../../server/markers/marker.js";
import live2dPlugin from "../../plugins/live2d/index.mjs";

describe("Live2D 看板娘心声 Inline Marker", () => {
	it("通过 host.registerMarker 注册并在反激活时清理", async () => {
		let registeredMarker: any = null;
		const broadcastMessages: any[] = [];

		const mockHost = {
			dir: "fake-dir",
			log: () => {},
			route: () => () => {},
			registerAgentTool: () => () => {},
			registerMarker: (markerDef: any) => {
				registeredMarker = markerDef;
				registerMarker(markerDef);
				return () => {
					unregisterMarker(markerDef.name);
				};
			},
			broadcast: (payload: any) => {
				broadcastMessages.push(payload);
			},
			onRunEvent: () => () => {},
			onSettingsChanged: () => () => {},
		};

		const deactivate = live2dPlugin.activate(mockHost as any);

		expect(registeredMarker).toBeDefined();
		expect(registeredMarker.name).toBe("live2d");
		expect(registeredMarker.label).toContain("Live2D");
		expect(registeredMarker.guidance.length).toBeGreaterThan(0);

		// 检查中英文 guidance
		const zhGuidance = registeredMarker.getGuidance("zh");
		const enGuidance = registeredMarker.getGuidance("en");
		expect(zhGuidance[0]).toContain("心声");
		expect(enGuidance[0]).toContain("inner voice");

		// 测试 stripMarkers 能够识别并剥离 [[live2d:thought:...]]
		const replyWithMarker = "主人好厉害！[[live2d:thought:写代码速度真快呀,emotion=happy]] 任务已经完成。";
		const stripped = stripMarkers(replyWithMarker);
		expect(stripped).toBe("主人好厉害！ 任务已经完成。");

		// 测试心声 apply
		const mockCtx = {
			conversationId: "c1",
			notify: () => {},
		};

		// 1) 基础心声
		const res1 = await registeredMarker.apply(
			{
				tool: "live2d",
				op: "thought",
				args: ["想吃草莓蛋糕了！"],
				kwargs: {},
				raw: "[[live2d:thought:想吃草莓蛋糕了！]]",
			},
			mockCtx,
			{},
			"zh",
		);
		expect(res1.applied).toBe(true);
		expect(broadcastMessages[broadcastMessages.length - 1]).toEqual({
			type: "live2d:action",
			action: "thought",
			text: "想吃草莓蛋糕了！",
			expression: undefined,
			duration: 5000,
			thought: true,
		});

		// 2) 携带表情与自定义时长的心声
		const res2 = await registeredMarker.apply(
			{
				tool: "live2d",
				op: "thought",
				args: ["今天真是元气满满呢~"],
				kwargs: { emotion: "wink", duration: "6000" },
				raw: "[[live2d:thought:今天真是元气满满呢~,emotion=wink,duration=6000]]",
			},
			mockCtx,
			{},
			"zh",
		);
		expect(res2.applied).toBe(true);
		expect(broadcastMessages[broadcastMessages.length - 1]).toEqual({
			type: "live2d:action",
			action: "thought",
			text: "今天真是元气满满呢~",
			expression: "wink",
			duration: 6000,
			thought: true,
		});

		// 3) heart/mind op 别名识别为心声
		const res3 = await registeredMarker.apply(
			{
				tool: "live2d",
				op: "heart",
				args: ["悄悄关注中..."],
				kwargs: {},
				raw: "[[live2d:heart:悄悄关注中...]]",
			},
			mockCtx,
			{},
			"zh",
		);
		expect(res3.applied).toBe(true);
		expect(broadcastMessages[broadcastMessages.length - 1].thought).toBe(true);
		expect(broadcastMessages[broadcastMessages.length - 1].action).toBe("thought");

		// 4) say op 别名识别为普通气泡
		const res4 = await registeredMarker.apply(
			{
				tool: "live2d",
				op: "say",
				args: ["大家好！"],
				kwargs: {},
				raw: "[[live2d:say:大家好！]]",
			},
			mockCtx,
			{},
			"zh",
		);
		expect(res4.applied).toBe(true);
		expect(broadcastMessages[broadcastMessages.length - 1].thought).toBe(false);
		expect(broadcastMessages[broadcastMessages.length - 1].action).toBe("bubble");

		// 5) 缺少内容时拒绝
		const res5 = await registeredMarker.apply(
			{
				tool: "live2d",
				op: "thought",
				args: [],
				kwargs: {},
				raw: "[[live2d:thought:]]",
			},
			mockCtx,
			{},
			"zh",
		);
		expect(res5.applied).toBe(false);
		expect(res5.error).toContain("缺少心声内容");

		// 反激活清理
		deactivate();
		expect(stripMarkers("测试 [[live2d:thought:abc]] 文本")).toBe("测试 [[live2d:thought:abc]] 文本");
	});
});
