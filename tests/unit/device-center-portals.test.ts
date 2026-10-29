import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { DevicePortals, parsePortalPorts } from "../../server/device-center/device-portals.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "device-portals-"));
	directories.push(path);
	return path;
}
const origin = "https://hub.example";
const ports = [19001, 19002, 19003];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parsePortalPorts", () => {
	it("parses a strict unique comma-separated port pool", () => {
		expect(parsePortalPorts(undefined)).toEqual([]);
		expect(parsePortalPorts(" ")).toEqual([]);
		expect(parsePortalPorts("1, 65535,19001")).toEqual([1, 65535, 19001]);
	});
	it.each(["0", "65536", "01", "1,1", "1,", ",1", "1,,2", "-1", "+1", "1.0", "1e2", "1 2", "foo"])(
		"rejects invalid port syntax %s",
		(value) => {
			expect(() => parsePortalPorts(value)).toThrow();
			try {
				parsePortalPorts(value);
			} catch (error) {
				expect(error).toMatchObject({ status: 400 });
			}
		},
	);
});

describe("DevicePortals", () => {
	it("persists ports, aliases and detached origin snapshots", async () => {
		const dir = await directory();
		let registry = await DevicePortals.open(dir, `${origin}/`, ports);
		expect(await registry.assign("device-a", "account-a", "workstation")).toEqual({
			deviceId: "device-a",
			accountId: "account-a",
			port: 19001,
			alias: "workstation",
		});
		expect(await registry.assign("device-a", "account-a")).toMatchObject({ port: 19001, alias: "workstation" });
		const snapshot = registry.origins();
		await registry.assign("device-b", "account-b", "laptop");
		expect(snapshot.size).toBe(1);
		registry = await DevicePortals.open(dir, origin, [...ports].reverse());
		expect(registry.getOrigin("device-a")).toBe("https://hub.example:19001");
		expect(registry.getAlias("device-a")).toBe("workstation");
		expect(registry.resolveAlias("workstation")).toEqual({ deviceId: "device-a", accountId: "account-a" });
		expect(registry.getOrigin("unknown")).toBeUndefined();
		expect(registry.resolveAlias("unknown")).toBeUndefined();
		if (process.platform !== "win32") expect((await stat(join(dir, "device-portals.json"))).mode & 0o777).toBe(0o600);
	});
	it("serializes simultaneous assignments and alias conflicts without revealing ownership", async () => {
		const dir = await directory();
		const registry = await DevicePortals.open(dir, origin, ports);
		const results = await Promise.allSettled([
			registry.assign("one", "owner-one", "shared"),
			registry.assign("two", "owner-two", "shared"),
			registry.assign("three", "owner-three", "other"),
		]);
		expect(results[0].status).toBe("fulfilled");
		expect(results[1]).toMatchObject({ status: "rejected", reason: { status: 409, message: "Portal unavailable" } });
		expect(results[2]).toMatchObject({ status: "fulfilled", value: { port: 19002 } });
		await expect(registry.assign("one", "intruder", "private")).rejects.toMatchObject({
			status: 409,
			message: "Portal unavailable",
		});
		expect(registry.getAlias("one")).toBe("shared");
		const reopened = await DevicePortals.open(dir, origin, ports);
		expect(reopened.origins().size).toBe(2);
	});
	it("never reallocates retired ports, releases aliases, and permits the same owner to reactivate", async () => {
		const dir = await directory();
		let registry = await DevicePortals.open(dir, origin, [19001, 19002]);
		await registry.assign("one", "owner", "shared");
		await registry.retire("one");
		await registry.retire("missing");
		expect(registry.getOrigin("one")).toBeUndefined();
		expect(registry.getAlias("one")).toBeUndefined();
		expect(registry.resolveAlias("shared")).toBeUndefined();
		registry = await DevicePortals.open(dir, origin, [19001, 19002]);
		expect(await registry.assign("two", "owner", "shared")).toMatchObject({ port: 19002 });
		await expect(registry.assign("three", "owner")).rejects.toMatchObject({ status: 409 });
		await expect(registry.assign("one", "intruder")).rejects.toMatchObject({ status: 409 });
		expect(await registry.assign("one", "owner")).toEqual({ deviceId: "one", accountId: "owner", port: 19001 });
	});
	it("changes aliases atomically and supports concurrent idempotent device assignments", async () => {
		const registry = await DevicePortals.open(await directory(), origin, ports);
		const results = await Promise.all(Array.from({ length: 8 }, () => registry.assign("one", "owner", "first")));
		expect(new Set(results.map((entry) => entry.port))).toEqual(new Set([19001]));
		await registry.assign("one", "owner", "second");
		expect(registry.resolveAlias("first")).toBeUndefined();
		expect(registry.resolveAlias("second")).toEqual({ deviceId: "one", accountId: "owner" });
	});
	it.each([
		"",
		"UPPER",
		"1bad",
		"a_b",
		"é",
		"a/b",
		"a".repeat(33),
		"api",
		"ws",
		"device-connect",
		"assets",
		"devices",
		"rooms",
		"desktop",
		"auth",
		"login",
		"portal",
	])("rejects invalid or reserved alias %s", async (alias) => {
		const registry = await DevicePortals.open(await directory(), origin, ports);
		await expect(registry.assign("device", "owner", alias)).rejects.toMatchObject({ status: 400 });
		expect(registry.origins().size).toBe(0);
	});
	it("validates identities and empty pools", async () => {
		const registry = await DevicePortals.open(await directory(), origin, []);
		await expect(registry.assign("", "owner")).rejects.toMatchObject({ status: 400 });
		await expect(registry.assign("device", " ")).rejects.toMatchObject({ status: 400 });
		await expect(registry.assign("device", "owner")).rejects.toMatchObject({ status: 409 });
	});
	it("rejects changed host, protocol, hub port, and allocation pool", async () => {
		const dir = await directory();
		const registry = await DevicePortals.open(dir, origin, ports);
		await registry.assign("one", "owner");
		for (const changed of ["https://other.example", "http://hub.example", "https://hub.example:8443"])
			await expect(DevicePortals.open(dir, changed, ports)).rejects.toThrow(/configuration/);
		await expect(DevicePortals.open(dir, origin, [19002, 19003])).rejects.toThrow(/configuration/);
		await expect(DevicePortals.open(dir, origin, [...ports, 19004])).rejects.toThrow(/configuration/);
	});
	it.each(["garbage", "null", "{}", '{"version":2}'])("fails closed on malformed registry %s", async (raw) => {
		const dir = await directory();
		const path = join(dir, "device-portals.json");
		await writeFile(path, raw);
		await expect(DevicePortals.open(dir, origin, ports)).rejects.toThrow(/malformed/);
		expect(await readFile(path, "utf8")).toBe(raw);
	});
	it("fails closed on duplicate ports, devices, aliases, invalid accounts and retired aliases", async () => {
		const dir = await directory();
		const registry = await DevicePortals.open(dir, origin, ports);
		await registry.assign("one", "owner", "first");
		const path = join(dir, "device-portals.json");
		const state = JSON.parse(await readFile(path, "utf8"));
		for (const allocations of [
			[state.allocations[0], { ...state.allocations[0], deviceId: "two", alias: "second" }],
			[state.allocations[0], { ...state.allocations[0], port: 19002, alias: "second" }],
			[state.allocations[0], { ...state.allocations[0], deviceId: "two", port: 19002 }],
			[{ ...state.allocations[0], accountId: "" }],
			[{ ...state.allocations[0], retired: true }],
			[{ ...state.allocations[0], port: 19999 }],
		]) {
			await writeFile(path, JSON.stringify({ ...state, allocations }));
			await expect(DevicePortals.open(dir, origin, ports)).rejects.toThrow(/malformed/);
		}
	});
	it("keeps memory and disk unchanged on atomic replacement failure and recovers its queue", async () => {
		const dir = await directory();
		const registry = await DevicePortals.open(dir, origin, ports);
		await registry.assign("one", "owner", "first");
		const path = join(dir, "device-portals.json");
		const before = await readFile(path, "utf8");
		const spy = vi
			.spyOn(fs, "rename")
			.mockRejectedValueOnce(Object.assign(new Error("simulated rename failure"), { code: "EACCES" }));
		await expect(registry.assign("one", "owner", "second")).rejects.toThrow("simulated rename failure");
		expect(registry.getAlias("one")).toBe("first");
		expect(await readFile(path, "utf8")).toBe(before);
		expect(await readdir(dir)).toEqual(["device-portals.json"]);
		spy.mockRejectedValueOnce(new Error("retire failed"));
		await expect(registry.retire("one")).rejects.toThrow("retire failed");
		expect(registry.getOrigin("one")).toBeDefined();
		await registry.assign("two", "owner", "second");
		expect((await DevicePortals.open(dir, origin, ports)).getAlias("two")).toBe("second");
	});
	it("rejects invalid origins and port arrays before creating a registry", async () => {
		const dir = await directory();
		for (const value of [
			"garbage",
			"ftp://hub.example",
			"https://hub.example/path",
			"https://hub.example?query",
			"https://user@hub.example",
		])
			await expect(DevicePortals.open(dir, value, ports)).rejects.toMatchObject({ status: 400 });
		for (const pool of [[0], [65536], [19001, 19001], [443], [1.5]])
			await expect(DevicePortals.open(dir, origin, pool)).rejects.toMatchObject({ status: 400 });
		expect(await readdir(dir)).toEqual([]);
	});
});
