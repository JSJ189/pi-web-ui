/**
 * skill-maintenance.ts — 通用多智能体技能（Universal Multi-Agent Skills）维护管理工具。
 *
 * 功能定位：
 *   1. 跨智能体全源技能扫描与结构化维护报告（输出各生态覆盖、作用域、同名覆盖冲突）；
 *   2. 技能文件合规性与健康检查（文件大小、8KB 上限、frontmatter 规范等）；
 *   3. 跨 Agent 技能物理同步/软链维护（一键汇聚外部技能至当前工作区或全局目录）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	discoverDiskSkills,
	getMultiAgentSkillCandidateDirs,
	parseSkillFrontmatter,
	type DiscoveredSkill,
	type DiscoverSkillsOptions,
	type SkillAgentSource,
	type SkillScope,
} from "./skill-discovery.js";
import { decodeText } from "./text-sniff.js";

/** 技能扫描维护统计结果 */
export interface UniversalSkillsScanResult {
	totalUnique: number;
	totalDiscovered: number;
	skills: DiscoveredSkill[];
	bySource: Record<SkillAgentSource, number>;
	byScope: Record<SkillScope, number>;
	conflicts: Array<{
		name: string;
		chosen: DiscoveredSkill;
		overridden: DiscoveredSkill[];
	}>;
	scannedDirs: string[];
}

/** 技能单文件健康度检查结果 */
export interface SkillHealthCheck {
	valid: boolean;
	filePath: string;
	sizeBytes: number;
	exceedsBudget: boolean; // 是否超过 8KB 单文件预算
	hasFrontmatter: boolean;
	name: string;
	description: string;
	issues: string[];
}

/** 技能同步操作配置 */
export interface SyncAgentSkillsOptions {
	cwd: string;
	targetDir?: string; // 默认 <cwd>/.pi/skills
	mode?: "symlink" | "copy";
	sources?: SkillAgentSource[]; // 筛选来源，空表示全部
	dryRun?: boolean;
}

/** 执行全源技能扫描与维护统计 */
export function scanAllAgentSkills(opts: DiscoverSkillsOptions): UniversalSkillsScanResult {
	const allDirs = getMultiAgentSkillCandidateDirs(opts);
	const existingDirs = allDirs.filter((d) => existsSync(d.path)).map((d) => d.path);

	// 获取胜出的主技能
	const primarySkills = discoverDiskSkills({ ...opts, includeConflicts: false });
	// 获取所有发现的候选技能（包含同名被覆盖的）
	const allSkills = discoverDiskSkills({ ...opts, includeConflicts: true });

	const bySource: Record<SkillAgentSource, number> = {
		pi: 0,
		agents: 0,
		claude: 0,
		cursor: 0,
		windsurf: 0,
		github: 0,
		opencode: 0,
		cline: 0,
		roo: 0,
		npm: 0,
		"data-dir": 0,
		custom: 0,
	};

	const byScope: Record<SkillScope, number> = {
		project: 0,
		ancestor: 0,
		global: 0,
		package: 0,
	};

	for (const s of primarySkills) {
		if (s.source) bySource[s.source] = (bySource[s.source] || 0) + 1;
		if (s.scope) byScope[s.scope] = (byScope[s.scope] || 0) + 1;
	}

	// 识别冲突覆盖
	const mapAll = new Map<string, DiscoveredSkill[]>();
	for (const s of allSkills) {
		const key = s.name.toLowerCase();
		const list = mapAll.get(key) ?? [];
		list.push(s);
		mapAll.set(key, list);
	}

	const conflicts: UniversalSkillsScanResult["conflicts"] = [];
	for (const chosen of primarySkills) {
		const key = chosen.name.toLowerCase();
		const allSameName = mapAll.get(key) || [];
		if (allSameName.length > 1) {
			const overridden = allSameName.filter((item) => item.filePath !== chosen.filePath);
			if (overridden.length > 0) {
				conflicts.push({
					name: chosen.name,
					chosen,
					overridden,
				});
			}
		}
	}

	return {
		totalUnique: primarySkills.length,
		totalDiscovered: allSkills.length,
		skills: primarySkills,
		bySource,
		byScope,
		conflicts,
		scannedDirs: existingDirs,
	};
}

/** 生成格式化的人类与智能体可读维护报告 */
export function generateSkillsReport(result: UniversalSkillsScanResult, lang: "zh" | "en" = "zh"): string {
	const isZh = lang === "zh";
	const lines: string[] = [];

	lines.push(isZh ? "=== 跨智能体全源技能扫描与维护报告 ===" : "=== Universal Multi-Agent Skills Report ===");
	lines.push(
		isZh
			? `整合唯一技能数: ${result.totalUnique} 个 (全源物理发现: ${result.totalDiscovered} 个, 扫描目录: ${result.scannedDirs.length} 处)`
			: `Total Unique Skills: ${result.totalUnique} (Discovered: ${result.totalDiscovered}, Scanned Dirs: ${result.scannedDirs.length})`,
	);
	lines.push("");

	// 来源分布
	lines.push(isZh ? "【各智能体生态分布】:" : "[Agent Distribution]:");
	for (const [source, count] of Object.entries(result.bySource)) {
		if (count > 0) {
			lines.push(`  - ${source.toUpperCase()}: ${count} skills`);
		}
	}
	lines.push("");

	// 作用域分布
	lines.push(isZh ? "【作用域层级分布】:" : "[Scope Distribution]:");
	for (const [scope, count] of Object.entries(result.byScope)) {
		if (count > 0) {
			lines.push(`  - ${scope}: ${count} skills`);
		}
	}
	lines.push("");

	// 冲突与覆盖信息
	if (result.conflicts.length > 0) {
		lines.push(
			isZh
				? `【同名技能优先级决议 (${result.conflicts.length} 处)】:`
				: `[Skill Precedence Conflicts (${result.conflicts.length})]:`,
		);
		for (const c of result.conflicts) {
			lines.push(`  * ${c.name}:`);
			lines.push(`      [生效] [${c.chosen.source}/${c.chosen.scope}] ${c.chosen.filePath}`);
			for (const o of c.overridden) {
				lines.push(`      [覆盖] [${o.source}/${o.scope}] ${o.filePath}`);
			}
		}
		lines.push("");
	}

	// 技能简表
	lines.push(isZh ? "【整合生效技能清单】:" : "[Effective Skills Catalog]:");
	for (const s of result.skills) {
		const tag = `[${(s.source || "custom").toUpperCase()}|${s.scope || "global"}]`;
		lines.push(`  - ${s.name} ${tag}: ${s.description || "No description"} (${s.filePath})`);
	}

	return lines.join("\n");
}

/** 校验技能文件健康状态与规格预算 */
export function verifySkillFile(filePath: string): SkillHealthCheck {
	const issues: string[] = [];
	if (!existsSync(filePath)) {
		return {
			valid: false,
			filePath,
			sizeBytes: 0,
			exceedsBudget: false,
			hasFrontmatter: false,
			name: basename(filePath, ".md"),
			description: "",
			issues: ["File does not exist"],
		};
	}

	let sizeBytes = 0;
	try {
		const st = statSync(filePath);
		sizeBytes = st.size;
	} catch {
		issues.push("Cannot read file metadata");
	}

	const exceedsBudget = sizeBytes > 8192;
	if (exceedsBudget) {
		issues.push(`File size (${sizeBytes} B) exceeds the 8KB skill budget limit`);
	}

	let raw = "";
	try {
		raw = decodeText(readFileSync(filePath));
	} catch {
		issues.push("Cannot decode file text");
	}

	const hasFrontmatter = raw.trim().startsWith("---");
	if (!hasFrontmatter) {
		issues.push("Missing YAML frontmatter (recommend adding --- name & description ---)");
	}

	const fallback =
		basename(filePath).toLowerCase() === "skill.md" ? basename(dirname(filePath)) : basename(filePath, ".md");
	const parsed = parseSkillFrontmatter(raw, fallback);
	if (!parsed.description || parsed.description === `Skill ${parsed.name}`) {
		issues.push("Missing informative description");
	}

	return {
		valid: issues.length === 0,
		filePath,
		sizeBytes,
		exceedsBudget,
		hasFrontmatter,
		name: parsed.name,
		description: parsed.description,
		issues,
	};
}

/**
 * 跨 Agent 技能物理同步/软链维护：
 * 将外部 Agent（如 Claude Code 或通用 Agents）的技能同步或软链至工作区或指定目录中。
 */
export function syncAgentSkills(opts: SyncAgentSkillsOptions): {
	synced: Array<{ name: string; from: string; to: string }>;
	skipped: Array<{ name: string; reason: string }>;
} {
	const targetDir = opts.targetDir ? opts.targetDir : join(opts.cwd, ".pi", "skills");
	const mode = opts.mode || "copy";
	const dryRun = !!opts.dryRun;

	const scan = scanAllAgentSkills({ cwd: opts.cwd });
	const targetSources = opts.sources && opts.sources.length > 0 ? new Set(opts.sources) : null;

	const synced: Array<{ name: string; from: string; to: string }> = [];
	const skipped: Array<{ name: string; reason: string }> = [];

	if (!dryRun && !existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}

	for (const skill of scan.skills) {
		if (targetSources && skill.source && !targetSources.has(skill.source)) {
			continue;
		}

		// 如果目标技能已经在目标目录中，跳过
		if (skill.filePath.startsWith(targetDir)) {
			skipped.push({ name: skill.name, reason: "Already in target directory" });
			continue;
		}

		const isDirSkill = basename(skill.filePath).toLowerCase() === "skill.md";
		const destPath = isDirSkill ? join(targetDir, skill.name, "SKILL.md") : join(targetDir, `${skill.name}.md`);

		if (existsSync(destPath)) {
			skipped.push({ name: skill.name, reason: "Destination already exists" });
			continue;
		}

		if (!dryRun) {
			try {
				if (isDirSkill) {
					mkdirSync(dirname(destPath), { recursive: true });
				}
				if (mode === "symlink") {
					symlinkSync(skill.filePath, destPath);
				} else {
					copyFileSync(skill.filePath, destPath);
				}
			} catch (err) {
				skipped.push({ name: skill.name, reason: `FS Error: ${(err as Error).message}` });
				continue;
			}
		}

		synced.push({ name: skill.name, from: skill.filePath, to: destPath });
	}

	return { synced, skipped };
}
