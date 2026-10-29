import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clients: [] as any[], readFile: vi.fn(), verifier: vi.fn() }));
vi.mock("node:fs", () => ({ promises: { readFile: mocks.readFile } }));
vi.mock("../../plugin-sdk/ssh-host-trust.mjs", () => ({ createHostVerifier: mocks.verifier }));
vi.mock("ssh2", () => ({
	default: {
		Client: class extends EventEmitter {
			options: any;
			callback: any;
			end = vi.fn();
			constructor() {
				super();
				mocks.clients.push(this);
			}
			connect(options: any) {
				this.options = options;
			}
			sftp(callback: any) {
				this.callback = callback;
			}
			ready() {
				this.emit("ready");
				this.callback(null, { client: this });
			}
		},
	},
}));
import { createSshManager } from "../../plugins/sftp/lib/ssh.mjs";

const managers: any[] = [];
function setup(global: any = null) {
	const getDecryptedProfile = vi.fn(async () => global);
	const secrets = { get: vi.fn((name: string) => (name === "password" ? "secret-password" : undefined)) };
	const manager = createSshManager({ host: { get: () => ({ getDecryptedProfile }) }, secrets });
	managers.push(manager);
	return { manager, secrets, getDecryptedProfile };
}
const conn = (auth: any = { method: "password", password: "password" }, cwd = "/project") => ({
	name: "prod",
	host: "example.test",
	username: "user",
	__cwd: cwd,
	auth,
});
async function clientAt(index: number) {
	await vi.waitFor(() => expect(mocks.clients.length).toBeGreaterThan(index));
	return mocks.clients[index];
}
async function open(manager: any, connection: any) {
	const index = mocks.clients.length;
	const opening = manager.getSftp(connection);
	const client = await clientAt(index);
	client.ready();
	return opening;
}
beforeEach(() => {
	mocks.clients.length = 0;
	mocks.readFile.mockReset().mockRejectedValue(new Error("ENOENT"));
	mocks.verifier.mockReset().mockResolvedValue({ hostVerifier: () => true, getError: () => null });
});
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dropAll();
});

describe("SFTP method-specific credentials", () => {
	it.each(["password", "secret"])(
		"%s ignores stale local and global private key paths and references",
		async (method) => {
			const { manager, secrets, getDecryptedProfile } = setup({
				profile: { privateKeyPath: "/global-key" },
				password: "global",
				passphrase: "unused",
			});
			const connection = {
				...conn({
					method,
					password: "${secret:password}",
					privateKeyPath: "/missing",
					privateKey: "${secret:missing}",
					passphrase: "${secret:missing}",
					agent: "${secret:missing}",
				}),
				useGlobal: "global",
			};
			await open(manager, connection);
			expect(mocks.clients[0].options).toMatchObject({ password: "secret-password" });
			expect(secrets.get).toHaveBeenCalledTimes(1);
			expect(mocks.readFile).not.toHaveBeenCalled();
			expect(getDecryptedProfile).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["key", "agent"])("global password cannot override explicit %s", async (method) => {
		const { manager } = setup({
			profile: { privateKeyPath: "/global-key" },
			password: "global-password",
			passphrase: "global-passphrase",
		});
		mocks.readFile.mockResolvedValue("global-key");
		await open(manager, {
			...conn({
				method,
				agent: "agent-socket",
				password: "${secret:missing}",
				privateKeyPath: method === "agent" ? "/stale" : undefined,
			}),
			useGlobal: "global",
		});
		const options = mocks.clients[0].options;
		expect(options.password).toBeUndefined();
		if (method === "key") expect(options).toMatchObject({ privateKey: "global-key", passphrase: "global-passphrase" });
		else {
			expect(options).toMatchObject({ agent: "agent-socket" });
			expect(options.privateKey).toBeUndefined();
			expect(mocks.readFile).not.toHaveBeenCalled();
		}
	});
	it("password takes only global password and allows the global host to supply a missing host", async () => {
		const { manager } = setup({
			profile: { host: "global.test", privateKeyPath: "/global-key" },
			password: "global-password",
			passphrase: "unused",
		});
		await open(manager, { ...conn({ method: "password" }), host: "", useGlobal: "global" });
		expect(mocks.clients[0].options).toMatchObject({ host: "global.test", password: "global-password" });
		expect(mocks.readFile).not.toHaveBeenCalled();
	});
	it("local key path wins over global key path", async () => {
		const { manager } = setup({ profile: { privateKeyPath: "/global-key" }, password: "global-password" });
		mocks.readFile.mockResolvedValue("local-key");
		await open(manager, { ...conn({ method: "key", privateKeyPath: "/local-key" }), useGlobal: "global" });
		expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/local-key", "utf8");
		expect(mocks.clients[0].options.privateKey).toBe("local-key");
	});
});

describe("SFTP pool credentials and invalidation", () => {
	it("rotates equal-length private keys and exposes only a hash in the pool", async () => {
		const { manager } = setup();
		const first = await open(manager, conn({ method: "key", privateKey: "key-AAAA" }));
		const entry = manager._pool.get(first.key);
		expect(entry.fp).toMatch(/^[a-f0-9]{64}$/);
		expect(entry.fp).not.toContain("key-AAAA");
		const second = await open(manager, conn({ method: "key", privateKey: "key-BBBB" }));
		expect(second.client).not.toBe(first.client);
		expect(first.client.end).toHaveBeenCalledTimes(1);
		expect(manager._pool.get(first.key).fp).not.toBe(entry.fp);
	});
	it("shares identical inflight credentials", async () => {
		const { manager } = setup();
		const first = manager.getSftp(conn());
		const second = manager.getSftp(conn());
		const client = await clientAt(0);
		client.ready();
		expect((await second).client).toBe((await first).client);
		expect(mocks.clients).toHaveLength(1);
	});
	it("waits then rechecks different inflight credentials instead of returning the old connection", async () => {
		const { manager } = setup();
		const first = manager.getSftp(conn());
		const old = await clientAt(0);
		const second = manager.getSftp(conn({ method: "password", password: "new-password" }));
		await Promise.resolve();
		expect(mocks.clients).toHaveLength(1);
		old.ready();
		await first;
		const fresh = await clientAt(1);
		expect(fresh.options.password).toBe("new-password");
		fresh.ready();
		expect((await second).client).toBe(fresh);
		expect(old.end).toHaveBeenCalledTimes(1);
	});
	it.each(["drop", "dropAll"])(
		"%s cancels in-progress SFTP and ignores late callbacks without deleting a new flight",
		async (operation) => {
			const { manager } = setup();
			const opening = manager.getSftp(conn());
			const rejection = expect(opening).rejects.toThrow("cancelled");
			const old = await clientAt(0);
			old.emit("ready");
			if (operation === "drop") manager.drop("/project\u0000prod");
			else manager.dropAll();
			const next = manager.getSftp(conn());
			await rejection;
			const fresh = await clientAt(1);
			old.callback(null, {});
			old.emit("close");
			expect(manager._pool.size).toBe(0);
			const shared = manager.getSftp(conn());
			fresh.ready();
			expect((await next).client).toBe(fresh);
			expect((await shared).client).toBe(fresh);
			expect(mocks.clients).toHaveLength(2);
			expect(manager._pool.size).toBe(1);
			expect(old.end).toHaveBeenCalledTimes(1);
		},
	);
	it("dropAll preserves exceptCwd inflight connections", async () => {
		const { manager } = setup();
		const kept = manager.getSftp(conn(undefined, "/keep"));
		const discarded = manager.getSftp(conn(undefined, "/discard"));
		const rejection = expect(discarded).rejects.toThrow("cancelled");
		await clientAt(1);
		manager.dropAll("/keep");
		await rejection;
		const keepClient = mocks.clients.find((c) => !c.end.mock.calls.length);
		keepClient.ready();
		expect((await kept).client).toBe(keepClient);
		expect([...manager._pool.keys()]).toEqual(["/keep\u0000prod"]);
	});
	it("different credentials retry after the older flight fails", async () => {
		const { manager } = setup();
		const first = manager.getSftp(conn());
		const rejection = expect(first).rejects.toThrow("authentication failed");
		const old = await clientAt(0);
		const second = manager.getSftp(conn({ method: "password", password: "replacement" }));
		old.emit("error", new Error("authentication failed"));
		await rejection;
		const fresh = await clientAt(1);
		fresh.ready();
		expect((await second).client).toBe(fresh);
		expect(fresh.options.password).toBe("replacement");
	});
	it("dropAll during host verification prevents late TCP creation", async () => {
		let release!: (value: any) => void;
		mocks.verifier.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const { manager } = setup();
		const opening = manager.getSftp(conn());
		const rejection = expect(opening).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		manager.dropAll();
		release({ hostVerifier: () => true, getError: () => null });
		await rejection;
		expect(mocks.clients).toHaveLength(0);
		expect(manager._pool.size).toBe(0);
	});
	it("dropAll during auth resolution prevents later TCP creation", async () => {
		let release!: (value: any) => void;
		const { manager, getDecryptedProfile } = setup();
		getDecryptedProfile.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const opening = manager.getSftp({ ...conn(), useGlobal: "global" });
		const rejection = expect(opening).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		manager.dropAll();
		release({ profile: {} });
		await rejection;
		expect(mocks.clients).toHaveLength(0);
	});
});
