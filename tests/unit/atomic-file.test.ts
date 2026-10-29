import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomicSync, writeJsonAtomicSync } from "../../server/atomic-file.js";

describe("atomic-file", () => {
	it("optional private mode and flush preserve existing permissions", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-mode-"));
		try {
			const target = join(base, "secret.json");
			writeAtomicSync(target, "first", { mode: 0o600, fsync: true });
			expect(readFileSync(target, "utf8")).toBe("first");
			if (process.platform !== "win32") {
				expect(statSync(target).mode & 0o777).toBe(0o600);
				chmodSync(target, 0o640);
			}
			writeAtomicSync(target, "second", { mode: 0o600, fsync: true });
			expect(readFileSync(target, "utf8")).toBe("second");
			if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o640);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("writeAtomicSync: 正常原子写文件并自动创建父目录", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-test-"));
		try {
			const target = join(base, "nested", "sub", "test.txt");
			writeAtomicSync(target, "hello atomic world");
			expect(existsSync(target)).toBe(true);
			expect(readFileSync(target, "utf8")).toBe("hello atomic world");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("writeJsonAtomicSync: 正常原子写 JSON 并格式化", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-atomic-test-"));
		try {
			const target = join(base, "data.json");
			const obj = { key: "value", count: 42 };
			writeJsonAtomicSync(target, obj);
			expect(existsSync(target)).toBe(true);
			const read = JSON.parse(readFileSync(target, "utf8"));
			expect(read).toEqual(obj);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
