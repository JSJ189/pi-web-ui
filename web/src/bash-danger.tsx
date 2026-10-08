import type { ReactNode } from "react";
import type { UiApprovalHit } from "./types";

export interface DangerousSegment {
	start: number;
	end: number;
	label?: string;
}

const DANGEROUS_REGEXES: { re: RegExp; label: string }[] = [
	{
		re: /\brm\s+((-[a-zA-Z0-9]*[rf][a-zA-Z0-9]*|--recursive|--force)\s+)+(((\/)|(~)|(\.\.)|(\*)|(\.\/))|[a-zA-Z]:[\\/])/i,
		label: "rm -rf (递归/强制删除)",
	},
	{
		re: /\b(del|rmdir|rd)\s+[/-][fsq]/i,
		label: "Windows 强制删除 (del/rmdir/rd)",
	},
	{
		re: /\b(mkfs|dd\s+if=.*of=\/dev\/[sh]d|fdisk|parted)\b/i,
		label: "底层磁盘/格式化操作",
	},
	{
		re: /\b(curl|wget)\s+.*\|\s*(bash|sh|zsh)\b/i,
		label: "管道下载执行远程脚本",
	},
	{
		re: /\bchmod\s+(-R\s+)?(777|a\+rwx)\b/i,
		label: "放开全局写/执行权限 (chmod 777)",
	},
	{
		re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/i,
		label: "Git 破坏性未提交修改丢弃",
	},
	{
		re: /\b(shutdown|reboot|poweroff|init\s+0|halt)\b/i,
		label: "关机/重启",
	},
	{
		re: />\s*\/dev\/[sh]d[a-z]/i,
		label: "直接覆写原始磁盘设备",
	},
	{
		re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i,
		label: "Bash Fork Bomb",
	},
];

function mergeSegments(segments: DangerousSegment[]): DangerousSegment[] {
	if (segments.length <= 1) return segments;
	const sorted = [...segments].sort((a, b) => a.start - b.start);
	const merged: DangerousSegment[] = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const cur = sorted[i];
		const last = merged[merged.length - 1];
		if (cur.start <= last.end) {
			last.end = Math.max(last.end, cur.end);
			if (cur.label && (!last.label || !last.label.includes(cur.label))) {
				last.label = last.label ? `${last.label} / ${cur.label}` : cur.label;
			}
		} else {
			merged.push(cur);
		}
	}
	return merged;
}

export function findDangerousBashSegments(command: string, hits?: UiApprovalHit[]): DangerousSegment[] {
	if (!command || typeof command !== "string") return [];

	if (hits && hits.length > 0) {
		const segments: DangerousSegment[] = [];
		for (const h of hits) {
			if (h.field === "command" && h.length > 0) {
				const start = Math.max(0, h.index);
				const end = Math.min(command.length, start + h.length);
				if (end > start) {
					segments.push({ start, end, label: h.label });
				}
			}
		}
		if (segments.length > 0) {
			return mergeSegments(segments);
		}
	}

	const found: DangerousSegment[] = [];
	for (const { re, label } of DANGEROUS_REGEXES) {
		const m = re.exec(command);
		if (m && m[0].length > 0) {
			found.push({
				start: m.index,
				end: m.index + m[0].length,
				label,
			});
		}
	}
	return mergeSegments(found);
}

export function renderHighlightedCommand(command: string, hits?: UiApprovalHit[]): ReactNode {
	const segments = findDangerousBashSegments(command, hits);
	if (segments.length === 0) return command;

	const parts: ReactNode[] = [];
	let lastIndex = 0;
	segments.forEach((seg, i) => {
		if (seg.start > lastIndex) {
			parts.push(command.slice(lastIndex, seg.start));
		}
		const highlightedText = command.slice(seg.start, seg.end);
		parts.push(
			<mark key={i} className="bash-danger-hit" title={seg.label ?? "高危命令片段"}>
				{highlightedText}
			</mark>,
		);
		lastIndex = seg.end;
	});
	if (lastIndex < command.length) {
		parts.push(command.slice(lastIndex));
	}
	return <>{parts}</>;
}
