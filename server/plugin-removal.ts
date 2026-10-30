import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const REMOVAL_RE = /^removed-[0-9a-f-]{36}$/;

/** Move out of the loader's directory before deleting: Windows may keep native addons locked. */
export function removePlugin(dataDir: string, id: string): { deferred: boolean } {
	if (!ID_RE.test(id)) throw new Error(`Invalid plugin id: ${id}`);
	const target = join(dataDir, "plugins", id);
	// Check before creating a tombstone; missing installations must still fail.
	lstatSync(target);
	const trash = join(dataDir, "plugin-trash");
	mkdirSync(trash, { recursive: true });
	const removed = join(trash, `removed-${randomUUID()}`);
	// If renaming fails, preserve the installed tree intact and report the error.
	renameSync(target, removed);
	try {
		rmSync(removed, { recursive: true, force: true });
		return { deferred: false };
	} catch {
		// Already uninstalled. Never restore a partially deleted tree to the loader.
		return { deferred: true };
	}
}

/** Retry only our tombstones on service startup, after the previous process released its DLLs. */
export function cleanupRemovedPlugins(dataDir: string): void {
	const trash = join(dataDir, "plugin-trash");
	let names: string[];
	try {
		if (lstatSync(trash).isSymbolicLink()) return;
		names = readdirSync(trash);
	} catch {
		return;
	}
	for (const name of names) {
		if (!REMOVAL_RE.test(name)) continue;
		try {
			rmSync(join(trash, name), { recursive: true, force: true });
		} catch {
			// Another process may still hold the native module; retry on the next start.
		}
	}
}
