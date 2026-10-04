/**
 * preset-share 单测：交换格式的解析/净化、目录解析与缓存、网址收口（SSRF）、
 * 以及 port 编排（导出/导入/分享/目录）在假 port 上的行为。
 * 全程零网络、零磁盘（gh 与 fetch 都不真跑；createPresetIssue 只用不存在
 * 的 ghPath 验证失败回落路径）。
 */
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildImportPreview,
	buildShareDoc,
	catalogBaseUrl,
	clearPresetCatalogCache,
	DEFAULT_PRESET_REPO,
	exportPresetVia,
	fetchPresetCatalog,
	importPresetFromUrlVia,
	importPresetVia,
	isBlockedHost,
	normalizeCatalogEntry,
	normalizeTags,
	parseCatalog,
	parseShareDoc,
	presetCatalogUrl,
	presetFileName,
	presetIssueBody,
	presetIssueTitle,
	presetIssueWebUrl,
	presetRepoUrl,
	presetShareRepo,
	presetShortHash,
	presetSummary,
	PRESET_JSON_MAX_BYTES,
	PRESET_SHARE_FORMAT,
	PRESET_SHARE_VERSION,
	pushPresetCatalogVia,
	sanitizePresetSettings,
	serializeShareDoc,
	sharePresetVia,
	slugifyPresetName,
	toSettingsPreset,
	validateFetchUrl,
	type PresetCatalogCache,
	type PresetSharePort,
	type TextFetcher,
} from "../../server/preset-share.js";
import type { ClientMessage, ServerMessage, UiPresetCatalogEntry } from "../../server/protocol.js";

const SETTINGS = {
	promptMode: "append",
	customSystemPrompt: "be brief",
	promptTemplate: "",
	promptOverrides: {},
	disabledSkills: ["a"],
	disabledExtensions: [],
	disabledAgentTools: [],
	disabledPluginTools: [],
	terminalToolsEnabled: true,
	terminalBash: false,
	terminalBashIdleMs: 0,
	terminalBashMaxForegroundMs: 0,
	editSoftEnabled: false,
	retryMaxAttempts: 6,
	softCapTokens: 0,
	softCapByModel: {},
	reviewPrompt: "",
	reviewDisabledSkills: [],
	skillsFullText: [],
};

function shareText(): string {
	return serializeShareDoc(
		buildShareDoc("My preset", SETTINGS, {
			description: "d",
			author: "me",
			tags: ["x"],
			createdAt: "2026-01-01T00:00:00.000Z",
		}),
	);
}

/** 一个记录所有 emit 的假 port（编排测试用）。 */
function makePort(over: Partial<PresetSharePort> = {}): {
	port: PresetSharePort;
	sent: ServerMessage[];
	saved: string[];
} {
	const sent: ServerMessage[] = [];
	const saved: string[] = [];
	const port: PresetSharePort = {
		lang: () => "en",
		appVersion: () => "9.9.9",
		presets: () => [],
		currentSettings: () => ({ ...SETTINGS }),
		upsertPreset: (p) => saved.push(p.name),
		applyPreset: async (name) => {
			saved.push(`apply:${name}`);
		},
		pushSettings: () => saved.push("push"),
		emit: (m) => sent.push(m),
		...over,
	};
	return { port, sent, saved };
}

describe("slug / hash / file name", () => {
	it("slug 与共享仓库脚本同源（非 ASCII 退化成 preset）", () => {
		expect(slugifyPresetName("My Preset!")).toBe("my-preset");
		expect(slugifyPresetName("  A__b  ")).toBe("a-b");
		expect(slugifyPresetName("极简回复")).toBe("preset");
		expect(slugifyPresetName("")).toBe("preset");
	});

	it("短哈希稳定且定长，文件名 = slug-短哈希.json", () => {
		expect(presetShortHash("abc")).toBe(presetShortHash("abc"));
		expect(presetShortHash("abc")).toHaveLength(7);
		expect(presetShortHash("abc")).not.toBe(presetShortHash("abd"));
		expect(presetFileName("My Preset!")).toMatch(/^my-preset-[0-9a-f]{7}\.json$/);
	});
});

describe("sanitizePresetSettings（白名单 + 类型 + 上限）", () => {
	it("只留白名单字段，未知字段记入 ignored", () => {
		const r = sanitizePresetSettings({ ...SETTINGS, evil: "x", promptMode2: 1 });
		expect(r.ignored).toEqual(["evil", "promptMode2"]);
		expect(r.rejected).toEqual([]);
		expect(r.fields).toEqual([...r.fields].sort());
		expect(r.fields).toContain("customSystemPrompt");
		expect(r.settings).not.toHaveProperty("evil");
	});

	it("类型不符的已知字段丢弃（不抛错），并记入 rejected", () => {
		const r = sanitizePresetSettings({
			promptMode: "nope",
			customSystemPrompt: 42,
			disabledSkills: "not-an-array",
			terminalBash: "yes",
			retryMaxAttempts: "6",
			softCapByModel: [],
		});
		expect(r.rejected).toEqual([
			"customSystemPrompt",
			"disabledSkills",
			"promptMode",
			"retryMaxAttempts",
			"softCapByModel",
			"terminalBash",
		]);
		expect(r.fields).toEqual([]);
	});

	it("列表去重去空白并有条数上限；负数/非有限数被拒", () => {
		const r = sanitizePresetSettings({
			disabledSkills: [" a ", "a", "", 5, "b"],
			terminalBashIdleMs: -1,
			softCapTokens: Number.NaN,
		});
		expect(r.settings["disabledSkills"]).toEqual(["a", "b"]);
		expect(r.rejected).toEqual(["softCapTokens", "terminalBashIdleMs"]);
	});

	it("超长文本字段被拒（防一条巨型 JSON 顶爆设置存储）", () => {
		const r = sanitizePresetSettings({ customSystemPrompt: "x".repeat(100_001) });
		expect(r.rejected).toEqual(["customSystemPrompt"]);
	});

	it("promptOverrides / softCapByModel 走各自归一化", () => {
		const r = sanitizePresetSettings({
			promptOverrides: { soul: "hi", bad: 5 },
			softCapByModel: { "gpt-x": 1000 },
		});
		expect(r.settings["promptOverrides"]).toEqual({ soul: "hi" });
		// softCapByModel 的值走 soft-cap 归一化（<=1000 视为 K tokens）。
		expect(r.settings["softCapByModel"]).toEqual({ "gpt-x": 1_000_000 });
	});

	it("toSettingsPreset 补齐缺失字段（旧文档/新客户端都能读）", () => {
		const p = toSettingsPreset("n", { promptMode: "replace" });
		expect(p.name).toBe("n");
		expect(p.promptMode).toBe("replace");
		expect(p.customSystemPrompt).toBe("");
		expect(p.terminalToolsEnabled).toBe(true);
		expect(p.retryMaxAttempts).toBeGreaterThan(0);
		expect(p.softCapTokens).toBe(0);
	});
});

describe("parseShareDoc（形状校验 + 净化）", () => {
	it("接受导出文档，并在 settings 里只留白名单字段", () => {
		const r = parseShareDoc(shareText());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.format).toBe(PRESET_SHARE_FORMAT);
		expect(r.doc.version).toBe(PRESET_SHARE_VERSION);
		expect(r.doc.name).toBe("My preset");
		expect(r.doc.tags).toEqual(["x"]);
		expect(r.sanitized.fields).toContain("customSystemPrompt");
	});

	it("能取出 issue 正文里的 ```json 代码块（前后有说明文字）", () => {
		const body = ["由 pi-web-ui 生成。", "", "```json", shareText(), "```", "", "(说明)"].join("\n");
		const r = parseShareDoc(body);
		expect(r.ok).toBe(true);
	});

	it("空内容 / 坏 JSON / 错 format / 错 version / 无名 / 无 settings 各有稳定 errorKey", () => {
		const cases: [string, string][] = [
			["", "presets.import.empty"],
			["{oops", "presets.import.parse"],
			[JSON.stringify({ format: "other", version: 1, name: "a", settings: SETTINGS }), "presets.import.format"],
			[
				JSON.stringify({ format: PRESET_SHARE_FORMAT, version: 2, name: "a", settings: SETTINGS }),
				"presets.import.version",
			],
			[
				JSON.stringify({ format: PRESET_SHARE_FORMAT, version: 1, name: "  ", settings: SETTINGS }),
				"presets.import.name",
			],
			[JSON.stringify({ format: PRESET_SHARE_FORMAT, version: 1, name: "a", settings: [] }), "presets.import.settings"],
			[
				JSON.stringify({ format: PRESET_SHARE_FORMAT, version: 1, name: "a", settings: { nope: 1 } }),
				"presets.import.noFields",
			],
			["[1,2,3]", "presets.import.shape"],
		];
		for (const [input, key] of cases) {
			const r = parseShareDoc(input);
			expect(r.ok, input).toBe(false);
			if (!r.ok) expect(r.errorKey, input).toBe(key);
		}
	});

	it("单元素数组也接受（有人会把一个预设包成数组）", () => {
		const r = parseShareDoc(`[${shareText()}]`);
		expect(r.ok).toBe(true);
	});

	it("超大内容直接拒绝（字节上限）", () => {
		const big = JSON.stringify({
			format: PRESET_SHARE_FORMAT,
			version: 1,
			name: "a",
			settings: { customSystemPrompt: "x".repeat(PRESET_JSON_MAX_BYTES) },
		});
		const r = parseShareDoc(big);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errorKey).toBe("presets.import.tooLarge");
	});

	it("中文名归一化（压缩空白 + 截断 60 字）", () => {
		const doc = buildShareDoc("  a   b  ", SETTINGS);
		expect(doc.name).toBe("a b");
		const r = parseShareDoc(JSON.stringify({ ...doc, name: "字".repeat(80) }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.name).toHaveLength(60);
	});

	it("标签归一化：去重、去空白、单条 24 字、最多 8 条", () => {
		expect(normalizeTags([" a ", "a", "b"])).toEqual(["a", "b"]);
		expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(8);
		expect(normalizeTags("nope")).toEqual([]);
		expect(normalizeTags(["x".repeat(50)])[0]).toHaveLength(24);
	});
});

describe("摘要（列表徽标）", () => {
	it("统计禁用技能/工具并标记模板与审查提示词", () => {
		const s = presetSummary({
			promptMode: "replace",
			disabledSkills: ["a"],
			reviewDisabledSkills: ["b"],
			disabledAgentTools: ["c"],
			promptTemplate: "{{soul}}",
			reviewPrompt: "check",
		});
		expect(s).toEqual({ promptMode: "replace", skills: 2, agentTools: 1, hasTemplate: true, hasReviewPrompt: true });
		expect(presetSummary({}).promptMode).toBe("append");
	});
});

describe("网址收口（SSRF）", () => {
	it("内网/回环/链路本地/元数据地址一律拦截", () => {
		for (const host of [
			"localhost",
			"127.0.0.1",
			"10.0.0.5",
			"192.168.1.2",
			"172.16.0.1",
			"172.31.255.255",
			"169.254.169.254",
			"0.0.0.0",
			"::1",
			"fd00::1",
			"foo.local",
			"x.internal",
			"",
		]) {
			expect(isBlockedHost(host), host).toBe(true);
		}
		expect(isBlockedHost("raw.githubusercontent.com")).toBe(false);
		expect(isBlockedHost("172.32.0.1")).toBe(false);
	});

	it("validateFetchUrl 只放行 http/https 且非内网", () => {
		expect(validateFetchUrl("file:///etc/passwd")).toEqual({ ok: false, reason: "scheme" });
		expect(validateFetchUrl("javascript:alert(1)")).toEqual({ ok: false, reason: "scheme" });
		expect(validateFetchUrl("not a url")).toEqual({ ok: false, reason: "scheme" });
		expect(validateFetchUrl("http://127.0.0.1/x.json")).toEqual({ ok: false, reason: "host" });
		const ok = validateFetchUrl("https://raw.githubusercontent.com/o/r/main/presets/a.json");
		expect(ok.ok).toBe(true);
	});
});

describe("目录解析与缓存", () => {
	const base = "https://raw.githubusercontent.com/o/r/main";
	const rawIndex = JSON.stringify({
		version: 1,
		presets: [
			{
				id: "a-1",
				name: "A",
				description: "d",
				author: "me",
				tags: ["t"],
				file: "presets/a-1.json",
				issue: 12,
				updatedAt: "2026-02-01T00:00:00.000Z",
				summary: { promptMode: "replace", skills: 1, agentTools: 0, hasTemplate: true, hasReviewPrompt: false },
			},
			{ id: "b-2", name: "B", file: "presets/b-2.json", updatedAt: "2026-03-01T00:00:00.000Z" },
			// 坏条目：缺 file / 越界 file / 重复 id → 全部丢弃
			{ id: "c-3", name: "C" },
			{ id: "d-4", name: "D", file: "../../etc/passwd" },
			{ id: "d-4", name: "D2", file: "/abs.json" },
			{ id: "a-1", name: "A dup", file: "presets/a-1.json" },
		],
	});

	it("条目校验：相对路径、id 去重、最近更新在前，url 由 raw 基址拼出", () => {
		const r = parseCatalog(rawIndex, { base, repoUrl: "https://github.com/o/r" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.entries.map((e) => e.id)).toEqual(["b-2", "a-1"]);
		expect(r.entries[1]?.url).toBe(`${base}/presets/a-1.json`);
		expect(r.entries[1]?.issueUrl).toBe("https://github.com/o/r/issues/12");
		expect(r.entries[0]?.issueUrl).toBe("");
	});

	it("坏目录（非对象 / 缺 presets 数组 / 坏 JSON）报错而不是空列表", () => {
		for (const text of ["[]", "{}", "{oops", JSON.stringify({ presets: {} })]) {
			const r = parseCatalog(text, { base });
			expect(r.ok, text).toBe(false);
		}
	});

	it("catalogBaseUrl 去掉最后一段（index.json → 目录）", () => {
		expect(catalogBaseUrl("https://x/y/main/index.json")).toBe("https://x/y/main");
		expect(catalogBaseUrl("https://x/y/main/catalog.json")).toBe("https://x/y/main");
	});

	it("normalizeCatalogEntry 对非对象/缺字段返回 null", () => {
		expect(normalizeCatalogEntry(null, base, "")).toBeNull();
		expect(normalizeCatalogEntry({ name: "x", file: "presets/x.json" }, base, "")).toBeNull();
	});

	it("fetchPresetCatalog：成功写缓存，TTL 内不再抓，refresh 强制重抓，失败保留上次列表", async () => {
		clearPresetCatalogCache();
		const url = "https://example.com/main/index.json";
		let calls = 0;
		let fail = false;
		const fetcher: TextFetcher = async () => {
			calls++;
			if (fail) return { ok: false, status: 500, text: async () => "" };
			return { ok: true, status: 200, text: async () => rawIndex };
		};
		const cache: PresetCatalogCache = (() => {
			let store: { entries: UiPresetCatalogEntry[]; fetchedAt: number } | undefined;
			return {
				get: () => store,
				set: (_u, v) => {
					store = v;
				},
				clear: () => {
					store = undefined;
				},
			};
		})();
		const first = await fetchPresetCatalog({ url, fetcher, cache });
		expect(first.ok).toBe(true);
		expect(first.cached).toBe(false);
		expect(calls).toBe(1);
		const second = await fetchPresetCatalog({ url, fetcher, cache });
		expect(second.cached).toBe(true);
		expect(calls).toBe(1);
		await fetchPresetCatalog({ url, fetcher, cache, refresh: true });
		expect(calls).toBe(2);
		fail = true;
		const failed = await fetchPresetCatalog({ url, fetcher, cache, refresh: true });
		expect(failed.ok).toBe(false);
		expect(failed.cached).toBe(true);
		expect(failed.entries.length).toBe(2);
		expect(failed.errorKey).toBe("presets.catalog.failed");
	});

	it("目录被关掉（无 url）时返回明确的错误", async () => {
		const r = await fetchPresetCatalog({ url: "" });
		expect(r.ok).toBe(false);
		expect(r.errorKey).toBe("presets.catalog.disabled");
	});

	it("内网目录地址被拦下（不抓取）", async () => {
		let called = false;
		const fetcher: TextFetcher = async () => {
			called = true;
			return { ok: true, status: 200, text: async () => rawIndex };
		};
		const r = await fetchPresetCatalog({ url: "http://127.0.0.1/index.json", fetcher, refresh: true });
		expect(r.ok).toBe(false);
		expect(called).toBe(false);
	});
});

describe("env 读取", () => {
	it("默认仓库与目录地址；off/空串可关掉", () => {
		const saved = { repo: process.env["PI_WEB_PRESET_REPO"], url: process.env["PI_WEB_PRESET_CATALOG_URL"] };
		try {
			delete process.env["PI_WEB_PRESET_REPO"];
			delete process.env["PI_WEB_PRESET_CATALOG_URL"];
			expect(presetShareRepo()).toBe(DEFAULT_PRESET_REPO);
			expect(presetCatalogUrl()).toBe(`https://raw.githubusercontent.com/${DEFAULT_PRESET_REPO}/main/index.json`);
			expect(presetRepoUrl()).toBe(`https://github.com/${DEFAULT_PRESET_REPO}`);

			process.env["PI_WEB_PRESET_REPO"] = "https://github.com/me/my-presets.git";
			expect(presetShareRepo()).toBe("me/my-presets");
			expect(presetCatalogUrl()).toBe("https://raw.githubusercontent.com/me/my-presets/main/index.json");

			process.env["PI_WEB_PRESET_CATALOG_URL"] = "https://example.com/c.json";
			expect(presetCatalogUrl()).toBe("https://example.com/c.json");
			process.env["PI_WEB_PRESET_CATALOG_URL"] = "off";
			expect(presetCatalogUrl()).toBe("");
			process.env["PI_WEB_PRESET_REPO"] = "0";
			expect(presetShareRepo()).toBe("");
			expect(presetCatalogUrl()).toBe("");
		} finally {
			if (saved.repo === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = saved.repo;
			if (saved.url === undefined) delete process.env["PI_WEB_PRESET_CATALOG_URL"];
			else process.env["PI_WEB_PRESET_CATALOG_URL"] = saved.url;
		}
	});
});

describe("issue 文本", () => {
	it("标题前缀是仓库 Action 的触发条件", () => {
		expect(presetIssueTitle("My preset")).toBe("[preset] My preset");
	});

	it("正文含 ```json 代码块（Action 只取第一个代码块）", () => {
		const doc = buildShareDoc("A", SETTINGS);
		const body = presetIssueBody(doc, "https://github.com/o/r");
		expect(body).toContain("```json");
		const parsed = parseShareDoc(body);
		expect(parsed.ok).toBe(true);
	});

	it("网页回落：小正文预填 body，大正文只预填标题", () => {
		const small = presetIssueWebUrl("o/r", "A", "body");
		expect(small).toContain("template=share-preset.yml");
		expect(small).toContain("body=body");
		const big = presetIssueWebUrl("o/r", "A", "x".repeat(5000));
		expect(big).not.toContain("body=");
		expect(decodeURIComponent(big.replace(/\+/g, " "))).toContain("[preset] A");
	});
});

describe("编排：导出", () => {
	it("导出预设：回执带 json / fileName / name", () => {
		const { port, sent } = makePort({
			presets: () => [{ ...SETTINGS, name: "P" } as never],
		});
		exportPresetVia(port, { type: "preset_export", name: "P", requestId: "export:1" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_export_result" }>;
		expect(msg.type).toBe("preset_export_result");
		expect(msg.ok).toBe(true);
		expect(msg.name).toBe("P");
		expect(msg.requestId).toBe("export:1");
		expect(msg.fileName).toMatch(/^p-[0-9a-f]{7}\.json$/);
		const doc = JSON.parse(String(msg.json));
		expect(doc.format).toBe(PRESET_SHARE_FORMAT);
		expect(doc.appVersion).toBe("9.9.9");
		expect(doc.settings).not.toHaveProperty("name");
		expect(doc.settings.customSystemPrompt).toBe("be brief");
	});

	it("导出当前设置：用 currentSettings 快照 + 兜底名", () => {
		const { port, sent } = makePort();
		exportPresetVia(port, { type: "preset_export", source: "current", requestId: "e" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_export_result" }>;
		expect(msg.ok).toBe(true);
		expect(msg.name).toBe("Current settings");
	});

	it("预设不存在：ok:false 且带 error（不抛）", () => {
		const { port, sent } = makePort();
		exportPresetVia(port, { type: "preset_export", name: "ghost" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_export_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.error).toContain("ghost");
	});
});

describe("编排：导入", () => {
	it("dryRun 只回预览，不落盘", async () => {
		const { port, sent, saved } = makePort();
		await importPresetVia(port, { type: "preset_import", json: shareText(), dryRun: true, requestId: "paste:1" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(true);
		expect(msg.dryRun).toBe(true);
		expect(msg.preview?.name).toBe("My preset");
		expect(msg.preview?.replaces).toBe(false);
		expect(saved).toEqual([]);
	});

	it("确认导入：落盘 + 推送 + notice；apply=true 时顺带应用", async () => {
		const { port, sent, saved } = makePort({ presets: () => [{ ...SETTINGS, name: "My preset" } as never] });
		await importPresetVia(port, { type: "preset_import", json: shareText(), apply: true, requestId: "paste:2" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.dryRun).toBe(false);
		expect(msg.preview?.replaces).toBe(true);
		expect(saved).toEqual(["My preset", "push", "apply:My preset"]);
		const notice = sent[1] as Extract<ServerMessage, { type: "notice" }>;
		expect(notice.type).toBe("notice");
		expect(notice.textEn).toContain("My preset");
	});

	it("导入可改名（name 覆盖文档里的名字）", async () => {
		const { port, sent, saved } = makePort();
		await importPresetVia(port, { type: "preset_import", json: shareText(), name: "Renamed" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.preview?.name).toBe("Renamed");
		expect(saved).toEqual(["Renamed", "push"]);
	});

	it("解析失败：ok:false + 错误文案，不落盘", async () => {
		const { port, sent, saved } = makePort();
		await importPresetVia(port, { type: "preset_import", json: "{oops", requestId: "paste:3" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.requestId).toBe("paste:3");
		expect(saved).toEqual([]);
	});

	it("网址导入：抓取成功走同一套预览/落盘", async () => {
		const { port, sent, saved } = makePort();
		vi.stubGlobal("fetch", async () => new Response(shareText(), { status: 200 }));
		try {
			await importPresetFromUrlVia(port, {
				type: "preset_import_url",
				url: "https://example.com/p.json",
				dryRun: true,
				requestId: "url:1",
			});
		} finally {
			vi.unstubAllGlobals();
		}
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(true);
		expect(msg.preview?.name).toBe("My preset");
		expect(saved).toEqual([]);
	});

	it("网址导入：内网地址直接拒（不抓取）", async () => {
		const { port, sent } = makePort();
		await importPresetFromUrlVia(port, { type: "preset_import_url", url: "http://127.0.0.1/p.json" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.error).toContain("private hosts");
	});

	it("网址导入：非 http(s) 拒绝", async () => {
		const { port, sent } = makePort();
		await importPresetFromUrlVia(port, { type: "preset_import_url", url: "file:///tmp/p.json" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.error).toContain("http://");
	});

	it("网址导入：抓取失败（HTTP 500）回执带错误", async () => {
		const { port, sent } = makePort();
		vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
		try {
			await importPresetFromUrlVia(port, { type: "preset_import_url", url: "https://example.com/p.json" });
		} finally {
			vi.unstubAllGlobals();
		}
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.error).toContain("500");
	});
});

describe("编排：分享与目录", () => {
	it("分享关闭（PI_WEB_PRESET_REPO=0）时明确回执", async () => {
		const saved = process.env["PI_WEB_PRESET_REPO"];
		process.env["PI_WEB_PRESET_REPO"] = "0";
		try {
			const { port, sent } = makePort({ presets: () => [{ ...SETTINGS, name: "P" } as never] });
			await sharePresetVia(port, { type: "preset_share", name: "P" });
			const msg = sent[0] as Extract<ServerMessage, { type: "preset_share_result" }>;
			expect(msg.ok).toBe(false);
			expect(msg.error).toContain("PI_WEB_PRESET_REPO");
			expect(msg.json).toBeTruthy();
		} finally {
			if (saved === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = saved;
		}
	});

	it("gh 不可用（PI_WEB_PRESET_GH 指向不存在的文件）时回落浏览器路径：method=browser + url + json", async () => {
		const savedRepo = process.env["PI_WEB_PRESET_REPO"];
		const savedGh = process.env["PI_WEB_PRESET_GH"];
		process.env["PI_WEB_PRESET_REPO"] = "o/r";
		process.env["PI_WEB_PRESET_GH"] = join(tmpdir(), "pi-web-ui-no-such-gh-binary");
		try {
			const { port, sent } = makePort({ presets: () => [{ ...SETTINGS, name: "P" } as never] });
			await sharePresetVia(port, { type: "preset_share", name: "P" });
			const msg = sent[0] as Extract<ServerMessage, { type: "preset_share_result" }>;
			expect(msg.ok).toBe(false);
			expect(msg.method).toBe("browser");
			expect(msg.url).toContain("github.com/o/r/issues/new");
			expect(msg.json).toBeTruthy();
			expect(msg.name).toBe("P");
		} finally {
			if (savedRepo === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = savedRepo;
			if (savedGh === undefined) delete process.env["PI_WEB_PRESET_GH"];
			else process.env["PI_WEB_PRESET_GH"] = savedGh;
		}
	});

	it("目录：抓取成功回执带 entries 与来源；关闭时 ok:false", async () => {
		const savedUrl = process.env["PI_WEB_PRESET_CATALOG_URL"];
		const savedRepo = process.env["PI_WEB_PRESET_REPO"];
		delete process.env["PI_WEB_PRESET_REPO"];
		process.env["PI_WEB_PRESET_CATALOG_URL"] = "https://example.com/main/index.json";
		clearPresetCatalogCache();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ version: 1, presets: [{ id: "a", name: "A", file: "presets/a.json" }] }), {
					status: 200,
				}),
		);
		try {
			const { port, sent } = makePort();
			await pushPresetCatalogVia(port, { type: "preset_catalog", requestId: "catalog:1" });
			const msg = sent[0] as Extract<ServerMessage, { type: "preset_catalog_result" }>;
			expect(msg.ok).toBe(true);
			expect(msg.entries).toHaveLength(1);
			expect(msg.entries[0]?.url).toBe("https://example.com/main/presets/a.json");
			expect(msg.source).toBe("https://example.com/main/index.json");
			expect(msg.requestId).toBe("catalog:1");
		} finally {
			vi.unstubAllGlobals();
			if (savedUrl === undefined) delete process.env["PI_WEB_PRESET_CATALOG_URL"];
			else process.env["PI_WEB_PRESET_CATALOG_URL"] = savedUrl;
			if (savedRepo === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = savedRepo;
			clearPresetCatalogCache();
		}
	});
});

describe("buildImportPreview", () => {
	it("截断长文本、带上 fields/ignored/rejected 与 replaces", () => {
		const doc = buildShareDoc("A", { customSystemPrompt: "y".repeat(1000), nope: 1 });
		const sanitized = sanitizePresetSettings(doc.settings);
		const preview = buildImportPreview("A", doc, sanitized, true);
		expect(preview.replaces).toBe(true);
		expect(preview.customSystemPrompt).toHaveLength(400);
		expect(preview.ignored).toEqual(["nope"]);
		expect(preview.fields).toEqual(sanitized.fields);
	});
});

describe("协议消息形状（前端依赖）", () => {
	it("ClientMessage 的预设分享消息可被 Extract 出来（类型级守卫）", () => {
		const msgs: ClientMessage[] = [
			{ type: "preset_export", name: "P" },
			{ type: "preset_import", json: "{}" },
			{ type: "preset_import_url", url: "https://x/y.json" },
			{ type: "preset_catalog", refresh: true },
			{ type: "preset_share", name: "P" },
		];
		expect(msgs.map((m) => m.type)).toEqual([
			"preset_export",
			"preset_import",
			"preset_import_url",
			"preset_catalog",
			"preset_share",
		]);
	});
});
