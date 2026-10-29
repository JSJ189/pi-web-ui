import { describe, expect, it, vi } from "vitest";
import {
	appendCompactionInstructions,
	COMPACTION_RETENTION_INSTRUCTIONS,
	installCompactionInstructions,
} from "../../server/compaction-instructions.js";
import { buildCompactionInstructions } from "../../server/compact-context-tool.js";

function fixture(result: unknown = Promise.resolve({ summary: "checkpoint" })) {
	const calls = vi.fn();
	const session = {
		_runDefaultCompaction(
			this: unknown,
			prep: unknown,
			model: unknown,
			instructions: unknown,
			signal: unknown,
			reason: unknown,
			...rest: unknown[]
		) {
			calls(this, prep, model, instructions, signal, reason, ...rest);
			return result;
		},
	};
	return { session, calls, result };
}

describe("compaction retention instructions", () => {
	it("preserves the SDK format while requiring goals, constraints, evidence, changes, validation and next steps", () => {
		for (const category of [
			"default structured checkpoint format",
			"Goal:",
			"Constraints & Preferences:",
			"verified facts",
			"actual changes",
			"validation commands",
			"Next Steps:",
			"hypotheses",
			"unverified claims",
			"context-evidence:<sha256>",
			"earlier summaries",
			"candidate notes",
		]) {
			expect(COMPACTION_RETENTION_INSTRUCTIONS).toContain(category);
		}
	});

	it("appends verbatim, handles absent instructions and is idempotent", () => {
		expect(appendCompactionInstructions()).toBe(COMPACTION_RETENTION_INSTRUCTIONS);
		expect(appendCompactionInstructions("")).toBe(COMPACTION_RETENTION_INSTRUCTIONS);
		const input = "  Focus on this task.\ncontext-evidence:" + "a".repeat(64) + "\n";
		const once = appendCompactionInstructions(input);
		expect(once).toBe(`${input}\n\n${COMPACTION_RETENTION_INSTRUCTIONS}`);
		expect(appendCompactionInstructions(once)).toBe(once);
	});

	it("tool summaries retain caller notes and exact evidence refs with one shared policy", () => {
		const ref = `context-evidence:${"b".repeat(64)}`;
		const built = buildCompactionInstructions("  focus  ", `  unverified note ${ref}  `);
		expect(built).toContain(`focus\n\n[Key Points / Summary to Retain]\nunverified note ${ref}`);
		expect(appendCompactionInstructions(built)).toBe(built);
		expect(buildCompactionInstructions("  ", "  ")).toBe(COMPACTION_RETENTION_INSTRUCTIONS);
	});
});

describe("installCompactionInstructions", () => {
	it.each(["manual", "threshold", "overflow"])(
		"delegates %s with original receiver, arguments and promise",
		(reason) => {
			const { session, calls, result } = fixture();
			const prep = {},
				model = {},
				signal = new AbortController().signal;
			expect(installCompactionInstructions(session)).toBe(true);
			const instructions = reason === "manual" ? "caller focus" : undefined;
			expect(session._runDefaultCompaction(prep, model, instructions, signal, reason)).toBe(result);
			expect(calls).toHaveBeenCalledExactlyOnceWith(
				session,
				prep,
				model,
				appendCompactionInstructions(instructions),
				signal,
				reason,
			);
		},
	);

	it("is idempotent and avoids duplicating the tool's instructions", () => {
		const { session, calls } = fixture();
		expect(installCompactionInstructions(session)).toBe(true);
		const wrapped = session._runDefaultCompaction;
		expect(installCompactionInstructions(session)).toBe(true);
		expect(session._runDefaultCompaction).toBe(wrapped);
		const built = buildCompactionInstructions("focus", "notes");
		session._runDefaultCompaction({}, {}, built, undefined, "manual");
		expect(calls.mock.calls[0][3]).toBe(built);
	});

	it("wraps only the selected session without changing its prototype", () => {
		const { session: prototype, calls } = fixture();
		const original = prototype._runDefaultCompaction;
		const session = Object.create(prototype);
		expect(installCompactionInstructions(session)).toBe(true);
		expect(prototype._runDefaultCompaction).toBe(original);
		const receiver = {};
		session._runDefaultCompaction.call(receiver, 1, 2, undefined, 4, 5);
		expect(calls.mock.calls[0][0]).toBe(receiver);
	});

	it("preserves synchronous throws and rejected promises", async () => {
		const error = new Error("cancelled");
		const { session, calls } = fixture();
		calls.mockImplementation(() => {
			throw error;
		});
		installCompactionInstructions(session);
		expect(() => session._runDefaultCompaction(1, 2, undefined, 4, 5)).toThrow(error);
		calls.mockReset();
		const rejected = fixture(Promise.reject(error));
		installCompactionInstructions(rejected.session);
		await expect(rejected.session._runDefaultCompaction(1, 2, undefined, 4, 5)).rejects.toBe(error);
	});

	it("passes unexpected instruction types and future trailing arguments through", () => {
		const { session, calls } = fixture();
		installCompactionInstructions(session);
		const future = {};
		Reflect.apply(session._runDefaultCompaction, session, [1, 2, future, 4, 5, 6]);
		expect(calls).toHaveBeenCalledExactlyOnceWith(session, 1, 2, future, 4, 5, 6);
	});

	it("returns false for absent or incompatible methods without invoking accessors", () => {
		const getter = vi.fn(() => fixture().session._runDefaultCompaction);
		for (const session of [
			null,
			undefined,
			1,
			{},
			{ _runDefaultCompaction: "method" },
			{ _runDefaultCompaction() {} },
			Object.defineProperty({}, "_runDefaultCompaction", { get: getter }),
		]) {
			expect(installCompactionInstructions(session)).toBe(false);
		}
		expect(getter).not.toHaveBeenCalled();
	});

	it.each(["manual", "threshold", "overflow"])(
		"appends the host index after %s compaction and retains result fields",
		async (reason) => {
			const original = {
				summary: "SDK checkpoint\n## Next Steps\n1. Continue",
				tokensBefore: 123,
				details: { retained: true },
			};
			let resolveCompaction!: (result: typeof original) => void;
			const { session, calls } = fixture(
				new Promise<typeof original>((resolve) => {
					resolveCompaction = resolve;
				}),
			);
			const index = `Evidence directory (read for complete index): E:/sessions/chat.evidence\ncontext-evidence:${"c".repeat(64)}`;
			const getEvidenceIndex = vi.fn(async () => index);
			expect(installCompactionInstructions(session, { getEvidenceIndex })).toBe(true);
			const pending = session._runDefaultCompaction({}, {}, "focus", undefined, reason);
			expect(getEvidenceIndex).not.toHaveBeenCalled();
			resolveCompaction(original);
			const result = await pending;
			expect(result).toEqual({ ...original, summary: `${original.summary}\n\n${index}` });
			expect(original.summary).toBe("SDK checkpoint\n## Next Steps\n1. Continue");
			expect(getEvidenceIndex).toHaveBeenCalledTimes(1);
			expect(calls.mock.calls[0][3]).toBe(appendCompactionInstructions("focus"));
		},
	);

	it("retains the first callback on repeated installation and refreshes the index each time", async () => {
		const { session } = fixture();
		const getEvidenceIndex = vi.fn().mockResolvedValueOnce("index one").mockResolvedValueOnce("index two");
		const ignored = vi.fn(async () => "ignored");
		installCompactionInstructions(session, { getEvidenceIndex });
		const wrapped = session._runDefaultCompaction;
		installCompactionInstructions(session, { getEvidenceIndex: ignored });
		expect(session._runDefaultCompaction).toBe(wrapped);
		await expect(session._runDefaultCompaction(1, 2, undefined, 4, 5)).resolves.toEqual({
			summary: "checkpoint\n\nindex one",
		});
		await expect(session._runDefaultCompaction(1, 2, undefined, 4, 5)).resolves.toEqual({
			summary: "checkpoint\n\nindex two",
		});
		expect(ignored).not.toHaveBeenCalled();
	});

	it.each(["", "  \n "])("leaves the original result intact for an empty index %j", async (index) => {
		const original = { summary: "checkpoint" };
		const { session } = fixture(Promise.resolve(original));
		installCompactionInstructions(session, { getEvidenceIndex: async () => index });
		expect(await session._runDefaultCompaction(1, 2, undefined, 4, 5)).toBe(original);
	});

	it.each([undefined, null, {}, { summary: 123 }])(
		"does not invoke the callback for incompatible results %j",
		async (original) => {
			const { session } = fixture(Promise.resolve(original));
			const getEvidenceIndex = vi.fn(async () => "index");
			installCompactionInstructions(session, { getEvidenceIndex });
			expect(await session._runDefaultCompaction(1, 2, undefined, 4, 5)).toBe(original);
			expect(getEvidenceIndex).not.toHaveBeenCalled();
		},
	);

	it("propagates compaction failures without invoking the callback", async () => {
		const error = new Error("compaction failed");
		const { session } = fixture(Promise.reject(error));
		const getEvidenceIndex = vi.fn(async () => "index");
		installCompactionInstructions(session, { getEvidenceIndex });
		await expect(session._runDefaultCompaction(1, 2, undefined, 4, 5)).rejects.toBe(error);
		expect(getEvidenceIndex).not.toHaveBeenCalled();
	});

	it("rejects on index failure instead of silently losing the index", async () => {
		const error = new Error("index unavailable");
		const { session } = fixture();
		installCompactionInstructions(session, {
			getEvidenceIndex: async () => {
				throw error;
			},
		});
		await expect(session._runDefaultCompaction(1, 2, undefined, 4, 5)).rejects.toBe(error);
	});

	it("fails conservatively for non-writable sessions", () => {
		const { session } = fixture();
		const original = session._runDefaultCompaction;
		Object.freeze(session);
		expect(installCompactionInstructions(session)).toBe(false);
		expect(session._runDefaultCompaction).toBe(original);
	});
});
