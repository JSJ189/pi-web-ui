import { useLocale } from "../../i18n";

/** Canvas-local copy avoids concurrent edits to the shared translation catalog. */
export function canvasText(locale: string, zh: string, en: string): string {
	return locale.toLowerCase().startsWith("zh") ? zh : en;
}
export function useCanvasT() {
	const locale = useLocale();
	return (zh: string, en: string) => canvasText(locale, zh, en);
}
