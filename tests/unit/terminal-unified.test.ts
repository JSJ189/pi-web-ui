import { describe, expect, it, vi } from "vitest";
import { makePersistentTerminalTools } from "../../server/terminals.js";

function setup() {
	const manager = {
		create: vi.fn(() => ({ id: "test" })),
		list: vi.fn(() => [{ id: "test" }]),
		has: vi.fn(() => true),
		kill: vi.fn(),
		noteAgentActivity: vi.fn(),
		inputChecked: vi.fn(() => null),
		read: vi.fn(() => ({
			data: "\u001b[31mfirst match\u001b[0m\nnoise\nlast match\n",
			cursor: 99,
			commandPending: false,
		})),
		waitForOutput: vi.fn(async () => undefined),
		isSentinelPending: vi.fn(() => true),
		endCursor: vi.fn(() => 10),
		waitForCompletion: vi.fn(async () => ({ finished: true, exitCode: 0 })),
	};
	const checkSafety = vi.fn(async (_command: string, _meta: unknown) => ({}));
	const tools = makePersistentTerminalTools(manager as any, "/workspace", () => "en", { checkSafety });
	const call = (params: any, signal?: AbortSignal) => tools[0].execute("call", params, signal, undefined, {} as any);
	return { manager, tools, call, checkSafety };
}

describe("unified terminal action tool", () => {
	it("registers exactly one tool with concise English prompts", () => {
		const { tools } = setup();
		expect(tools.map((tool) => tool.name)).toEqual(["terminal"]);
		expect(tools[0].description.length).toBeLessThanOrEqual(600);
		expect(tools[0].promptSnippet!.length).toBeLessThanOrEqual(80);
		expect(Object.keys((tools[0].parameters as any).properties)).toContain("action");
	});
	it.each([
		[{ action: "create" }, "terminalId"],
		[{ action: "close" }, "terminalId"],
		[{ action: "input", terminalId: "test" }, "data"],
		[{ action: "key", terminalId: "test" }, "key"],
		[{ action: "read" }, "terminalId"],
		[{ action: "wait" }, "terminalId"],
		[{ action: "unknown" }, "Unknown"],
		[{ action: "read", terminalId: "test", head: 1, tail: 1 }, "mutually exclusive"],
	])("rejects missing action-specific parameters before side effects: %j", async (params, error) => {
		const { call, manager } = setup();
		await expect(call(params)).rejects.toThrow(error);
		expect(manager.create).not.toHaveBeenCalled();
		expect(manager.inputChecked).not.toHaveBeenCalled();
		expect(manager.read).not.toHaveBeenCalled();
	});
	it("creates, lists and closes through the same entry", async () => {
		const { call, manager } = setup();
		await call({ action: "create", terminalId: "test", cols: 80, rows: 24 });
		expect(manager.create).toHaveBeenCalledWith("test", "/workspace", 80, 24, "/workspace", "test");
		await call({ action: "list" });
		expect(manager.list).toHaveBeenCalledTimes(1);
		await call({ action: "close", terminalId: "test" });
		expect(manager.kill).toHaveBeenCalledWith("test");
	});
	it("checks assembled input and Enter submissions with unified safety metadata", async () => {
		const { call, checkSafety } = setup();
		await call({ action: "input", terminalId: "test", data: "echo one\n" });
		expect(checkSafety).toHaveBeenLastCalledWith("echo one", {
			toolName: "terminal",
			action: "input",
			terminalId: "test",
			toolCallId: "call",
		});
		await call({ action: "input", terminalId: "test", data: "echo two" });
		await call({ action: "key", terminalId: "test", key: "Enter" });
		expect(checkSafety).toHaveBeenLastCalledWith("echo two", {
			toolName: "terminal",
			action: "key",
			terminalId: "test",
			toolCallId: "call",
		});
	});
	it.each([
		{ head: 1, data: "first match" },
		{ tail: 1, data: "last match" },
	])("filters lines while retaining the unfiltered cursor: %j", async ({ data, ...filter }) => {
		const { call, manager } = setup();
		const signal = new AbortController().signal;
		const res = await call(
			{ action: "read", terminalId: "test", cursor: 5, maxBytes: 400, waitMs: 20, search: "match", ...filter },
			signal,
		);
		expect(res.details).toMatchObject({ data, cursor: 99 });
		expect(manager.read).toHaveBeenCalledWith("test", 5, 400);
		expect(manager.waitForOutput).toHaveBeenCalledWith("test", 5, 20, signal);
	});
	it("waits with explicit cursor and cancellation signal and returns completion output", async () => {
		const { call, manager } = setup();
		const signal = new AbortController().signal;
		const res = await call({ action: "wait", terminalId: "test", cursor: 5, maxWaitMs: 1000 }, signal);
		expect(manager.waitForCompletion).toHaveBeenCalledWith("test", 1000, signal, 5);
		expect(res.details).toMatchObject({
			finished: true,
			exitCode: 0,
			outputTail: expect.stringContaining("first match"),
		});
	});
	it("directs untracked commands to read without waiting for a nonexistent marker", async () => {
		const { call, manager } = setup();
		manager.isSentinelPending.mockReturnValue(false);
		const res = await call({ action: "wait", terminalId: "test" });
		expect(res.details).toMatchObject({ applicable: false });
		expect(manager.waitForCompletion).not.toHaveBeenCalled();
	});
	it.each(["input", "key"])("cancels %s after safety approval without writing to the PTY", async (action) => {
		const { call, manager, checkSafety } = setup();
		const abort = new AbortController();
		if (action === "key") {
			await call({ action: "input", terminalId: "test", data: "echo pending" });
			manager.inputChecked.mockClear();
		}
		checkSafety.mockImplementation(async () => {
			abort.abort();
			return {};
		});
		await expect(
			call({ action, terminalId: "test", data: "echo test\n", key: "Enter" }, abort.signal),
		).rejects.toThrow();
		expect(manager.inputChecked).not.toHaveBeenCalled();
	});
	it("rejects cancelled operations before touching the PTY", async () => {
		const { call, manager } = setup();
		const abort = new AbortController();
		abort.abort();
		await expect(call({ action: "input", terminalId: "test", data: "echo\n" }, abort.signal)).rejects.toThrow();
		expect(manager.inputChecked).not.toHaveBeenCalled();
	});
});
