import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAttachmentUiMessages,
	formatUnavailableCanvasReference,
	scanAtMentions,
} from "../../server/universal/universal-attachments.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("canvas attachments in other engines", () => {
	it("preserves canvas identity and reports unavailable tooling without probing a file", () => {
		const exists = vi.spyOn(fs, "existsSync");
		const stat = vi.spyOn(fs, "statSync");
		const att = { mode: "canvas" as const, path: "build.png", name: 'Build "UI" & <test>' };
		const messages = createAttachmentUiMessages([att], 123);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			timestamp: 123,
			customType: "file",
			details: { mode: "canvas", path: att.path, name: att.name, title: att.name },
		});
		expect(messages[0].content).toEqual([{ type: "text", text: formatUnavailableCanvasReference(att) }]);
		expect(formatUnavailableCanvasReference(att)).toContain("Canvas tooling is unavailable");
		expect(formatUnavailableCanvasReference(att)).toContain("&quot;UI&quot; &amp; &lt;test&gt;");
		expect(exists).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
	});

	it.each(["Plan", "Plan with spaces", "Plan.v2+test"])(
		"skips the canvas display mention %s but still detects other files",
		(name) => {
			const cwd = fs.mkdtempSync(join(tmpdir(), "pi-canvas-mention-"));
			dirs.push(cwd);
			fs.writeFileSync(join(cwd, name), "secret");
			fs.writeFileSync(join(cwd, name.split(" ")[0]), "secret");
			fs.writeFileSync(join(cwd, "other.txt"), "other");
			const result = scanAtMentions(`@${name} @other.txt`, cwd, [], [{ mode: "canvas", path: "graph-1", name }]);
			expect(result.detectedAttachments).toEqual([{ path: "other.txt", name: "other.txt", mode: "reference" }]);
		},
	);
});
