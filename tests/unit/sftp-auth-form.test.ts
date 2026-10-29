import { describe, expect, it } from "vitest";
import { authFormState } from "../../plugins/sftp/client/auth-form.mjs";
import { normalizeConnection, publicConnection } from "../../plugins/sftp/lib/config.mjs";

describe("SFTP authentication form round trip", () => {
	it.each(["key", "agent", "password"])("preserves explicit %s despite a retained encrypted password", (method) => {
		const conn = normalizeConnection(
			"default",
			{
				host: "example.test",
				auth: {
					method,
					password: "${secret:old-password}",
					privateKeyPath: "~/.ssh/id_ed25519",
					agent: "agent-socket",
				},
			},
			{},
			[],
		);
		expect(authFormState(publicConnection(conn))).toEqual({ method, secretName: "" });
	});
	it("fills encrypted password names only for secret authentication", () => {
		expect(authFormState({ name: "prod", auth: { method: "secret", password: "secret:prod-password" } })).toEqual({
			method: "secret",
			secretName: "prod-password",
		});
	});
	it("infers a method for legacy connections lacking an explicit choice", () => {
		expect(authFormState({ auth: { password: "secret:legacy" } }).method).toBe("secret");
		expect(authFormState({ auth: { privateKeyPath: "~/.ssh/id_ed25519" } }).method).toBe("key");
	});
});
