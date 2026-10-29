import { describe, expect, it } from "vitest";
import { syncModelDraft } from "../../web/src/model-config-sync";

const a = { id: "a", name: "A" };
const b = { id: "b", name: "B" };
const c = { id: "c", name: "C" };

describe("model config live refresh", () => {
	it("immediately replaces a clean draft with the refreshed catalog", () => {
		expect(syncModelDraft([a], [a], [a, b])).toEqual([a, b]);
	});
	it("replaces the empty placeholder when models arrive", () => {
		const empty = { id: "", name: "" };
		expect(syncModelDraft([empty], [empty], [a])).toEqual([a]);
	});
	it("preserves local edits and deletions while adding discovered models", () => {
		const edited = { ...a, name: "Local name" };
		expect(syncModelDraft([edited], [a, b], [a, b, c])).toEqual([edited, c]);
	});
	it("updates untouched rows even when another row is edited", () => {
		const edited = { ...a, name: "Local name" };
		const updated = { ...b, name: "Remote name" };
		expect(syncModelDraft([edited, b], [a, b], [a, updated])).toEqual([edited, updated]);
	});
	it("does not duplicate locally added models after saving", () => {
		expect(syncModelDraft([a, b], [a], [a, b])).toEqual([a, b]);
	});
	it("removes remotely deleted untouched rows and preserves local additions", () => {
		expect(syncModelDraft([a, b, c], [a, b], [a])).toEqual([a, c]);
	});
});
