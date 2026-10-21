import { describe, expect, it } from "vitest";
import { mergeEarlierPage } from "../../web/src/history-window.js";
import type { UiMessage, UiState } from "../../web/src/types.js";

const m = (id: string): UiMessage => ({ id, role: "user", content: [] }) as UiMessage;

function ui(ids: string[], historyStart: number, historyTotal: number): UiState {
	return { conversationId: "c1", messages: ids.map(m), historyStart, historyTotal } as unknown as UiState;
}

describe("mergeEarlierPage", () => {
	it("接得上就前插，并推进窗口起点", () => {
		const merged = mergeEarlierPage(ui(["m10", "m11"], 10, 12), {
			messages: [m("m8"), m("m9")],
			historyStart: 8,
			historyTotal: 12,
		});
		expect(merged?.messages.map((x) => x.id)).toEqual(["m8", "m9", "m10", "m11"]);
		expect(merged?.historyStart).toBe(8);
		expect(merged?.historyTotal).toBe(12);
	});

	it("接缝对不上（错位）就丢弃整页", () => {
		const merged = mergeEarlierPage(ui(["m10", "m11"], 10, 12), {
			messages: [m("m5"), m("m6")],
			historyStart: 5,
			historyTotal: 12,
		});
		expect(merged).toBeNull();
	});

	it("总数变了（期间被压缩/改写）也丢弃", () => {
		const merged = mergeEarlierPage(ui(["m10", "m11"], 10, 12), {
			messages: [m("m8"), m("m9")],
			historyStart: 8,
			historyTotal: 99,
		});
		expect(merged).toBeNull();
	});

	it("空页 = 已到最早：对齐计数，即使起点没变也返回（用于收起加载态）", () => {
		expect(mergeEarlierPage(ui(["m4"], 0, 5), { messages: [], historyStart: 0, historyTotal: 5 })).toBeNull();
		const aligned = mergeEarlierPage(ui(["m4"], 3, 5), { messages: [], historyStart: 0, historyTotal: 5 });
		expect(aligned?.historyStart).toBe(0);
	});

	it("老服务端（无窗口字段）视为起点 0，不接受任何更早页", () => {
		const legacy = { conversationId: "c1", messages: [m("a")] } as unknown as UiState;
		expect(mergeEarlierPage(legacy, { messages: [m("x")], historyStart: 0, historyTotal: 2 })).toBeNull();
	});
});
