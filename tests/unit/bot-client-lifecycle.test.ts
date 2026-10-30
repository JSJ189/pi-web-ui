import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { AgentService } from "../../server/agent-service-daemon.js";
import { registerBotExecution, isBotExecutionRegistered } from "../../server/device-center/bot-execution.js";

function binding() {
	return registerBotExecution({
		id: "lifecycle-bot",
		revision: 1,
		enabled: true,
		cwd: resolve("bot-project"),
		tools: ["read"],
		skills: [],
		mcpServers: [],
	} as any);
}

function daemon(clientId: string) {
	const sink = vi.fn();
	const sinks = new Set([sink]);
	const cs = {
		detachSink: vi.fn((send) => sinks.delete(send)),
		sinkCount: () => sinks.size,
		dispose: vi.fn(async () => {}),
		refreshPluginTools: vi.fn(),
	};
	const service = Object.assign(Object.create(AgentService.prototype), {
		clients: new Map([[clientId, cs]]),
		pending: new Map(),
		offlineSince: new Map(),
		pokeExternalRunning: vi.fn(),
		armOfflineRowExpiry: vi.fn(),
	});
	return { service, cs, sink };
}

describe("Bot execution client lifetime", () => {
	it("retires a confirmed stopped Bot before later global tool broadcasts", () => {
		const task = binding();
		const { service, cs, sink } = daemon(task.clientId);
		task.release();
		service.detach(task.clientId, sink);
		expect(service.clients.has(task.clientId)).toBe(false);
		expect(cs.dispose).toHaveBeenCalledOnce();
		service.applyPluginAgentTools();
		expect(cs.refreshPluginTools).not.toHaveBeenCalled();
	});

	it("retains ownership when capability was revoked but stop is unconfirmed", () => {
		const task = binding();
		try {
			const { service, cs, sink } = daemon(task.clientId);
			task.capability.revoke();
			expect(isBotExecutionRegistered(task.clientId)).toBe(true);
			service.detach(task.clientId, sink);
			expect(service.clients.get(task.clientId)).toBe(cs);
			expect(cs.dispose).not.toHaveBeenCalled();
		} finally {
			task.release();
		}
	});

	it("keeps ordinary offline browser sessions available for takeover", () => {
		const { service, cs, sink } = daemon("ordinary-browser");
		service.detach("ordinary-browser", sink);
		expect(service.clients.get("ordinary-browser")).toBe(cs);
		expect(cs.dispose).not.toHaveBeenCalled();
		expect(service.armOfflineRowExpiry).toHaveBeenCalledWith("ordinary-browser", cs);
	});

	it("does not refresh a Bot's fixed tools after revocation, while refreshing ordinary sessions", () => {
		const task = binding();
		try {
			const applyToolGating = vi.fn(() => task.capability.assertActive());
			const cs = Object.assign(Object.create(ClientSession.prototype), {
				botExecution: task.capability,
				disposed: false,
				convs: new Map([["c1", { session: {}, agentPreset: "standard" }]]),
				applyToolGating,
			});
			task.capability.revoke();
			expect(() => cs.refreshPluginTools()).not.toThrow();
			expect(applyToolGating).not.toHaveBeenCalled();
			cs.botExecution = undefined;
			applyToolGating.mockImplementation(() => {});
			cs.refreshPluginTools();
			expect(applyToolGating).toHaveBeenCalledOnce();
			cs.disposed = true;
			cs.refreshPluginTools();
			expect(applyToolGating).toHaveBeenCalledOnce();
		} finally {
			task.release();
		}
	});
});
