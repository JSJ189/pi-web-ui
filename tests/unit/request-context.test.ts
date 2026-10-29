import { describe, expect, it } from "vitest";
import {
	deduplicateRequestContext,
	requestContextExtension,
	requestMessageBudget,
} from "../../server/request-context.js";

const text = "file content\n".repeat(500);
function pair(id: string, options: { tool?: string; path?: string; text?: string; isError?: boolean } = {}): any[] {
	const tool = options.tool ?? "read";
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: { path: options.path ?? "a.ts" } }] },
		{
			role: "toolResult",
			toolCallId: id,
			toolName: tool,
			isError: options.isError ?? false,
			content: [{ type: "text", text: options.text ?? text }],
		},
	];
}

describe("request context deduplication", () => {
	it("budgets fixed prompt, tool schemas and output for the current model", () => {
		const model = { contextWindow: 100000, maxTokens: 10000 };
		const empty = requestMessageBudget(model, "", []);
		expect(empty).toBeLessThan(60000);
		expect(requestMessageBudget(model, "x".repeat(3000), [])).toBe(empty - 1000);
		expect(requestMessageBudget(model, "", [{ schema: "x".repeat(3000) }])).toBeLessThan(empty - 1000);
		expect(requestMessageBudget({ contextWindow: 100, maxTokens: 100 }, "x".repeat(1000), [])).toBe(0);
	});
	it("keeps original evidence and call/result pairs without mutating persisted messages", () => {
		const messages = [...pair("a"), ...pair("b"), ...pair("c")];
		const before = structuredClone(messages);
		const result = deduplicateRequestContext(messages);
		expect(messages).toEqual(before);
		expect(result[1]).toBe(messages[1]);
		expect(result[2]).toBe(messages[2]);
		expect(result[3]).toMatchObject({
			toolCallId: "b",
			content: [{ type: "text", text: expect.stringContaining("tool call a") }],
		});
		expect(result[5]).toMatchObject({ content: [{ text: expect.stringContaining("tool call a") }] });
		expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(messages).length / 2);
	});

	it("preserves earlier request prefixes when new results arrive", () => {
		const messages = [...pair("a"), ...pair("b")];
		const first = deduplicateRequestContext(messages);
		const next = deduplicateRequestContext([...messages, ...pair("c")]);
		expect(next.slice(0, first.length)).toEqual(first);
	});

	it("recomputes references after compaction, without referring to absent evidence", () => {
		const messages = [...pair("b"), ...pair("c")];
		const result = deduplicateRequestContext(messages);
		expect(result[1]).toBe(messages[1]);
		expect(result[3]).toMatchObject({ content: [{ text: expect.stringContaining("tool call b") }] });
	});

	it.each([
		{ tool: "bash" },
		{ tool: "edit" },
		{ tool: "plugin_read" },
		{ path: "b.ts" },
		{ text: text + "changed" },
		{ isError: true },
		{ text: "small" },
	])("preserves nonidentical, small, error and untrusted tool results: %j", (options) => {
		const messages = [...pair("a"), ...pair("b", options)];
		expect(deduplicateRequestContext(messages)).toBe(messages);
	});

	it("does not deduplicate images, signed text, or orphan results", () => {
		for (const block of [
			{ type: "image", data: "abc", mimeType: "image/png" },
			{ type: "text", text, signature: "signed" },
		]) {
			const messages = [...pair("a"), ...pair("b")];
			messages[1].content.push(block);
			messages[3].content.push(block);
			expect(deduplicateRequestContext(messages)).toBe(messages);
		}
		const orphaned = [pair("a")[1], pair("b")[1]];
		expect(deduplicateRequestContext(orphaned)).toBe(orphaned);
	});

	it("keeps structured results and results that changed between reads", () => {
		const structured = [...pair("a"), ...pair("b")];
		structured[3].structuredContent = { value: 1 };
		expect(deduplicateRequestContext(structured)).toBe(structured);
		const changed = [...pair("a"), ...pair("b", { text: text + "updated" }), ...pair("c")];
		const result = deduplicateRequestContext(changed);
		expect(result[3]).toBe(changed[3]);
		expect(result[5]).toBe(changed[5]);
	});

	it.each(["edit", "write", "bash", "codemode", "plugin_read"])("starts new evidence after %s", (tool) => {
		const messages = [...pair("a"), ...pair("mutation", { tool }), ...pair("b"), ...pair("c")];
		const result = deduplicateRequestContext(messages);
		expect(result[5]).toBe(messages[5]);
		expect(result[7]).toMatchObject({ content: [{ text: expect.stringContaining("tool call b") }] });
	});

	it("starts new evidence after user intervention", () => {
		const messages = [...pair("a"), { role: "user", content: "I changed the file" }, ...pair("b"), ...pair("c")];
		const result = deduplicateRequestContext(messages as any);
		expect(result[4]).toBe(messages[4]);
		expect(result[6]).toMatchObject({ content: [{ text: expect.stringContaining("tool call b") }] });
	});

	it.each([{ isError: true }, { text: "small" }])("invalidates evidence after an ineligible result: %j", (options) => {
		const messages = [...pair("a"), ...pair("b", options), ...pair("c"), ...pair("d")];
		const result = deduplicateRequestContext(messages);
		expect(result[5]).toBe(messages[5]);
		expect(result[7]).toMatchObject({ content: [{ text: expect.stringContaining("tool call c") }] });
	});

	it("does not reuse evidence from mixed read/write batches", () => {
		const messages = [...pair("a")];
		const read = pair("b");
		read[0].content.push(pair("mutation", { tool: "edit" })[0].content[0]);
		messages.push(...read, pair("mutation", { tool: "edit" })[1], ...pair("c"));
		expect(deduplicateRequestContext(messages)).toBe(messages);
	});

	it("preserves full results when SDK adapters were not enabled and propagates cancellation", async () => {
		let handler: any;
		requestContextExtension({
			on: (_event: string, callback: any) => {
				handler = callback;
			},
		} as any);
		const messages = pair("a", { text: "x".repeat(30000) });
		const ctx = { cwd: "/workspace", sessionManager: { getSessionFile: () => "/session.jsonl" } };
		expect((await handler({ messages }, ctx)).messages).toBe(messages);
		const controller = new AbortController();
		controller.abort(new Error("stopped"));
		const cyclic = pair("a");
		cyclic[0].content[0].arguments.circular = cyclic[0].content[0].arguments;
		await expect(handler({ messages: cyclic }, { ...ctx, signal: controller.signal })).rejects.toThrow("stopped");
	});

	it("registers a request hook rather than changing session state", async () => {
		let handler: any;
		requestContextExtension({
			on: (event: string, callback: any) => {
				expect(event).toBe("context");
				handler = callback;
			},
		} as any);
		const messages = [...pair("a"), ...pair("b")];
		const ctx = { cwd: "/workspace", sessionManager: { getSessionFile: () => undefined } };
		expect((await handler({ messages }, ctx)).messages).toEqual(deduplicateRequestContext(messages));
		const cyclic = [...pair("a")];
		cyclic[0].content[0].arguments.circular = cyclic[0].content[0].arguments;
		expect((await handler({ messages: cyclic }, ctx)).messages).toBe(cyclic);
	});
});
