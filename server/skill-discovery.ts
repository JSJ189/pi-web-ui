/**
 * skill-discovery.ts — 通用跨智能体技能（Universal Multi-Agent Skills）全源扫描、解析与整合引擎。
 *
 * 覆盖生态与目录规范：
 *   1. Pi Coding Agent:
 *      - 全局：$PI_CODING_AGENT_DIR/skills 或 ~/.pi/agent/skills/
 *      - 本地：<cwd>/.pi/skills/ 及多根工作区 <root>/.pi/skills/
 *      - 祖先：沿工作区向上回溯的父级 .pi/skills/
 *      - npm 包：<agentDir>/npm/node_modules/<pkg>/skills 与 <cwd>/.pi/npm/node_modules/<pkg>/skills
 *   2. Universal Agent Skills 规范 (issue #669 / OpenAI Codex / Anthropic 标准):
 *      - 全局：~/.agents/skills/
 *      - 本地：<cwd>/.agents/skills/
 *      - 祖先：沿工作区向上回溯的最多 6 层 .agents/skills/
 *   3. Claude Code:
 *      - 全局：~/.claude/skills/
 *      - 本地：<cwd>/.claude/skills/ 与祖先 .claude/skills/
 *   4. Cursor / Windsurf / GitHub Copilot / OpenCode / Cline / Roo Code:
 *      - 本地/全局的 .cursor/skills, .windsurf/skills, .github/skills, .opencode/skills 等
 *   5. WebUI 本地数据目录：
 *      - <dataDir>/skills/ (例如 ~/.pi-web/skills/)
 *
 * 技能结构：
 *   1. 目录形式（标准）：<skill-name>/SKILL.md
 *   2. 独立文件形式：<skill-name>.md
 *   3. 嵌套分类目录：<category>/<skill-name>/SKILL.md
 *
 * 优先级与冲突决议：
 *   Scope 优先级：本地项目 (project) > 祖先目录 (ancestor, 深度越浅越优) > 用户全局 (global) > npm包 (package)
 *   同 Scope 来源优先级：pi > agents > claude > cursor > windsurf > github > opencode > 其他
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { decodeText } from "./text-sniff.js";

/** 支持识别的智能体来源生态 */
export type SkillAgentSource =
	| "pi"
	| "agents"
	| "claude"
	| "cursor"
	| "windsurf"
	| "github"
	| "opencode"
	| "cline"
	| "roo"
	| "npm"
	| "data-dir"
	| "custom";

/** 技能作用域范围 */
export type SkillScope = "project" | "ancestor" | "global" | "package";

/** 扫描发现的技能元数据定义（完全兼容旧版字段） */
export interface DiscoveredSkill {
	name: string;
	description: string;
	descriptionEn?: string;
	filePath: string;
	dirPath: string;
	source?: SkillAgentSource;
	scope?: SkillScope;
	depth?: number;
	disableModelInvocation?: boolean;
	allowedTools?: string[];
}

/** 候选技能扫描目录条目 */
export interface SkillCandidateDir {
	path: string;
	source: SkillAgentSource;
	scope: SkillScope;
	depth: number;
}

/** 技能发现配置参数 */
export interface DiscoverSkillsOptions {
	cwd: string;
	agentDir?: string;
	homeDir?: string;
	includeHome?: boolean;
	workspaceRoots?: string[];
	scanAncestors?: boolean;
	maxAncestorDepth?: number;
	includeNpm?: boolean;
	dataDir?: string;
	/** 是否返回包含冲突被覆盖的全部候选项（默认 false：仅返回胜出的主技能） */
	includeConflicts?: boolean;
}

/** 解析 SKILL.md 的 YAML frontmatter 提取 name, description 与元数据配置 */
export function parseSkillFrontmatter(
	content: string,
	fallbackName: string,
): {
	name: string;
	description: string;
	disableModelInvocation?: boolean;
	allowedTools?: string[];
} {
	const trimmed = content.trim();
	let name = fallbackName;
	let description = "";
	let disableModelInvocation = false;
	let allowedTools: string[] | undefined;

	if (trimmed.startsWith("---")) {
		const secondDash = trimmed.indexOf("\n---", 3);
		if (secondDash !== -1) {
			const header = trimmed.slice(3, secondDash);
			for (const line of header.split("\n")) {
				const colon = line.indexOf(":");
				if (colon <= 0) continue;
				const key = line.slice(0, colon).trim().toLowerCase();
				let val = line.slice(colon + 1).trim();
				if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
					val = val.slice(1, -1);
				}
				if (key === "name" && val) {
					name = val;
				} else if (key === "description" && val) {
					description = val;
				} else if (key === "disable-model-invocation" || key === "disablemodelinvocation") {
					disableModelInvocation = val === "true" || val === "1" || val === "yes";
				} else if (key === "allowed-tools" || key === "allowedtools") {
					allowedTools = val
						.split(/[\s,]+/)
						.map((t) => t.trim())
						.filter(Boolean);
				}
			}
			// 若 frontmatter 缺 description，取正文第一行非标题段落
			if (!description) {
				const rest = trimmed.slice(secondDash + 4).trim();
				const firstLine = rest.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
				if (firstLine) description = firstLine.trim();
			}
		}
	}

	if (!description) {
		const firstHeader = trimmed.split("\n").find((l) => l.trim().startsWith("#"));
		if (firstHeader) {
			description = firstHeader.replace(/^#+\s*/, "").trim();
		} else {
			description = `Skill ${name}`;
		}
	}

	return { name, description, disableModelInvocation, allowedTools };
}

/** 规范化计算全局 Agent 目录 */
export function resolveGlobalAgentDir(explicitAgentDir?: string): string {
	if (explicitAgentDir?.trim()) return explicitAgentDir.trim();
	if (process.env.PI_CODING_AGENT_DIR?.trim()) return process.env.PI_CODING_AGENT_DIR.trim();
	return join(homedir(), ".pi", "agent");
}

/**
 * 收集当前环境所有可能存在技能的候选目录。
 */
export function getMultiAgentSkillCandidateDirs(opts: DiscoverSkillsOptions): SkillCandidateDir[] {
	const dirs: SkillCandidateDir[] = [];
	const seenPaths = new Set<string>();

	const add = (p: string, source: SkillAgentSource, scope: SkillScope, depth = 0) => {
		const normalized = resolve(p);
		if (!seenPaths.has(normalized)) {
			seenPaths.add(normalized);
			dirs.push({ path: normalized, source, scope, depth });
		}
	};

	const cwd = opts.cwd ? resolve(opts.cwd) : "";
	const home = opts.homeDir ? resolve(opts.homeDir) : homedir();
	const agentDir = resolveGlobalAgentDir(opts.agentDir);

	// 1. 本地工作区（CWD 及其声明的多根工作区）
	const rootDirs = [cwd];
	if (Array.isArray(opts.workspaceRoots)) {
		for (const r of opts.workspaceRoots) {
			if (r && typeof r === "string") rootDirs.push(resolve(r));
		}
	}

	for (const r of rootDirs) {
		if (!r) continue;
		// 优先级最高的各 Agent 本地目录
		add(join(r, ".pi", "skills"), "pi", "project", 0);
		add(join(r, ".agents", "skills"), "agents", "project", 0);
		add(join(r, ".claude", "skills"), "claude", "project", 0);
		add(join(r, ".cursor", "skills"), "cursor", "project", 0);
		add(join(r, ".windsurf", "skills"), "windsurf", "project", 0);
		add(join(r, ".github", "skills"), "github", "project", 0);
		add(join(r, ".opencode", "skills"), "opencode", "project", 0);
	}

	// 2. 祖先目录链回溯（向上最多 6 层，直到文件系统根、用户主目录或 git 根）
	if (cwd && opts.scanAncestors !== false) {
		const maxDepth = typeof opts.maxAncestorDepth === "number" ? opts.maxAncestorDepth : 6;
		let cur = dirname(cwd);
		for (let i = 1; i <= maxDepth && cur && cur !== dirname(cur); i++, cur = dirname(cur)) {
			// 若回溯到了用户家目录，祖先扫描终止（家目录层级归属于 opts.includeHome 管辖，避免污染祖先 scope）
			if (cur === home) break;
			add(join(cur, ".pi", "skills"), "pi", "ancestor", i);
			add(join(cur, ".agents", "skills"), "agents", "ancestor", i);
			add(join(cur, ".claude", "skills"), "claude", "ancestor", i);
			add(join(cur, ".cursor", "skills"), "cursor", "ancestor", i);
			// 遇到 .git 目录说明已达仓库顶层，再上一层通常不是同个项目
			if (existsSync(join(cur, ".git"))) {
				break;
			}
		}
	}

	// 3. 用户全局主目录（各类 Agent 的全局配置区）
	// 注意：agentDir 作为显式传入或配置的全局 Agent 目录，不受 includeHome 控制（includeHome 仅控制是否扫描系统 ~ 家目录下的各第三方 agent 目录）
	add(join(agentDir, "skills"), "pi", "global", 0);

	if (opts.includeHome !== false) {
		// 通用 Agent 规范全局目录 (issue #669)
		add(join(home, ".agents", "skills"), "agents", "global", 0);
		// Claude Code 全局目录
		add(join(home, ".claude", "skills"), "claude", "global", 0);
		// Cursor 全局目录
		add(join(home, ".cursor", "skills"), "cursor", "global", 0);
		// Windsurf / Codeium 全局目录
		add(join(home, ".windsurf", "skills"), "windsurf", "global", 0);
		add(join(home, ".codeium", "windsurf", "skills"), "windsurf", "global", 0);
		// OpenCode / Cline / Roo Code 全局目录
		add(join(home, ".config", "opencode", "skills"), "opencode", "global", 0);
		add(join(home, ".cline", "skills"), "cline", "global", 0);
		add(join(home, ".roo-code", "skills"), "roo", "global", 0);

		// WebUI 本地数据目录
		if (opts.dataDir) {
			add(join(opts.dataDir, "skills"), "data-dir", "global", 0);
		}
	}

	// 4. npm 技能包目录（已安装的插件与技能包）
	if (opts.includeNpm !== false) {
		const npmRoots: string[] = [join(agentDir, "npm", "node_modules")];
		if (cwd) {
			npmRoots.push(join(cwd, ".pi", "npm", "node_modules"));
		}
		for (const npmRoot of npmRoots) {
			if (!existsSync(npmRoot)) continue;
			try {
				const entries = readdirSync(npmRoot, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					if (!entry.name.startsWith("@")) {
						add(join(npmRoot, entry.name, "skills"), "npm", "package", 0);
					} else {
						// scoped package: @org/pkg/skills
						try {
							const subEntries = readdirSync(join(npmRoot, entry.name), { withFileTypes: true });
							for (const sub of subEntries) {
								if (sub.isDirectory()) {
									add(join(npmRoot, entry.name, sub.name, "skills"), "npm", "package", 0);
								}
							}
						} catch {
							/* 忽略坏目录 */
						}
					}
				}
			} catch {
				/* 忽略读取错误 */
			}
		}
	}

	return dirs;
}

/** 计算技能来源条目的综合排序得分（用于同名决议：高分优先覆盖） */
function getSkillPriorityScore(skill: DiscoveredSkill): number {
	// Scope 基础分
	let scopeScore = 0;
	if (skill.scope === "project") scopeScore = 1000;
	else if (skill.scope === "ancestor") scopeScore = 800 - Math.min(skill.depth ?? 1, 10) * 20;
	else if (skill.scope === "global") scopeScore = 500;
	else if (skill.scope === "package") scopeScore = 200;

	// Source 优先分（同 scope 下优先级）
	let sourceScore = 0;
	switch (skill.source) {
		case "pi":
			sourceScore = 90;
			break;
		case "agents":
			sourceScore = 80;
			break;
		case "claude":
			sourceScore = 70;
			break;
		case "cursor":
			sourceScore = 60;
			break;
		case "windsurf":
			sourceScore = 50;
			break;
		case "github":
			sourceScore = 40;
			break;
		case "opencode":
			sourceScore = 30;
			break;
		case "data-dir":
			sourceScore = 20;
			break;
		case "npm":
			sourceScore = 10;
			break;
		default:
			sourceScore = 5;
			break;
	}

	return scopeScore + sourceScore;
}

/**
 * 递归/顺序扫描全源各候选目录，发现并整合来自所有 Agent 的技能。
 */
export function discoverDiskSkills(opts: DiscoverSkillsOptions): DiscoveredSkill[] {
	const candidateDirs = getMultiAgentSkillCandidateDirs(opts);
	// key: skillName.toLowerCase() -> 候选列表
	const skillCandidates = new Map<string, DiscoveredSkill[]>();

	for (const candidate of candidateDirs) {
		if (!existsSync(candidate.path)) continue;
		try {
			const entries = readdirSync(candidate.path, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;

				if (entry.isDirectory()) {
					// 1. 目录型标准结构：<baseDir>/<entry>/SKILL.md
					const skillMd = join(candidate.path, entry.name, "SKILL.md");
					if (existsSync(skillMd)) {
						try {
							const text = decodeText(readFileSync(skillMd));
							const parsed = parseSkillFrontmatter(text, entry.name);
							const item: DiscoveredSkill = {
								name: parsed.name,
								description: parsed.description,
								filePath: skillMd,
								dirPath: join(candidate.path, entry.name),
								source: candidate.source,
								scope: candidate.scope,
								depth: candidate.depth,
								disableModelInvocation: parsed.disableModelInvocation,
								allowedTools: parsed.allowedTools,
							};
							const key = parsed.name.toLowerCase();
							const list = skillCandidates.get(key) ?? [];
							list.push(item);
							skillCandidates.set(key, list);
						} catch {
							/* 忽略单文件损坏 */
						}
					} else {
						// 2. 检查单层分类子目录：<baseDir>/<category>/<skill>/SKILL.md
						try {
							const subEntries = readdirSync(join(candidate.path, entry.name), { withFileTypes: true });
							for (const sub of subEntries) {
								if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
								const nestedMd = join(candidate.path, entry.name, sub.name, "SKILL.md");
								if (existsSync(nestedMd)) {
									try {
										const text = decodeText(readFileSync(nestedMd));
										const parsed = parseSkillFrontmatter(text, sub.name);
										const item: DiscoveredSkill = {
											name: parsed.name,
											description: parsed.description,
											filePath: nestedMd,
											dirPath: join(candidate.path, entry.name, sub.name),
											source: candidate.source,
											scope: candidate.scope,
											depth: candidate.depth,
											disableModelInvocation: parsed.disableModelInvocation,
											allowedTools: parsed.allowedTools,
										};
										const key = parsed.name.toLowerCase();
										const list = skillCandidates.get(key) ?? [];
										list.push(item);
										skillCandidates.set(key, list);
									} catch {}
								}
							}
						} catch {}
					}
				} else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
					// 3. 单文件 Markdown 形式：<baseDir>/<name>.md
					const filePath = join(candidate.path, entry.name);
					const base = basename(entry.name, ".md");
					try {
						const text = decodeText(readFileSync(filePath));
						const parsed = parseSkillFrontmatter(text, base);
						const item: DiscoveredSkill = {
							name: parsed.name,
							description: parsed.description,
							filePath,
							dirPath: candidate.path,
							source: candidate.source,
							scope: candidate.scope,
							depth: candidate.depth,
							disableModelInvocation: parsed.disableModelInvocation,
							allowedTools: parsed.allowedTools,
						};
						const key = parsed.name.toLowerCase();
						const list = skillCandidates.get(key) ?? [];
						list.push(item);
						skillCandidates.set(key, list);
					} catch {
						/* 忽略单文件损坏 */
					}
				}
			}
		} catch {
			/* 目录读取异常静默跳过 */
		}
	}

	const results: DiscoveredSkill[] = [];
	for (const list of skillCandidates.values()) {
		if (list.length === 0) continue;
		// 按照优先级得分降序排序，取最高分的作为主技能
		list.sort((a, b) => getSkillPriorityScore(b) - getSkillPriorityScore(a));
		if (opts.includeConflicts) {
			results.push(...list);
		} else {
			results.push(list[0]);
		}
	}

	// 保持名称排序以提供稳定确定性
	results.sort((a, b) => a.name.localeCompare(b.name));
	return results;
}

/** 读取技能完整指令正文（若含 frontmatter，保留或剥离后返回有效指令） */
export function readSkillInstruction(filePath: string): string {
	if (!existsSync(filePath)) return "";
	try {
		const raw = decodeText(readFileSync(filePath)).trim();
		return raw;
	} catch {
		return "";
	}
}

/**
 * 跨 Agent 技能与 SDK 原生技能集合并器。
 * 将从磁盘多来源扫描整合出的技能，注入到现有技能列表中（按 name 去重，已存在的保留原有对象并补齐 filePath）。
 */
export function mergeSkillCollections<T extends { name: string; description?: string; filePath?: string }>(
	existingSkills: T[],
	discoveredSkills: DiscoveredSkill[],
): T[] {
	const map = new Map<string, T>();

	// 1. 先加入已有技能
	for (const s of existingSkills) {
		map.set(s.name.toLowerCase(), { ...s });
	}

	// 2. 将发现的新技能合并进来
	for (const d of discoveredSkills) {
		const key = d.name.toLowerCase();
		const current = map.get(key);
		if (!current) {
			map.set(key, {
				name: d.name,
				description: d.description,
				filePath: d.filePath,
				source: d.source,
				scope: d.scope,
				disableModelInvocation: d.disableModelInvocation,
				allowedTools: d.allowedTools,
			} as unknown as T);
		} else if (!current.filePath && d.filePath) {
			// 如果已有技能缺少物理路径，补齐物理路径
			current.filePath = d.filePath;
		}
	}

	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 判断指定 skill 名称是否仍物理存在于任意可用 Agent 来源目录中。
 * 供 settings-service 的清理逻辑与验证逻辑使用，替代手写的固定目录判断。
 */
export function isSkillStillOnDisk(
	skillName: string,
	opts: { cwd: string; agentDir?: string; workspaceRoots?: string[] },
): boolean {
	const n = skillName.trim().toLowerCase();
	if (!n) return false;

	const candidateDirs = getMultiAgentSkillCandidateDirs({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		workspaceRoots: opts.workspaceRoots,
		scanAncestors: true,
		includeHome: true,
		includeNpm: true,
	});

	for (const candidate of candidateDirs) {
		if (!existsSync(candidate.path)) continue;
		// 检查目录结构: <dir>/<skillName>/SKILL.md
		const dirSkill = join(candidate.path, skillName, "SKILL.md");
		if (existsSync(dirSkill)) return true;
		// 检查单文件结构: <dir>/<skillName>.md
		const mdSkill = join(candidate.path, `${skillName}.md`);
		if (existsSync(mdSkill)) return true;
	}

	return false;
}
