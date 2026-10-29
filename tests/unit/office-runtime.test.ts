import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	documentKey,
	fileVersion,
	resolvePreviewPath,
	safeWorkspacePath,
	writeDocumentAtomic,
} from "../../plugins/office/runtime.mjs";

let root: string;
let out: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "office-runtime-"));
	out = path.join(root, "document.docx");
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});
const data = Buffer.from("document contents");
const tempFiles = () => fs.readdirSync(root).filter((name) => name.startsWith(".office-"));

describe("office runtime", () => {
	it("allows preview outside the workspace while retaining write containment", () => {
		fs.writeFileSync(out, data);
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		expect(resolvePreviewPath(out, workspace)).toBe(fs.realpathSync(out));
		expect(resolvePreviewPath("../document.docx", workspace)).toBe(fs.realpathSync(out));
		expect(() => safeWorkspacePath(out, workspace)).toThrow(expect.objectContaining({ statusCode: 403 }));
	});
	it("reports lexical and symlink workspace escapes as Chinese 403 errors", () => {
		expect(() => safeWorkspacePath(path.join(root, "..", "escape"), root)).toThrow(
			expect.objectContaining({ statusCode: 403, message: expect.stringContaining("工作区") }),
		);
		fs.symlinkSync(path.dirname(root), path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
		expect(() => safeWorkspacePath(path.join(root, "outside", "new.docx"), root)).toThrow(
			expect.objectContaining({ statusCode: 403, message: expect.stringContaining("工作区") }),
		);
	});

	it("rejects an unexpected canonical parent before staging", () => {
		expect(() => writeDocumentAtomic(out, data, { expectedParentRealpath: path.dirname(root) })).toThrow(
			expect.objectContaining({ statusCode: 409 }),
		);
		expect(tempFiles()).toEqual([]);
		expect(fs.existsSync(out)).toBe(false);
	});

	it("rejects a parent symlink swap during staging and cleans the canonical temporary file", () => {
		const first = path.join(root, "first");
		const second = path.join(root, "second");
		const alias = path.join(root, "alias");
		fs.mkdirSync(first);
		fs.mkdirSync(second);
		const kind = process.platform === "win32" ? "junction" : "dir";
		fs.symlinkSync(first, alias, kind);
		const sync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			sync(fd);
			fs.unlinkSync(alias);
			fs.symlinkSync(second, alias, kind);
		});
		expect(() => writeDocumentAtomic(path.join(alias, "new.docx"), data)).toThrow(
			expect.objectContaining({ statusCode: 409 }),
		);
		expect(fs.readdirSync(first)).toEqual([]);
		expect(fs.readdirSync(second)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"preserves uid/gid only when different and aborts on ownership failure",
		() => {
			fs.writeFileSync(out, "old");
			const stat = fs.statSync(out);
			const chown = vi.spyOn(fs, "fchownSync").mockImplementation(() => {});
			const fstat = fs.fstatSync;
			vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => ({
				...fstat(fd),
				uid: stat.uid + 1,
				gid: stat.gid + 1,
			})) as typeof fs.fstatSync);
			writeDocumentAtomic(out, data, { overwrite: true, expectedVersion: fileVersion(out) });
			expect(chown).toHaveBeenCalledWith(expect.any(Number), stat.uid, stat.gid);
			chown.mockImplementation(() => {
				throw Object.assign(new Error("ownership denied"), { code: "EPERM" });
			});
			expect(() =>
				writeDocumentAtomic(out, Buffer.from("replacement"), { overwrite: true, expectedVersion: fileVersion(out) }),
			).toThrow("ownership denied");
			expect(fs.readFileSync(out)).toEqual(data);
			expect(tempFiles()).toEqual([]);
			vi.restoreAllMocks();
			const unchanged = vi.spyOn(fs, "fchownSync");
			writeDocumentAtomic(out, data, { overwrite: true, expectedVersion: fileVersion(out) });
			expect(unchanged).not.toHaveBeenCalled();
			expect(fs.statSync(out).uid).toBe(stat.uid);
			expect(fs.statSync(out).gid).toBe(stat.gid);
		},
	);

	it("hashes the entire path and captures stat identity", () => {
		expect(documentKey(out)).toBe(createHash("sha256").update(out).digest("hex"));
		expect(documentKey(out)).not.toBe(documentKey(path.join(root, "other", "document.docx")));
		expect(fileVersion(out)).toBeNull();
		fs.writeFileSync(out, data);
		const stat = fs.statSync(out);
		expect(fileVersion(out)).toEqual({
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
		});
	});

	it("accepts existing paths and missing suffixes, rejects lexical escapes", () => {
		fs.writeFileSync(out, data);
		expect(safeWorkspacePath(out, root)).toBe(fs.realpathSync(out));
		expect(safeWorkspacePath(path.join(root, "missing", "new.docx"), root)).toBe(
			path.join(fs.realpathSync(root), "missing", "new.docx"),
		);
		expect(() => safeWorkspacePath(`${root}-sibling/file`, root)).toThrow("outside workspace");
		expect(() => safeWorkspacePath(path.join(root, "..", "escape"), root)).toThrow("outside workspace");
		expect(() => safeWorkspacePath("relative.docx", root)).toThrow("Absolute paths");
	});

	it("rejects existing and missing paths through escaping directory symlinks", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "office-outside-"));
		try {
			fs.writeFileSync(path.join(outside, "existing.docx"), data);
			fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
			for (const suffix of ["existing.docx", "new.docx", "nested/new.docx"]) {
				expect(() => safeWorkspacePath(path.join(root, "escape", suffix), root)).toThrow("outside workspace");
			}
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("rejects dangling symlinks and accepts workspace aliases", () => {
		fs.symlinkSync(path.join(root, "missing"), out);
		expect(() => safeWorkspacePath(out, root)).toThrow("Cannot resolve");
		fs.symlinkSync(root, path.join(root, "alias"));
		expect(safeWorkspacePath(path.join(root, "alias", "new.docx"), path.join(root, "alias"))).toBe(
			path.join(fs.realpathSync(root), "new.docx"),
		);
	});

	it("creates exclusively, returns version, and leaves no temporary files", () => {
		const rename = vi.spyOn(fs, "renameSync");
		const link = vi.spyOn(fs, "linkSync");
		const sync = vi.spyOn(fs, "fsyncSync");
		expect(writeDocumentAtomic(out, data)).toEqual(fileVersion(out));
		expect(fs.readFileSync(out)).toEqual(data);
		expect(link).toHaveBeenCalledOnce();
		expect(rename).not.toHaveBeenCalled();
		expect(sync).toHaveBeenCalledOnce();
		expect(tempFiles()).toEqual([]);
	});

	it("requires overwrite and an exact version for replacement", () => {
		fs.writeFileSync(out, "old");
		const version = fileVersion(out);
		for (const options of [
			{},
			{ overwrite: true },
			{ expectedVersion: version },
			{ overwrite: true, expectedVersion: { ...version!, ctimeMs: -1 } },
		]) {
			expect(() => writeDocumentAtomic(out, data, options)).toThrow(expect.objectContaining({ statusCode: 409 }));
		}
		expect(writeDocumentAtomic(out, data, { overwrite: true, expectedVersion: version })).toEqual(fileVersion(out));
		expect(fs.readFileSync(out)).toEqual(data);
		expect(tempFiles()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("preserves existing mode even with a restrictive umask", () => {
		fs.writeFileSync(out, "old", { mode: 0o640 });
		const version = fileVersion(out);
		const oldMask = process.umask(0o077);
		try {
			writeDocumentAtomic(out, data, { overwrite: true, expectedVersion: version });
			expect(fs.statSync(out).mode & 0o777).toBe(0o640);
		} finally {
			process.umask(oldMask);
		}
	});

	it("detects changes during staging immediately before rename", () => {
		fs.writeFileSync(out, "old");
		const version = fileVersion(out);
		const sync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			sync(fd);
			fs.writeFileSync(out, "concurrent editor content");
		});
		const rename = vi.spyOn(fs, "renameSync");
		expect(() => writeDocumentAtomic(out, data, { overwrite: true, expectedVersion: version })).toThrow(
			expect.objectContaining({ statusCode: 409 }),
		);
		expect(rename).not.toHaveBeenCalled();
		expect(fs.readFileSync(out, "utf8")).toBe("concurrent editor content");
		expect(tempFiles()).toEqual([]);
	});

	it("never overwrites a destination created during staging", () => {
		const sync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			sync(fd);
			fs.writeFileSync(out, "winner");
		});
		expect(() => writeDocumentAtomic(out, data, { overwrite: true })).toThrow(
			expect.objectContaining({ statusCode: 409 }),
		);
		expect(fs.readFileSync(out, "utf8")).toBe("winner");
		expect(tempFiles()).toEqual([]);
	});

	it("cleans staged files after failed writes, syncs, or renames", () => {
		fs.writeFileSync(out, "old");
		for (const method of ["writeFileSync", "fsyncSync", "renameSync"] as const) {
			const version = fileVersion(out);
			const spy = vi.spyOn(fs, method).mockImplementation(() => {
				throw new Error("injected failure");
			});
			expect(() => writeDocumentAtomic(out, data, { overwrite: true, expectedVersion: version })).toThrow(
				"injected failure",
			);
			spy.mockRestore();
			expect(fs.readFileSync(out, "utf8")).toBe("old");
			expect(tempFiles()).toEqual([]);
		}
	});

	it("validates size and rejects stale versions for absent destinations before staging", () => {
		expect(() => writeDocumentAtomic(out, data, { maxBytes: 1 })).toThrow(expect.objectContaining({ statusCode: 413 }));
		expect(() => writeDocumentAtomic(out, data, { maxBytes: -1 })).toThrow(RangeError);
		expect(() =>
			writeDocumentAtomic(out, data, { expectedVersion: { dev: 0, ino: 0, size: 1, mtimeMs: 0, ctimeMs: 0 } }),
		).toThrow(expect.objectContaining({ statusCode: 409 }));
		expect(writeDocumentAtomic(out, Buffer.alloc(0), { maxBytes: 0 })).toEqual(fileVersion(out));
		expect(tempFiles()).toEqual([]);
	});
});
