import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 跨平台安全原子写文件：先写临时文件再 renameSync，进程崩溃不留半截文件。
 * - tmp 文件位于目标文件同目录下（保证处于同物理卷，rename 为原子操作）；
 * - tmp 文件名携带 pid + 时间戳 + 随机串，防止同机多进程互踩；
 * - 临时占用导致 rename 失败时有限重试；最终失败抛出错误，绝不截断原文件；
 * - 确保无论成功失败，临时文件在 finally 中及时清理，杜绝残留 .tmp 垃圾文件。
 */
export interface AtomicWriteOptions {
	/** Mode for new files; preserve the existing file's mode when present. */
	mode?: number;
	/** Flush staged bytes before rename (does not promise directory/power-loss durability). */
	fsync?: boolean;
}

export function writeAtomicSync(
	file: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): void {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });
	const suffix = `${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
	const tmp = `${file}.${suffix}`;
	try {
		if (options.mode !== undefined || options.fsync) {
			let mode = options.mode;
			if (mode !== undefined) {
				try {
					mode = statSync(file).mode & 0o777;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			const fd = openSync(tmp, "wx", mode);
			try {
				writeFileSync(fd, data);
				if (options.fsync) fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} else {
			writeFileSync(tmp, data);
		}
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(tmp, file);
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (attempt >= 2 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
			}
		}
	} finally {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// ignore cleanup errors
		}
	}
}

/**
 * 原子写 JSON 辅助函数（默认 2 空格缩进 + 末尾换行）。
 */
export function writeJsonAtomicSync(file: string, data: unknown, indent: number | string = 2): void {
	const text = JSON.stringify(data, null, indent) + "\n";
	writeAtomicSync(file, text);
}
