import { describe, expect, it } from "vitest";
import { PlanManager } from "../../server/plan-manager.js";
import type { PlanStep } from "../../server/protocol.js";

describe("结构化任务计划状态机与看板管理 (PlanManager / Plan Mode)", () => {
	it("初始状态为空", () => {
		const pm = new PlanManager();
		expect(pm.getPlan("conv-1")).toBeNull();
		expect(pm.describePlan("conv-1")).toBe("No active plan.");
	});

	it("设置和规范化计划步骤", () => {
		const pm = new PlanManager();
		const steps: PlanStep[] = [
			{ id: "1", title: "需求调研与设计", status: "done", description: "完成 API 设计" },
			{ id: "2", title: "编写核心模块代码", status: "in_progress" },
			{ id: "3", title: "运行单元测试", status: "pending" },
		];

		const plan = pm.setPlan("conv-1", steps);
		expect(plan).toBeTruthy();
		expect(plan.steps.length).toBe(3);
		// 自动识别 in_progress 步骤为 activeStepId
		expect(plan.activeStepId).toBe("2");
		expect(plan.steps[0].status).toBe("done");
		expect(plan.steps[1].status).toBe("in_progress");
		expect(plan.steps[2].status).toBe("pending");
	});

	it("增量更新步骤状态并自动推进 activeStepId", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [
			{ id: "step-1", title: "步骤一", status: "in_progress" },
			{ id: "step-2", title: "步骤二", status: "pending" },
		]);

		// 步骤一完成
		const updated = pm.updateStep("conv-1", "step-1", { status: "done" });
		expect(updated).toBeTruthy();
		expect(updated?.steps[0].status).toBe("done");
		// 完成后自动推进到下一个 pending 步骤
		expect(updated?.activeStepId).toBe("step-2");

		// 将步骤二设为进行中
		const updated2 = pm.updateStep("conv-1", "step-2", { status: "in_progress" });
		expect(updated2?.activeStepId).toBe("step-2");
	});

	it("格式化计划文本供模型上下文使用", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [
			{ id: "1", title: "第一步", status: "done" },
			{ id: "2", title: "第二步", status: "in_progress", description: "正在进行中..." },
		]);

		const text = pm.describePlan("conv-1");
		expect(text).toContain("Plan Progress: 1/2 completed");
		expect(text).toContain("[x] 1. 第一步");
		expect(text).toContain("[>] 2. 第二步 (current)");
		expect(text).toContain("正在进行中...");
	});

	it("清空计划", () => {
		const pm = new PlanManager();
		pm.setPlan("conv-1", [{ id: "1", title: "第一步", status: "pending" }]);
		expect(pm.getPlan("conv-1")).not.toBeNull();

		pm.clearPlan("conv-1");
		expect(pm.getPlan("conv-1")).toBeNull();
	});
});
