/**
 * Host-owned compaction recovery state. Never reads or rewrites SDK transcripts.
 *
 * Integration:
 * - Capture the session file at compaction_start; pass undefined for ephemeral or
 *   !sessionManager.isPersisted() sessions, even if the SDK exposes a file name.
 * - mark(file, { reason, startedAt }) must succeed before claiming durable state.
 * - On compaction_end, append COMPACTION_DONE_TYPE via the captured session's
 *   SessionManager.appendCustomEntry(), then finish(file). This module does not
 *   append SDK entries. Keep the old compaction-markers repair for old files.
 * - Call consumeInterrupted(file) only when restoring a session, before starting
 *   new work. Emit the interruption notice only when it returns a state.
 *
 * All operations are synchronous within the host's single-writer data directory.
 * I/O and invalid-state errors propagate; callers must report persistence errors.
 * A successful consume removes the state before returning (at most one notice).
 */
import { readFileSync, rmSync } from "node:fs";
import { writeJsonAtomicSync } from "./atomic-file.js";

export interface CompactionState {
	reason: string;
	startedAt: number;
}

type SessionFile = string | null | undefined;

function sidecar(file: SessionFile): string | undefined {
	return file ? `${file}.compaction-state.json` : undefined;
}

function isState(value: unknown): value is CompactionState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<CompactionState>;
	return (
		typeof state.reason === "string" &&
		state.reason.length > 0 &&
		typeof state.startedAt === "number" &&
		Number.isFinite(state.startedAt) &&
		state.startedAt >= 0
	);
}

/** Atomically persist pending state; false means this session has no durable file. */
export function mark(file: SessionFile, state: CompactionState): boolean {
	const path = sidecar(file);
	if (!path) return false;
	if (!isState(state)) throw new Error("Invalid compaction state");
	writeJsonAtomicSync(path, {
		version: 1,
		reason: state.reason,
		startedAt: state.startedAt,
	});
	return true;
}

/** Clear pending state after the caller records the outcome through the SDK. */
export function finish(file: SessionFile): boolean {
	const path = sidecar(file);
	if (!path) return false;
	try {
		rmSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Consume once on restore. A failed read/delete never reports successful recovery. */
export function consumeInterrupted(file: SessionFile): CompactionState | undefined {
	const path = sidecar(file);
	if (!path) return undefined;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const state: unknown = JSON.parse(raw);
	if (!isState(state) || (state as CompactionState & { version?: unknown }).version !== 1) {
		throw new Error(`Invalid compaction state: ${path}`);
	}
	// Do not return a notice if another consumer has already removed the state.
	if (!finish(file)) return undefined;
	return { reason: state.reason, startedAt: state.startedAt };
}
