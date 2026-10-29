import { describe, expect, it, vi } from "vitest";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";

for (const Session of [UniversalSession, DshClientSession]) {
	describe(`${Session.name} partial presets`, () => {
		function harness(preset: Record<string, unknown>) {
			const current = {
				customSystemPrompt: "old prompt",
				retryMaxAttempts: 7,
				softCapTokens: 64000,
				softCapByModel: { model: 48000 },
				reviewPrompt: "keep review",
				reviewDisabledSkills: ["review-skill"],
				disabledSkills: ["skill"],
				disabledExtensions: ["extension"],
				disabledAgentTools: ["bash"],
				toolApprovalEnabled: true,
				terminalBash: true,
			};
			const persisted = structuredClone(current);
			const saveSettings = vi.fn((_id: string, patch: object) => Object.assign(persisted, patch));
			const session = Object.assign(Object.create(Session.prototype), {
				clientId: "preset-test",
				settings: structuredClone(current),
				stateStore: { getPresets: () => [preset], saveSettings },
				applyPersona: vi.fn().mockResolvedValue(undefined),
				pushSettings: vi.fn(),
				flushSnapshot: vi.fn(),
				emit: vi.fn(),
				emitNotice: vi.fn(),
			});
			return { session, current, persisted, saveSettings };
		}

		it("preserves retry, soft cap, review, skills and tools for a prompt-only preset", async () => {
			const { session, current, persisted, saveSettings } = harness({
				name: "prompt",
				customSystemPrompt: "new prompt",
			});
			await session.applyPreset("prompt");
			expect(saveSettings).toHaveBeenCalledExactlyOnceWith("preset-test", {
				customSystemPrompt: "new prompt",
			});
			expect(persisted).toEqual({ ...current, customSystemPrompt: "new prompt" });
			if (Session === DshClientSession) expect(session.settings).toEqual(persisted);
		});

		it("saves compose fields and explicit clears without persisting metadata or unknown fields", async () => {
			const compose = {
				promptTemplate: "{{soul}}\n{{custom}}",
				promptOverrides: { soul: "new soul" },
				promptDisabled: ["skills"],
				reviewPrompt: "",
				disabledSkills: [],
				terminalBash: false,
			};
			const { session, saveSettings } = harness({
				name: "compose",
				...compose,
				plugins: [{ id: "example", version: "1.0.0" }],
				engine: "other",
			});
			await session.applyPreset("compose");
			expect(saveSettings).toHaveBeenCalledExactlyOnceWith("preset-test", compose);
			if (Session === DshClientSession) {
				expect(session.settings).toMatchObject(compose);
				expect(session.applyPersona).toHaveBeenCalledOnce();
				expect(session.settings).not.toHaveProperty("plugins");
			}
		});

		it("ignores invalid provided fields without replacing current values", async () => {
			const { session, current, persisted, saveSettings } = harness({
				name: "invalid",
				retryMaxAttempts: undefined,
				softCapTokens: "bad",
				toolApprovalEnabled: null,
			});
			await session.applyPreset("invalid");
			expect(saveSettings).toHaveBeenCalledExactlyOnceWith("preset-test", {});
			expect(persisted).toEqual(current);
		});
	});
}
