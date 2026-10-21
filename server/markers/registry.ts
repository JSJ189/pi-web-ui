/**
 * registry.ts — 标记工具注册表（内置版）。
 */

import type { MarkerTool } from "./marker.js";
import type { ServerLang } from "../i18n.js";

type MarkerMap = Map<string, MarkerTool<unknown>>;

const registry: MarkerMap = new Map();

export function registerMarker(marker: MarkerTool<unknown>): void {
	registry.set(marker.name, marker);
}

export function getMarker(name: string): MarkerTool<unknown> | undefined {
	return registry.get(name);
}

export function allMarkers(): MarkerTool<unknown>[] {
	return [...registry.values()];
}

export function collectGuidance(disabled: Set<string> = new Set(), lang: ServerLang = "en"): string[] {
	const out: string[] = [];
	for (const m of allMarkers()) {
		if (m.isAlias) continue;
		if (disabled.has(m.name)) continue;
		const lines = m.getGuidance?.(lang) ?? m.guidance;
		if (lines && lines.length > 0) out.push(...lines);
	}
	return out;
}

export function listMarkerNames(): string[] {
	return [...registry.keys()];
}
