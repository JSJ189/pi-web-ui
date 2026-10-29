import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DeviceCollabContext, DeviceCollabService } from "./collab-tool.js";
import type { createDeviceFileSync } from "./file-sync.js";
import { transferSummary } from "./transfers.js";
import { checkedUrl } from "./relay.js";

type Config = { hubUrl: string; deviceId: string; credential: string; allowExecution: boolean };
export function createDeviceCollabService(options: {
	getConfig: () => Config | undefined;
	root?: string;
	files?: ReturnType<typeof createDeviceFileSync>;
	workspaceResolver?: (input: {
		roomId: string;
		context: DeviceCollabContext;
		signal?: AbortSignal;
	}) => Promise<{ root: string; files: ReturnType<typeof createDeviceFileSync>; release(): void }>;
	fetch?: typeof fetch;
	getParentTask?: (context?: DeviceCollabContext) => string | undefined;
}): DeviceCollabService {
	const root = options.root === undefined ? undefined : resolve(options.root);
	return {
		async execute(action, args, signal, context) {
			let workspace: { root: string; files: ReturnType<typeof createDeviceFileSync>; release(): void } | undefined;
			try {
				signal?.throwIfAborted();
				if (!context) throw new Error("Invalid workspace");
				if (options.workspaceResolver && !["list_devices", "list_rooms", "create_room"].includes(action)) {
					if (!args.roomId) throw new Error("Room required");
					workspace = await options.workspaceResolver({ roomId: args.roomId, context, signal });
					if (resolve(context.cwd) !== resolve(workspace.root)) throw new Error("Invalid workspace");
				} else if (!options.workspaceResolver && resolve(context.cwd) !== root) throw new Error("Invalid workspace");
				const config = options.getConfig();
				if (!config || !config.deviceId || !config.credential) throw new Error("Device unavailable");
				if (!["list_devices", "list_rooms"].includes(action) && !config.allowExecution)
					throw new Error("Device execution disabled");
				const base = checkedUrl(config.hubUrl);
				if (!["http:", "https:"].includes(base.protocol) || base.search) throw new Error("Invalid hub URL");
				const parentTaskId = options.getParentTask?.(context);
				const request = async (path: string, body?: unknown) => {
					signal?.throwIfAborted();
					const url = new URL(base.href);
					url.pathname = `${url.pathname.replace(/\/$/, "")}/api/agent/${path}`;
					const response = await (options.fetch ?? fetch)(url, {
						method: body === undefined ? "GET" : "POST",
						headers: {
							authorization: `Bearer ${config.credential}`,
							"X-Device-Id": config.deviceId,
							...(body === undefined ? {} : { "Content-Type": "application/json" }),
						},
						body: body === undefined ? undefined : JSON.stringify(body),
						signal,
						redirect: "error",
					});
					if (!response.ok) throw new Error("Hub request failed");
					const result: unknown = await response.json();
					signal?.throwIfAborted();
					return result;
				};
				const room = () => {
					if (!args.roomId) throw new Error("Room required");
					return `rooms/${encodeURIComponent(args.roomId)}`;
				};
				switch (action) {
					case "list_devices":
						return await request("devices");
					case "list_rooms":
						return await request("rooms");
					case "create_room":
						if (!args.targetDeviceId) throw new Error("Target required");
						return await request("rooms", {
							name: args.name,
							deviceIds: [...new Set([config.deviceId, args.targetDeviceId])],
						});
					case "send_message":
						return await request(`${room()}/messages`, { text: args.message });
					case "send_task":
						if (!args.targetDeviceId) throw new Error("Target required");
						return await request(`${room()}/messages`, {
							text: args.prompt,
							targetDeviceIds: [args.targetDeviceId],
							idempotencyKey: randomUUID(),
							...(parentTaskId ? { parentTaskId } : {}),
						});
					case "sync_files": {
						if (!args.targetDeviceId || !args.roomId || !args.paths?.length)
							throw new Error("Transfer fields required");
						const files = workspace?.files ?? options.files;
						if (!files) throw new Error("File workspace unavailable");
						const bundle = await files.prepare({ paths: args.paths, signal });
						const response = await request("transfers", {
							action: "stage",
							roomId: args.roomId,
							targetDeviceId: args.targetDeviceId,
							bundle,
						});
						return summarizeTransfer(response);
					}
					case "transfer_preview":
					case "transfer_apply": {
						if (!args.roomId || !args.targetDeviceId || !args.transferId) throw new Error("Transfer fields required");
						if (action === "transfer_apply" && (!args.revision || !Array.isArray(args.overwritePaths)))
							throw new Error("Explicit apply required");
						return summarizeTransfer(
							await request("transfers", {
								action: action === "transfer_apply" ? "apply" : "preview",
								roomId: args.roomId,
								targetDeviceId: args.targetDeviceId,
								transferId: args.transferId,
								...(action === "transfer_apply"
									? { revision: args.revision, overwritePaths: args.overwritePaths }
									: {}),
							}),
						);
					}
					default:
						throw new Error("Unsupported collaboration action");
				}
			} catch {
				// Remote errors, URLs, fetch errors and local file errors may contain secrets.
				throw new Error(signal?.aborted ? "Device collaboration cancelled." : "Device collaboration request failed.");
			} finally {
				workspace?.release();
			}
		},
	};
}
function summarizeTransfer(value: unknown) {
	const id = value && typeof value === "object" ? (value as { transferId?: unknown }).transferId : undefined;
	return { ...transferSummary(value), ...(typeof id === "string" ? { transferId: id } : {}) };
}
