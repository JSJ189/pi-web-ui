import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { utils } from "ssh2";
import { createHostVerifier, saveTrustedHostKey, verifyKnownHosts } from "../../plugin-sdk/ssh-host-trust.mjs";

function generateKey() {
	const parsed = utils.parseKey(utils.generateKeyPairSync("ed25519").private);
	if (parsed instanceof Error) throw parsed;
	return (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH();
}
const key = generateKey();
const oldKey = generateKey();
const fingerprint = (value: Buffer) =>
	`SHA256:${createHash("sha256").update(value).digest("base64").replace(/=+$/, "")}`;
const record = (hosts: string, value = key) => `${hosts} ssh-ed25519 ${value.toString("base64")}\n`;
let dir: string;
let file: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "sftp-trust-"));
	file = path.join(dir, "known_hosts");
	vi.stubEnv("PI_WEB_SSH_KNOWN_HOSTS", file);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});
const save = (options: Record<string, unknown> = {}) =>
	saveTrustedHostKey({ host: "example.test", key, fingerprint: fingerprint(key), ...options });

async function challenge(port = 22) {
	const verifier = await createHostVerifier("example.test", port);
	expect(verifier.hostVerifier(key)).toBe(false);
	return verifier.getError() as Error & { hostTrust: Record<string, unknown>; hostKey: Buffer };
}

describe("explicit shared SSH trust", () => {
	it("reports an unknown challenge without exposing key bytes or implicitly writing trust", async () => {
		const error = await challenge(2222);
		expect(error.hostTrust).toEqual({
			host: "example.test",
			port: 2222,
			algorithm: "ssh-ed25519",
			fingerprint: fingerprint(key),
			knownHostsFile: file,
			status: "unknown",
		});
		expect(error.hostKey).toEqual(key);
		expect(Object.keys(error)).not.toContain("hostKey");
		expect(JSON.stringify(error)).not.toContain(key.toString("base64"));
		expect(error.message).toContain("host key untrusted or changed");
		expect(error.message).toContain("StrictHostKeyChecking=ask");
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("persists a verified nonstandard-port key and accepts it on the next handshake", async () => {
		const result = await save({ port: 2222 });
		expect(result).toEqual({
			host: "example.test",
			port: 2222,
			algorithm: "ssh-ed25519",
			fingerprint: fingerprint(key),
			knownHostsFile: file,
		});
		expect(await readFile(file, "utf8")).toBe(record("[example.test]:2222"));
		expect((await createHostVerifier("example.test", 2222)).hostVerifier(key)).toBe(true);
		expect((await createHostVerifier("example.test", 22)).hostVerifier(key)).toBe(false);
	});

	it("requires explicit replacement and re-reads changes made after the challenge", async () => {
		await challenge();
		const original = record("example.test", oldKey);
		await writeFile(file, original);
		expect((await challenge()).hostTrust.status).toBe("changed");
		await expect(save()).rejects.toThrow("explicit replace");
		expect(await readFile(file, "utf8")).toBe(original);
		await save({ replace: true });
		expect(verifyKnownHosts(await readFile(file, "utf8"), "example.test", 22, oldKey)).toBe(false);
		expect((await createHostVerifier("example.test")).hostVerifier(key)).toBe(true);
	});

	it("rejects mismatched fingerprints without touching the file and permits later saves", async () => {
		await expect(save({ fingerprint: fingerprint(oldKey) })).rejects.toThrow("fingerprint mismatch");
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		await save();
		expect(await readdir(dir)).toEqual(["known_hosts"]);
	});

	it("reports revoked keys and never overwrites revoked bindings", async () => {
		const original = record("example.test") + "@revoked " + record("example.test");
		await writeFile(file, original);
		expect((await challenge()).hostTrust.status).toBe("revoked");
		await expect(save({ replace: true })).rejects.toThrow("revoked");
		await expect(save({ key: oldKey, fingerprint: fingerprint(oldKey), replace: true })).rejects.toThrow("revoked");
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("serializes concurrent saves without losing hosts or duplicating an accepted key", async () => {
		await Promise.all(Array.from({ length: 12 }, (_, i) => save({ host: `host${i}.test` })));
		await Promise.all([save(), save(), save()]);
		const contents = await readFile(file, "utf8");
		for (let i = 0; i < 12; i++) expect(verifyKnownHosts(contents, `host${i}.test`, 22, key)).toBe(true);
		expect(contents.split("\n").filter(Boolean)).toHaveLength(13);
		expect(await readdir(dir)).toEqual(["known_hosts"]);
	});

	it("preserves aliases, unrelated rows, comments and original permissions during replacement", async () => {
		const neighbors = "# trusted fleet\r\n" + record("neighbor.test", oldKey);
		await writeFile(
			file,
			neighbors + "  " + record("example.test,alias.test", oldKey).trimEnd() + " alias comment\r\n",
		);
		await chmod(file, 0o640);
		const mode = (await stat(file)).mode & 0o777;
		await save({ replace: true });
		const contents = await readFile(file, "utf8");
		expect(contents).toBe(
			neighbors + "  " + record("alias.test", oldKey).trimEnd() + " alias comment\r\n" + record("example.test"),
		);
		expect(verifyKnownHosts(contents, "alias.test", 22, oldKey)).toBe(true);
		expect((await stat(file)).mode & 0o777).toBe(mode);
	});

	it("replaces only the matching hashed binding while preserving hashed neighbors", async () => {
		const hashed = (host: string) => {
			const salt = Buffer.alloc(20, 3);
			return `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update(host).digest("base64")}`;
		};
		const neighbor = record(hashed("neighbor.test"), oldKey);
		await writeFile(file, record(hashed("example.test"), oldKey) + neighbor);
		await save({ replace: true });
		expect(await readFile(file, "utf8")).toBe(neighbor + record("example.test"));
	});

	it.each(["*.test", "example.test,*.test", "@cert-authority example.test", "@revoked *.test"])(
		"refuses broad or marked replacement: %s",
		async (hosts) => {
			const original = record(hosts, oldKey);
			await writeFile(file, original);
			await expect(save({ replace: true })).rejects.toThrow(/safely replace|revoked/);
			expect(await readFile(file, "utf8")).toBe(original);
		},
	);

	it.each(["bad\nhost", "*.test", "a,b.test", "!example.test", "|1|hash", "#comment"])(
		"rejects unsafe host input: %s",
		async (host) => {
			await expect(save({ host })).rejects.toThrow("Invalid SSH host");
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("fails closed for an unreadable trust file", async () => {
		vi.stubEnv("PI_WEB_SSH_KNOWN_HOSTS", dir);
		await expect(save()).rejects.toThrow("Cannot read SSH known_hosts");
	});
});
