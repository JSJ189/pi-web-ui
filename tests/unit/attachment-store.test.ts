import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAttachmentStore, saveAttachment, findAttachment, readAttachment } from "../../server/attachment-store.js";

describe("attachment-store 内容寻址附件存储（CAS）", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-attachment-test-"));
		initAttachmentStore(tempDir);
		return () => {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		};
	});

	it("成功保存二进制附件并按 SHA-256 寻址", async () => {
		const data = Buffer.from("Hello attachment CAS test");
		const record = await saveAttachment(data, "image/png");

		expect(record.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(record.url).toBe(`/api/attachment/${record.hash}`);
		expect(record.size).toBe(data.length);
		expect(record.mimeType).toBe("image/png");
		expect(record.ext).toBe(".png");
	});

	it("同一内容的写入幂等去重", async () => {
		const data = Buffer.from("Identical content test");
		const rec1 = await saveAttachment(data, "image/jpeg");
		const rec2 = await saveAttachment(data, "image/jpeg");

		expect(rec1.hash).toBe(rec2.hash);
		expect(rec1.url).toBe(rec2.url);
	});

	it("readAttachment 可以正确读回内容与 MIME", async () => {
		const data = Buffer.from("Test read content 123456");
		const record = await saveAttachment(data, "image/webp");

		const hit = await readAttachment(record.hash);
		expect(hit).not.toBeNull();
		expect(hit!.buffer.toString()).toBe("Test read content 123456");
		expect(hit!.mimeType).toBe("image/webp");
	});

	it("防御路径穿越：非法 hash 拒绝读取", async () => {
		expect(await findAttachment("../../../etc/passwd")).toBeNull();
		expect(await readAttachment("../../secret")).toBeNull();
		expect(await findAttachment("short-hash")).toBeNull();
	});
});
