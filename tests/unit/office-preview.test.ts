import { describe, expect, it } from "vitest";
import { detectRemoteViewer, inspectionToText } from "../../plugins/office/client/preview.mjs";

describe("Office remote preview selection", () => {
	it("allows only a separate viewer origin on the same explicit loopback host", () => {
		expect(detectRemoteViewer("http://127.0.0.1:9999/?file=x", "http://127.0.0.1:8787/")).toBe(false);
		expect(detectRemoteViewer("http://localhost:9999/", "http://localhost:8787/")).toBe(false);
		expect(detectRemoteViewer("http://[::1]:9999/", "http://[::1]:8787/")).toBe(false);
	});

	it.each([
		["http://127.0.0.1:9999/", "https://office.example/"],
		["http://127.0.0.1:9999/", "http://192.168.1.9:8787/"],
		["http://127.0.0.1:9999/", "https://127.0.0.1:8787/"],
		["http://127.0.0.1:8787/", "http://127.0.0.1:8787/"],
		["http://localhost:9999/", "http://127.0.0.1:8787/"],
		["http://127.0.0.1.evil.test:9999/", "http://127.0.0.1:8787/"],
		["https://127.0.0.1:9999/", "http://127.0.0.1:8787/"],
		["http://user:secret@127.0.0.1:9999/", "http://127.0.0.1:8787/"],
		["javascript:alert(1)", "http://127.0.0.1:8787/"],
		["/plugins/office/viewer", "http://127.0.0.1:8787/"],
		["", "invalid"],
	])("uses read-only preview for %s on %s", (viewer, page) => {
		expect(detectRemoteViewer(viewer, page)).toBe(true);
	});
});

describe("Office inspection plain text", () => {
	it("extracts workbook metadata from the actual worker envelope", () => {
		expect(
			inspectionToText({
				result: {
					ok: true,
					value: {
						kind: "workbook",
						name: "Budget",
						worksheets: [{ name: "Costs", rowCount: 12, columnCount: 5, valueUsedRanges: ["A1:C5"] }],
					},
				},
			}),
		).toBe("Budget\nSheet 1: Costs\n12 rows × 5 columns\nRange: A1:C5");
	});

	it("keeps document content as text and omits arbitrary metadata", () => {
		const result = inspectionToText({
			kind: "document",
			title: "Report",
			paragraphs: [{ textPreview: "<img src=x onerror=alert(1)>" }, { text: "First\r\nSecond\u0000\u202e" }],
			html: "UNTRUSTED",
			raw: { secret: "OMIT" },
		});
		expect(result).toBe("Report\n<img src=x onerror=alert(1)>\nFirst\nSecond");
		expect(result).not.toContain("UNTRUSTED");
		expect(result).not.toContain("OMIT");
	});

	it("renders presentation previews and slide element text", () => {
		expect(
			inspectionToText({
				kind: "presentation",
				name: "Deck",
				slides: [{ name: "Intro", textPreview: "Welcome", elements: [{ text: "Hello" }, { text: { text: "World" } }] }],
			}),
		).toBe("Deck\nSlide 1: Intro\nWelcome\nHello\nWorld");
	});

	it("renders bounded display values without cell formulas or object coercion", () => {
		const output = inspectionToText({
			kind: "worksheet-range",
			ranges: [
				{
					worksheet: { name: "Data" },
					resolvedRange: "A1:C2",
					displayValues: [
						["One\tTwo\nThree", 2, false],
						[
							null,
							{
								toString() {
									throw new Error("no");
								},
							},
							"",
						],
					],
					cellData: [[{ f: "=SECRET()" }]],
				},
			],
		});
		expect(output).toContain("Data A1:C2\nOne Two Three\t2\tfalse");
		expect(output).not.toContain("SECRET");
	});

	it("caps output and array processing with a truncation notice", () => {
		const data = { kind: "document", paragraphs: Array.from({ length: 1000 }, () => ({ text: "x".repeat(1000) })) };
		const output = inspectionToText(data, { maxChars: 80, maxItems: 2 });
		expect(output.length).toBeLessThanOrEqual(80);
		expect(output).toContain("[Preview truncated]");
		for (const maxChars of [1, 5, 19, 20, 100]) {
			expect(inspectionToText(data, { maxChars }).length).toBeLessThanOrEqual(maxChars);
			expect(inspectionToText(null, { maxChars }).length).toBeLessThanOrEqual(maxChars);
		}
	});

	it("limits worksheet rows and columns", () => {
		const data = {
			kind: "worksheet-range",
			ranges: [
				{
					displayValues: [
						["a", "b"],
						["c", "d"],
					],
				},
			],
		};
		const output = inspectionToText(data, { maxRows: 1, maxColumns: 1 });
		expect(output).toContain("\na\n[Preview truncated]");
		expect(output).not.toContain("b");
	});

	it("fails closed for errors, unsupported structures, and malformed nested values", () => {
		for (const value of [
			null,
			[],
			{ ok: false, error: "SECRET" },
			{ result: { ok: false, error: "SECRET" } },
			{ kind: "unknown" },
		]) {
			expect(inspectionToText(value)).toMatch(/^Preview unavailable/);
		}
		expect(inspectionToText({ kind: "document", paragraphs: [null, [], { text: { html: "SECRET" } }] })).not.toContain(
			"SECRET",
		);
	});
});
