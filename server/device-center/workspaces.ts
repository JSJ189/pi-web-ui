import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface DeviceWorkspaceBinding {
	roomId: string;
	root: string;
	revision: string;
}
export interface DeviceWorkspaceLease {
	root: string;
	revision: string;
	release(): void;
}
export interface DeviceWorkspaces {
	readonly defaultRoot: string;
	get(roomId: string): DeviceWorkspaceBinding | undefined;
	list(): DeviceWorkspaceBinding[];
	set(input: { roomId: string; path: string; signal?: AbortSignal }): Promise<DeviceWorkspaceBinding>;
	remove(roomId: string, options?: { signal?: AbortSignal }): Promise<void>;
	acquire(roomId: string): Promise<DeviceWorkspaceLease>;
}
export class DeviceWorkspaceError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}
function invalid(message: string): never {
	throw new DeviceWorkspaceError(400, "WORKSPACE_INVALID", message);
}
function roomKey(roomId: string): string {
	if (typeof roomId !== "string" || !roomId.trim() || roomId.length > 256) invalid("Invalid room ID");
	return roomId;
}
function contains(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Create once per local device/hub scope; share the same instance with all executors and routes. */
export async function createDeviceWorkspaces(options: {
	dataDir: string;
	defaultRoot: string;
	scope: string;
}): Promise<DeviceWorkspaces> {
	if (typeof options.scope !== "string" || !options.scope) invalid("Workspace scope is required");
	await mkdir(options.dataDir, { recursive: true });
	const dataRoot = await realpath(options.dataDir);
	const home = await realpath(homedir());
	const directory = join(dataRoot, "device-workspaces");
	await mkdir(directory, { recursive: true });
	const file = join(directory, `${createHash("sha256").update(options.scope).digest("hex")}.json`);
	let bindings = new Map<string, DeviceWorkspaceBinding>();
	const leases = new Map<string, number>();
	let serial: Promise<unknown> = Promise.resolve();
	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = serial.then(work);
		serial = result.catch(() => undefined);
		return result;
	}
	async function validateRoot(input: string): Promise<string> {
		if (typeof input !== "string" || !input || !isAbsolute(input)) invalid("Select an absolute project directory");
		const selected = resolve(input);
		try {
			// Reject links at every path component, including the chosen root.
			for (let current = selected; ; current = dirname(current)) {
				const stat = await lstat(current);
				if (stat.isSymbolicLink()) invalid("Project path must not contain symbolic links");
				if (!stat.isDirectory()) invalid("Project path must be a directory");
				if (dirname(current) === current) break;
			}
			const root = await realpath(selected);
			if (root === parse(root).root || relative(home, root) === "") invalid("Home and volume roots cannot be projects");
			if (contains(root, dataRoot)) invalid("Device data directory must be outside the project");
			return root;
		} catch (error) {
			if (error instanceof DeviceWorkspaceError) throw error;
			invalid("Project directory is unavailable");
		}
	}
	try {
		const saved: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!Array.isArray(saved)) throw new Error("Invalid workspace registry");
		for (const item of saved) {
			if (
				!item ||
				typeof item.root !== "string" ||
				!isAbsolute(item.root) ||
				typeof item.revision !== "string" ||
				!item.revision ||
				bindings.has(roomKey(item.roomId))
			)
				throw new Error("Invalid workspace registry");
			bindings.set(item.roomId, { roomId: item.roomId, root: item.root, revision: item.revision });
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	function checkCancelled(signal?: AbortSignal): void {
		if (signal?.aborted) throw new DeviceWorkspaceError(409, "REQUEST_CANCELLED", "Project binding request cancelled");
	}
	async function commit(next: Map<string, DeviceWorkspaceBinding>, signal?: AbortSignal): Promise<void> {
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, JSON.stringify([...next.values()]), { mode: 0o600, flag: "wx" });
			checkCancelled(signal);
			await rename(temp, file);
		} catch (error) {
			if (error instanceof DeviceWorkspaceError) throw error;
			throw new DeviceWorkspaceError(500, "WORKSPACE_SAVE_FAILED", "Could not save project binding");
		} finally {
			await rm(temp, { force: true }).catch(() => undefined);
		}
		bindings = next;
	}
	function assertIdle(roomId: string): void {
		if (leases.get(roomId))
			throw new DeviceWorkspaceError(
				409,
				"WORKSPACE_BUSY",
				"Stop active work or transfers before changing the project",
			);
	}
	return {
		defaultRoot: options.defaultRoot,
		get(roomId) {
			const binding = bindings.get(roomId);
			return binding ? { ...binding } : undefined;
		},
		list() {
			return [...bindings.values()].map((binding) => ({ ...binding }));
		},
		set(input) {
			return enqueue(async () => {
				checkCancelled(input.signal);
				const roomId = roomKey(input.roomId);
				assertIdle(roomId);
				const root = await validateRoot(input.path);
				const binding = { roomId, root, revision: randomUUID() };
				const next = new Map(bindings);
				next.set(roomId, binding);
				await commit(next, input.signal);
				return { ...binding };
			});
		},
		remove(roomId, removeOptions) {
			return enqueue(async () => {
				checkCancelled(removeOptions?.signal);
				roomKey(roomId);
				assertIdle(roomId);
				if (!bindings.has(roomId)) return;
				const next = new Map(bindings);
				next.delete(roomId);
				await commit(next, removeOptions?.signal);
			});
		},
		acquire(roomId) {
			return enqueue(async () => {
				roomKey(roomId);
				const binding = bindings.get(roomId);
				if (!binding)
					throw new DeviceWorkspaceError(409, "WORKSPACE_NOT_BOUND", "Bind this group to a local project first");
				await validateRoot(binding.root);
				leases.set(roomId, (leases.get(roomId) ?? 0) + 1);
				let released = false;
				return {
					root: binding.root,
					revision: binding.revision,
					release() {
						if (released) return;
						released = true;
						const count = (leases.get(roomId) ?? 1) - 1;
						if (count) leases.set(roomId, count);
						else leases.delete(roomId);
					},
				};
			});
		},
	};
}
