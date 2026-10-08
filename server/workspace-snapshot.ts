/**
 * server/workspace-snapshot.ts
 *
 * 工作区版本影子快照机制（Workspace Snapshot / Dual-State Rollback）。
 *
 * 每次用户发起新任务或运行关键操作前，为当前工作区记录轻量快照引用（Git commit SHA）。
 * 机制：
 * - 利用独立的临时 GIT_INDEX_FILE，通过 `git add -A -- .` + `git write-tree` + `git commit-tree` 生成独立 commit；
 * - 快照只覆盖对话 cwd 的**子树**（而非整个工作区），commit-tree 的顶层因此只有该子目录一个条目；
 * - 绝不改变用户现有的 HEAD、branch 指针、工作区文件或 .git/index；
 * - 回滚时若启用 restoreWorkspace，通过 `git checkout <snapshotRef> -- <prefix>` 与 `git clean -fd -- <prefix>`
 *   只还原/清理 cwd 子树，绝不触碰同仓库的兄弟目录。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitDirOf } from "./scm.js";

const exec = promisify(execFile);

/** 单次 git 快照/还原命令超时时间（毫秒）。 */
const GIT_SNAPSHOT_TIMEOUT_MS = 15_000;

/** 执行单条 git 命令，返回 stdout。 */
async function runGit(cwd: string, args: string[], envExtra?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
		cwd,
		env: envExtra ? { ...process.env, ...envExtra } : process.env,
		timeout: GIT_SNAPSHOT_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	return stdout.trim();
}

/** 检查工作区是否由 Git 管理。 */
export async function isGitWorkspace(cwd: string): Promise<boolean> {
	return (await gitDirOf(cwd)) !== null;
}

/**
 * 为当前工作区创建轻量版本快照。
 * 若当前目录不在 Git 仓库内，返回 null。
 *
 * 该操作纯粹在临时 index 文件中完成，绝不影响用户的实际 index 或 HEAD。
 */
export async function createWorkspaceSnapshot(cwd: string): Promise<string | null> {
	const gitDir = await gitDirOf(cwd);
	if (!gitDir) return null;

	const tempIndex = join(gitDir, `temp-index-snapshot-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: tempIndex };

	try {
		// 1. 将 cwd 子树（而非整个工作区）的当前改动（含未跟踪与新增）记录到临时 index；
		//    暂存路径相对仓库根，write-tree 顶层因此只有该子目录一个条目
		await runGit(cwd, ["add", "-A", "--", "."], env);

		// 2. 写入 tree 对象
		const tree = await runGit(cwd, ["write-tree"], env);
		if (!tree) return null;

		// 3. 检查是否有 HEAD commit 作为 parent
		let hasHead = false;
		try {
			await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
			hasHead = true;
		} catch {
			hasHead = false;
		}

		// 4. 创建轻量 commit 对象，不关联任何分支引用
		const commitArgs = ["commit-tree", tree];
		if (hasHead) {
			commitArgs.push("-p", "HEAD");
		}
		commitArgs.push("-m", `pi-web-ui: workspace shadow snapshot ${new Date().toISOString()}`);

		const commitHash = await runGit(cwd, commitArgs, env);
		return commitHash || null;
	} catch (err) {
		console.warn(`[workspace-snapshot] 创建快照失败 (${cwd}):`, (err as Error).message);
		return null;
	} finally {
		// 务必清理临时 index 文件
		try {
			await rm(tempIndex, { force: true });
		} catch {
			// ignore cleanup error
		}
	}
}

/**
 * 将工作区物理文件还原到指定的快照状态，作用范围严格限定在 cwd 子树内。
 *
 * 执行步骤：
 * - 仓库根 cwd：使用原子 `git read-tree -u --reset` + `git clean -fd` 整仓还原（天然支持空仓库快照）；
 * - 子目录 cwd（pathspec 以 `:(top)` 锚定到仓库根的 cwd 前缀）：
 *   1. `git rm -r --cached -- <pathspec>` 把 cwd 子树移出 index（工作区文件不动），使快照中
 *      不存在的文件退回未跟踪状态——这一步让 checkout 之外的「快照后新增且已 add」的文件也能被回滚；
 *   2. `git checkout <snapshotRef> -- <pathspec>` 把快照内容写回 index 与工作区（恢复被修改/删除的跟踪文件，快照无该子树文件时容错跳过）；
 *   3. `git clean -fd -- <pathspec>` 清理快照之后新增的未跟踪文件与空目录。
 * 同仓库的兄弟目录在以上任何一步都不受影响。
 */
export async function restoreWorkspaceSnapshot(
	cwd: string,
	snapshotRef: string,
): Promise<{ success: boolean; error?: string }> {
	const gitDir = await gitDirOf(cwd);
	if (!gitDir) {
		return { success: false, error: "Workspace is not a Git repository" };
	}

	try {
		// 验证 snapshotRef 合法性
		await runGit(cwd, ["rev-parse", "--verify", snapshotRef]);

		// cwd 相对仓库根的前缀（子目录形如 `proj/`，仓库根为空串）。
		const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"]);

		if (!prefix) {
			// 仓库根 cwd：整仓还原，使用原子 read-tree --reset，旧实现经过长期验证且天然支持空仓库快照
			await runGit(cwd, ["read-tree", "-u", "--reset", snapshotRef]);
			await runGit(cwd, ["clean", "-fd"]);
			return { success: true };
		}

		// 子目录 cwd：作用域收敛到该子树，不误伤同仓兄弟目录与仓库根
		const pathspec = `:(top)${prefix}`;

		// 1. 把 cwd 子树移出 index（不删除工作区文件），快照里不存在的文件由此退回未跟踪状态
		await runGit(cwd, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", pathspec]);

		// 2. 从快照树把 cwd 子树写回 index 与工作区（恢复被修改与被删除的跟踪文件）
		//    注：若快照时刻该子树为空（快照树内无匹配文件），checkout 会报
		//    "did not match any file(s) known to git"；此时快照树内本无文件，捕获忽略即可，
		//    第 3 步 clean 会清理掉新增文件完成空状态还原。
		try {
			await runGit(cwd, ["checkout", snapshotRef, "--", pathspec]);
		} catch (checkoutErr) {
			const errMsg = String(checkoutErr);
			if (!errMsg.includes("did not match any file(s) known to git")) {
				throw checkoutErr;
			}
		}

		// 3. 清理快照之后新增的未跟踪文件与空目录（含第 1 步退回未跟踪的那些）
		await runGit(cwd, ["clean", "-fd", "--", pathspec]);

		return { success: true };
	} catch (err) {
		const msg = (err as Error).message;
		console.error(`[workspace-snapshot] 还原快照失败 (${cwd}, ${snapshotRef}):`, msg);
		return { success: false, error: msg };
	}
}
