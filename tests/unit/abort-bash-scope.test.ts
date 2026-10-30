import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";

// Exercise the real abortBash/bashKillsOf on a ClientSession prototype without
// starting a server or a model runtime (same construction trick as
// conversation-lifecycle-regressions.test.ts).
function client(): any {
	return Object.assign(Object.create(ClientSession.prototype), {
		activeId: "A",
		convs: new Map<string, unknown>(),
		bashKills: new Map<string, Set<AbortController>>(),
		settingsSvc: { current: {} },
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
	});
}

function conversation(id: string) {
	return {
		id,
		isSubagent: false,
		runtime: { session: { sendUserMessage: vi.fn().mockResolvedValue(undefined) } },
	};
}

describe("abortBash scoping", () => {
	it("stops only the named conversation's command", async () => {
		const session = client();
		const mine = new AbortController();
		const other = new AbortController();
		session.bashKillsOf("A").add(mine);
		session.bashKillsOf("B").add(other);
		session.convs.set("A", conversation("A"));
		session.convs.set("B", conversation("B"));

		await session.abortBash("A");

		expect(mine.signal.aborted).toBe(true);
		expect(other.signal.aborted).toBe(false);
	});

	it("falls back to the active conversation when no id is given", async () => {
		const session = client();
		const mine = new AbortController();
		const other = new AbortController();
		session.bashKillsOf("A").add(mine);
		session.bashKillsOf("B").add(other);
		await session.abortBash();
		expect(mine.signal.aborted).toBe(true);
		expect(other.signal.aborted).toBe(false);
	});

	it("stops the single running command elsewhere when the active conversation has none", async () => {
		// Subagent detail view: the card belongs to another conversation while
		// activeId still points at the parent. Exactly one command is live, so
		// stopping it is unambiguous — and it must never take a second one along.
		const session = client();
		const subagent = new AbortController();
		session.bashKillsOf("S").add(subagent);
		await session.abortBash();
		expect(subagent.signal.aborted).toBe(true);
	});

	it("stops nothing when several conversations have commands and none is named", async () => {
		const session = client();
		const first = new AbortController();
		const second = new AbortController();
		session.bashKillsOf("B").add(first);
		session.bashKillsOf("C").add(second);

		await session.abortBash();

		expect(first.signal.aborted).toBe(false);
		expect(second.signal.aborted).toBe(false);
		expect(session.emit).toHaveBeenCalledWith(expect.objectContaining({ text: "当前没有正在运行的 bash 命令" }));
	});

	it("sends the stop hint to the conversation that owned the command", async () => {
		const session = client();
		session.convs.set("A", conversation("A"));
		const other = conversation("B");
		session.convs.set("B", other);
		session.bashKillsOf("B").add(new AbortController());

		await session.abortBash("B");

		expect(other.runtime.session.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(session.convs.get("A").runtime.session.sendUserMessage).not.toHaveBeenCalled();
	});
});
