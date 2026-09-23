/**
 * office-preview 服务端入口 —— 工作区 docx / xlsx / csv 解析 + 1 个 AI 工具。
 *
 * 零依赖：docx / xlsx 本质是 zip 包（word/document.xml、xl/*.xml），这里用
 * node:zlib + 手写 zip 中央目录解析做最小解包（只支持 stored / deflate，
 * Office 写出的文件都是这两种），XML 用正则提文本，不引入任何 npm 包。
 *
 * 路由（实际暴露为 /plugins-api/office-preview/*，继承主站鉴权）：
 *   GET  /list         → 工作区内的 .docx/.xlsx/.xlsm/.csv 清单
 *   GET  /parse?path=  → 解析工作区文件，返回段落 / 表格 JSON
 *   POST /upload?filename= → 解析请求体原始字节（本地文件上传），返回同上
 *
 * AI 工具：office_read({ path, maxChars? }) → 文本预览（截断封顶）。
 */

import { inflateRawSync } from "node:zlib";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;
const MAX_ROWS = 200;
const MAX_COLS = 20;

const OFFICE_EXT = new Set([".docx", ".xlsx", ".xlsm", ".csv"]);

/** 路径归一：防 `..\` 越界（宿主 host.fs 本来也会拦，这里先做一层）。 */
function normalizeRel(p) {
	const s = String(p ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.trim();
	if (!s || s.startsWith("/") || s.split("/").includes("..")) return "";
	return s;
}

/* ---------------- 最小 zip 解包（stored + deflate） ---------------- */

function findEocd(buf) {
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
function unzipFiles(buf, wanted) {
	const want = new Set(wanted);
	const eocd = findEocd(buf);
	const cdCount = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	const files = new Map(); // name → { method, compSize, localOffset }
	let p = cdOffset;
	for (let i = 0; i < cdCount; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
		const flag = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		if (want.has(name)) files.set(name, { method, compSize, flag, localOffset });
		p += 46 + nameLen + extraLen + commentLen;
	}
	const out = new Map();
	for (const [name, meta] of files) {
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

/* ---------------- XML 小工具（正则提文本，够预览用） ---------------- */

function decodeEntities(s) {
	return String(s ?? "")
		.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e])
		.replace(/&#(\d+);/g, (_, n) => {
			try {
				return String.fromCodePoint(Number(n));
			} catch {
				return "";
			}
		})
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
			try {
				return String.fromCodePoint(Number.parseInt(h, 16));
			} catch {
				return "";
			}
		});
}

const stripTags = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, ""));

/* ---------------- docx → 段落 ---------------- */

function parseDocx(buf) {
	const files = unzipFiles(buf, ["word/document.xml"]);
	const xml = files.get("word/document.xml")?.toString("utf8");
	if (!xml) throw new Error("docx 里找不到 word/document.xml");
	const paragraphs = [];
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
	// 尾部连续空段落只留一个，避免几百行空白
	while (
		paragraphs.length > 1 &&
		paragraphs[paragraphs.length - 1] === "" &&
		paragraphs[paragraphs.length - 2] === ""
	) {
		paragraphs.pop();
	}
	return paragraphs;
}

/* ---------------- xlsx → 表格 ---------------- */

function colLettersToIndex(letters) {
	let n = 0;
	for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function splitCellRef(ref) {
	const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref ?? "").trim());
	if (!m) return null;
	return { col: colLettersToIndex(m[1]), row: Number(m[2]) - 1 };
}

function parseSharedStrings(xml) {
	if (!xml) return [];
	const out = [];
	for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
		const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1]));
		out.push(texts.join(""));
	}
	return out;
}

function parseSheet(xml, shared) {
	const rows = [];
	for (const m of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
		const rowAttr = m[0].slice(0, m[0].indexOf(">"));
		const rNum = Number(/r="(\d+)"/.exec(rowAttr)?.[1] ?? rows.length + 1) - 1;
		while (rows.length <= rNum) rows.push([]);
		const row = rows[rNum];
		for (const c of m[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
			const attrs = c[1];
			const ref = /r="([^"]+)"/.exec(attrs)?.[1];
			const t = /t="([^"]+)"/.exec(attrs)?.[1];
			const pos = splitCellRef(ref);
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
				// n / d / str / 无标记：取 v 原值（公式格取缓存值，不算公式）
				val = stripTags(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
				if (!val) val = stripTags(inner);
			}
			while (row.length <= pos.col) row.push("");
			row[pos.col] = val;
		}
	}
	return rows;
}

function parseXlsx(buf) {
	// 先读 workbook 定 sheet 名与顺序
	const probe = unzipFiles(buf, ["xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);
	const wbXml = probe.get("xl/workbook.xml")?.toString("utf8") ?? "";
	const relsXml = probe.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
	const relTarget = new Map();
	for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
		const id = /Id="([^"]+)"/.exec(m[0])?.[1];
		const target = /Target="([^"]+)"/.exec(m[0])?.[1];
		if (id && target) relTarget.set(id, target.replace(/^\/+/, "").replace(/^xl\//, ""));
	}
	const sheetDefs = [];
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
	const sheets = targets.map((t) => {
		const xml = files.get(t.file)?.toString("utf8");
		const all = xml ? parseSheet(xml, shared) : [];
		const nCols = Math.min(MAX_COLS, Math.max(0, ...all.map((r) => r.length)));
		const cut = all.slice(0, MAX_ROWS).map((r) => {
			const row = r.slice(0, MAX_COLS);
			while (row.length < nCols) row.push("");
			return row;
		});
		return {
			name: t.name,
			nRows: all.length,
			nCols: Math.max(0, ...all.map((r) => r.length)),
			rows: cut,
			truncated: all.length > MAX_ROWS || Math.max(0, ...all.map((r) => r.length)) > MAX_COLS,
		};
	});
	return sheets;
}

/* ---------------- csv → 表格（基础引号处理） ---------------- */

function parseCsv(text) {
	const rows = [];
	let row = [];
	let cur = "";
	let quoted = false;
	const pushCell = () => {
		row.push(cur);
		cur = "";
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					cur += '"';
					i++;
				} else quoted = false;
			} else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") pushCell();
		else if (ch === "\r" || ch === "\n") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			pushCell();
			// 忽略文件尾最后一个空行
			if (!(row.length === 1 && row[0] === "" && i >= text.length - 1)) rows.push(row);
			row = [];
		} else cur += ch;
	}
	pushCell();
	if (!(row.length === 1 && row[0] === "")) rows.push(row);
	return rows;
}

/* ---------------- 统一解析入口 ---------------- */

function extOf(name) {
	const m = /\.([a-z0-9]+)$/i.exec(String(name ?? "").trim());
	return m ? `.${m[1].toLowerCase()}` : "";
}

function parseBuffer(filename, buf) {
	const ext = extOf(filename);
	if (buf.length > MAX_FILE_BYTES) throw new Error(`文件太大（${(buf.length / 1048576).toFixed(1)} MB，上限 15 MB）`);
	if (ext === ".docx") {
		const paragraphs = parseDocx(buf);
		const text = paragraphs.join("\n");
		return {
			ok: true,
			kind: "docx",
			filename,
			paragraphs: paragraphs.slice(0, 2000),
			text: text.slice(0, MAX_TEXT_CHARS),
			textLength: text.length,
			truncated: text.length > MAX_TEXT_CHARS || paragraphs.length > 2000,
		};
	}
	if (ext === ".xlsx" || ext === ".xlsm") {
		const sheets = parseXlsx(buf);
		return { ok: true, kind: "xlsx", filename, sheets };
	}
	if (ext === ".csv") {
		let text = buf.toString("utf8");
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		const all = parseCsv(text);
		const nCols = Math.max(0, ...all.map((r) => r.length));
		return {
			ok: true,
			kind: "csv",
			filename,
			sheets: [
				{
					name: filename,
					nRows: all.length,
					nCols,
					rows: all.slice(0, MAX_ROWS).map((r) => {
						const row = r.slice(0, MAX_COLS);
						while (row.length < Math.min(nCols, MAX_COLS)) row.push("");
						return row;
					}),
					truncated: all.length > MAX_ROWS || nCols > MAX_COLS,
				},
			],
		};
	}
	throw new Error(`不支持的格式（只支持 .docx / .xlsx / .csv）：${ext || "(无扩展名)"}`);
}

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
	return Buffer.concat(chunks);
}

/** 表格 → Markdown（AI 工具与复制文本用）。 */
// 与 server/office-parse.ts 的 sheetToMarkdown 互为镜像：表头固定用 A/B/C…
// 列标（不拿第一行数据冒充表头）。改一处请同步另一处。
function colName(i) {
	let s = "";
	let n = i;
	do {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return s;
}
function sheetToMarkdown(sheet, maxRows = 50, maxCols = 10) {
	const rows = sheet.rows.slice(0, maxRows).map((r) => r.slice(0, maxCols));
	if (rows.length === 0) return `（${sheet.name} 为空表）`;
	const esc = (s) =>
		String(s ?? "")
			.replace(/\|/g, "\\|")
			.replace(/\n/g, " ");
	const width = Math.max(1, ...rows.map((r) => r.length));
	const pad = (r) => {
		const row = r.slice(0, width);
		while (row.length < width) row.push("");
		return row;
	};
	const lines = [Array.from({ length: width }, (_, i) => colName(i)), ...rows.map(pad)].map(
		(r) => `| ${r.map(esc).join(" | ")} |`,
	);
	lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
	return [`## ${sheet.name}（${sheet.nRows} 行 × ${sheet.nCols} 列）`, ...lines].join("\n");
}

// 纯函数导出（单测用，不影响插件协议）。
export { parseBuffer, parseDocx, parseXlsx, parseCsv, unzipFiles };

export default {
	activate(host) {
		host.route("GET", "/list", async (req, res) => {
			try {
				const found = new Map();
				for (const pat of ["*.docx", "*.xlsx", "*.xlsm", "*.csv", "**/*.docx", "**/*.xlsx", "**/*.xlsm", "**/*.csv"]) {
					try {
						for (const f of await host.fs.glob(pat)) {
							if (OFFICE_EXT.has(extOf(f))) found.set(f, true);
							if (found.size >= 500) break;
						}
					} catch {
						/* 某条 pattern 不支持就跳过 */
					}
					if (found.size >= 500) break;
				}
				res.json({ ok: true, files: [...found.keys()].sort() });
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err?.message ?? err) });
			}
		});

		host.route("GET", "/parse", async (req, res) => {
			try {
				const rel = normalizeRel(req.query?.path);
				if (!rel) return void res.status(400).json({ ok: false, error: "缺少 path 参数" });
				if (!OFFICE_EXT.has(extOf(rel))) {
					return void res.status(400).json({ ok: false, error: "只支持 .docx / .xlsx / .csv 文件" });
				}
				const buf = await host.fs.read(rel);
				res.json(parseBuffer(rel.split("/").pop(), buf));
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err?.message ?? err) });
			}
		});

		host.route("POST", "/upload", async (req, res) => {
			try {
				const filename = String(req.query?.filename ?? "upload.xlsx");
				const buf = await readBody(req);
				if (buf.length === 0) return void res.status(400).json({ ok: false, error: "上传内容为空" });
				res.json(parseBuffer(filename, buf));
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err?.message ?? err) });
			}
		});

		host.registerAgentTool({
			name: "office_read",
			label: "读取 Office 文件",
			description:
				"读取工作区内的 docx / xlsx / csv 文件并返回文本预览（Word 段落、表格转 Markdown），path 为工作区相对路径。",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "工作区相对路径，如 docs/报告.docx" },
					maxChars: { type: "number", description: "最多返回字符数，默认 6000" },
				},
				required: ["path"],
			},
			execute: async (_id, params) => {
				const rel = normalizeRel(params?.path);
				if (!rel) throw new Error("缺少 path 参数");
				const buf = await host.fs.read(rel);
				const parsed = parseBuffer(rel.split("/").pop(), buf);
				const maxChars = Math.min(20_000, Math.max(500, Number(params?.maxChars) || 6000));
				let text;
				if (parsed.kind === "docx") text = parsed.text;
				else text = parsed.sheets.map((s) => sheetToMarkdown(s)).join("\n\n");
				const cut = text.slice(0, maxChars);
				return {
					content: [
						{
							type: "text",
							text: `${rel}（${parsed.kind}）预览：\n\n${cut}${text.length > maxChars ? "\n\n…（已截断）" : ""}`,
						},
					],
				};
			},
		});

		host.log("office-preview activated");
	},
};
