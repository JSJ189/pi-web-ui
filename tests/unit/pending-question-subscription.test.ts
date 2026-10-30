import { describe, expect, it, vi } from "vitest";
import { PendingQuestion } from "../../server/pending-question.js";

describe("PendingQuestion settlement subscriptions", () => {
	it("survives legacy callback replacement during takeover and settles once", async () => {
		const pending = new PendingQuestion([], "stable", "parent", 0);
		const service = vi.fn();
		const oldHolder = vi.fn();
		const newHolder = vi.fn();
		pending.subscribeSettled(service);
		const unsubscribe = pending.subscribeSettled(oldHolder);
		unsubscribe();
		pending.onSettled = undefined;
		pending.subscribeSettled(newHolder);
		pending.resolve(null);
		pending.resolve([]);
		expect(service).toHaveBeenCalledOnce();
		expect(oldHolder).not.toHaveBeenCalled();
		expect(newHolder).toHaveBeenCalledOnce();
		await expect(pending.promise).resolves.toBeNull();
		const late = vi.fn();
		pending.subscribeSettled(late)();
		expect(late).toHaveBeenCalledOnce();
	});
	it("runs all cleanup if another owner throws", () => {
		const pending = new PendingQuestion([], "stable", "user", 0);
		const cleanup = vi.fn();
		pending.subscribeSettled(() => {
			throw new Error("bad holder");
		});
		pending.subscribeSettled(cleanup);
		expect(() => pending.resolve(null)).toThrow("bad holder");
		expect(cleanup).toHaveBeenCalledOnce();
		expect(pending.settled).toBe(true);
	});
});
