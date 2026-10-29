import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const faults = vi.hoisted(() => ({ write: false }));
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
			if (faults.write) {
				actual.writeFileSync(args[0], "partial", args[2]);
				throw new Error("Injected disk full");
			}
			return actual.writeFileSync(...args);
		},
	};
});
import { FilesService } from "../../server/files-service.js";
import { saveUpload, writeUploadExclusiveSync, writeRemoteUploadExclusive } from "../../server/uploads.js";

const roots: string[] = [];
function fixture() {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-integrity-"));
	roots.push(root);
	const notices: any[] = [];
	const service = new FilesService({
		getCwd: () => root,
		getActiveCwd: () => root,
		isDisposed: () => false,
		emit: (m) => {
			notices.push(m);
		},
	});
	return { root, service, notices };
}
afterEach(() => {
	faults.write = false;
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("file integrity", () => {
	it("cleans failed workspace and attachment uploads without publishing partial data", async () => {
		const { root, service } = fixture();
		faults.write = true;
		await service.uploadFile("", "a.txt", Buffer.from("new").toString("base64"));
		expect(fs.readdirSync(root)).toEqual([]);
		expect(() => saveUpload("client", "a.txt", Buffer.from("new"), root)).toThrow("disk full");
		expect(fs.readdirSync(join(root, "uploads", "client"))).toEqual([]);
	});
	it("keeps both same-millisecond attachment uploads and never replaces an existing destination", () => {
		const { root } = fixture();
		vi.spyOn(Date, "now").mockReturnValue(123);
		const a = saveUpload("client", "a.txt", Buffer.from("one"), root);
		const b = saveUpload("client", "a.txt", Buffer.from("two"), root);
		expect(a.abs).not.toBe(b.abs);
		expect(fs.readFileSync(a.abs, "utf8")).toBe("one");
		expect(fs.readFileSync(b.abs, "utf8")).toBe("two");
		expect(() => writeUploadExclusiveSync(a.abs, Buffer.from("replace"))).toThrow();
		expect(fs.readFileSync(a.abs, "utf8")).toBe("one");
		expect(fs.readdirSync(join(root, "uploads", "client"))).toHaveLength(2);
	});
	it("passes cancellation into a running remote commit", async () => {
		const controller = new AbortController();
		const ssh = {
			sftpWriteFile: vi.fn().mockResolvedValue(undefined),
			execInWorkspace: vi.fn().mockImplementation(async (_cwd, command, options) => {
				if (command.startsWith("rm -f ")) return { exitCode: 0 };
				return new Promise((_ok, fail) => {
					options.signal.addEventListener("abort", () => fail(options.signal.reason), { once: true });
					controller.abort();
				});
			}),
		};
		await expect(
			writeRemoteUploadExclusive(ssh as any, "remote", "/root/a", Buffer.from("x"), controller.signal),
		).rejects.toThrow();
		expect(ssh.execInWorkspace).toHaveBeenCalledTimes(2);
		expect(ssh.execInWorkspace.mock.calls[1][2].signal.aborted).toBe(false);
	});
	it("uses portable no-replace commands and bounded independent cleanup", async () => {
		const controller = new AbortController();
		const ssh = {
			sftpWriteFile: vi.fn().mockResolvedValue(undefined),
			execInWorkspace: vi
				.fn()
				.mockResolvedValueOnce({ exitCode: 17, stderr: "exists" })
				.mockResolvedValue({ exitCode: 0 }),
		};
		await expect(
			writeRemoteUploadExclusive(ssh as any, "remote", "/root/a", Buffer.from("x"), controller.signal),
		).rejects.toMatchObject({ code: "EEXIST" });
		expect(ssh.sftpWriteFile.mock.calls[0][3]).toEqual({
			createParents: true,
			flag: "wx",
			signal: expect.any(AbortSignal),
			timeoutMs: 30_000,
		});
		const commit = ssh.execInWorkspace.mock.calls[0];
		expect(commit[1]).toContain("ln ");
		expect(commit[1]).not.toMatch(/-T|--reference|stat -c|readlink -f/);
		expect(commit[2]).toMatchObject({ timeoutMs: 30000, signal: expect.any(AbortSignal) });
		expect(commit[2].signal).toBe(ssh.sftpWriteFile.mock.calls[0][3].signal);
		const cleanup = ssh.execInWorkspace.mock.calls[1];
		expect(cleanup[1]).toMatch(/^rm -f /);
		expect(cleanup[2]).toMatchObject({ timeoutMs: 5000, signal: expect.any(AbortSignal) });
		expect(cleanup[2].signal).not.toBe(commit[2].signal);
	});
	it("does not publish a remote upload cancelled during SFTP writing", async () => {
		const controller = new AbortController();
		const ssh = {
			sftpWriteFile: vi.fn().mockImplementation(async () => {
				controller.abort();
			}),
			execInWorkspace: vi.fn().mockResolvedValue({ exitCode: 0 }),
		};
		await expect(
			writeRemoteUploadExclusive(ssh as any, "remote", "/root/a", Buffer.from("x"), controller.signal),
		).rejects.toThrow();
		expect(ssh.execInWorkspace.mock.calls.every((call) => call[1].startsWith("rm -f "))).toBe(true);
		expect(ssh.execInWorkspace).toHaveBeenCalled();
	});
	it("keeps the upload pending until cancelled SFTP actually settles, then cleans without committing", async () => {
		const controller = new AbortController();
		let finish!: () => void;
		const ssh = {
			sftpWriteFile: vi.fn().mockImplementation(
				() =>
					new Promise<void>((ok) => {
						finish = ok;
					}),
			),
			execInWorkspace: vi.fn().mockResolvedValue({ exitCode: 0 }),
		};
		const upload = writeRemoteUploadExclusive(ssh as any, "remote", "/root/a", Buffer.from("x"), controller.signal);
		let settled = false;
		void upload.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		controller.abort();
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(ssh.sftpWriteFile.mock.calls[0][3].signal.aborted).toBe(true);
		expect(ssh.execInWorkspace).not.toHaveBeenCalled();
		finish();
		await expect(upload).rejects.toThrow();
		expect(ssh.execInWorkspace).toHaveBeenCalledTimes(1);
		expect(ssh.execInWorkspace.mock.calls[0][1]).toMatch(/^rm -f /);
	});
	it("cleans remote partial staging and never writes directly to the destination", async () => {
		const ssh = {
			sftpWriteFile: vi.fn().mockRejectedValue(new Error("disk full")),
			execInWorkspace: vi.fn().mockResolvedValue({ exitCode: 0 }),
		};
		await expect(writeRemoteUploadExclusive(ssh as any, "remote", "/root/a", Buffer.from("x"))).rejects.toThrow(
			"disk full",
		);
		expect(ssh.sftpWriteFile.mock.calls[0][1]).not.toBe("/root/a");
		expect(ssh.execInWorkspace.mock.calls[0][1]).toMatch(/^rm -f /);
	});
});
