import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEVICE_COLLAB_ACTIONS,
	makeDeviceCollabTool,
	setDeviceCollabService,
	type DeviceCollabInput,
} from "../../server/device-center/collab-tool.js";
import { readOnlyToolCallAllowed, planModeDenial } from "../../server/plan-mode.js";
import { delegationDenial } from "../../server/delegate-mode.js";
import { evaluateSandboxJail } from "../../server/sandbox-service.js";

const context = (cwd = "/project", sessionId = "session-a") =>
	({ cwd, sessionManager: { getSessionId: () => sessionId } }) as any;
const invoke = (input: unknown, signal?: AbortSignal, ctx = context()) =>
	makeDeviceCollabTool().execute("call", input as DeviceCollabInput, signal, undefined, ctx);
afterEach(() => setDeviceCollabService(undefined));

describe("device_collab", () => {
	it("fails clearly without a bound service", async () => {
		await expect(invoke({ action: "list_bots" })).rejects.toThrow("not bound");
	});
	it.each([
		{ action: "list_bots" },
		{ action: "list_rooms" },
		{ action: "create_room", name: "Build", sourceBotId: "local", targetBotId: "d" },
		{ action: "send_message", roomId: "r", sourceBotId: "local", message: "hello" },
		{ action: "send_task", roomId: "r", sourceBotId: "local", targetBotId: "d", prompt: "Run checks" },
		{
			action: "send_task",
			roomId: "r",
			sourceBotId: "local",
			targetBotId: "d",
			prompt: "Run checks",
			parentTaskId: "parent",
		},
		{ action: "sync_files", roomId: "r", sourceBotId: "local", targetBotId: "d", paths: ["src/app.ts"] },
		{ action: "transfer_preview", roomId: "r", sourceBotId: "local", targetBotId: "d", transferId: "t" },
		{
			action: "transfer_apply",
			roomId: "r",
			sourceBotId: "local",
			targetBotId: "d",
			transferId: "t",
			revision: "v",
			overwritePaths: ["src/app.ts"],
		},
		{
			action: "transfer_apply",
			roomId: "r",
			sourceBotId: "local",
			targetBotId: "d",
			transferId: "t",
			revision: "v",
			overwritePaths: [],
		},
	])("routes $action with stable context and cancellation", async (input) => {
		const execute = vi.fn().mockResolvedValue({ status: "ok" });
		setDeviceCollabService({ execute });
		const controller = new AbortController();
		const { action, ...args } = input;
		await invoke(input, controller.signal);
		expect(execute).toHaveBeenCalledWith(action, args, controller.signal, { cwd: "/project", sessionId: "session-a" });
	});
	it.each([
		{ action: "list_bots", hubUrl: "https://evil.test" },
		{ action: "list_bots", token: "secret" },
		{ action: "list_bots", accountId: "other" },
		{ action: "list_bots", root: "/elsewhere" },
		{ action: "send_task", roomId: "r", prompt: "run" },
		{ action: "transfer_apply", transferId: "t" },
		{ action: "transfer_apply", roomId: "r", sourceBotId: "local", targetBotId: "d", transferId: "t", revision: "v" },
		{ action: "create_room", name: "Build" },
		{ action: "unknown" },
	])("rejects unsafe or incomplete input %#", async (input) => {
		const execute = vi.fn();
		setDeviceCollabService({ execute });
		await expect(invoke(input)).rejects.toThrow();
		expect(execute).not.toHaveBeenCalled();
	});
	it.each(["../secret", "/absolute", "C:/secret", "a\\b", "a/../b", "./a", "a//b", "a\u0000b", ""])(
		"rejects unsafe relative path %s",
		async (path) => {
			const execute = vi.fn();
			setDeviceCollabService({ execute });
			await expect(
				invoke({ action: "sync_files", roomId: "r", sourceBotId: "local", targetBotId: "d", paths: [path] }),
			).rejects.toThrow();
			await expect(
				invoke({
					action: "transfer_apply",
					roomId: "r",
					sourceBotId: "local",
					targetBotId: "d",
					transferId: "t",
					revision: "v",
					overwritePaths: [path],
				}),
			).rejects.toThrow();
			expect(execute).not.toHaveBeenCalled();
		},
	);
	it("captures context before awaits and binds the service once", async () => {
		let finish!: (value: unknown) => void;
		const execute = vi.fn().mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		setDeviceCollabService({ execute });
		const ctx = context();
		const pending = invoke({ action: "list_bots" }, undefined, ctx);
		ctx.cwd = "/other";
		setDeviceCollabService(undefined);
		finish({ count: 1 });
		await pending;
		expect(execute.mock.calls[0][3]).toEqual({ cwd: "/project", sessionId: "session-a" });
	});
	it("propagates cancellation before dispatch and after service completion", async () => {
		const controller = new AbortController();
		const execute = vi.fn().mockImplementation(async () => {
			controller.abort();
			return {};
		});
		setDeviceCollabService({ execute });
		await expect(invoke({ action: "list_bots" }, controller.signal)).rejects.toThrow();
		expect(execute).toHaveBeenCalledTimes(1);
		await expect(invoke({ action: "list_bots" }, controller.signal)).rejects.toThrow();
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("does not expose service secrets or raw errors", async () => {
		setDeviceCollabService({
			execute: async () => ({
				status: "ok",
				token: "SECRET",
				files: [{ path: "a", content: "SECRET", credentials: "SECRET" }],
			}),
		});
		const result = await invoke({ action: "list_bots" });
		expect(JSON.stringify(result)).not.toContain("SECRET");
		expect(result.details).toEqual({ action: "list_bots", summary: { status: "ok", files: [{ path: "a" }] } });
		setDeviceCollabService({
			execute: async () => {
				throw new Error("SECRET");
			},
		});
		await expect(invoke({ action: "list_bots" })).rejects.toThrow(/^Device collaboration request failed\.$/);
	});
	it("limits nested summaries to less than 64KB", async () => {
		setDeviceCollabService({
			execute: async () => ({
				bots: Array.from({ length: 2000 }, () => ({
					name: "x".repeat(5000),
					files: Array.from({ length: 80 }, () => ({ path: "x".repeat(5000) })),
				})),
			}),
		});
		const result = await invoke({ action: "list_bots" });
		expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(65536);
	});
	it.each(DEVICE_COLLAB_ACTIONS)("keeps %s behind existing write gates", (action) => {
		expect(readOnlyToolCallAllowed("device_collab", { action })).toBe(false);
		expect(planModeDenial("device_collab", { action })).toBeDefined();
		expect(delegationDenial("device_collab", { action })).toBeDefined();
		expect(
			evaluateSandboxJail({ path: "/project" } as any, "device_collab", { action }, "/project", { trustedTool: true }),
		).not.toBeNull();
	});
});
