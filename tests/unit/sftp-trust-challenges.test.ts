import { describe, expect, it, vi } from "vitest";
import { createTrustChallenges } from "../../plugins/sftp/lib/host-trust.mjs";

function failure(status = "unknown") {
	return Object.assign(new Error("untrusted"), {
		hostTrust: {
			host: "example.test",
			port: 22,
			algorithm: "ssh-ed25519",
			fingerprint: "SHA256:test",
			knownHostsFile: "/tmp/known_hosts",
			status,
		},
		hostKey: Buffer.from("server-key"),
	});
}

describe("SFTP explicit trust challenges", () => {
	it("keeps raw keys server-side and saves only the exact confirmed challenge", async () => {
		const save = vi.fn().mockResolvedValue({});
		const challenges = createTrustChallenges({ save });
		const challenge = challenges.capture(failure(), "/project");
		expect(challenge).not.toHaveProperty("hostKey");
		await expect(
			challenges.accept({ ...challenge, fingerprint: "wrong", confirmed: true }, "/project"),
		).rejects.toThrow("fingerprint");
		await expect(challenges.accept({ ...challenge, confirmed: true }, "/other")).rejects.toThrow("workspace");
		expect(save).not.toHaveBeenCalled();
		await challenges.accept({ ...challenge, confirmed: true }, "/project");
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ key: Buffer.from("server-key"), fingerprint: "SHA256:test", replace: false }),
		);
		await expect(challenges.accept({ ...challenge, confirmed: true }, "/project")).rejects.toThrow("expired");
	});

	it("requires explicit replacement and refuses revoked keys", async () => {
		const save = vi.fn().mockResolvedValue({});
		const challenges = createTrustChallenges({ save });
		const changed = challenges.capture(failure("changed"), "/project");
		await expect(challenges.accept({ ...changed, confirmed: true }, "/project")).rejects.toThrow("replacement");
		await challenges.accept({ ...changed, confirmed: true, replace: true }, "/project");
		const revoked = challenges.capture(failure("revoked"), "/project");
		await expect(challenges.accept({ ...revoked, confirmed: true, replace: true }, "/project")).rejects.toThrow(
			"Revoked",
		);
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("expires requests and retains a failed save for a user retry", async () => {
		let time = 0;
		const save = vi.fn().mockRejectedValueOnce(new Error("read only")).mockResolvedValue({});
		const challenges = createTrustChallenges({ save, now: () => time });
		const challenge = challenges.capture(failure(), "/project");
		await expect(challenges.accept({ ...challenge, confirmed: true }, "/project")).rejects.toThrow("read only");
		await challenges.accept({ ...challenge, confirmed: true }, "/project");
		const expired = challenges.capture(failure(), "/project");
		time = 300_001;
		await expect(challenges.accept({ ...expired, confirmed: true }, "/project")).rejects.toThrow("expired");
	});
});
