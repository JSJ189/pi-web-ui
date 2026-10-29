import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSubagentWorktree, finalizeSubagentWorktree, removeWorktree } from "../../server/worktree-service.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-wt-preserve-"));
	roots.push(root);
	await exec("git", ["init", "-b", "main"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	writeFileSync(join(root, "tracked.txt"), "base");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "-m", "base"], { cwd: root });
	const wt = await createSubagentWorktree(root, "sa-preserve");
	return { root, wt };
}

describe("worktree cleanup requires positively verified clean state", () => {
	it("preserves uncommitted work if status fails while HEAD remains readable", async () => {
		const { root, wt } = await fixture();
		writeFileSync(join(wt.worktreePath, "valuable.txt"), "keep this work");
		const gitDir = readFileSync(join(wt.worktreePath, ".git"), "utf8")
			.trim()
			.replace(/^gitdir: /, "");
		writeFileSync(join(gitDir, "index"), "invalid index");
		await expect(exec("git", ["rev-parse", "HEAD"], { cwd: wt.worktreePath })).resolves.toBeDefined();
		const result = await finalizeSubagentWorktree(wt);
		expect(result.cleanedUp).toBe(false);
		expect(result.error).toContain("Cannot verify worktree status");
		expect(readFileSync(join(wt.worktreePath, "valuable.txt"), "utf8")).toBe("keep this work");
		const branches = await exec("git", ["branch", "--list", wt.branch], { cwd: root });
		expect(branches.stdout).toContain(wt.branch);
	});

	it("cleans verified unchanged work and conditionally deletes its branch", async () => {
		const { root, wt } = await fixture();
		const result = await finalizeSubagentWorktree(wt);
		expect(result.error).toBeUndefined();
		expect(result.cleanedUp).toBe(true);
		expect(existsSync(wt.worktreePath)).toBe(false);
		const branches = await exec("git", ["branch", "--list", wt.branch], { cwd: root });
		expect(branches.stdout.trim()).toBe("");
	});

	it("non-forced explicit removal also fails closed on unreadable status", async () => {
		const { root, wt } = await fixture();
		const gitDir = readFileSync(join(wt.worktreePath, ".git"), "utf8")
			.trim()
			.replace(/^gitdir: /, "");
		writeFileSync(join(gitDir, "index"), "invalid index");
		await expect(removeWorktree(root, wt.worktreePath)).rejects.toThrow("Cannot verify worktree status");
		expect(existsSync(wt.worktreePath)).toBe(true);
	});
});
