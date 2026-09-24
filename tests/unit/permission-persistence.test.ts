import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

describe("Conversation Permission Persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "perm-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (_err) {
			// ignore cleanup error
		}
	});

	function readPermissionFromSession(sm: unknown): string | undefined {
		try {
			const mgr = sm as { getEntries?: () => unknown[] };
			if (typeof mgr?.getEntries !== "function") return undefined;
			const entries = mgr.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i] as { type?: string; customType?: string; data?: { preset?: string } } | undefined;
				if (e?.type === "custom" && e.customType === "permission/preset" && typeof e.data?.preset === "string") {
					return e.data.preset;
				}
			}
		} catch (_err) {
			// ignore
		}
		return undefined;
	}

	it("returns undefined when session has no permission entry", () => {
		const sm = SessionManager.create(tempDir);
		expect(readPermissionFromSession(sm)).toBeUndefined();
	});

	it("persists and restores permission preset across reload", () => {
		const sm = SessionManager.create(tempDir);
		// Pi SessionManager flushes entries to file once the first assistant response arrives
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);

		const sessionFile = sm.getSessionFile();
		expect(sessionFile).toBeDefined();

		// Simulate user switching permission to danger-full-access
		sm.appendCustomEntry("permission/preset", { preset: "danger-full-access" });

		// Read back from the same manager
		expect(readPermissionFromSession(sm)).toBe("danger-full-access");

		// Open afresh from file (simulating project switch or session reopen)
		const reopened = SessionManager.open(sessionFile!);
		expect(readPermissionFromSession(reopened)).toBe("danger-full-access");
	});

	it("restores the latest permission when switched multiple times", () => {
		const sm = SessionManager.create(tempDir);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);

		const sessionFile = sm.getSessionFile();

		sm.appendCustomEntry("permission/preset", { preset: "danger-full-access" });
		sm.appendCustomEntry("permission/preset", { preset: "read-only" });
		sm.appendCustomEntry("permission/preset", { preset: "danger-full-access" });

		const reopened = SessionManager.open(sessionFile!);
		expect(readPermissionFromSession(reopened)).toBe("danger-full-access");
	});
});
