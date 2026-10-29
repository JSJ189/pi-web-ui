/** Display writers opt into history replacement; streaming parsers omit reset. */
export interface TerminalWriter {
	write(data: string): void;
	dispose(): void;
	reset?(): void;
}

const MAX_TERM_BUFFER = 200_000;

export type TerminalOwnerKind = "client" | "conversation";
type BufferedOutput = { data: string; reset: boolean };

/** Routes live output and retained-history replacements to terminal subscribers. */
export function makeTerminalBridge() {
	const writers = new Map<string, Set<TerminalWriter>>();
	const buffers = new Map<string, BufferedOutput>();
	const key = (conversationId: string, terminalId: string, ownerKind?: TerminalOwnerKind) =>
		JSON.stringify([ownerKind ?? "legacy", ownerKind === "client" ? "" : conversationId, terminalId]);
	const legacyKeys = (keys: Iterable<string>, terminalId: string) =>
		[...keys].filter((k) => {
			const [owner, , id] = JSON.parse(k);
			return owner === "legacy" && id === terminalId;
		});
	const deliver = (writer: TerminalWriter, data: string, reset: boolean) => {
		try {
			if (reset) {
				// A replay must neither reset nor feed old command markers to a live SCM parser.
				if (!writer.reset) return;
				writer.reset();
			}
			writer.write(data);
		} catch {
			// A stale subscriber must not prevent delivery to the others.
		}
	};
	return {
		write(
			conversationId: string,
			terminalId: string,
			data: string,
			reset = false,
			ownerKind?: TerminalOwnerKind,
		): void {
			const writerKey = key(conversationId, terminalId, ownerKind);
			const recipientKeys =
				ownerKind || writers.get(writerKey)?.size ? [writerKey] : legacyKeys(writers.keys(), terminalId);
			for (const k of recipientKeys) for (const writer of writers.get(k) ?? []) deliver(writer, data, reset);

			// Keep one retained view per terminal, even while mounted. New display
			// subscribers and remounts must receive the same history as existing ones.
			const previous =
				buffers.get(writerKey) ?? (!ownerKind ? buffers.get(legacyKeys(buffers.keys(), terminalId)[0]) : undefined);
			if (!ownerKind) for (const k of legacyKeys(buffers.keys(), terminalId)) buffers.delete(k);
			buffers.set(writerKey, {
				data: (reset ? data : (previous?.data ?? "") + data).slice(-MAX_TERM_BUFFER),
				reset: reset || (previous?.reset ?? false),
			});
		},
		register(
			conversationId: string,
			terminalId: string,
			writer: TerminalWriter,
			ownerKind?: TerminalOwnerKind,
		): () => void {
			const writerKey = key(conversationId, terminalId, ownerKind);
			let set = writers.get(writerKey);
			if (!set) writers.set(writerKey, (set = new Set()));
			set.add(writer);
			const buffered =
				buffers.get(writerKey) ?? (!ownerKind ? buffers.get(legacyKeys(buffers.keys(), terminalId)[0]) : undefined);
			if (buffered) deliver(writer, buffered.data, buffered.reset);
			return () => {
				const current = writers.get(writerKey);
				current?.delete(writer);
				if (!current?.size) writers.delete(writerKey);
			};
		},
		/** Remove output for terminals absent from an authoritative manager list. */
		reconcile(conversationId: string, terminals: { id: string; ownerKind?: TerminalOwnerKind }[]): void {
			const retained = new Set(terminals.map((t) => key(conversationId, t.id, t.ownerKind ?? "client")));
			for (const k of buffers.keys()) {
				const [owner, conversation] = JSON.parse(k);
				if ((owner === "client" || conversation === conversationId) && !retained.has(k)) buffers.delete(k);
			}
		},
		/** Socket/engine changes invalidate history, not mounted subscriptions. */
		clear(): void {
			buffers.clear();
		},
	};
}
