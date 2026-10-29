import { describe, expect, it, vi } from "vitest";
import {
	appPath,
	decodeBytes,
	encodeInput,
	expandSnippet,
	findBuffer,
	readSessions,
	saveSessions,
	matchesHost,
	importableHosts,
} from "../../plugins/remote-workbench/client/lib/workbench-state.mjs";

import { createInputQueue } from "../../plugins/remote-workbench/client/lib/input-queue.mjs";

describe("remote workbench browser behavior helpers", () => {
	it("chunks UTF8 at 16KiB, waits for acceptance and drain without duplicate writes", () => {
		const send = vi.fn(),
			error = vi.fn();
		const queue = createInputQueue(send, error);
		const text = "中文".repeat(4000);
		expect(queue.enqueue(text)).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		const [id, b64] = send.mock.calls[0];
		expect(decodeBytes(b64)).toHaveLength(16384);
		queue.reply({ reqId: id, ok: true, accepted: true, writable: false });
		expect(send).toHaveBeenCalledTimes(1);
		queue.drain();
		expect(send).toHaveBeenCalledTimes(2);
		const [id2, b642] = send.mock.calls[1];
		queue.reply({ reqId: id2, ok: true, accepted: true, writable: true });
		expect(new TextDecoder().decode(Uint8Array.from([...decodeBytes(b64), ...decodeBytes(b642)]))).toBe(text);
		expect(queue.bytes).toBe(0);
		expect(queue.enqueue("x".repeat(65537))).toBe(false);
		expect(error).toHaveBeenCalledOnce();
	});
	it("keeps rejected input for drain retry and isolates simultaneous terminal queues", () => {
		const send = vi.fn();
		const a = createInputQueue(send, vi.fn()),
			b = createInputQueue(send, vi.fn());
		a.enqueue("a");
		b.enqueue("b");
		expect(send.mock.calls[0][0]).not.toBe(send.mock.calls[1][0]);
		const id = send.mock.calls[0][0];
		a.reply({ reqId: id, ok: false });
		expect(a.bytes).toBe(1);
		a.drain();
		expect(send.mock.calls[2][1]).toBe(encodeInput("a"));
		a.dispose();
		expect(a.enqueue("new")).toBe(false);
	});
	it("uses host URL resolver and preserves reverse proxy prefix", () => {
		const appUrl = vi.fn((p) => `/proxy${p}`);
		expect(appPath({ appUrl }, "/plugins-api/test")).toBe("/proxy/plugins-api/test");
		expect(appUrl).toHaveBeenCalledOnce();
		expect(appPath({}, "/plugins-api/test", "https://host/pi/plugins/remote-workbench/client/entry.mjs")).toBe(
			"/pi/plugins-api/test",
		);
	});
	it("keeps split UTF8 output as bytes until the streaming decoder consumes it", () => {
		const bytes = decodeBytes(encodeInput("中文🙂"));
		const decoder = new TextDecoder();
		expect(decoder.decode(bytes.slice(0, 2), { stream: true }) + decoder.decode(bytes.slice(2))).toBe("中文🙂");
	});
	it("quotes shell parameters including apostrophes without executing user input", () => {
		expect(expandSnippet("tail {{path}}", { path: "a'; rm -rf /" })).toBe("tail 'a'\\''; rm -rf /'");
		expect(() => expandSnippet("echo {{missing}}", {})).toThrow("missing");
	});
	it("locates next, previous and wrapped terminal matches", () => {
		const lines = ["hello", "中文 target", "last target"];
		const term = {
			buffer: { active: { length: lines.length, getLine: (i: number) => ({ translateToString: () => lines[i] }) } },
			scrollToLine: vi.fn(),
			select: vi.fn(),
		};
		expect(findBuffer(term, "target")).toBe(1);
		expect(findBuffer(term, "target", 1)).toBe(2);
		expect(findBuffer(term, "target", 1, true)).toBe(2);
		expect(term.select).toHaveBeenCalledWith(5, 2, 6);
		expect(findBuffer(term, "absent")).toBe(-1);
	});
	it("persists only recovery metadata, drops closed sessions and tolerates unavailable storage", () => {
		let value = "";
		const storage = {
			getItem: () => value,
			setItem: (_key: string, text: string) => {
				value = text;
			},
		};
		saveSessions(storage, "key", [
			{ host: "host", resumeToken: "token", credential: "secret" },
			{ host: "closed", resumeToken: "old", closed: true },
		]);
		expect(readSessions(storage, "key")).toEqual([{ host: "host", resumeToken: "token" }]);
		expect(value).not.toContain("secret");
		value = "bad json";
		expect(readSessions(storage, "key")).toEqual([]);
		expect(() =>
			saveSessions(
				{
					setItem() {
						throw new Error("blocked");
					},
				},
				"key",
				[],
			),
		).not.toThrow();
	});
	it("filters group/environment and blocks unsupported SSH imports", () => {
		const host = { name: "db", group: "ops", environment: "production" };
		expect(matchesHost(host, "PROD", "ops", "production")).toBe(true);
		expect(matchesHost(host, "", "dev")).toBe(false);
		expect(
			importableHosts([{ alias: "jump", importable: false }, { alias: "ok" }, { alias: "old", imported: true }]),
		).toEqual([{ alias: "ok" }]);
	});
});
