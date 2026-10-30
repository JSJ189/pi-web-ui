import { describe, expect, it } from "vitest";
import {
	groupConversationState,
	groupDeviceHits,
	groupMessageTargets,
	groupSendAttempt,
} from "../../web/src/device-group-messages";
const devices = [
	{ id: "a", name: "Twin" },
	{ id: "b", name: "Twin" },
];
describe("group conversation adapter", () => {
	it("uses stable ids for duplicate device names and never dispatches plain chat", () => {
		expect(groupDeviceHits(devices, "Twin").map((h) => h.text)).toEqual(["@Twin(a)", "@Twin(b)"]);
		expect(groupMessageTargets("hello @Twin", devices)).toEqual([]);
		expect(groupMessageTargets("@Twin(b) @Twin(b)", devices)).toEqual(["b"]);
		expect(groupMessageTargets("@Twin(outsider)", devices)).toEqual([]);
	});
	it("renders task reports as real assistant markdown and retains sender/status labels", () => {
		const { state, labels } = groupConversationState(
			"room",
			{
				room: { id: "room", name: "Room", botIds: ["a"] },
				bots: devices,
				messages: [{ id: "m", text: "hi", createdAt: 1, sender: { name: "Human" } }],
				tasks: [
					{
						id: "t",
						deviceId: "host",
						botId: "a",
						text: "work",
						createdAt: 2,
						status: "completed",
						report: "**done**",
					},
					{ id: "q", deviceId: "host", botId: "b", text: "next", createdAt: 3, status: "queued" },
				],
			},
			devices,
		);
		expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
		expect(state.messages[1].content).toEqual([{ type: "text", text: "**done**" }]);
		expect(labels.get("group-message:m")).toBe("Human");
		expect(labels.get("group-task:q")).toBe("Twin · Queued");
		expect(state.messages[2].content).toEqual([{ type: "text", text: "Queued\n\nnext" }]);
		expect(groupConversationState("other", null, devices).state.messages).toEqual([]);
	});
	it("retries the same request with the same key and rotates for changed room/body/targets", () => {
		let n = 0;
		const key = () => String(++n);
		const first = groupSendAttempt(null, "r", "hello", ["b", "a"], key);
		expect(groupSendAttempt(first, "r", "hello", ["a", "b"], key)).toBe(first);
		expect(groupSendAttempt(first, "other", "hello", ["a", "b"], key).key).not.toBe(first.key);
		expect(groupSendAttempt(first, "r", "changed", ["a", "b"], key).key).not.toBe(first.key);
		expect(groupSendAttempt(first, "r", "hello", [], key).key).not.toBe(first.key);
	});
});
