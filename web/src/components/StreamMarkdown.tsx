import { memo, useEffect, useMemo, useRef, useState } from "react";
import { segmentStream, stepSmoothStream } from "../stream-markdown";
import { MarkdownBody } from "./Markdown";

/**
 * Prefix-cached streaming markdown renderer (see stream-markdown.ts for the
 * segmentation rules). Replaces the naive `<Markdown text={growingString}>`
 * during streaming, which re-parsed the whole document per delta — O(n²)
 * cumulative parse + highlight work that janks long code-heavy replies.
 *
 * Structure:
 *  - All blocks share one flat list of memoized Segment components keyed by
 *    stable index. Freezing a non-fence tail preserves its MarkdownBody and DOM;
 *    unchanged frozen blocks skip parent-driven renders (copy buttons stay mounted).
 *  - active tail inside an unclosed fence: rendered as PLAIN code — no
 *    highlighting a growing block (that would be O(n²) within the block).
 *  - active tail otherwise: full markdown, rendered immediately below 600 chars;
 *    longer tails throttle to 32ms with a trailing-edge timer. Freezing bypasses
 *    the throttle immediately so the complete block always renders.
 *
 * The parent switches to the authoritative one-shot <Markdown> at message end,
 * correcting any segmentation imperfection (setext headings, forward link
 * reference definitions) in the final render.
 */

/** 恒定步进时间间隔（ms）：锚定约 45 步/秒的细腻节奏，防止在 120Hz/144Hz/240Hz 高刷屏上因 rAF 频率翻倍导致吐字过快。 */
const SMOOTH_PACE_MS = 22;
/** 余韵收尾（finishing）步进时间间隔（ms）：保持平滑加速的同时防止在高刷屏上瞬间闪完导致短思考无过程。 */
const FINISHING_PACE_MS = 14;

const isDocumentHidden = () => typeof document !== "undefined" && document.hidden;

/**
 * 将网络层大段脉冲到达的流式文本，通过 requestAnimationFrame + 时间锚定熨平为
 * 恒定节奏逐字/微步连续流淌的字符串（接收时大段接收，渲染时逐字细腻丝滑渲染）。
 * - 首次挂载若非活跃流（!active）或已有超长历史文本（> 1500 字符，如刷新或切换会话），直接对齐现有长度；
 *   后台标签页（document.hidden）挂载或流式到达直接对齐现有长度，杜绝切回前台时多块同时补播文字流动画；
 *   活跃流中到达的 200~400 字短思考块一律从 0 开始平滑吐出，避免无过程直接全部显示；
 * - 支持 onSettled 回调：当缓冲池追平 targetText 时触发，供流结束余韵收尾（Graceful Tail Drain）无缝切回静态渲染。
 */
export function useSmoothStreamText(text: string, active = true, finishing = false, onSettled?: () => void): string {
	const [displayedLen, setDisplayedLen] = useState<number>(() =>
		!active || isDocumentHidden() || text.length > 1500 ? text.length : 0,
	);
	const targetRef = useRef(text);
	targetRef.current = text;
	const lenRef = useRef(displayedLen);
	lenRef.current = displayedLen;
	const activeRef = useRef(active);
	activeRef.current = active;
	const finishingRef = useRef(finishing);
	finishingRef.current = finishing;
	const onSettledRef = useRef(onSettled);
	onSettledRef.current = onSettled;
	const rafIdRef = useRef(0);
	const lastTickTimeRef = useRef(0);

	useEffect(() => {
		if (typeof document === "undefined") return;
		const handleVisibility = () => {
			if (document.hidden) {
				// 切至后台：直接追平现有长度并结算，不堆积后台动画积压
				if (rafIdRef.current) {
					cancelAnimationFrame(rafIdRef.current);
					rafIdRef.current = 0;
				}
				lenRef.current = targetRef.current.length;
				setDisplayedLen(targetRef.current.length);
				if (finishingRef.current || !activeRef.current) {
					onSettledRef.current?.();
				}
			} else {
				// 切回前台：在后台期间收到的所有文字全部直接显示；
				// 若流已结束（finishing/非活跃），立即结算并不再播放文字流动画；
				// 若流仍在继续，已有文字直接就绪，后续新到 chunk 才平滑流淌。
				if (rafIdRef.current) {
					cancelAnimationFrame(rafIdRef.current);
					rafIdRef.current = 0;
				}
				lenRef.current = targetRef.current.length;
				setDisplayedLen(targetRef.current.length);
				if (finishingRef.current || !activeRef.current) {
					onSettledRef.current?.();
				}
			}
		};
		document.addEventListener("visibilitychange", handleVisibility);
		return () => document.removeEventListener("visibilitychange", handleVisibility);
	}, []);

	useEffect(() => {
		if (!active) {
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = 0;
			}
			if (lenRef.current !== text.length) {
				lenRef.current = text.length;
				setDisplayedLen(text.length);
			}
			return;
		}
		if (isDocumentHidden()) {
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = 0;
			}
			if (lenRef.current !== text.length) {
				lenRef.current = text.length;
				setDisplayedLen(text.length);
			}
			if (finishing || lenRef.current >= text.length) {
				onSettledRef.current?.();
			}
			return;
		}
		if (text.length < lenRef.current) {
			lenRef.current = text.length;
			setDisplayedLen(text.length);
			return;
		}
		if (lenRef.current >= text.length) {
			if (!rafIdRef.current) {
				onSettledRef.current?.();
			}
			return;
		}

		// 若当前平滑推进动画已在运行，绝不因为新 chunk 到达而频繁 cancelAnimationFrame
		// （消除 Debounce / Cancel Starvation，彻底根治流式展开思考块冻结卡死 #708）
		if (rafIdRef.current) return;

		const tick = (now: number) => {
			rafIdRef.current = 0;
			if (!activeRef.current) return;
			const paceMs = finishingRef.current ? FINISHING_PACE_MS : SMOOTH_PACE_MS;
			if (lastTickTimeRef.current > 0 && now - lastTickTimeRef.current < paceMs) {
				rafIdRef.current = requestAnimationFrame(tick);
				return;
			}
			lastTickTimeRef.current = now;
			const target = targetRef.current;
			const next = stepSmoothStream(target, lenRef.current, finishingRef.current);
			if (next !== lenRef.current) {
				lenRef.current = next;
				setDisplayedLen(next);
			}
			if (next < targetRef.current.length) {
				rafIdRef.current = requestAnimationFrame(tick);
			} else {
				onSettledRef.current?.();
			}
		};
		rafIdRef.current = requestAnimationFrame(tick);
	}, [text, active, finishing]);

	useEffect(() => {
		return () => {
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = 0;
			}
		};
	}, []);

	if (!active || displayedLen >= text.length) return text;
	return text.slice(0, displayedLen);
}

const LONG_TAIL_THRESHOLD = 600;
const LONG_TAIL_INTERVAL_MS = 32;

/** Stable identity from active tail to frozen block. Only long active non-fence
 *  tails throttle to 32ms; short tails follow the smooth character pacer directly.
 *  Frozen blocks use current text immediately and memo skips unchanged props. */
const Segment = memo(function Segment({ text, active, inFence }: { text: string; active: boolean; inFence: boolean }) {
	const isLong = active && !inFence && text.length >= LONG_TAIL_THRESHOLD;
	const [rendered, setRendered] = useState(text);
	const lastRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!isLong) return;
		const elapsed = Date.now() - lastRef.current;
		const flush = () => {
			lastRef.current = Date.now();
			setRendered(text);
		};
		if (elapsed >= LONG_TAIL_INTERVAL_MS) {
			flush();
			return;
		}
		timerRef.current = setTimeout(flush, LONG_TAIL_INTERVAL_MS - elapsed);
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [text, isLong]);

	if (active && inFence) {
		// Growing fenced code: plain <pre>, zero highlight cost while typing.
		return (
			<div className="codeblock">
				<pre>
					<code>{text}</code>
				</pre>
			</div>
		);
	}
	// Keep the shared pipeline and component type when a non-fence tail freezes.
	return <MarkdownBody text={isLong ? rendered : text} />;
});

export const StreamMarkdown = memo(function StreamMarkdown({
	text,
	finishing = false,
	onSettled,
}: {
	text: string;
	finishing?: boolean;
	onSettled?: () => void;
}) {
	const smoothed = useSmoothStreamText(text, true, finishing, onSettled);
	const { frozen, active, inFence } = useMemo(() => segmentStream(smoothed), [smoothed]);
	return (
		<div className="md">
			{/* One flat keyed list preserves identity across the active/frozen boundary.
			    A new tail gets a fresh key and its own immediate initial render. */}
			{[...frozen, ...(active.length > 0 ? [active] : [])].map((seg, i) => (
				<Segment key={i} text={seg} active={i === frozen.length} inFence={i === frozen.length && inFence} />
			))}
		</div>
	);
});
