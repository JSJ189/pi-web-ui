import { describe, expect, it } from "vitest";
import { createMcpDraft, getMcpServerDisplayState, serializeMcpDraft } from "../../web/src/mcp-server-draft";
import type { UiMcpServer } from "../../server/protocol";

const base: UiMcpServer = { name: "test", scope: "global", command: "node" };

describe("MCP server drafts", () => {
	const args = [
		"C:\\Program Files\\MCP\\server.js",
		"",
		'"quoted value"',
		"'single quotes'",
		"back\\slash\\",
		" leading and trailing ",
		"line\nbreak",
	];

	it("round trips arguments literally, including empty arguments and whitespace", () => {
		const server = { ...base, args };
		expect(serializeMcpDraft(createMcpDraft(server))).toEqual(server);
	});

	it("edits, adds, and removes individual arguments without parsing other entries", () => {
		const draft = createMcpDraft({ ...base, args });
		draft.args = [...draft.args.slice(1), "another path with spaces", ""];
		expect(serializeMcpDraft(draft).args).toEqual([...args.slice(1), "another path with spaces", ""]);
		expect(args[0]).toBe("C:\\Program Files\\MCP\\server.js");
	});

	it.each([undefined, [], [""]])("preserves distinct argument configuration %j", (value) => {
		const server = value === undefined ? { ...base } : { ...base, args: value };
		expect(serializeMcpDraft(createMcpDraft(server))).toEqual(server);
	});

	it("saves an empty array when all argument rows are removed", () => {
		const draft = createMcpDraft({ ...base, args: [""] });
		draft.args = [];
		expect(serializeMcpDraft(draft).args).toEqual([]);
	});

	it.each(["stdio", "http", "streamable-http"] as const)(
		"preserves protocolVersion and untouched fields for %s",
		(type) => {
			const server: UiMcpServer = {
				...base,
				type,
				protocolVersion: "2025-03-26",
				args,
				url: type === "stdio" ? undefined : "https://example.com/mcp",
				cwd: " C:\\Program Files\\MCP ",
				env: { " KEY ": " value " },
				headers: { Authorization: "Bearer token" },
				timeout: 0,
				description: " spaced description ",
			};
			const draft = createMcpDraft(server);
			draft.name = "renamed";
			expect(serializeMcpDraft(draft)).toEqual({ ...server, name: "renamed" });
		},
	);

	it("preserves unknown configuration fields but excludes all runtime metadata", () => {
		const server = {
			...base,
			protocolVersion: "2024-11-05",
			futureOption: { mode: "custom" },
			status: "running" as const,
			error: "new config failed",
			tools: [{ name: "tool" }],
			overriddenBy: "project" as const,
			usingPreviousConfig: true,
		};
		expect(serializeMcpDraft(createMcpDraft(server))).toEqual({
			...base,
			protocolVersion: "2024-11-05",
			futureOption: { mode: "custom" },
		});
	});

	it("clears incompatible transport fields while retaining the protocol version", () => {
		const draft = createMcpDraft({ ...base, args, env: { KEY: "secret" }, protocolVersion: "2025-03-26" });
		draft.transport = "http";
		draft.url = "https://example.com/mcp";
		const server = serializeMcpDraft(draft);
		expect(server).toMatchObject({ type: "http", url: draft.url, protocolVersion: "2025-03-26" });
		expect(server.command).toBeUndefined();
		expect(server.args).toBeUndefined();
		expect(server.env).toBeUndefined();
	});
});

describe("MCP status display", () => {
	it.each([undefined, "stopped", "error", "running"] as const)("uses runtime status %s even when enabled", (status) => {
		const display = getMcpServerDisplayState({ ...base, enabled: true, status });
		expect(display.status).toBe(status ?? "stopped");
		expect(display.label).toBe(
			status === "running" ? "mcpStatusRunning" : status === "error" ? "mcpStatusError" : "mcpStatusStopped",
		);
	});

	it("marks overridden entries and hides their tools even with stale running metadata", () => {
		expect(
			getMcpServerDisplayState({ ...base, status: "running", overriddenBy: "project", tools: [{ name: "tool" }] }),
		).toEqual({
			status: "stopped",
			label: "mcpStatusOverridden",
			toolsCount: 0,
		});
	});

	it("marks a previous configuration that is still running with an error", () => {
		expect(
			getMcpServerDisplayState({
				...base,
				status: "running",
				usingPreviousConfig: true,
				error: "failed",
				tools: [{ name: "tool" }],
			}),
		).toEqual({
			status: "running",
			label: "mcpStatusPreviousConfig",
			toolsCount: 1,
		});
	});
});
