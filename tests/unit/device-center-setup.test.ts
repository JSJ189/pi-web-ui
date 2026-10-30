import { describe, expect, it } from "vitest";
import { buildHubDeploymentPrompt, isLocalSetupOrigin, validateHubSetup } from "../../web/src/device-center-setup";
import { readFileSync } from "node:fs";
const input = { host: "127.0.0.1", port: 8790, publicUrl: "http://127.0.0.1:8790" };
describe("device center first-run setup", () => {
	it("accepts bind IPs and unprivileged ports with reachable origins", () => {
		for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "::", "::1", "2001:db8::1"])
			expect(validateHubSetup({ ...input, host })).toBe(true);
	});
	it("rejects shell syntax, credentials, paths, wildcard public URLs and privileged ports", () => {
		for (const host of ["example.com", "127.0.0.1;shutdown", "999.1.1.1", "01.2.3.4"])
			expect(validateHubSetup({ ...input, host })).toBe(false);
		for (const port of [0, 1023, 65536, 8790.5, NaN]) expect(validateHubSetup({ ...input, port })).toBe(false);
		for (const publicUrl of [
			"javascript:alert(1)",
			"https://user:secret@example.com",
			"https://example.com/path",
			"http://0.0.0.0:8790",
			"http://[::]:8790",
			"https://example.com?token=secret",
			"https://example.com#secret",
		])
			expect(validateHubSetup({ ...input, publicUrl })).toBe(false);
	});
	it("limits one-click setup to local browser origins", () => {
		expect(isLocalSetupOrigin("http://127.0.0.1:8787")).toBe(true);
		expect(isLocalSetupOrigin("http://[::1]:8787")).toBe(true);
		expect(isLocalSetupOrigin("https://localhost.evil.example")).toBe(false);
	});
	it("bounds deployment context and states remote execution and verification limits", () => {
		const prompt = buildHubDeploymentPrompt(
			input,
			{
				platform: "x".repeat(10000),
				nodeVersion: "22",
				defaultPort: 8790,
				defaultPublicUrl: input.publicUrl,
				dataDir: "private-path",
				cliPath: "private-cli",
			},
			"remote",
		);
		expect(prompt.length).toBeLessThan(2200);
		expect(prompt).not.toContain("private-path");
		expect(prompt).toContain("Do not automatically SSH");
		expect(prompt).toContain("without verification");
		expect(prompt).toContain("not evidence of the remote server environment");
		expect(() => buildHubDeploymentPrompt({ ...input, host: ";echo" }, null, "current")).toThrow();
	});
	it("retains group data on request failure and only hides after confirmed unbinding", () => {
		const source = readFileSync("web/src/components/DeviceGroupSection.tsx", "utf8");
		expect(source).toContain('>("status", signal)');
		expect(source).toContain("if (!confirmedBound) return []");
		expect(source).not.toContain("setRooms([])");
		expect(source).toContain("if (bound === false");
	});
});
