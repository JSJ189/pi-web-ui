import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_TOOL_NAMES } from "../../server/conversation-tool-names.js";
import { planModeDenial, PLAN_MODE_BLOCKED_TOOL_NAMES, readOnlyToolCallAllowed } from "../../server/plan-mode.js";
import { delegationDenial, DELEGATE_MODE_BLOCKED_TOOL_NAMES } from "../../server/delegate-mode.js";
import { goalReviewDenial } from "../../server/goal-review-gate.js";
import {
	subagentAllowedToolCall,
	subagentAllowedToolVisible,
	subagentSecurityDenial,
} from "../../server/subagent-security-gate.js";
import {
	evaluateApprovalRules,
	matchApprovalRuleDetail,
	matchApprovalRuleDetails,
	type ApprovalRule,
} from "../../server/approval-rules.js";
import { evaluateSandboxJail } from "../../server/sandbox-service.js";
import { createSandboxRuntimeGate } from "../../server/sandbox-runtime-gate.js";
import type { SandboxInfo } from "../../server/protocol.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readonlyActions = ["get_result", "list", "templates", "read", "files", "status"];
const writeActions = ["spawn", "steer", "stop", "handoff", "wait_all", "dismiss", "unknown", ""];
describe.each(CONVERSATION_TOOL_NAMES)("%s security alias", (name) => {
	it("shares visibility and execution restrictions across every read-only gate", () => {
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has(name)).toBe(true);
		expect(DELEGATE_MODE_BLOCKED_TOOL_NAMES.includes(name)).toBe(true);
		for (const action of readonlyActions) {
			expect(readOnlyToolCallAllowed(name, { action })).toBe(true);
			expect(planModeDenial(name, { action })).toBeUndefined();
			expect(goalReviewDenial(name, { action })).toBeUndefined();
			for (const mode of ["readonly", "verify"] as const)
				expect(subagentSecurityDenial(mode, name, { action })).toBeUndefined();
			expect(delegationDenial(name, { action })).toBeUndefined();
		}
		for (const action of writeActions) {
			expect(readOnlyToolCallAllowed(name, { action })).toBe(false);
			expect(planModeDenial(name, { action })?.kind).toBe("bypass-tool");
			expect(goalReviewDenial(name, { action })).toBeDefined();
			expect(delegationDenial(name, { action })).toBeDefined();
			for (const mode of ["readonly", "verify"] as const)
				expect(subagentSecurityDenial(mode, name, { action })?.kind).toBe("dispatch-tool");
		}
	});

	it.each(CONVERSATION_TOOL_NAMES)("accepts %s in an explicit allowlist without bypassing the mode gate", (alias) => {
		const allowed = new Set([alias]);
		expect(subagentAllowedToolVisible(allowed, name)).toBe(true);
		expect(subagentAllowedToolCall(allowed, name, { action: "spawn" })).toBe(true);
		expect(subagentSecurityDenial("normal", name, { action: "spawn" }, allowed)).toBeUndefined();
		expect(subagentSecurityDenial("readonly", name, { action: "spawn" }, allowed)?.kind).toBe("dispatch-tool");
		expect(subagentAllowedToolVisible(new Set(["read"]), name)).toBe(false);
		expect(subagentSecurityDenial("normal", name, {}, new Set(["read"]))?.kind).toBe("not-allowed-tool");
	});

	it.each(CONVERSATION_TOOL_NAMES)(
		"matches approval rules named %s including regex hit details and rule order",
		(alias) => {
			const rule: ApprovalRule = {
				id: "alias",
				enabled: true,
				tools: [alias],
				field: "params",
				match: "regex",
				value: "spawn",
				action: "ask",
				label: "dispatch",
			};
			const params = { action: "spawn", prompt: "spawn" };
			expect(matchApprovalRuleDetail(rule, name, params, "/project")).not.toBeNull();
			expect(matchApprovalRuleDetails(rule, name, params, "/project")).toHaveLength(2);
			for (const action of ["ask", "deny", "allow"] as const)
				expect(evaluateApprovalRules([{ ...rule, action }], name, params, "/project").action).toBe(action);
			expect(
				evaluateApprovalRules(
					[
						{ ...rule, action: "allow" },
						{ ...rule, id: "deny", tools: [name], action: "deny" },
					],
					name,
					params,
					"/project",
				).action,
			).toBe("allow");
			expect(matchApprovalRuleDetail({ ...rule, tools: ["conversation_read"] }, name, params, "/project")).toBeNull();
		},
	);

	it("requires trusted origin and inherited identity in the sandbox policy, and stays blocked by the final runtime gate", () => {
		const cwd = mkdtempSync(join(tmpdir(), "conversation-alias-"));
		dirs.push(cwd);
		const sandbox = { path: cwd } as SandboxInfo;
		const params = { action: "spawn" };
		expect(
			evaluateSandboxJail(sandbox, name, params, cwd, { trustedTool: true, inheritedSandboxSubagent: true }),
		).toBeNull();
		expect(evaluateSandboxJail(sandbox, name, params, cwd, { trustedTool: true })).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, name, params, cwd, { inheritedSandboxSubagent: true })).not.toBeNull();
		const definition = { name, execute: () => undefined };
		const gate = createSandboxRuntimeGate(() => sandbox, cwd);
		gate.seal({ getToolDefinition: () => definition }, [definition]);
		expect(gate.check({ toolName: name, input: params })?.block).toBe(true);
	});
});
