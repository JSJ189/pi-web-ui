/** Additional focus for Pi's existing initial/update summary prompts; never replaces their format. */
export const COMPACTION_RETENTION_INSTRUCTIONS = `Preserve the SDK's default structured checkpoint format. Within its existing sections, always retain the following categories when present; mark missing information as unknown rather than inventing it:
- Goal: the active user goal, scope, and completion criteria.
- Constraints & Preferences: explicit user requirements, prohibitions, permissions, and corrections that still apply.
- Critical Context: verified facts and their evidence (observed outputs, exact paths, symbols, errors, and relevant references). Label hypotheses, inferences, and unverified claims explicitly; never promote them to facts.
- Progress / Done and In Progress: actual changes, affected files, decisions and rationale, and what remains incomplete. Distinguish proposed work from applied changes.
- Progress / Critical Context: validation commands, observed results, failures, and checks not run; never infer success from a proposed command or an absent error.
- Blocked / Next Steps: unresolved questions, blockers, and concrete next actions needed to continue.
Preserve all context-evidence:<sha256> references verbatim, including references in earlier summaries, with their associated claim and verification status. A reference alone does not prove a claim; do not invent, rewrite, or expand its contents.
Treat any supplied summary as candidate notes to verify against the conversation, not as authoritative evidence. Condense redundant exploration without dropping the retained categories or still-applicable user constraints.`;

/** Append without changing caller instructions; safe when both tool and adapter apply it. */
export function appendCompactionInstructions(instructions?: string): string {
	if (instructions?.includes(COMPACTION_RETENTION_INSTRUCTIONS)) return instructions;
	return instructions ? `${instructions}\n\n${COMPACTION_RETENTION_INSTRUCTIONS}` : COMPACTION_RETENTION_INSTRUCTIONS;
}

export interface CompactionInstructionsOptions {
	/**
	 * Return a bounded, deterministic index (up to 32 hash-named evidence refs)
	 * and the real evidence directory path for read to list the complete index.
	 * The host owns filesystem access; do not include evidence bodies here.
	 * Called after successful default compaction, before its summary is persisted.
	 * Empty/whitespace output adds nothing. Errors reject compaction so an index
	 * failure cannot silently persist a checkpoint without the evidence index.
	 */
	getEvidenceIndex?: () => Promise<string>;
}

const installedWrappers = new WeakSet<Function>();

/**
 * Compatibility adapter for Pi's shared manual/auto default summarization path.
 * No public hook currently accepts instructions for automatic compaction:
 * session_before_compact can cancel or supply a finished summary instead.
 * Install once on each new SDK session, before it can compact. False means the
 * private five-argument method is unavailable/incompatible; leave it untouched.
 * Extension-provided summaries bypass this method and are intentionally unaffected.
 * Reinstallation keeps the first installation's callback; install with options upfront.
 */
export function installCompactionInstructions(session: unknown, options?: CompactionInstructionsOptions): boolean {
	if (!session || typeof session !== "object") return false;
	try {
		// Inspect data descriptors only: do not invoke an unknown SDK accessor.
		let owner: object | null = session;
		let descriptor: PropertyDescriptor | undefined;
		while (owner && !descriptor) {
			descriptor = Object.getOwnPropertyDescriptor(owner, "_runDefaultCompaction");
			if (!descriptor) owner = Object.getPrototypeOf(owner);
		}
		const original = descriptor?.value;
		if (typeof original !== "function") return false;
		if (installedWrappers.has(original)) return true;
		if (original.length !== 5) return false;
		const getEvidenceIndex = options?.getEvidenceIndex;
		function wrapped(
			this: unknown,
			preparation: unknown,
			model: unknown,
			instructions: unknown,
			signal: unknown,
			reason: unknown,
			...rest: unknown[]
		) {
			// Unexpected future argument types pass through unchanged.
			const result = original.call(
				this,
				preparation,
				model,
				typeof instructions === "string" || instructions === undefined
					? appendCompactionInstructions(instructions)
					: instructions,
				signal,
				reason,
				...rest,
			);
			if (!getEvidenceIndex) return result;
			return Promise.resolve(result).then(async (compaction: unknown) => {
				if (!compaction || typeof compaction !== "object" || !("summary" in compaction)) return compaction;
				if (typeof compaction.summary !== "string") return compaction;
				const index = await getEvidenceIndex();
				if (!index.trim()) return compaction;
				return { ...compaction, summary: `${compaction.summary}\n\n${index}` };
			});
		}
		Object.defineProperty(session, "_runDefaultCompaction", {
			...(owner === session ? descriptor : { configurable: true, writable: true, enumerable: false }),
			value: wrapped,
		});
		installedWrappers.add(wrapped);
		return true;
	} catch {
		return false;
	}
}
