import { describe, expect, it } from "vitest";
import { normalizePluginChatAttachments } from "../../server/plugin-chat-attachments.js";

describe("external channel attachment admission", () => {
	it("preserves actual image bytes and file references without injecting arbitrary fields", () => {
		expect(
			normalizePluginChatAttachments([
				{ path: "ignored", imageData: "aGVsbG8=", mimeType: "image/png", name: "photo.png", mode: "page" },
			]),
		).toEqual([{ path: "", imageData: "aGVsbG8=", mimeType: "image/png", name: "photo.png", size: 5 }]);
		expect(normalizePluginChatAttachments([{ path: "/tmp/audio.ogg", mode: "reference", secret: "no" }])).toEqual([
			{ path: "/tmp/audio.ogg", mode: "reference", name: undefined, mimeType: undefined },
		]);
	});
	it("supports uploaded audio bytes for the existing persistent upload pipeline", () => {
		expect(
			normalizePluginChatAttachments([{ path: "", fileData: "YQ==", mimeType: "audio/ogg", name: "voice.ogg" }])?.[0],
		).toMatchObject({ fileData: "YQ==", size: 1 });
	});
	it.each([
		null,
		{},
		Array(9).fill({ path: "/tmp/a" }),
		[{ path: "", imageData: "aGVsbG8=", mimeType: "image/svg+xml" }],
		[{ path: "", imageData: "%%%", mimeType: "image/png" }],
		[{ path: "", fileData: "YQ==", imageData: "YQ==" }],
		[{ path: "https://example.org", mode: "page" }],
		[{ path: "a\0b" }],
	])("rejects invalid or unsafe attachments: %j", (input) => {
		expect(() => normalizePluginChatAttachments(input)).toThrow(/chat:/);
	});
	it("rejects individual and aggregate byte overflow instead of truncating", () => {
		const large = Buffer.alloc(10 * 1024 * 1024).toString("base64");
		expect(() =>
			normalizePluginChatAttachments([{ path: "", fileData: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }]),
		).toThrow();
		expect(() =>
			normalizePluginChatAttachments([
				{ path: "", fileData: large },
				{ path: "", fileData: large },
				{ path: "", fileData: "YQ==" },
			]),
		).toThrow(/budget/);
	});
});
