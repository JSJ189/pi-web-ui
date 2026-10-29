/** Shared streaming transcript reader. Memory scales with textual JSONL records,
 * not the file or embedded binary `data` strings. */
import { createReadStream } from "node:fs";
import { setImmediate } from "node:timers/promises";

/** Discard JSON string values of `data` properties (embedded image/base64 payloads)
 * before assembling lines. Preserve the empty string so JSON syntax stays valid.
 * Text/content strings remain intact, including escaped quotes and newlines. */
class BinaryStringFilter {
	private inString = false;
	private escaped = false;
	private token = "";
	private dataKey = false;
	private awaitingValue = false;
	private discard = false;

	push(chunk: string): string {
		const output: string[] = [];
		for (const char of chunk) {
			if (char === "\n") {
				this.inString = false;
				this.escaped = false;
				this.discard = false;
			}
			if (this.inString) {
				if (!this.discard) output.push(char);
				if (this.escaped) {
					this.escaped = false;
					if (this.token.length < 16) this.token += char;
				} else if (char === "\\") {
					this.escaped = true;
					if (this.token.length < 16) this.token += char;
				} else if (char === '"') {
					this.inString = false;
					if (this.discard) output.push(char);
					try {
						this.dataKey = JSON.parse('"' + this.token + '"') === "data";
					} catch {
						this.dataKey = false;
					}
					this.discard = false;
				} else if (this.token.length < 16) this.token += char;
				continue;
			}
			output.push(char);
			if (char === '"') {
				this.inString = true;
				this.token = "";
				this.discard = this.awaitingValue;
				this.awaitingValue = false;
				this.dataKey = false;
			} else if (!/\s/.test(char)) {
				this.awaitingValue = char === ":" && this.dataKey;
				this.dataKey = false;
			}
			// JSONL records are independent, including after malformed lines.
			if (char === "\n") {
				this.dataKey = false;
				this.awaitingValue = false;
			}
		}
		return output.join("");
	}
}

/** Early return and errors close the file. Non-binary text records are not capped:
 * an exceptionally large single text message still requires one record in memory. */
export async function* sessionLines(filePath: string, signal?: AbortSignal): AsyncGenerator<string> {
	signal?.throwIfAborted();
	const input = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024, signal });
	const filter = new BinaryStringFilter();
	let pending = "";
	let count = 0;
	try {
		for await (const chunk of input) {
			signal?.throwIfAborted();
			const text = filter.push(chunk as string);
			let start = 0;
			let end: number;
			while ((end = text.indexOf("\n", start)) !== -1) {
				const line = pending + text.slice(start, end);
				pending = "";
				if (++count % 128 === 0) await setImmediate();
				signal?.throwIfAborted();
				yield line.endsWith("\r") ? line.slice(0, -1) : line;
				start = end + 1;
			}
			pending += text.slice(start);
			await setImmediate();
		}
		signal?.throwIfAborted();
		if (pending) yield pending;
		signal?.throwIfAborted();
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	} finally {
		input.destroy();
	}
}

/** Bounded worker pool; results retain input order. No implicit list/result limit. */
export async function mapSessionsConcurrent<T, R>(
	items: readonly T[],
	visit: (item: T, index: number) => Promise<R>,
	concurrency = 4,
	signal?: AbortSignal,
): Promise<R[]> {
	signal?.throwIfAborted();
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
		throw new RangeError("concurrency must be an integer between 1 and 32");
	}
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) {
				signal?.throwIfAborted();
				const index = next++;
				results[index] = await visit(items[index], index);
				signal?.throwIfAborted();
			}
		}),
	);
	signal?.throwIfAborted();
	return results;
}
