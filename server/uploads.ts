/**
 * uploads — 文件对话上传的存储与清理。
 *
 * 上传文件落在 <dataDir>/uploads/<clientId>/<ts>-<uuid>-<name>（模型以绝对路径
 * reference 读取）。此前这里硬编码 ~/.pi-web，不吃 PI_WEB_DATA_DIR —— 已改为
 * 与 index.ts 相同的解析逻辑。清理策略：默认保留 14 天，启动时扫一次 +
 * 每 6 小时扫一次；PI_WEB_UPLOAD_RETENTION_DAYS 覆盖保留天数，0 = 关闭清理。
 * 全程 best-effort：清理失败绝不影响服务。
 */
import { readdir, rm, stat } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { shellQuotePosix, type RemoteSshService } from "./remote-ssh-service.js";
import { homedir } from "node:os";
import { join, resolve, posix } from "node:path";

/** Same resolution as index.ts DATA_DIR — kept in sync by env contract. */
export function resolveDataDir(): string {
	return resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
}

export function uploadsRoot(dataDir = resolveDataDir()): string {
	return join(dataDir, "uploads");
}

/** Retention in days; 0 disables sweeping. */
export function uploadRetentionDays(): number {
	const v = Number(process.env.PI_WEB_UPLOAD_RETENTION_DAYS);
	return Number.isFinite(v) && v >= 0 ? v : 14;
}

/** clientId 白名单：clientId 来自浏览器自报（ws hello），却直接拼进上传目录
 *  路径 —— 只允许安全的单段字符（字母数字、:、_、-，1-128 长），否则可
 *  "../" 遍历写任意目录。不匹配整条拒绝抛错：绝不能静默换 randomUUID，
 *  上传目录必须与 ws 会话一一对应（编辑重问靠 uploadPath 按同一目录找回）。 */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

/** Persist an uploaded buffer; returns the absolute path + sanitized display name.
 *  clientId 不匹配白名单、displayName 为空 / "." / ".." 时抛错，调用方负责报错。 */
export function saveUpload(
	clientId: string,
	name: string,
	buf: Buffer,
	dataDir = resolveDataDir(),
): { abs: string; displayName: string } {
	if (!CLIENT_ID_PATTERN.test(clientId)) {
		throw new Error(`Invalid upload clientId: ${JSON.stringify(clientId.slice(0, 129))}`);
	}
	// displayName 只取 basename 并拒绝 "." / ".."：防 ".." 与绝对路径拼接穿越
	// （最终文件名带 <ts>- 前缀兜底，这里从源头收紧）。
	const base = name.split(/[\\/]/).pop() ?? "";
	if (!base || base === "." || base === "..") {
		throw new Error(`Invalid upload name: ${JSON.stringify(name.slice(0, 129))}`);
	}
	const displayName = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80) || "file";
	const dir = join(uploadsRoot(dataDir), clientId);
	mkdirSync(dir, { recursive: true });
	const abs = join(dir, `${Date.now()}-${randomUUID()}-${displayName}`);
	writeUploadExclusiveSync(abs, buf);
	return { abs, displayName };
}

/** Publish only a complete file, using a same-volume hard link for atomic no-replace.
 * NTFS and POSIX support this; unsupported filesystems fail without a destructive fallback. */
export function writeUploadExclusiveSync(dest: string, data: Buffer): void {
	const temp = `${dest}.${randomUUID()}.upload`;
	try {
		writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
		linkSync(temp, dest);
	} finally {
		rmSync(temp, { force: true });
	}
}

/** SFTP accepts buffers only. Stage exclusively, then use portable POSIX ln
 * without -f: a competing regular file can never be overwritten. */
export async function writeRemoteUploadExclusive(
	ssh: RemoteSshService,
	cwd: string,
	dest: string,
	data: Buffer,
	signal?: AbortSignal,
): Promise<void> {
	const temp = `${dest}.${randomUUID()}.upload`;
	const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
	const cleanup = async () => {
		const result = await ssh.execInWorkspace(cwd, `rm -f ${shellQuotePosix(temp)}`, {
			cwd: "/",
			timeoutMs: 5000,
			signal: AbortSignal.timeout(5000),
		});
		if (result.exitCode !== 0) throw new Error(result.stderr || "Remote upload cleanup failed");
	};
	try {
		operationSignal.throwIfAborted();
		// Do not race cancellation against SFTP: HTTP reservations must remain
		// held until the underlying write releases its buffered payload.
		await ssh.sftpWriteFile(cwd, temp, data, {
			createParents: true,
			flag: "wx",
			signal: operationSignal,
			timeoutMs: 30_000,
		});
		operationSignal.throwIfAborted();
		const target = shellQuotePosix(dest);
		// POSIX ln treats a directory as a container. Guard it both before and
		// after linking, removing only our unpredictable link if a directory raced.
		const stray = shellQuotePosix(posix.join(dest, posix.basename(temp)));
		const result = await ssh.execInWorkspace(
			cwd,
			`if test -e ${target} || test -L ${target}; then exit 17; fi; ln ${shellQuotePosix(temp)} ${target} || exit 17; if test -d ${target}; then rm -f ${stray}; exit 17; fi`,
			{
				cwd: "/",
				timeoutMs: 30_000,
				signal: operationSignal,
			},
		);
		if (result.exitCode !== 0) {
			const error = new Error(result.stderr || result.stdout || "Upload commit failed") as NodeJS.ErrnoException;
			if (result.exitCode === 17) error.code = "EEXIST";
			throw error;
		}
	} finally {
		await cleanup();
	}
}

/**
 * Delete uploaded files older than the retention window, then prune client
 * dirs left empty. Returns { files, bytes, dirs } removed (best-effort:
 * individual failures are skipped).
 */
export async function cleanupUploads(
	dataDir = resolveDataDir(),
	retentionDays = uploadRetentionDays(),
): Promise<{ files: number; bytes: number; dirs: number }> {
	const out = { files: 0, bytes: 0, dirs: 0 };
	if (retentionDays <= 0) return out;
	const root = uploadsRoot(dataDir);
	if (!existsSync(root)) return out;

	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	let clients: string[];
	try {
		clients = await readdir(root);
	} catch {
		return out;
	}
	for (const clientId of clients) {
		const dir = join(root, clientId);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			continue; // not a dir / vanished
		}
		for (const entry of entries) {
			const abs = join(dir, entry);
			try {
				const st = await stat(abs);
				if (st.mtimeMs >= cutoff) continue;
				await rm(abs, { recursive: true });
				out.files++;
				out.bytes += st.size;
			} catch {
				// skip on any per-file failure
			}
		}
		try {
			if ((await readdir(dir)).length === 0) {
				await rmdirSafe(dir);
				out.dirs++;
			}
		} catch {
			// ignore
		}
	}
	return out;
}

async function rmdirSafe(dir: string): Promise<void> {
	try {
		await rm(dir, { recursive: false });
	} catch {
		// non-empty or race — fine
	}
}

/** Startup sweep + periodic re-sweep. Timer is unref'd so it never blocks exit. */
export function scheduleUploadCleanup(intervalMs = 6 * 60 * 60 * 1000): void {
	void cleanupUploads().catch(() => {});
	const timer = setInterval(() => {
		void cleanupUploads().catch(() => {});
	}, intervalMs);
	timer.unref?.();
}
