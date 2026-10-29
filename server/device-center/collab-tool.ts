import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DEVICE_COLLAB_TOOL_NAME } from "../tool-manager.js";

export const DEVICE_COLLAB_ACTIONS = [
	"list_devices",
	"list_rooms",
	"create_room",
	"send_message",
	"send_task",
	"sync_files",
	"transfer_preview",
	"transfer_apply",
] as const;
export type DeviceCollabAction = (typeof DEVICE_COLLAB_ACTIONS)[number];

const parameters = Type.Object(
	{
		action: Type.Unsafe<DeviceCollabAction>({ type: "string", enum: [...DEVICE_COLLAB_ACTIONS] }),
		roomId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		targetDeviceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		message: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
		prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
		parentTaskId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 256,
				description: "Parent remote task; the service verifies or replaces this from the current session.",
			}),
		),
		paths: Type.Optional(Type.Array(Type.String(), { maxItems: 200, description: "Project-relative files to send." })),
		transferId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		revision: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		overwritePaths: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: 200,
				description: "Project-relative paths explicitly approved for overwrite.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type DeviceCollabInput = Static<typeof parameters>;
export type DeviceCollabArgs = Omit<DeviceCollabInput, "action">;
export interface DeviceCollabContext {
	cwd: string;
	sessionId?: string;
}
/** The controller must enforce the bound account/project and propagate signal to fetch. */
export interface DeviceCollabService {
	execute(
		action: DeviceCollabAction,
		args: DeviceCollabArgs,
		signal: AbortSignal | undefined,
		context?: DeviceCollabContext,
	): Promise<unknown>;
}
let service: DeviceCollabService | undefined;
export function setDeviceCollabService(value: DeviceCollabService | undefined): void {
	service = value;
}

const allowed: Record<DeviceCollabAction, string[]> = {
	list_devices: [],
	list_rooms: [],
	create_room: ["name", "targetDeviceId"],
	send_message: ["roomId", "message"],
	send_task: ["roomId", "targetDeviceId", "prompt", "parentTaskId"],
	sync_files: ["roomId", "targetDeviceId", "paths"],
	transfer_preview: ["roomId", "targetDeviceId", "transferId"],
	transfer_apply: ["roomId", "targetDeviceId", "transferId", "revision", "overwritePaths"],
};
const required: Record<DeviceCollabAction, string[]> = {
	...allowed,
	send_task: ["roomId", "targetDeviceId", "prompt"],
};
function validate(input: DeviceCollabInput): void {
	if (!input || !Object.hasOwn(allowed, input.action)) throw new Error("Invalid device_collab action.");
	const fields = allowed[input.action];
	for (const [key, value] of Object.entries(input)) {
		if (key === "action") continue;
		if (!fields.includes(key)) throw new Error("Unsupported device_collab argument.");
		if (key === "paths" || key === "overwritePaths") {
			if (!Array.isArray(value) || value.length > 200 || (key === "paths" && !value.length))
				throw new Error("Invalid file paths.");
			for (const path of value) {
				if (
					typeof path !== "string" ||
					!path ||
					path.length > 4096 ||
					/[\\:\x00-\x1f]/.test(path) ||
					path.startsWith("/") ||
					path.split("/").some((s) => !s || s === "." || s === "..")
				)
					throw new Error("File paths must be project-relative without traversal.");
			}
		} else if (
			typeof value !== "string" ||
			!value.trim() ||
			value.length > (key === "message" || key === "prompt" ? 16000 : key === "name" ? 200 : 256)
		) {
			throw new Error("Invalid device_collab argument value.");
		}
	}
	for (const key of required[input.action])
		if (!Object.hasOwn(input, key)) throw new Error(`Missing device_collab argument: ${key}.`);
}

// Only structural identifiers/status/counts leave the service boundary. No raw replies,
// file contents, credentials, endpoints, or arbitrary service error strings are exposed.
const summaryKeys = new Set([
	"id",
	"deviceId",
	"roomId",
	"targetDeviceId",
	"transferId",
	"taskId",
	"messageId",
	"revision",
	"status",
	"online",
	"ok",
	"count",
	"total",
	"size",
	"bytes",
	"truncated",
	"devices",
	"rooms",
	"tasks",
	"files",
	"conflicts",
	"path",
	"exists",
	"changed",
	"name",
	"sha256",
	"baseline",
	"applied",
	"unchanged",
	"rejected",
	"preview",
	"manifest",
	"totalBytes",
]);
function summarize(value: unknown, depth = 0): unknown {
	if (depth > 4) return undefined;
	if (typeof value === "string") return value.slice(0, 256);
	if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => summarize(item, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) if (summaryKeys.has(key)) out[key] = summarize(item, depth + 1);
		return out;
	}
	return undefined;
}
export function makeDeviceCollabTool() {
	return defineTool({
		name: DEVICE_COLLAB_TOOL_NAME,
		label: "Device collaboration",
		description:
			"List devices and rooms, create rooms, send messages or explicit tasks, and preview or apply file transfers through the locally bound device service. Uses the current account and project; accepts no endpoints, credentials, or arbitrary roots. Returns bounded summaries.",
		promptSnippet: "coordinate tasks and project files across your bound devices",
		promptGuidelines: [
			"List devices and rooms before selecting targets; send tasks only to an explicit targetDeviceId in a roomId.",
			"Use project-relative paths; preview a transfer before applying its revision and explicitly selected overwritePaths.",
		],
		parameters,
		execute: async (_id, input, signal, _onUpdate, context) => {
			const bound = service;
			if (!bound) throw new Error("Device collaboration service is not bound.");
			signal?.throwIfAborted();
			validate(input);
			const captured: DeviceCollabContext = { cwd: context.cwd, sessionId: context.sessionManager.getSessionId() };
			if (!captured.cwd) throw new Error("Device collaboration requires a project context.");
			const { action, ...args } = input;
			let response: unknown;
			try {
				response = await bound.execute(action, args, signal, captured);
			} catch {
				signal?.throwIfAborted();
				throw new Error("Device collaboration request failed.");
			}
			signal?.throwIfAborted();
			let summary = response && typeof response === "object" ? (summarize(response) ?? {}) : {};
			if (Buffer.byteLength(JSON.stringify(summary), "utf8") > 48000) summary = { truncated: true };
			const details = { action, summary };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}
