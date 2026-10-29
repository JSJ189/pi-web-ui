import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server, utils } from "ssh2";
import { createHostVerifier, verifyKnownHosts } from "../../plugin-sdk/ssh-host-trust.mjs";
import { createSshManager } from "../../plugins/sftp/lib/ssh.mjs";
import { RemoteSshService } from "../../server/remote-ssh-service.js";

const privateKey = utils.generateKeyPairSync("ed25519").private;
const parsed = utils.parseKey(privateKey);
if (parsed instanceof Error) throw parsed;
const key = (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH();
const record = (host: string) => `${host} ssh-ed25519 ${key.toString("base64")}\n`;
let dir: string;
let knownHosts: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "ssh-trust-"));
	knownHosts = path.join(dir, "known_hosts");
	vi.stubEnv("PI_WEB_SSH_KNOWN_HOSTS", knownHosts);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

describe("known_hosts verification", () => {
	it("binds the key to the exact host and port", () => {
		expect(verifyKnownHosts(record("example.test"), "example.test", 22, key)).toBe(true);
		expect(verifyKnownHosts(record("example.test"), "other.test", 22, key)).toBe(false);
		expect(verifyKnownHosts(record("example.test"), "example.test", 2222, key)).toBe(false);
		expect(verifyKnownHosts(record("[example.test]:2222"), "example.test", 2222, key)).toBe(true);
		expect(verifyKnownHosts(record("[::1]:2222"), "::1", 2222, key)).toBe(true);
		expect(verifyKnownHosts(record("example.test"), "example.test", 22, Buffer.from("wrong key"))).toBe(false);
	});
	it("supports hashed hosts including nonstandard ports", () => {
		const salt = Buffer.alloc(20, 7);
		const hash = createHmac("sha1", salt).update("[example.test]:2222").digest("base64");
		const line = record(`|1|${salt.toString("base64")}|${hash}`);
		expect(verifyKnownHosts(line, "example.test", 2222, key)).toBe(true);
		expect(verifyKnownHosts(line, "example.test", 22, key)).toBe(false);
	});
	it("handles aliases, patterns, negation, revocation and unsupported CA entries", () => {
		expect(verifyKnownHosts(record("alias.test,*.example.test,!bad.example.test"), "ok.example.test", 22, key)).toBe(
			true,
		);
		expect(verifyKnownHosts(record("alias.test,*.example.test,!bad.example.test"), "bad.example.test", 22, key)).toBe(
			false,
		);
		expect(
			verifyKnownHosts(record("example.test") + "@revoked " + record("example.test"), "example.test", 22, key),
		).toBe(false);
		expect(verifyKnownHosts("@cert-authority " + record("example.test"), "example.test", 22, key)).toBe(false);
		expect(verifyKnownHosts("# comment\ninvalid\nexample.test ssh-rsa !!!", "example.test", 22, key)).toBe(false);
	});
	it("rejects unknown keys without writing trust and gives actionable verification instructions", async () => {
		const trust = await createHostVerifier("example.test", 2222);
		expect(trust.hostVerifier(key)).toBe(false);
		expect(trust.getError()?.message).toContain("SHA256:");
		expect(trust.getError()?.message).toContain("StrictHostKeyChecking=ask");
		expect(trust.getError()?.message).toContain("PI_WEB_SSH_KNOWN_HOSTS");
		await expect(readFile(knownHosts)).rejects.toMatchObject({ code: "ENOENT" });
		await writeFile(knownHosts, record("[example.test]:2222"));
		expect((await createHostVerifier("example.test", 2222)).hostVerifier(key)).toBe(true);
	});
	it("fails closed when the configured trust file is unreadable", async () => {
		vi.stubEnv("PI_WEB_SSH_KNOWN_HOSTS", dir);
		await expect(createHostVerifier("example.test")).rejects.toThrow("Cannot read SSH known_hosts");
	});
});

describe("real SSH handshake trust boundary", () => {
	it("both core and plugin reject before authentication, then accept a preprovisioned key", async () => {
		let authentications = 0;
		const clients = new Set<any>();
		const server = new Server({ hostKeys: [privateKey] }, (client) => {
			clients.add(client);
			client.on("error", () => {});
			client.on("close", () => clients.delete(client));
			client.on("authentication", (ctx) => {
				authentications++;
				ctx.accept();
			});
			client.on("ready", () =>
				client.on("session", (accept) => {
					accept().on("sftp", (acceptSftp) => {
						acceptSftp();
					});
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing test port");
		const port = address.port;
		const service = Object.create(RemoteSshService.prototype) as any;
		service.hydrateAuthParams = async (params: any) => params;
		const manager = createSshManager({ host: {} as any, secrets: {} as any });
		const params = { host: "127.0.0.1", port, username: "test", auth: { type: "password", password: "test" } };
		const connection = { ...params, name: "test", auth: { method: "password", password: "test" } };
		let coreClient: any;
		try {
			await expect(service.createClient(params)).rejects.toThrow("host key untrusted");
			await expect(manager.getSftp(connection)).rejects.toThrow("host key untrusted");
			expect(authentications).toBe(0);
			const other = utils.parseKey(utils.generateKeyPairSync("ed25519").private);
			if (other instanceof Error) throw other;
			const otherKey = (Array.isArray(other) ? other[0] : other).getPublicSSH();
			const changedRecord = `[127.0.0.1]:${port} ssh-ed25519 ${otherKey.toString("base64")}\n`;
			await writeFile(knownHosts, changedRecord);
			await expect(service.createClient(params)).rejects.toThrow("host key untrusted");
			await expect(manager.getSftp(connection)).rejects.toThrow("host key untrusted");
			expect(authentications).toBe(0);
			expect(await readFile(knownHosts, "utf8")).toBe(changedRecord);
			await writeFile(knownHosts, record(`[127.0.0.1]:${port}`));
			coreClient = (await service.createClient(params)).client;
			const plugin = await manager.getSftp(connection);
			expect(plugin.client).toBeDefined();
			expect(authentications).toBeGreaterThanOrEqual(2);
		} finally {
			coreClient?.end();
			manager.dropAll();
			for (const client of clients) client.end();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 15_000);
});
