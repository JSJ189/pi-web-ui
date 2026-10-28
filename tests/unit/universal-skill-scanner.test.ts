/**
 * universal-skill-scanner.test.ts — 通用多智能体技能扫描维护体系单元测试。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverDiskSkills,
	getMultiAgentSkillCandidateDirs,
	isSkillStillOnDisk,
	mergeSkillCollections,
	parseSkillFrontmatter,
} from "../../server/skill-discovery.js";
import {
	generateSkillsReport,
	scanAllAgentSkills,
	syncAgentSkills,
	verifySkillFile,
} from "../../server/skill-maintenance.js";
import { makeSkillTool } from "../../server/skill-tool.js";

describe("Universal Multi-Agent Skills Scanner", () => {
	let tempRoot: string;
	let fakeHome: string;
	let fakeAgentDir: string;
	let projectCwd: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-universal-skills-test-"));
		fakeHome = join(tempRoot, "home");
		fakeAgentDir = join(fakeHome, ".pi", "agent");
		projectCwd = join(tempRoot, "workspace", "repo", "subproject");

		mkdirSync(fakeHome, { recursive: true });
		mkdirSync(fakeAgentDir, { recursive: true });
		mkdirSync(projectCwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("Frontmatter 解析与边界回退", () => {
		// 1. 标准 YAML frontmatter
		const standard = `---
name: my-awesome-skill
description: Useful instructions for testing
disable-model-invocation: true
allowed-tools: bash, read
---
# Body
Some content here.`;
		const res1 = parseSkillFrontmatter(standard, "fallback");
		expect(res1.name).toBe("my-awesome-skill");
		expect(res1.description).toBe("Useful instructions for testing");
		expect(res1.disableModelInvocation).toBe(true);
		expect(res1.allowedTools).toEqual(["bash", "read"]);

		// 2. 缺少 description 时，回退取正文首段非标题文字
		const noDesc = `---
name: no-desc-skill
---
This is the first paragraph describing the skill.
Another line.`;
		const res2 = parseSkillFrontmatter(noDesc, "fallback");
		expect(res2.name).toBe("no-desc-skill");
		expect(res2.description).toBe("This is the first paragraph describing the skill.");

		// 3. 无 frontmatter 时，回退提取 Markdown 一级标题
		const pureMd = `# Specialized Diagnostic Protocol\nInstructions...`;
		const res3 = parseSkillFrontmatter(pureMd, "fallback-file");
		expect(res3.name).toBe("fallback-file");
		expect(res3.description).toBe("Specialized Diagnostic Protocol");
	});

	it("能够全源扫描识别来自各类 Agent 的技能（Pi, Claude, Agents, Cursor 等）", () => {
		// 1. 本地 Pi 技能 (.pi/skills/pi-local/SKILL.md)
		const piLocalDir = join(projectCwd, ".pi", "skills", "pi-local");
		mkdirSync(piLocalDir, { recursive: true });
		writeFileSync(join(piLocalDir, "SKILL.md"), `---\nname: pi-local\ndescription: Pi Project Skill\n---\nBody`);

		// 2. 本地 Claude Code 技能 (.claude/skills/claude-helper.md)
		const claudeProjectDir = join(projectCwd, ".claude", "skills");
		mkdirSync(claudeProjectDir, { recursive: true });
		writeFileSync(
			join(claudeProjectDir, "claude-helper.md"),
			`---\nname: claude-helper\ndescription: Claude Helper Skill\n---\nBody`,
		);

		// 3. 本地 Universal Agent 技能 (.agents/skills/agent-arch/SKILL.md)
		const agentLocalDir = join(projectCwd, ".agents", "skills", "agent-arch");
		mkdirSync(agentLocalDir, { recursive: true });
		writeFileSync(
			join(agentLocalDir, "SKILL.md"),
			`---\nname: agent-arch\ndescription: Universal Agent Arch\n---\nBody`,
		);

		// 4. 全局 Claude Code 技能 (~/.claude/skills/claude-global.md)
		const claudeGlobalDir = join(fakeHome, ".claude", "skills");
		mkdirSync(claudeGlobalDir, { recursive: true });
		writeFileSync(
			join(claudeGlobalDir, "claude-global.md"),
			`---\nname: claude-global\ndescription: Global Claude Skill\n---\nBody`,
		);

		// 5. 全局 Cursor 技能 (~/.cursor/skills/cursor-debug/SKILL.md)
		const cursorGlobalDir = join(fakeHome, ".cursor", "skills", "cursor-debug");
		mkdirSync(cursorGlobalDir, { recursive: true });
		writeFileSync(
			join(cursorGlobalDir, "SKILL.md"),
			`---\nname: cursor-debug\ndescription: Cursor Debugging Skill\n---\nBody`,
		);

		const discovered = discoverDiskSkills({
			cwd: projectCwd,
			agentDir: fakeAgentDir,
			homeDir: fakeHome,
			includeHome: true,
		});

		const names = discovered.map((s) => s.name);
		expect(names).toContain("pi-local");
		expect(names).toContain("claude-helper");
		expect(names).toContain("agent-arch");
		expect(names).toContain("claude-global");
		expect(names).toContain("cursor-debug");

		const claudeSkill = discovered.find((s) => s.name === "claude-helper");
		expect(claudeSkill?.source).toBe("claude");
		expect(claudeSkill?.scope).toBe("project");

		const cursorSkill = discovered.find((s) => s.name === "cursor-debug");
		expect(cursorSkill?.source).toBe("cursor");
		expect(cursorSkill?.scope).toBe("global");
	});

	it("祖先链回溯发现仓库根目录的技能（Monorepo / Worktree 场景）", () => {
		// 在 repo 根目录（projectCwd 的上一级）创建 .git 与 .pi/skills
		const repoRoot = join(tempRoot, "workspace", "repo");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		const rootSkillDir = join(repoRoot, ".pi", "skills", "repo-root-skill");
		mkdirSync(rootSkillDir, { recursive: true });
		writeFileSync(
			join(rootSkillDir, "SKILL.md"),
			`---\nname: repo-root-skill\ndescription: Shared Repo Skill\n---\nRoot Instructions`,
		);

		const discovered = discoverDiskSkills({
			cwd: projectCwd, // 子目录
			agentDir: fakeAgentDir,
			includeHome: false,
			scanAncestors: true,
		});

		const rootSkill = discovered.find((s) => s.name === "repo-root-skill");
		expect(rootSkill).toBeDefined();
		expect(rootSkill?.scope).toBe("ancestor");
		expect(rootSkill?.depth).toBe(1);
	});

	it("同名技能的优先级决议：项目级优先于全局级，Pi 优先于外部 Agent", () => {
		// 在全局与本地同时放置同名技能 "code-reviewer"
		const globalDir = join(fakeAgentDir, "skills", "code-reviewer");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(
			join(globalDir, "SKILL.md"),
			`---\nname: code-reviewer\ndescription: Global Code Reviewer\n---\nGlobal`,
		);

		const localDir = join(projectCwd, ".pi", "skills", "code-reviewer");
		mkdirSync(localDir, { recursive: true });
		writeFileSync(
			join(localDir, "SKILL.md"),
			`---\nname: code-reviewer\ndescription: Local Project Reviewer\n---\nLocal`,
		);

		const discovered = discoverDiskSkills({
			cwd: projectCwd,
			agentDir: fakeAgentDir,
			homeDir: fakeHome,
			includeHome: true,
		});

		const chosen = discovered.find((s) => s.name === "code-reviewer");
		expect(chosen).toBeDefined();
		expect(chosen?.description).toBe("Local Project Reviewer");
		expect(chosen?.scope).toBe("project");
	});

	it("mergeSkillCollections 能够将多 Agent 技能无缝注入 SDK 技能列表", () => {
		const existingSdkSkills = [
			{ name: "sdk-builtin", description: "Builtin", filePath: "/path/to/sdk-builtin/SKILL.md" },
		];

		const multiAgentDiscovered = [
			{
				name: "claude-analysis",
				description: "Claude Analyzer",
				filePath: "/path/to/claude/SKILL.md",
				dirPath: "/path/to/claude",
				source: "claude" as const,
				scope: "global" as const,
			},
		];

		const merged = mergeSkillCollections(existingSdkSkills, multiAgentDiscovered);
		expect(merged.length).toBe(2);
		expect(merged.map((s) => s.name)).toEqual(["claude-analysis", "sdk-builtin"]);
		expect(merged.find((s) => s.name === "claude-analysis")?.filePath).toBe("/path/to/claude/SKILL.md");
	});

	it("isSkillStillOnDisk 正确验证不同 Agent 技能的物理存在性", () => {
		const claudeDir = join(projectCwd, ".claude", "skills");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(join(claudeDir, "existing-skill.md"), `Content`);

		expect(isSkillStillOnDisk("existing-skill", { cwd: projectCwd, agentDir: fakeAgentDir })).toBe(true);
		expect(isSkillStillOnDisk("deleted-skill", { cwd: projectCwd, agentDir: fakeAgentDir })).toBe(false);
	});

	it("整合后的技能能被 skill 工具精确调用并读取正文，且支持维护报告查询", async () => {
		// 创建一个真实的技能文件
		const skillPath = join(projectCwd, ".agents", "skills", "test-agent-skill", "SKILL.md");
		mkdirSync(join(projectCwd, ".agents", "skills", "test-agent-skill"), { recursive: true });
		writeFileSync(
			skillPath,
			`---\nname: test-agent-skill\ndescription: Agent Integration Test\n---\n# Specialist Instructions\nExecute step A and B.`,
		);

		const mockHost = {
			listSkills: () => [
				{
					name: "test-agent-skill",
					description: "Agent Integration Test",
					filePath: skillPath,
					source: "agents",
					scope: "project",
				},
			],
		};

		const tool = makeSkillTool(mockHost, () => "zh");

		// 1. 模型按名读取正文
		const callRes = await tool.execute(
			"call_1",
			{ name: "test-agent-skill" },
			undefined as any,
			undefined as any,
			{} as any,
		);
		const content = (callRes as any).content[0].text;
		expect(content).toContain('<skill name="test-agent-skill"');
		expect(content).toContain("Specialist Instructions");

		// 2. 查看多智能体维护报告
		const reportRes = await tool.execute("call_2", { action: "report" }, undefined as any, undefined as any, {} as any);
		const reportText = (reportRes as any).content[0].text;
		expect(reportText).toContain("跨智能体技能整合报告");
		expect(reportText).toContain("AGENTS: 1");
		expect(reportText).toContain("test-agent-skill");
	});

	it("通用维护工具层：scanAllAgentSkills, verifySkillFile 与 syncAgentSkills", () => {
		// 创建一个合法技能与一个超限技能
		const skillsDir = join(projectCwd, ".claude", "skills");
		mkdirSync(skillsDir, { recursive: true });

		const validSkillFile = join(skillsDir, "valid.md");
		writeFileSync(validSkillFile, `---\nname: valid\ndescription: Good skill\n---\nInstructions`);

		const oversizedSkillFile = join(skillsDir, "oversized.md");
		writeFileSync(oversizedSkillFile, "A".repeat(9000)); // 超过 8KB

		// 1. 扫描与维护报告
		const scan = scanAllAgentSkills({ cwd: projectCwd, agentDir: fakeAgentDir, includeHome: false });
		expect(scan.totalUnique).toBeGreaterThanOrEqual(2);
		expect(scan.bySource.claude).toBeGreaterThanOrEqual(2);

		const report = generateSkillsReport(scan, "zh");
		expect(report).toContain("跨智能体全源技能扫描与维护报告");
		expect(report).toContain("CLAUDE:");

		// 2. 健康检查
		const health1 = verifySkillFile(validSkillFile);
		expect(health1.valid).toBe(true);
		expect(health1.exceedsBudget).toBe(false);

		const health2 = verifySkillFile(oversizedSkillFile);
		expect(health2.valid).toBe(false);
		expect(health2.exceedsBudget).toBe(true);

		// 3. 跨 Agent 技能物理同步（将 Claude 技能同步至 .pi/skills）
		const targetPiDir = join(projectCwd, ".pi", "skills");
		const syncRes = syncAgentSkills({
			cwd: projectCwd,
			targetDir: targetPiDir,
			mode: "copy",
		});
		expect(syncRes.synced.length).toBeGreaterThanOrEqual(1);
	});
});
