import { describe, expect, it, vi } from "vitest";
import { makeCommunicateTool } from "../../server/communicate-tool.js";

describe("communicate tool", () => {
	it("forwards structured requests and cancellation without binding a conversation holder", async () => {
		const communicate = vi.fn(async () => ({ requestId: "q", result: null }));
		const tool = makeCommunicateTool({ communicate });
		const signal = new AbortController().signal;
		const args = { to: "root", questions: [{ id: "q", question: "Choose?" }], timeoutSeconds: 0 };
		const result = await tool.execute("call", { action: "request", ...args }, signal, undefined, {} as any);
		expect(communicate).toHaveBeenCalledWith("request", args, signal);
		expect(result.details).toEqual({ requestId: "q", result: null });
	});
	it("keeps tool prose concise and exposes all four discriminated actions", () => {
		const tool = makeCommunicateTool({ communicate: vi.fn() });
		expect(tool.description.length).toBeLessThanOrEqual(600);
		expect(tool.promptSnippet!.length).toBeLessThanOrEqual(80);
		const schema = tool.parameters as any;
		expect(schema.anyOf.map((v: any) => v.properties.action.const)).toEqual([
			"read",
			"send",
			"request",
			"reply",
			"escalate",
		]);
		const request = schema.anyOf[2];
		expect(request.required).toContain("questions");
		expect(request.properties.timeoutSeconds.minimum).toBe(0);
		expect(schema.anyOf[4].required).toEqual(["action", "requestId"]);
	});
	it("bounds adapter results before adding wire details", async () => {
		const tool = makeCommunicateTool({
			communicate: vi.fn(async () => ({
				requestId: "q",
				result: [{ id: "x", selected: [], custom: "x".repeat(50000) }],
			})),
		});
		await expect(
			tool.execute("call", { action: "escalate", requestId: "q" }, undefined, undefined, {} as any),
		).rejects.toThrow("byte limit");
	});
});
