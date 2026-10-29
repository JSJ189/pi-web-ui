import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxManager, evaluateSandboxJail } from "../../server/sandbox-service.js";

const roots: string[] = [];
async function setup() {
	const root = mkdtempSync(join(tmpdir(), "sandbox-integration-"));
	roots.push(root);
	const source = join(root, "source");
	mkdirSync(source);
	writeFileSync(join(source, "file.txt"), "baseline");
	const manager = new SandboxManager(join(root, "data"));
	const { sandbox } = await manager.create({ sourcePath: source });
	return { source, manager, sandbox };
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sandbox identity, admission and merge integration", () => {
	it("keeps independent source work while applying an approved sandbox change", async () => {
		const { source, manager, sandbox } = await setup();
		writeFileSync(join(sandbox.path, "added.txt"), "sandbox-work");
		writeFileSync(join(source, "file.txt"), "source-work");
		writeFileSync(join(source, "new.txt"), "new-source-work");
		const preview = await manager.diffWithSource(sandbox.id);
		expect(preview.modified).toEqual([]);
		expect(preview.deleted).toEqual([]);
		await manager.applyToSource(sandbox.id, preview.expectedRevision);
		expect(readFileSync(join(source, "file.txt"), "utf8")).toBe("source-work");
		expect(readFileSync(join(source, "new.txt"), "utf8")).toBe("new-source-work");
		expect(readFileSync(join(source, "added.txt"), "utf8")).toBe("sandbox-work");
	});

	it("refuses mutation with an execution lease and releases it idempotently", async () => {
		const { manager, sandbox } = await setup();
		const release = manager.acquireExecution(sandbox.path, sandbox);
		await expect(manager.reset(sandbox.id)).rejects.toThrow(/running|execution/i);
		release();
		release();
		await manager.reset(sandbox.id);
		expect(manager.getExecutionIdentity(sandbox.path, sandbox)?.id).toBe(sandbox.id);
	});

	it("freezes new execution before lifecycle owners are stopped", async () => {
		const { manager, sandbox } = await setup();
		const release = manager.acquireExecution(sandbox.path, sandbox);
		await manager.withLifecycle(sandbox.id, async (_info, operation) => {
			expect(() => manager.acquireExecution(sandbox.path, sandbox)).toThrow(/progress|busy|lifecycle/i);
			release();
			await operation.reset();
		});
		expect(manager.getExecutionIdentity(sandbox.path, sandbox)?.id).toBe(sandbox.id);
	});

	it("never downgrades a destroyed execution identity to an ordinary project", async () => {
		const { manager, sandbox } = await setup();
		await manager.destroy(sandbox.id);
		expect(() => manager.getExecutionIdentity(sandbox.path, sandbox)).toThrow();
		mkdirSync(sandbox.path);
		expect(() => manager.getExecutionIdentity(sandbox.path, sandbox)).toThrow();
	});

	it("refuses scripts and forged tool ownership while allowing bounded host edits", async () => {
		const { sandbox } = await setup();
		const args = { path: "file.txt", content: "safe-change" };
		expect(evaluateSandboxJail(sandbox, "write", args, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "write", args, sandbox.path, { trustedTool: true })).toBeNull();
		for (const [name, params] of [
			["bash", { command: "node task.js" }],
			["eval", { code: "require('node:fs').writeFileSync('/outside', 'bad')" }],
			["terminal", { action: "input", text: "node task.js" }],
			["custom_writer", args],
		] as const) {
			expect(evaluateSandboxJail(sandbox, name, params, sandbox.path, { trustedTool: true })).not.toBeNull();
		}
	});
});
