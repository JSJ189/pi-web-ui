import type { TextQuote } from "./protocol.js";

/** 校验引用元数据，保留原文的换行和缩进。 */
export function readTextQuote(value: unknown): TextQuote | null {
	if (!value || typeof value !== "object") return null;
	const q = value as Partial<TextQuote>;
	if (
		typeof q.text !== "string" ||
		!q.text.trim() ||
		typeof q.messageId !== "string" ||
		!q.messageId ||
		typeof q.role !== "string" ||
		!q.role
	)
		return null;
	return {
		text: q.text,
		messageId: q.messageId,
		role: q.role,
		...(typeof q.sessionId === "string" && q.sessionId ? { sessionId: q.sessionId } : {}),
	};
}

/** JSON 字符串保留原文边界，引用中的换行不参与外层标记解析。 */
export function formatTextQuote(quote: TextQuote): string {
	return `<quoted-text>\n${JSON.stringify(quote)}\n</quoted-text>`;
}

export function parseTextQuote(text: string): TextQuote | null {
	const match = /^<quoted-text>\n([^\n]*)\n<\/quoted-text>$/.exec(text);
	if (!match) return null;
	try {
		return readTextQuote(JSON.parse(match[1]));
	} catch {
		return null;
	}
}

export function formatQuotedPrompt(text: string, quotes: readonly TextQuote[]): string {
	return [text, ...quotes.map(formatTextQuote)].join("\n\n");
}

/** 排队项把引用与提问一起保存；展示时只拆分末尾的完整引用块。 */
export function splitQuotedPrompt(value: string): { text: string; quotes: TextQuote[] } {
	let text = value;
	const quotes: TextQuote[] = [];
	while (true) {
		const match = /(?:^|\n\n)(<quoted-text>\n[^\n]*\n<\/quoted-text>)$/.exec(text);
		const quote = match ? parseTextQuote(match[1]) : null;
		if (!match || !quote) break;
		quotes.unshift(quote);
		text = text.slice(0, match.index);
	}
	return { text, quotes };
}

export function messageTextWithQuotes(message: {
	content: readonly { type: string; text?: unknown }[];
	details?: unknown;
}): string {
	const text = message.content
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
	const values = (message.details as { quotes?: unknown[] } | undefined)?.quotes;
	const quotes = Array.isArray(values) ? values.map(readTextQuote).filter((q): q is TextQuote => q !== null) : [];
	return formatQuotedPrompt(text, quotes);
}
