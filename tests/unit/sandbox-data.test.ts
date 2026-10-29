import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	linkSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import { SandboxManager } from "../../server/sandbox-service.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

describe("sandbox repository transactions", () => {
	let root: string, source: string, data: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sandbox-data-"));
		source = join(root, "source");
		data = join(root, "data");
		mkdirSync(source);
		writeFileSync(join(source, "a"), "base");
		writeFileSync(join(source, "b"), "base");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});
	it("merges only sandbox changes, retaining concurrent source edits, additions and deletions", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		writeFileSync(join(sandbox.path, "a"), "sandbox");
		rmSync(join(source, "b"));
		writeFileSync(join(source, "extra"), "concurrent");
		const diff = await manager.diffWithSource(sandbox.id);
		expect(diff.modified).toEqual(["a"]);
		expect(diff.deleted).toEqual([]);
		await manager.applyToSource(sandbox.id, diff.expectedRevision);
		expect(readFileSync(join(source, "a"), "utf8")).toBe("sandbox");
		expect(existsSync(join(source, "b"))).toBe(false);
		expect(readFileSync(join(source, "extra"), "utf8")).toBe("concurrent");
	});
	it("rejects conflicts and stale previews without writing any files", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		writeFileSync(join(sandbox.path, "a"), "sandbox");
		const diff = await manager.diffWithSource(sandbox.id);
		writeFileSync(join(source, "a"), "concurrent");
		await expect(manager.applyToSource(sandbox.id, diff.expectedRevision)).rejects.toThrow("refresh preview");
		await expect(
			manager.applyToSource(sandbox.id, (await manager.diffWithSource(sandbox.id)).expectedRevision),
		).rejects.toThrow("conflict");
		expect(readFileSync(join(source, "a"), "utf8")).toBe("concurrent");
	});
	it("shares concurrent registry updates and fails persistence without publishing state", async () => {
		const one = new SandboxManager(data),
			two = new SandboxManager(data);
		await Promise.all([one.create({}), two.create({})]);
		expect(one.list()).toHaveLength(2);
		expect(two.list()).toHaveLength(2);
		const registry = join(data, "sandboxes", "registry.json");
		rmSync(registry);
		mkdirSync(registry);
		await expect(one.create({})).rejects.toThrow();
		expect(one.list()).toHaveLength(2);
	});
	it("requires a baseline for legacy writeback and validates sidecar paths", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		const sidecar = join(data, "sandboxes", ".baselines", `${sandbox.id}.json`);
		rmSync(sidecar);
		await expect(manager.applyToSource(sandbox.id)).rejects.toThrow("rebuild");
		writeFileSync(sidecar, JSON.stringify({ version: 1, files: { "../outside": "dir" } }));
		await expect(manager.diffWithSource(sandbox.id)).rejects.toThrow("baseline");
	});
	it("reset failure keeps original contents and destroy failure retains identity", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		writeFileSync(join(sandbox.path, "a"), "keep");
		rmSync(source, { recursive: true });
		await expect(manager.reset(sandbox.id)).rejects.toThrow();
		expect(readFileSync(join(sandbox.path, "a"), "utf8")).toBe("keep");
		const registry = join(data, "sandboxes", "registry.json");
		rmSync(registry);
		mkdirSync(registry);
		await expect(manager.destroy(sandbox.id)).rejects.toThrow();
		expect(manager.get(sandbox.id)?.id).toBe(sandbox.id);
		expect(readFileSync(join(sandbox.path, "a"), "utf8")).toBe("keep");
	});
	it("reports destroy cleanup failure with retained recovery contents", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		const realRm = fsPromises.rm;
		vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
			if (String(path).includes(".pi-tmp-destroy-")) throw new Error("cleanup busy");
			return realRm(path, options);
		});
		await expect(manager.destroy(sandbox.id)).rejects.toThrow("deregistered but cleanup failed");
		expect(manager.get(sandbox.id)).toBeUndefined();
		const tombstone = (await fsPromises.readdir(manager.sandboxesRoot)).find((n) => n.startsWith(".pi-tmp-destroy-"))!;
		expect(readFileSync(join(manager.sandboxesRoot, tombstone, "a"), "utf8")).toBe("base");
	});
	it("rolls back earlier writes when a later target is unsafe", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		writeFileSync(join(sandbox.path, "a"), "new-a");
		writeFileSync(join(sandbox.path, "b"), "new-b");
		linkSync(join(source, "b"), join(root, "hardlink"));
		const preview = await manager.diffWithSource(sandbox.id);
		await expect(manager.applyToSource(sandbox.id, preview.expectedRevision)).rejects.toThrow("Unsafe linked");
		expect(readFileSync(join(source, "a"), "utf8")).toBe("base");
		expect(readFileSync(join(source, "b"), "utf8")).toBe("base");
	});
	it("preserves a concurrent source edit during rollback and retains recovery evidence", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		writeFileSync(join(sandbox.path, "a"), "new-a");
		writeFileSync(join(sandbox.path, "b"), "new-b");
		const realRename = fsPromises.rename;
		vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
			if (String(from).includes("new-1")) {
				writeFileSync(join(source, "a"), "concurrent");
				throw new Error("commit failure");
			}
			return realRename(from, to);
		});
		await expect(
			manager.applyToSource(sandbox.id, (await manager.diffWithSource(sandbox.id)).expectedRevision),
		).rejects.toThrow("recovery files retained");
		expect(readFileSync(join(source, "a"), "utf8")).toBe("concurrent");
		expect(readFileSync(join(source, "b"), "utf8")).toBe("base");
		const stage = (await fsPromises.readdir(source)).find((n) => n.startsWith(".pi-tmp-"))!;
		expect(existsSync(join(source, stage, "recovery.json"))).toBe(true);
		expect(readFileSync(join(source, stage, "old-0"), "utf8")).toBe("base");
	});
	it("deletes empty directories and rolls directory deletion back on later failure", async () => {
		mkdirSync(join(source, "empty"));
		mkdirSync(join(source, "later"));
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		rmSync(join(sandbox.path, "empty"), { recursive: true });
		rmSync(join(sandbox.path, "later"), { recursive: true });
		const preview = await manager.diffWithSource(sandbox.id);
		const realRmdir = fsPromises.rmdir;
		const spy = vi.spyOn(fsPromises, "rmdir").mockImplementation(async (path) => {
			if (String(path) === join(source, "later")) throw new Error("directory busy");
			return realRmdir(path);
		});
		await expect(manager.applyToSource(sandbox.id, preview.expectedRevision)).rejects.toThrow("directory busy");
		expect(existsSync(join(source, "empty"))).toBe(true);
		spy.mockRestore();
		await manager.applyToSource(sandbox.id, (await manager.diffWithSource(sandbox.id)).expectedRevision);
		expect(existsSync(join(source, "empty"))).toBe(false);
		expect(existsSync(join(source, "later"))).toBe(false);
	});
	it("applies directory deletion idempotently including a source directory already deleted", async () => {
		mkdirSync(join(source, "removed"));
		writeFileSync(join(source, "removed", "file"), "base");
		mkdirSync(join(source, "already-gone"));
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		rmSync(join(sandbox.path, "removed"), { recursive: true });
		rmSync(join(sandbox.path, "already-gone"), { recursive: true });
		rmSync(join(source, "already-gone"), { recursive: true });
		const first = await manager.applyToSource(sandbox.id, (await manager.diffWithSource(sandbox.id)).expectedRevision);
		expect(first.deletedFiles).toBe(1);
		expect(existsSync(join(source, "removed"))).toBe(false);
		const second = await manager.applyToSource(sandbox.id, (await manager.diffWithSource(sandbox.id)).expectedRevision);
		expect(second.deletedFiles).toBe(0);
		expect(second.copiedFiles).toBe(0);
	});
	it("rejects dangling source links even when the desired target is absent", async () => {
		mkdirSync(join(source, "removed"));
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		rmSync(join(sandbox.path, "removed"), { recursive: true });
		rmSync(join(source, "removed"), { recursive: true });
		symlinkSync(join(root, "missing"), join(source, "removed"), process.platform === "win32" ? "junction" : "dir");
		await expect(
			manager.applyToSource(sandbox.id, (await manager.diffWithSource(sandbox.id)).expectedRevision),
		).rejects.toThrow();
	});
	it("rejects a corrupt copied file even when the source returns to its snapshot", async () => {
		const manager = new SandboxManager(data);
		const realCopy = fsPromises.copyFile;
		vi.spyOn(fsPromises, "copyFile").mockImplementation(async (from, to, flags) => {
			await realCopy(from, to, flags);
			writeFileSync(to, "transient-copy");
		});
		await expect(manager.create({ sourcePath: source })).rejects.toThrow("Copied content changed");
		expect(manager.list()).toEqual([]);
	});
	it("awaits unawaited lifecycle mutations and propagates their failures", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		writeFileSync(join(sandbox.path, "a"), "changed");
		await manager.withLifecycle(sandbox.id, async (_info, op) => {
			void op.reset();
		});
		expect(readFileSync(join(sandbox.path, "a"), "utf8")).toBe("base");
		manager.assertAvailable(sandbox.path);
		rmSync(source, { recursive: true });
		await expect(
			manager.withLifecycle(sandbox.id, async (_info, op) => {
				void op.reset();
			}),
		).rejects.toThrow();
		manager.assertAvailable(sandbox.path);
	});
	it("expands home export paths and safely creates missing parent directories", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		const destination = join(root, "new-parent", "nested", "export");
		const result = await manager.promote(sandbox.id, `~/${relative(homedir(), destination).replace(/\\/g, "/")}`);
		expect(result.targetPath).toBe(destination.replace(/\\/g, "/"));
		expect(readFileSync(join(destination, "a"), "utf8")).toBe("base");
		const linked = join(root, "linked-parent");
		symlinkSync(source, linked, process.platform === "win32" ? "junction" : "dir");
		await expect(manager.promote(sandbox.id, join(linked, "nested", "export"))).rejects.toThrow("Linked");
		expect(existsSync(join(source, "nested"))).toBe(false);
	});
	it("requires a preview token even for direct data-layer callers", async () => {
		const manager = new SandboxManager(data);
		const { sandbox } = await manager.create({ sourcePath: source });
		await expect(manager.applyToSource(sandbox.id)).rejects.toThrow("revision required");
	});
	it("rejects target junction traversal and source ancestor imports", async () => {
		const manager = new SandboxManager(data);
		await expect(manager.create({ sourcePath: root })).rejects.toThrow("managed");
		mkdirSync(join(source, "nested"));
		writeFileSync(join(source, "nested", "file"), "base");
		const { sandbox } = await manager.create({ sourcePath: source });
		writeFileSync(join(sandbox.path, "nested", "file"), "sandbox");
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "file"), "external");
		rmSync(join(source, "nested"), { recursive: true });
		symlinkSync(outside, join(source, "nested"), process.platform === "win32" ? "junction" : "dir");
		await expect(
			manager.applyToSource(sandbox.id, (await manager.diffWithSource(sandbox.id)).expectedRevision),
		).rejects.toThrow();
		expect(readFileSync(join(outside, "file"), "utf8")).toBe("external");
	});
});
