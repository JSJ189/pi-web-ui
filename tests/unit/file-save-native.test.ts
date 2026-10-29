import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, readdir, stat, chmod, link, symlink, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveFilePreservingMetadata } from "../../server/file-save.js";
import { FilesService } from "../../server/files-service.js";

const run = promisify(execFile);
const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-save-native-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native metadata-preserving save (no mocks)", () => {
	it("saves ordinary files, shorter text and empty content through FilesService", async () => {
		const root = await fixture();
		const name = "中文 ' $ ; [file].txt";
		const dest = join(root, name);
		await writeFile(dest, "original longer text", { mode: 0o640 });
		const before = await stat(dest);
		const notices: any[] = [];
		const service = new FilesService({
			getCwd: () => root,
			getActiveCwd: () => root,
			isDisposed: () => false,
			emit: (m) => {
				notices.push(m);
			},
		});
		for (const content of ["replacement 中文", "x", ""]) {
			await service.writeFile(name, content);
			expect(notices.filter((m) => m.type === "notice" && m.level === "error")).toEqual([]);
			expect(await readFile(dest, "utf8")).toBe(content);
			expect((await stat(dest)).mode & 0o777).toBe(before.mode & 0o777);
			expect(await readdir(root)).toEqual([name]);
		}
	}, 30_000);
	it("rejects hard links without changing either alias", async () => {
		const root = await fixture();
		const dest = join(root, "a.txt");
		await writeFile(dest, "original");
		await link(dest, join(root, "alias.txt"));
		await expect(saveFilePreservingMetadata(dest, "new")).rejects.toThrow("multiple hard links");
		expect(await readFile(dest, "utf8")).toBe("original");
		expect(await readFile(join(root, "alias.txt"), "utf8")).toBe("original");
		expect((await readdir(root)).sort()).toEqual(["a.txt", "alias.txt"]);
	});
	it.skipIf(process.platform === "win32")("preserves symbolic links and saves their target", async () => {
		const root = await fixture();
		await writeFile(join(root, "target"), "old");
		await symlink("target", join(root, "link"));
		await saveFilePreservingMetadata(join(root, "link"), "new");
		expect((await lstat(join(root, "link"))).isSymbolicLink()).toBe(true);
		expect(await readFile(join(root, "target"), "utf8")).toBe("new");
	});
	it("never deletes recovery files from earlier saves", async () => {
		const root = await fixture();
		const dest = join(root, "a.txt");
		await writeFile(dest, "old");
		await writeFile(`${dest}.earlier.save-backup`, "recover me");
		await saveFilePreservingMetadata(dest, "new");
		expect(await readFile(`${dest}.earlier.save-backup`, "utf8")).toBe("recover me");
	});
	it.skipIf(process.platform !== "win32")(
		"uses real File.Replace and preserves a protected DACL and alternate streams",
		async () => {
			const root = await fixture();
			const dest = join(root, "protected.txt");
			await writeFile(dest, "old");
			await writeFile(`${dest}:metadata`, "keep stream");
			const powershell = async (script: string) =>
				(
					await run(
						"powershell.exe",
						[
							"-NoLogo",
							"-NoProfile",
							"-NonInteractive",
							"-EncodedCommand",
							Buffer.from("$ErrorActionPreference='Stop'; " + script, "utf16le").toString("base64"),
						],
						{ env: { ...process.env, PI_TEST_FILE: dest }, timeout: 15_000, windowsHide: true },
					)
				).stdout.trim();
			const before = await powershell(
				"$a=Get-Acl -LiteralPath $env:PI_TEST_FILE; $a.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $env:PI_TEST_FILE -AclObject $a; (Get-Acl -LiteralPath $env:PI_TEST_FILE).Sddl",
			);
			await saveFilePreservingMetadata(dest, "new content");
			expect(await readFile(dest, "utf8")).toBe("new content");
			expect(await powershell("(Get-Acl -LiteralPath $env:PI_TEST_FILE).Sddl")).toBe(before);
			expect(await readFile(`${dest}:metadata`, "utf8")).toBe("keep stream");
			expect(await readdir(root)).toEqual(["protected.txt"]);
		},
		30_000,
	);
	it.skipIf(process.platform === "win32")("preserves uid, gid and POSIX mode", async () => {
		const root = await fixture();
		const dest = join(root, "mode.txt");
		await writeFile(dest, "old");
		await chmod(dest, 0o640);
		const before = await stat(dest);
		await saveFilePreservingMetadata(dest, "new");
		const after = await stat(dest);
		expect([after.uid, after.gid, after.mode & 0o7777]).toEqual([before.uid, before.gid, before.mode & 0o7777]);
	});
});
