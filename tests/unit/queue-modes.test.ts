import { describe, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { applyQueueModesToSession } from "../../server/queue-modes.js";

describe("pi queue delivery preferences", () => {
	it("selects every queued message in order in the real SDK and preserves pending messages when modes change", () => {
		const agent = new Agent({ streamFn: vi.fn() });
		const target = { agent, settingsManager: { applyOverrides: vi.fn() } };
		const messages = ["first", "correction", "final correction"].map((text) => ({
			role: "user" as const,
			content: text,
			timestamp: 1,
		}));
		for (const message of messages) agent.steer(message);
		applyQueueModesToSession(target, {});
		expect(agent.peekQueuedMessages()).toEqual(messages);
		applyQueueModesToSession(target, { steeringMode: "one-at-a-time" });
		expect(agent.peekQueuedMessages()).toEqual([messages[0]]);
		agent.clearAllQueues();
		for (const message of messages) agent.followUp(message);
		expect(agent.peekQueuedMessages()).toEqual(messages);
		applyQueueModesToSession(target, { followUpMode: "one-at-a-time" });
		expect(agent.peekQueuedMessages()).toEqual([messages[0]]);
		applyQueueModesToSession(target, {});
		expect(agent.peekQueuedMessages()).toEqual(messages);
	});
	function session() {
		return {
			settingsManager: { applyOverrides: vi.fn() },
			agent: {
				steeringMode: "one-at-a-time" as "all" | "one-at-a-time",
				followUpMode: "one-at-a-time" as "all" | "one-at-a-time",
			},
		};
	}

	it("defaults both live queues and the reload settings view to all", () => {
		const target = session();
		applyQueueModesToSession(target, {});
		expect(target.agent).toEqual({ steeringMode: "all", followUpMode: "all" });
		expect(target.settingsManager.applyOverrides).toHaveBeenCalledWith(target.agent);
	});

	it("changes each queue independently and reapplies preferences after reload", () => {
		const target = session();
		applyQueueModesToSession(target, { steeringMode: "one-at-a-time", followUpMode: "all" });
		expect(target.agent).toEqual({ steeringMode: "one-at-a-time", followUpMode: "all" });
		target.agent.followUpMode = "one-at-a-time";
		applyQueueModesToSession(target, { steeringMode: "all", followUpMode: "one-at-a-time" });
		expect(target.agent).toEqual({ steeringMode: "all", followUpMode: "one-at-a-time" });
	});
});
