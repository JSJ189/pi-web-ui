import { describe, expect, it } from "vitest";
import {
	buildHunksFromEdits,
	computeWordDiff,
	detectLanguage,
	parseFileMutationArgs,
	parseUnifiedDiffText,
	unescapeJsonString,
} from "../../web/src/file-diff";

describe("file-diff parser & model", () => {
	it("detectLanguage handles common file extensions", () => {
		expect(detectLanguage("src/app.tsx")).toBe("tsx");
		expect(detectLanguage("src/server.ts")).toBe("typescript");
		expect(detectLanguage("main.py")).toBe("python");
		expect(detectLanguage("package.json")).toBe("json");
		expect(detectLanguage("unknown")).toBe("plaintext");
	});

	it("computeWordDiff produces tokenized word-level diffs", () => {
		const oldLine = "const timeout = 3000;";
		const newLine = "const timeout = 6000;";
		const res = computeWordDiff(oldLine, newLine);
		expect(res.oldTokens.some((t) => t.type === "del" && t.text === "3000")).toBe(true);
		expect(res.newTokens.some((t) => t.type === "add" && t.text === "6000")).toBe(true);
		expect(res.oldTokens.some((t) => t.type === "same" && t.text.includes("const"))).toBe(true);
	});

	it("parseUnifiedDiffText parses standard unified diff", () => {
		const diff = [
			"--- a/file.ts",
			"+++ b/file.ts",
			"@@ -10,3 +10,4 @@ header",
			" line1",
			"-line2_old",
			"+line2_new",
			" line3",
		].join("\n");

		const { hunks, stats } = parseUnifiedDiffText(diff);
		expect(hunks).toHaveLength(1);
		expect(stats.additions).toBe(1);
		expect(stats.deletions).toBe(1);
		expect(hunks[0].lines.some((l) => l.type === "del" && l.content === "line2_old")).toBe(true);
		expect(hunks[0].lines.some((l) => l.type === "add" && l.content === "line2_new")).toBe(true);
	});

	it("buildHunksFromEdits builds hunks from raw edits array", () => {
		const edits = [
			{
				oldText: "foo = 1;\nbar = 2;",
				newText: "foo = 10;\nbar = 20;",
			},
		];
		const { hunks, stats } = buildHunksFromEdits(edits);
		expect(hunks).toHaveLength(1);
		expect(stats.deletions).toBe(2);
		expect(stats.additions).toBe(2);
	});

	it("parseUnifiedDiffText parses SDK display-oriented diff without @@ header", () => {
		const sdkDiff = ["   40 function test() {", "-  41   return false;", "+  41   return true;", "   42 }"].join("\n");

		const { hunks, stats } = parseUnifiedDiffText(sdkDiff);
		expect(hunks).toHaveLength(1);
		expect(stats.additions).toBe(1);
		expect(stats.deletions).toBe(1);
		expect(hunks[0].lines.some((l) => l.type === "del" && l.content === "  return false;")).toBe(true);
		expect(hunks[0].lines.some((l) => l.type === "add" && l.content === "  return true;")).toBe(true);
	});

	it("parseFileMutationArgs parses edit with details.patch", () => {
		const argsText = JSON.stringify({ path: "src/utils.ts" });
		const details = {
			patch:
				"===================================================================\n--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1,2 +1,2 @@\n-hello\n+world",
		};
		const data = parseFileMutationArgs("edit", argsText, details);
		expect(data).not.toBeNull();
		expect(data?.filePath).toBe("src/utils.ts");
		expect(data?.isWrite).toBe(false);
		expect(data?.hunks).toHaveLength(1);
		expect(data?.stats.additions).toBe(1);
		expect(data?.stats.deletions).toBe(1);
	});

	it("parseFileMutationArgs parses edit with details.diff (SDK display format)", () => {
		const argsText = JSON.stringify({ path: "src/utils.ts" });
		const details = {
			diff: "   10 const a = 1;\n-  11 const b = 2;\n+  11 const b = 3;\n   12 const c = 4;",
		};
		const data = parseFileMutationArgs("edit", argsText, details);
		expect(data).not.toBeNull();
		expect(data?.filePath).toBe("src/utils.ts");
		expect(data?.hunks).toHaveLength(1);
		expect(data?.stats.additions).toBe(1);
		expect(data?.stats.deletions).toBe(1);
	});

	it("parseFileMutationArgs parses write with full arguments", () => {
		const content = "line1\nline2\nline3";
		const argsText = JSON.stringify({ path: "README.md", content });
		const data = parseFileMutationArgs("write", argsText);
		expect(data).not.toBeNull();
		expect(data?.filePath).toBe("README.md");
		expect(data?.isWrite).toBe(true);
		expect(data?.content).toBe(content);
		expect(data?.stats.totalLines).toBe(3);
		expect(data?.stats.additions).toBe(3);
	});

	it("unescapeJsonString unescapes newlines, tabs, and quotes safely", () => {
		const raw = 'line1\\n\\tline2\\nline3\\"quoted\\"';
		expect(unescapeJsonString(raw)).toBe('line1\n\tline2\nline3"quoted"');
	});

	it("parseFileMutationArgs handles write with escaped content and output path fallback", () => {
		const truncatedArgs =
			'{"content": "import React from \\"react\\";\\n\\tconst a = 1;\\n\\treturn <div />;\\n... [truncated]';
		const output = "Successfully wrote to web/src/components/FileChangeCard.tsx";
		const data = parseFileMutationArgs("write", truncatedArgs, undefined, output);
		expect(data).not.toBeNull();
		expect(data?.filePath).toBe("web/src/components/FileChangeCard.tsx");
		expect(data?.isWrite).toBe(true);
		expect(data?.content).toContain("\n\tconst a = 1;\n\treturn <div />;");
		expect(data?.stats.totalLines).toBeGreaterThanOrEqual(3);
	});
});
