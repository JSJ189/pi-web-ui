import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSetupConfig, type SetupRuntimeConfig } from "../../server/setup-config.js";
import { loadServerFileConfig, saveServerFileConfig } from "../../server/server-config.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const runtime = (): SetupRuntimeConfig => ({
	token: "old-token",
	host: "127.0.0.1",
	port: 8787,
	allowHosts: [],
	allowOrigins: [],
});

describe("setup configuration transaction", () => {
	it.each([{ host: "invalid/host" }, { port: 0 }, { port: true }, { allowHosts: [] }, { allowOrigins: 123 }])(
		"does not publish a token or save on validation failure: %j",
		(invalid) => {
			const current = runtime();
			const previous = { token: "old-token" };
			const save = vi.fn();
			const result = saveSetupConfig({ token: "new-token", ...invalid }, previous, current, save);
			expect(result).toMatchObject({ ok: false, status: 400 });
			expect(result).not.toHaveProperty("nextToken");
			expect(current.token).toBe("old-token");
			expect(previous.token).toBe("old-token");
			expect(save).not.toHaveBeenCalled();
		},
	);

	it("keeps the runtime token when a real filesystem save fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-setup-transaction-"));
		dirs.push(dir);
		const blocked = join(dir, "not-a-directory");
		writeFileSync(blocked, "block mkdir");
		const current = runtime();
		const result = saveSetupConfig({ token: "new-token" }, { token: current.token }, current, (config) =>
			saveServerFileConfig(blocked, config),
		);
		if (result.ok) current.token = result.nextToken;
		expect(result).toMatchObject({ ok: false, status: 500 });
		expect(result).not.toHaveProperty("nextToken");
		expect(current.token).toBe("old-token");
	});

	it("publishes the trimmed next token only after successful persistence", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-setup-transaction-"));
		dirs.push(dir);
		const current = runtime();
		const result = saveSetupConfig(
			{ token: " new-token ", host: "0.0.0.0", port: "9001" },
			{ token: current.token },
			current,
			(config) => {
				expect(current.token).toBe("old-token");
				saveServerFileConfig(dir, config);
			},
		);
		expect(result).toMatchObject({ ok: true, nextToken: "new-token", tokenApplied: true, restartRequired: true });
		expect(loadServerFileConfig(dir)).toEqual({ token: "new-token", host: "0.0.0.0", port: 9001 });
		expect(current.token).toBe("old-token");
	});

	it("clears token and optional fields only in the saved candidate", () => {
		const current = runtime();
		const previous = { token: "old-token", host: "localhost", port: 9000, allowHosts: "example.com" };
		const save = vi.fn();
		const result = saveSetupConfig({ token: " ", host: "", port: "", allowHosts: "" }, previous, current, save);
		expect(save).toHaveBeenCalledWith({});
		expect(result).toMatchObject({ ok: true, nextToken: "", tokenApplied: true });
		expect(previous.token).toBe("old-token");
	});

	it("retains runtime token for omitted token and normalizes allowlists for restart comparison", () => {
		const current = { ...runtime(), allowHosts: ["example.com"], allowOrigins: ["https://example.com"] };
		const result = saveSetupConfig(
			{ allowHosts: " EXAMPLE.COM ", allowOrigins: " HTTPS://EXAMPLE.COM " },
			{},
			current,
			vi.fn(),
		);
		expect(result).toMatchObject({ ok: true, nextToken: "old-token", tokenApplied: false, restartRequired: false });
	});
});
