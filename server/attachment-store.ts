/**
 * attachment-store.ts — 基于 SHA-256 内容寻址（CAS）的附件存储。
 *
 * 借鉴 DSH 的 dsh-attachment 机制：
 *  - 图片与大二进制附件以 sha256 哈希落盘到 `<dataDir>/attachments/<hash>.<ext>`；
 *  - WebSocket 快照与会话转录中仅传递紧凑的 hash 引用与 URL；
 *  - 浏览器通过 `/api/attachment/:hash` 经 HTTP 访问，带永久强缓存（immutable）；
 *  - 避免快照和消息列表随会话进行出现数兆字节 base64 的膨胀。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { readFile, readdir, rename, rm, writeFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { writeAtomicSync } from "./atomic-file.js";

interface AttachmentStore {
	dir: string;
	files: Map<string, Set<string>>;
	ready?: Promise<void>;
}

let store: AttachmentStore | undefined;

function indexFile(target: AttachmentStore, fileName: string): void {
	// Accept legacy hash.ext names, but never unfinished atomic writes.
	const match = /^([a-f0-9]{64})\..+$/i.exec(fileName);
	if (!match || fileName.endsWith(".tmp")) return;
	let files = target.files.get(match[1]);
	if (!files) target.files.set(match[1], (files = new Set()));
	files.add(fileName);
}

function ensureIndex(target: AttachmentStore): Promise<void> {
	return (target.ready ??= readdir(target.dir, { withFileTypes: true })
		.then((entries) => {
			for (const entry of entries) {
				if (entry.isFile()) indexFile(target, entry.name);
			}
		})
		.catch((error) => {
			target.ready = undefined;
			throw error;
		}));
}

/** 初始化附件存储目录（服务启动时调用）。 */
export function initAttachmentStore(dataDir: string): string {
	const dir = join(dataDir, "attachments");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	store = { dir, files: new Map() };
	return dir;
}

/** 附件元数据。 */
export interface AttachmentRecord {
	hash: string;
	size: number;
	mimeType: string;
	ext: string;
	url: string;
	filePath: string;
}

const MIME_EXT_MAP: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"application/pdf": ".pdf",
};

const EXT_MIME_MAP: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".pdf": "application/pdf",
};

/**
 * 将二进制内容写入附件存储（内容寻址，幂等）：
 * 已存在同哈希文件则直接返回元数据，不重复写盘。
 */
export async function saveAttachment(
	buffer: Buffer,
	mimeType = "application/octet-stream",
	preferredExt?: string,
): Promise<AttachmentRecord> {
	if (!store) {
		throw new Error("AttachmentStore has not been initialized with initAttachmentStore(dataDir)");
	}
	const hash = createHash("sha256").update(buffer).digest("hex");
	const ext = preferredExt || MIME_EXT_MAP[mimeType] || ".bin";
	const fileName = `${hash}${ext}`;
	const target = store;
	const filePath = join(target.dir, fileName);

	if (!existsSync(filePath)) {
		// 原地 writeFile 有两个问题：a) 同 hash 并发写时两个 writeFileSync
		// 交错会留下半个文件；b) 读方（/api/attachment/:hash）可能在写完前就命中。
		// 因此先写私有 tmp 再 rename（同目录内原子生效）。POSIX rename 原子覆盖；
		// Windows 目标已存在时报 EEXIST/EPERM —— 内容寻址同 hash 即同内容，
		// 并发对手落盘视为成功。tmp 命名带 uuid，绝不与真实附件名冲突。
		const tmpPath = `${filePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(tmpPath, buffer);
			await rename(tmpPath, filePath);
		} catch (err) {
			await rm(tmpPath, { force: true }).catch(() => {});
			const code = (err as NodeJS.ErrnoException).code;
			if ((code !== "EEXIST" && code !== "EPERM") || !existsSync(filePath)) throw err;
		}
	}

	indexFile(target, fileName);
	return {
		hash,
		size: buffer.length,
		mimeType,
		ext,
		url: `/api/attachment/${hash}`,
		filePath,
	};
}

/**
 * 将二进制内容写入附件存储（同步版本，供消息序列化等纯同步链路使用）：
 * 已存在同哈希文件则直接返回元数据，不重复写盘。
 */
export function saveAttachmentSync(
	buffer: Buffer,
	mimeType = "application/octet-stream",
	preferredExt?: string,
): AttachmentRecord {
	if (!store) {
		throw new Error("AttachmentStore has not been initialized with initAttachmentStore(dataDir)");
	}
	const hash = createHash("sha256").update(buffer).digest("hex");
	const ext = preferredExt || MIME_EXT_MAP[mimeType] || ".bin";
	const fileName = `${hash}${ext}`;
	const target = store;
	const filePath = join(target.dir, fileName);

	if (!existsSync(filePath)) {
		try {
			writeAtomicSync(filePath, buffer);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				// 并发写同哈希：目标已在，按「已存在」成功路径返回
			} else if (code === "EPERM" && existsSync(filePath)) {
				// Windows 杀软/OneDrive 锁住的是 tmp 源而目标已由并发方写好：等同已存在
			} else {
				// EPERM 且目标不存在 / 其他错误：照常抛出。吞掉会返回指向缺失文件的
				// 坏记录，消息里图片 404；抛出让 serialize 回退 dataUrl（转录里 base64 仍在）
				throw err;
			}
		}
		if (!existsSync(filePath)) {
			const err = new Error(`EPERM: target file does not exist after write ${filePath}`) as NodeJS.ErrnoException;
			err.code = "EPERM";
			throw err;
		}
	}

	indexFile(target, fileName);
	return {
		hash,
		size: buffer.length,
		mimeType,
		ext,
		url: `/api/attachment/${hash}`,
		filePath,
	};
}

/**
 * 根据哈希定位附件；filePath、size、mimeType 可直接用于 HTTP 流式发送。
 * 首次有效查询惰性异步扫描旧目录，并发查询共享扫描；后续查询只访问索引。
 * 保存成功会增量更新索引。外部导入文件后需重新 initAttachmentStore。
 */
export async function findAttachment(hash: string): Promise<AttachmentRecord | null> {
	const target = store;
	if (!target || !/^[a-f0-9]{64}$/i.test(hash)) return null;
	try {
		await ensureIndex(target);
		const files = target.files.get(hash);
		if (!files) return null;
		for (const fileName of [...files].sort()) {
			const filePath = join(target.dir, fileName);
			try {
				const st = await stat(filePath);
				if (!st.isFile()) continue;
				const ext = extname(fileName).toLowerCase();
				return {
					hash,
					size: st.size,
					mimeType: EXT_MIME_MAP[ext] || "application/octet-stream",
					ext,
					url: `/api/attachment/${hash}`,
					filePath,
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") files.delete(fileName);
			}
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * 读取附件二进制数据。
 */
export async function readAttachment(hash: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
	const record = await findAttachment(hash);
	if (!record) return null;
	try {
		const buffer = await readFile(record.filePath);
		return { buffer, mimeType: record.mimeType };
	} catch {
		return null;
	}
}
