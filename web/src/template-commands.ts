import type { SlashCommandInfo } from "./types";

export interface CommandTemplate {
	id: string;
	command?: string;
	prompt: string;
}

/** Store names without the leading slash; matching is case insensitive. */
export function normalizeTemplateCommand(value: string): string {
	return value.trim().replace(/^\//, "").toLowerCase();
}

export function validTemplateCommand(value: string): boolean {
	return /^[a-z][a-z0-9_-]*$/.test(value);
}

export function availableTemplateCommands<T extends CommandTemplate>(
	templates: readonly T[],
	reserved: readonly Pick<SlashCommandInfo, "name">[],
): T[] {
	const used = new Set(["help", "copy", ...reserved.map((c) => c.name.toLowerCase())]);
	return templates.filter((tpl) => {
		const name = normalizeTemplateCommand(tpl.command ?? "");
		if (!validTemplateCommand(name) || used.has(name)) return false;
		used.add(name);
		return true;
	});
}

/** Expand once, preserving multiline arguments and literal replacement characters. */
export function expandTemplateCommand(text: string, templates: readonly CommandTemplate[]): string {
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;
	const tpl = templates.find((t) => normalizeTemplateCommand(t.command ?? "") === match[1].toLowerCase());
	if (!tpl) return text;
	const input = match[2] ?? "";
	return tpl.prompt.includes("{{input}}")
		? tpl.prompt.replaceAll("{{input}}", () => input)
		: [tpl.prompt, input].filter(Boolean).join("\n\n");
}
