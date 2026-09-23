/**
 * Office 文档纯文本提取（docx / xlsx / xlsm，csv 由调用方按普通文本处理）。
 *
 * 给「随处可看」用的：文件预览（files-service readFile）、附件等走 file_content
 * 下发 Markdown 文本，前端 FilePreview 按 Markdown 渲染表格/段落，无需改协议。
 *
 * 零依赖：docx / xlsx 本质是 zip 包，这里用 node:zlib + 手写 zip 中央目录解析
 * 做最小解包（只支持 stored / deflate，Office 写出的文件都是这两种）。
 *
 * 注意：plugins/office-preview/index.mjs 里有一份同逻辑的 JS 拷贝（插件必须
 * 自包含、不能 import 服务端 TS，见架构文档插件章）。两边改解析时请同步另一份。
 */
import { inflateRawSync } from "node:zlib";

const OFFICE_EXTS = new Set([".docx", ".xlsx", ".xlsm"]);

/** 单个文件上限（与 office-preview 插件一致）。 */
export const OFFICE_MAX_FILE_BYTES = 15 * 1024 * 1024;
/** 解包后总量上限（防 zip 炸弹：小包解出巨量内容）。 */
export const OFFICE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/** 下发文本上限（字符；超出截断并置 truncated）。 */
export const OFFICE_MAX_TEXT_CHARS = 200_000;
/** 表格上限：每表行数 × 列数（预览首屏口径）。 */
const MAX_ROWS = 500;
const MAX_COLS = 20;

export function isOfficeFile(name: string): boolean {
	const dot = String(name ?? "")
		.toLowerCase()
		.lastIndexOf(".");
	const ext = dot > 0 ? String(name).toLowerCase().slice(dot) : "";
	return OFFICE_EXTS.has(ext);
}

function findEocd(buf: Buffer): number {
	const sig = 0x06054b50;
	const minLen = 22;
	if (buf.length < minLen) throw new Error("不是有效的 zip 文件（太小）");
	const start = Math.max(0, buf.length - 65536 - minLen);
	for (let i = buf.length - minLen; i >= start; i--) {
		if (buf.readUInt32LE(i) === sig) return i;
	}
	throw new Error("不是有效的 zip 文件（找不到 EOCD）");
}

/** 返回 Map<文件名, Buffer>（只解要的文件，其余跳过）。 */
export function unzipFiles(buf: Buffer, wanted: string[]): Map<string, Buffer> {
	const want = new Set(wanted);
	const eocd = findEocd(buf);
	const cdCount = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	const files = new Map<
		string,
		{ method: number; compSize: number; flag: number; localOffset: number; uncompSize: number }
	>();
	let p = cdOffset;
	for (let i = 0; i < cdCount; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
		const flag = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const uncompSize = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		if (want.has(name)) files.set(name, { method, compSize, flag, localOffset, uncompSize });
		p += 46 + nameLen + extraLen + commentLen;
	}
	let totalUncomp = 0;
	const out = new Map<string, Buffer>();
	for (const [name, meta] of files) {
		totalUncomp += meta.uncompSize;
		if (totalUncomp > OFFICE_MAX_UNCOMPRESSED_BYTES) throw new Error("解包后内容过大（疑似 zip 炸弹），拒绝预览");
		const lp = meta.localOffset;
		if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`zip 局部头损坏：${name}`);
		const lMethod = buf.readUInt16LE(lp + 8);
		const lNameLen = buf.readUInt16LE(lp + 26);
		const lExtraLen = buf.readUInt16LE(lp + 28);
		const dataStart = lp + 30 + lNameLen + lExtraLen;
		const raw = buf.subarray(dataStart, dataStart + meta.compSize);
		if (meta.flag & 0x1) throw new Error(`不支持加密 zip 条目：${name}`);
		const method = lMethod || meta.method;
		if (method === 0) out.set(name, Buffer.from(raw));
		else if (method === 8) out.set(name, Buffer.from(inflateRawSync(raw)));
		else throw new Error(`不支持的压缩方式 ${method}：${name}`);
	}
	return out;
}

function decodeEntities(s: string): string {
	return String(s ?? "")
		.replace(
			/&(lt|gt|amp|quot|apos);/g,
			(_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e] as string,
		)
		.replace(/&#(\d+);/g, (_, n: string) => {
			try {
				return String.fromCodePoint(Number(n));
			} catch {
				return "";
			}
		})
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => {
			try {
				return String.fromCodePoint(Number.parseInt(h, 16));
			} catch {
				return "";
			}
		});
}

const stripTags = (s: string): string => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, ""));

/** docx → 段落数组。 */
export function parseDocxParagraphs(buf: Buffer): string[] {
	const files = unzipFiles(buf, ["word/document.xml"]);
	const xml = files.get("word/document.xml")?.toString("utf8");
	if (!xml) throw new Error("docx 里找不到 word/document.xml");
	const paragraphs: string[] = [];
	for (const m of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
		const pXml = m[0];
		let text = "";
		for (const n of pXml.matchAll(/<w:(t|tab|br)[^>]*\/?>([^<]*)(?:<\/w:t>)?/g)) {
			if (n[1] === "tab") text += "\t";
			else if (n[1] === "br") text += "\n";
			else text += decodeEntities(n[2]);
		}
		paragraphs.push(text);
	}
	while (
		paragraphs.length > 1 &&
		paragraphs[paragraphs.length - 1] === "" &&
		paragraphs[paragraphs.length - 2] === ""
	) {
		paragraphs.pop();
	}
	return paragraphs;
}

function colLettersToIndex(letters: string): number {
	let n = 0;
	for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function splitCellRef(ref: string): { col: number; row: number } | null {
	const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref ?? "").trim());
	if (!m) return null;
	return { col: colLettersToIndex(m[1]), row: Number(m[2]) - 1 };
}

function parseSharedStrings(xml: string | undefined): string[] {
	if (!xml) return [];
	const out: string[] = [];
	for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
		const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1]));
		out.push(texts.join(""));
	}
	return out;
}

export interface XlsxSheet {
	name: string;
	nRows: number;
	nCols: number;
	/** 首屏（MAX_ROWS × MAX_COLS），超出的计 truncated。 */
	rows: string[][];
	truncated: boolean;
}

function parseSheet(xml: string, shared: string[]): string[][] {
	const rows: string[][] = [];
	for (const m of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
		const rowAttr = m[0].slice(0, m[0].indexOf(">"));
		const rNum = Number(/r="(\d+)"/.exec(rowAttr)?.[1] ?? rows.length + 1) - 1;
		while (rows.length <= rNum) rows.push([]);
		const row = rows[rNum];
		for (const c of m[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
			const attrs = c[1];
			const ref = /r="([^"]+)"/.exec(attrs)?.[1];
			const t = /t="([^"]+)"/.exec(attrs)?.[1];
			const pos = splitCellRef(ref ?? "");
			if (!pos) continue;
			const inner = c[2];
			let val = "";
			if (t === "inlineStr") {
				val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1])).join("");
			} else if (t === "s") {
				const idx = Number(stripTags(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ""));
				val = Number.isFinite(idx) && shared[idx] !== undefined ? shared[idx] : "";
			} else if (t === "b") {
				val = stripTags(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "") === "1" ? "TRUE" : "FALSE";
			} else {
				val = stripTags(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
				if (!val) val = stripTags(inner);
			}
			while (row.length <= pos.col) row.push("");
			row[pos.col] = val;
		}
	}
	return rows;
}

/** xlsx/xlsm → sheet 数组（名按 workbook 还原，取不到时回落 sheetN）。 */
export function parseXlsxSheets(buf: Buffer): XlsxSheet[] {
	const probe = unzipFiles(buf, ["xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);
	const wbXml = probe.get("xl/workbook.xml")?.toString("utf8") ?? "";
	const relsXml = probe.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
	const relTarget = new Map<string, string>();
	for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
		const id = /Id="([^"]+)"/.exec(m[0])?.[1];
		const target = /Target="([^"]+)"/.exec(m[0])?.[1];
		if (id && target) relTarget.set(id, target.replace(/^\/+/, "").replace(/^xl\//, ""));
	}
	const sheetDefs: { name: string; rid: string | undefined }[] = [];
	for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
		const name = /name="([^"]*)"/.exec(m[0])?.[1] ?? `Sheet${sheetDefs.length + 1}`;
		const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
		sheetDefs.push({ name: decodeEntities(name), rid });
	}
	let targets = sheetDefs.map((d, i) => {
		const t = d.rid && relTarget.get(d.rid);
		return { name: d.name, file: t ? `xl/${t}` : `xl/worksheets/sheet${i + 1}.xml` };
	});
	if (targets.length === 0) targets = [{ name: "Sheet1", file: "xl/worksheets/sheet1.xml" }];

	const files = unzipFiles(buf, ["xl/sharedStrings.xml", ...targets.map((t) => t.file)]);
	const shared = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8"));
	return targets.map((t) => {
		const xml = files.get(t.file)?.toString("utf8");
		const all = xml ? parseSheet(xml, shared) : [];
		const fullCols = Math.max(0, ...all.map((r) => r.length));
		const nCols = Math.min(MAX_COLS, fullCols);
		const cut = all.slice(0, MAX_ROWS).map((r) => {
			const row = r.slice(0, MAX_COLS);
			while (row.length < nCols) row.push("");
			return row;
		});
		return {
			name: t.name,
			nRows: all.length,
			nCols: fullCols,
			rows: cut,
			truncated: all.length > MAX_ROWS || fullCols > MAX_COLS,
		};
	});
}

const mdCell = (s: string): string =>
	String(s ?? "")
		.replace(/\|/g, "\\|")
		.replace(/\r?\n/g, " ");

/** 列号 → Excel 式列名（0→A，25→Z，26→AA）。 */
function colName(i: number): string {
	let s = "";
	let n = i;
	do {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return s;
}

/**
 * 表头固定用 A/B/C…（与 Excel 列标一致），而不拿第一行数据冒充表头——
 * 很多表的第一行是通知/标题文字，染成紫色表头又怪又误导。
 */
function sheetToMarkdown(sheet: XlsxSheet): string {
	const head = `## ${sheet.name}（${sheet.nRows} 行 × ${sheet.nCols} 列${sheet.truncated ? "，只看前一部分" : ""}）`;
	if (sheet.rows.length === 0) return `${head}\n\n（空表）`;
	const width = Math.max(1, ...sheet.rows.map((r) => r.length));
	const pad = (r: string[]): string[] => {
		const row = r.slice(0, width);
		while (row.length < width) row.push("");
		return row;
	};
	const lines = [Array.from({ length: width }, (_, i) => colName(i)), ...sheet.rows.map(pad)].map(
		(r) => `| ${r.map(mdCell).join(" | ")} |`,
	);
	lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
	return [head, "", ...lines].join("\n");
}

/**
 * Office 文件 → Markdown 预览文本（前端 FilePreview 按 Markdown 渲染）。
 * 非 office 扩展名返回 null；zip 损坏/加密等抛错（调用方回落旧的二进制嗅探）。
 */
export function extractOfficeText(filename: string, buf: Buffer): { text: string; truncated: boolean } | null {
	const dot = String(filename ?? "")
		.toLowerCase()
		.lastIndexOf(".");
	const ext = dot > 0 ? String(filename).toLowerCase().slice(dot) : "";
	if (!OFFICE_EXTS.has(ext)) return null;
	if (buf.length > OFFICE_MAX_FILE_BYTES) {
		throw new Error(`文件太大（${(buf.length / 1048576).toFixed(1)} MB），Office 预览上限 15 MB`);
	}
	let text: string;
	let truncated = false;
	if (ext === ".docx") {
		const paras = parseDocxParagraphs(buf);
		text = paras.join("\n");
		truncated = text.length > OFFICE_MAX_TEXT_CHARS;
	} else {
		const sheets = parseXlsxSheets(buf);
		text = sheets.map(sheetToMarkdown).join("\n\n");
		truncated = text.length > OFFICE_MAX_TEXT_CHARS || sheets.some((s) => s.truncated);
	}
	if (text.length > OFFICE_MAX_TEXT_CHARS) text = text.slice(0, OFFICE_MAX_TEXT_CHARS);
	return { text, truncated };
}
