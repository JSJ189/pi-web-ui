import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installEvidenceToolHooks } from "../../server/evidence-tool-hooks.js";

const hash = "a".repeat(64);
const ref = `context-evidence:${hash}`;
const sessionFile = join("missing-session", "session.jsonl");
const resolved = join(`${sessionFile}.evidence`, `${hash}.txt`);

function context(args: Record<string, unknown> = { path: ref }, name = "read") {
	return { toolCall: { id: "call-1", name, arguments: { ...args } }, args };
}
function fixture() {
	const result = { block: false };
	const original = vi.fn(function (this: unknown, _context: unknown, _parent: unknown) {
		return result;
	});
	const session = {
		_beforeToolCall: original,
		sessionManager: { getSessionFile: vi.fn((): string | undefined => sessionFile) },
	};
	return { session, original, result };
}

describe("installEvidenceToolHooks", () => {
	it.each([{ path: ref }, { file_path: ref }, { path: ref, file_path: ref }])(
		"resolves aliases in place, preserving transcript: %j",
		(args) => {
			const { session, original, result } = fixture();
			const ctx = context(args);
			const history = { ...ctx.toolCall.arguments };
			expect(installEvidenceToolHooks(session)).toBe(true);
			expect(session._beforeToolCall(ctx, "parent")).toBe(result);
			expect(ctx.args).toBe(args);
			expect(ctx.args).toEqual({ path: resolved, file_path: resolved });
			expect(ctx.toolCall.arguments).toEqual(history);
			expect(original).toHaveBeenCalledWith(ctx, "parent");
			expect(original.mock.contexts[0]).toBe(session);
		},
	);

	it.each([
		{ path: "context-evidence:index" },
		{ file_path: "context-evidence:index" },
		{ path: "context-evidence:index", file_path: "context-evidence:index" },
	])("resolves index only to the current session evidence directory: %j", (args) => {
		const { session, original } = fixture();
		installEvidenceToolHooks(session);
		for (const currentFile of [sessionFile, join("another-session", "current.jsonl")]) {
			session.sessionManager.getSessionFile.mockReturnValue(currentFile);
			const input = { ...args };
			const ctx = context(input);
			session._beforeToolCall(ctx, "index-parent");
			expect(ctx.args).toBe(input);
			expect(ctx.args).toEqual({ path: `${currentFile}.evidence`, file_path: `${currentFile}.evidence` });
			expect(ctx.toolCall.arguments).toEqual(args);
			expect(original).toHaveBeenLastCalledWith(ctx, "index-parent");
		}
	});

	it("confirms the real SDK destructured-context method has arity two", () => {
		const method = (AgentSession.prototype as any)._beforeToolCall;
		expect(typeof method).toBe("function");
		expect(method.length).toBe(2);
	});

	it("installs once and preserves caller this and promise identity", () => {
		const { session, original } = fixture();
		const pending = Promise.resolve({ block: true });
		original.mockReturnValue(pending as any);
		expect(installEvidenceToolHooks(session)).toBe(true);
		const hook = session._beforeToolCall;
		expect(installEvidenceToolHooks(session)).toBe(true);
		expect(session._beforeToolCall).toBe(hook);
		const receiver = {};
		expect(hook.call(receiver, context(), undefined)).toBe(pending);
		expect(original.mock.contexts[0]).toBe(receiver);
	});

	it.each([
		null,
		{},
		{ _beforeToolCall: () => {} },
		{ _beforeToolCall: (_a: unknown) => {} },
		{ _beforeToolCall: (_a: unknown, _b: unknown, _c: unknown) => {} },
		{ _beforeToolCall: (_a: unknown, _b: unknown) => {} },
	])("rejects unsupported sessions: %j", (session) => {
		expect(installEvidenceToolHooks(session)).toBe(false);
	});

	it.each([
		{ path: "context-evidence:" },
		{ path: `context-evidence:${"A".repeat(64)}` },
		{ path: `${ref}/../other` },
		{ path: `${ref}\n` },
		{ path: "context-evidence:index/../other" },
		{ path: "context-evidence:index\n" },
		{ path: "context-evidence:index", file_path: "arbitrary-directory" },
		{ path: ref, file_path: "other.txt" },
		{ path: ref, file_path: `context-evidence:${"b".repeat(64)}` },
	])("rejects malformed or conflicting references before hooks: %j", (args) => {
		const { session, original } = fixture();
		installEvidenceToolHooks(session);
		const ctx = context(args);
		const before = { ...args };
		expect(() => session._beforeToolCall(ctx, undefined)).toThrow(/reference/);
		expect(ctx.args).toEqual(before);
		expect(original).not.toHaveBeenCalled();
	});

	it.each([ref, "context-evidence:index"])("requires persistence and leaves arguments intact: %s", (reference) => {
		const { session, original } = fixture();
		session.sessionManager.getSessionFile.mockReturnValue(undefined);
		installEvidenceToolHooks(session);
		const ctx = context({ path: reference });
		expect(() => session._beforeToolCall(ctx, undefined)).toThrow(/persisted/);
		expect(ctx.args).toEqual({ path: reference });
		expect(original).not.toHaveBeenCalled();
	});

	it("checks cancellation before resolving and after consulting session state", () => {
		for (const abortDuringLookup of [false, true]) {
			const { session, original } = fixture();
			const controller = new AbortController();
			const reason = new Error("cancelled");
			if (abortDuringLookup)
				session.sessionManager.getSessionFile.mockImplementation(() => {
					controller.abort(reason);
					return sessionFile;
				});
			else controller.abort(reason);
			installEvidenceToolHooks(session);
			const ctx = { ...context(), signal: controller.signal };
			expect(() => session._beforeToolCall(ctx, undefined)).toThrow(reason);
			expect(ctx.args).toEqual({ path: ref });
			expect(original).not.toHaveBeenCalled();
		}
	});

	it("refuses transcript aliases instead of mutating history", () => {
		const { session, original } = fixture();
		installEvidenceToolHooks(session);
		const ctx = context();
		ctx.args = ctx.toolCall.arguments;
		expect(() => session._beforeToolCall(ctx, undefined)).toThrow(/history/);
		expect(ctx.toolCall.arguments).toEqual({ path: ref });
		expect(original).not.toHaveBeenCalled();
	});

	it.each([context({ path: "ordinary.txt" }), context({ path: ref }, "write"), context({})])(
		"passes unrelated calls through unchanged: %j",
		(ctx) => {
			const { session, original, result } = fixture();
			const before = { ...ctx.args };
			installEvidenceToolHooks(session);
			expect(session._beforeToolCall(ctx, undefined)).toBe(result);
			expect(ctx.args).toEqual(before);
			expect(original).toHaveBeenCalledOnce();
			expect(session.sessionManager.getSessionFile).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ block: false, reference: ref, expected: resolved },
		{ block: true, reference: ref, expected: resolved },
		{ block: false, reference: "context-evidence:index", expected: `${sessionFile}.evidence` },
		{ block: true, reference: "context-evidence:index", expected: `${sessionFile}.evidence` },
	])("real SDK hook sees resolved input and retains permissions: %j", async ({ block, reference, expected }) => {
		const emitToolCall = vi.fn(async (_event: unknown) => ({ block, reason: "policy" }));
		const session = Object.create(AgentSession.prototype);
		session._extensionRunner = { hasHandlers: vi.fn(() => true), emitToolCall };
		session.sessionManager = { getSessionFile: () => sessionFile };
		expect(installEvidenceToolHooks(session)).toBe(true);
		const ctx = context({ path: reference });
		const execute = vi.fn(async (args: unknown) => args);
		const decision = await session._beforeToolCall(ctx, "parent-1");
		if (!decision?.block) await execute(ctx.args);
		expect(emitToolCall).toHaveBeenCalledWith({
			type: "tool_call",
			toolName: "read",
			toolCallId: "call-1",
			parentToolCallId: "parent-1",
			input: { path: expected, file_path: expected },
		});
		expect(emitToolCall.mock.calls[0][0]).toHaveProperty("input", ctx.args);
		expect(execute).toHaveBeenCalledTimes(block ? 0 : 1);
		if (!block) expect(execute).toHaveBeenCalledWith(ctx.args);
		expect(ctx.toolCall.arguments).toEqual({ path: reference });
	});

	it("preserves SDK permission hook errors", async () => {
		const session = Object.create(AgentSession.prototype);
		const error = new Error("permission denied");
		session._extensionRunner = {
			hasHandlers: () => true,
			emitToolCall: async () => {
				throw error;
			},
		};
		session.sessionManager = { getSessionFile: () => sessionFile };
		installEvidenceToolHooks(session);
		await expect(session._beforeToolCall(context(), undefined)).rejects.toBe(error);
	});
});
