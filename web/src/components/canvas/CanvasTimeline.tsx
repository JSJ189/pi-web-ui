import { useMemo } from "react";
import { useCanvasT } from "./canvas-i18n";
import type { CanvasEdge, CanvasNode, CanvasNodeLogEntry } from "../../types";

export interface CanvasTimelineProps {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	logs: Record<string, CanvasNodeLogEntry[]>;
	onRunNode: (id: string) => void;
	onLocate: (id: string) => void;
}

/** P1：执行时间线 — 用节点日志起止时间估算耗时，用 currentLoopCount/现状展示重试 */
export function CanvasTimeline({ nodes, edges, logs, onRunNode, onLocate }: CanvasTimelineProps) {
	const t = useCanvasT();
	const rows = useMemo(() => {
		const loopByTarget = new Map<string, number>();
		edges.forEach((e) => {
			if (e.currentLoopCount) loopByTarget.set(e.targetNodeId, e.currentLoopCount);
		});
		return nodes.map((n) => {
			const entries = logs[n.id] ?? [];
			const latestPrompt = entries.findLastIndex((e) => e.kind === "prompt");
			const attemptEntries = latestPrompt < 0 ? entries : entries.slice(latestPrompt);
			const ts = attemptEntries.map((e) => e.ts).filter((v) => Number.isFinite(v) && v > 0);
			const start = ts.length > 0 ? Math.min(...ts) : null;
			const end = ts.length > 0 ? Math.max(...ts) : null;
			const dur = start != null && end != null ? Math.max(0, end - start) : null;
			const errs = entries.filter((e) => e.kind === "error").length;
			const lastErr = [...entries].reverse().find((e) => e.kind === "error")?.text ?? n.error ?? "";
			return { node: n, count: entries.length, start, end, dur, errs, lastErr, loops: loopByTarget.get(n.id) ?? 0 };
		});
	}, [nodes, edges, logs]);
	const fmtDur = (ms: number) =>
		ms < 1000
			? `${ms}ms`
			: ms < 60000
				? `${(ms / 1000).toFixed(1)}s`
				: `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
	const fmtTime = (t: number) => new Date(t).toLocaleTimeString();
	const failed = rows.filter((r) => r.node.status === "error");
	return (
		<div className="canvas-timeline">
			<div className="canvas-timeline-head">
				<b>{t("执行时间线（最近一次日志估算）", "Execution timeline (latest attempt, estimated)")}</b>
				<span className="canvas-timeline-meta">
					{nodes.length}节点 · {failed.length}失败 · {rows.reduce((a, r) => a + r.count, 0)}条日志
				</span>
				{failed.length > 0 && (
					<button
						type="button"
						className="canvas-btn primary"
						onClick={() => failed.forEach((r) => onRunNode(r.node.id))}
					>
						{t("重试失败节点", "Retry failed nodes")} ({failed.length})
					</button>
				)}
			</div>
			<div className="canvas-timeline-list">
				{rows.map((r) => (
					<div key={r.node.id} className={`canvas-timeline-row st-${r.node.status}`}>
						<span className="canvas-timeline-dot" />
						<button
							type="button"
							className="canvas-timeline-title"
							onClick={() => onLocate(r.node.id)}
							title={t("定位到节点", "Locate node")}
						>
							{r.node.title}
						</button>
						<span className="canvas-timeline-sub">
							{r.node.status}
							{r.loops > 0 ? ` · ${r.loops} ${t("次重试", "retries")}` : ""}
							{r.count > 0 ? ` · ${r.count} ${t("条日志", "logs")}` : ` · ${t("无日志", "No logs")}`}
							{r.dur != null ? ` · ${fmtDur(r.dur)}` : ""}
							{r.start != null ? ` · ${fmtTime(r.start)}` : ""}
						</span>
						{r.node.status === "error" && (
							<button
								type="button"
								className="canvas-btn"
								onClick={() => onRunNode(r.node.id)}
								title={r.lastErr || t("重试该节点", "Retry node")}
							>
								{t("重试", "Retry")}
							</button>
						)}
					</div>
				))}
				{rows.length === 0 && <div className="canvas-timeline-empty">{t("暂无节点", "No nodes")}</div>}
			</div>
		</div>
	);
}
