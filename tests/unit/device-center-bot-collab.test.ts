import { describe, expect, it, vi } from "vitest";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";

function fixture(boundBot?: string) {
	const request = vi.fn(async () =>
		Response.json({
			bots: [
				{ id: "local", deviceId: "device" },
				{ id: "remote", deviceId: "other" },
			],
		}),
	);
	const release = vi.fn();
	const workspaceResolver = vi.fn(async () => ({ root: process.cwd(), files: {} as any, release }));
	const service = createDeviceCollabService({
		getConfig: () => ({
			hubUrl: "https://hub.example/base/",
			deviceId: "device",
			credential: "secret",
			allowExecution: true,
		}),
		workspaceResolver,
		getSourceBot: () => boundBot,
		getParentTask: () => "trusted-parent",
		fetch: request as any,
	});
	return { service, request, release, workspaceResolver, context: { cwd: process.cwd(), sessionId: "session" } };
}

describe("Bot collaboration identity", () => {
	it("marks local Bot candidates without disclosing credentials", async () => {
		const f = fixture();
		const result = await f.service.execute("list_bots", {}, undefined, f.context);
		expect(result).toEqual({
			bots: [
				{ id: "local", deviceId: "device", local: true },
				{ id: "remote", deviceId: "other", local: false },
			],
		});
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(f.workspaceResolver).not.toHaveBeenCalled();
	});
	it("rejects an execution session impersonating a second Bot in the same directory", async () => {
		const f = fixture("local");
		await expect(
			f.service.execute(
				"send_task",
				{ roomId: "room", sourceBotId: "other-local", targetBotId: "remote", prompt: "run" },
				undefined,
				f.context,
			),
		).rejects.toThrow("request failed");
		expect(f.request).not.toHaveBeenCalled();
		expect(f.release).toHaveBeenCalledOnce();
	});
	it("binds task sender and target to Bots and uses the trusted parent", async () => {
		const f = fixture("local");
		await f.service.execute(
			"send_task",
			{ roomId: "room", sourceBotId: "local", targetBotId: "remote", prompt: "run", parentTaskId: "forged" },
			undefined,
			f.context,
		);
		const [url, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.pathname).toBe("/base/api/agent/rooms/room/messages");
		expect(JSON.parse(init.body as string)).toMatchObject({
			sourceBotId: "local",
			targetBotIds: ["remote"],
			parentTaskId: "trusted-parent",
		});
		expect(f.release).toHaveBeenCalledOnce();
	});
	it("validates a source Bot project before creating a room", async () => {
		const f = fixture();
		await f.service.execute(
			"create_room",
			{ name: "Team", sourceBotId: "local", targetBotId: "remote" },
			undefined,
			f.context,
		);
		expect(f.workspaceResolver).toHaveBeenCalledWith({
			roomId: "",
			sourceBotId: "local",
			context: f.context,
			signal: undefined,
		});
		const [, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({
			name: "Team",
			sourceBotId: "local",
			botIds: ["local", "remote"],
		});
		expect(f.release).toHaveBeenCalledOnce();
	});
});
