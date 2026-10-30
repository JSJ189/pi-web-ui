import { useEffect, useState } from "react";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import {
	automaticQuestion,
	isCurrentQuestion,
	questionQueueKey,
	questionNavigation,
	questionWaitTime,
	type QueueQuestion,
	type QuestionQueueMode,
} from "../question-queue";
import { DshQuestionDialog } from "./DshQuestionDialog";

export interface QuestionQueueProps {
	questions: QueueQuestion[];
	activeConversationId?: string | null;
	mode: QuestionQueueMode;
}

/** The single rendering entrance for queued and legacy engine questionnaires. */
export function QuestionQueue({ questions, activeConversationId, mode }: QuestionQueueProps) {
	const t = useT();
	const [deferred, setDeferred] = useState<Set<string>>(() => new Set());
	const [opened, setOpened] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now);
	const hasTimedQuestions = questions.some((q) => q.audience === "user" && q.createdAt > 0);
	useEffect(() => {
		if (!hasTimedQuestions) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasTimedQuestions]);
	const visible = questions.filter((q) => q.audience === "user");
	const selected =
		visible.find((q) => questionQueueKey(q) === opened) ??
		automaticQuestion(visible, activeConversationId, mode, deferred);
	const selectedKey = selected ? questionQueueKey(selected) : null;
	useEffect(() => {
		setOpened(selectedKey);
	}, [selectedKey]);
	if (!visible.length) return null;
	const navigate = (q: QueueQuestion) => {
		const message = questionNavigation(q);
		if (message) appSend(message);
	};
	return (
		<section className="question-queue" aria-label={t("questionQueueTitle")}>
			{visible.some((q) => q !== selected) && (
				<div className="question-queue-list">
					<div>{t("questionQueueTitle")}</div>
					{visible
						.filter((q) => q !== selected)
						.map((q) => (
							<div className="question-queue-item" key={questionQueueKey(q)}>
								<div className="question-queue-summary">
									{q.conversationTitle && <strong>{q.conversationTitle} · </strong>}
									{q.questions[0]?.header || q.questions[0]?.question || t("modelQuestion")}
								</div>
								{questionWaitTime(q.createdAt, now) && (
									<span className="question-queue-wait">⏱ {questionWaitTime(q.createdAt, now)}</span>
								)}
								<div className="question-queue-actions">
									<button type="button" className="btn" onClick={() => setOpened(questionQueueKey(q))}>
										{t("questionQueueOpen")}
									</button>
									{(q.rootConversationId || q.conversationId) &&
										(q.owner ||
											(q.conversationId
												? q.conversationId !== activeConversationId
												: !isCurrentQuestion(q, activeConversationId))) && (
											<button type="button" className="btn" onClick={() => navigate(q)}>
												{t("questionQueueNavigate")}
											</button>
										)}
								</div>
							</div>
						))}
				</div>
			)}
			{selected && (
				<div className="question-queue-dialog">
					{questionWaitTime(selected.createdAt, now) && (
						<span className="question-queue-wait">⏱ {questionWaitTime(selected.createdAt, now)}</span>
					)}
					<DshQuestionDialog
						key={questionQueueKey(selected)}
						question={selected}
						owner={selected.owner}
						onDefer={() => {
							setDeferred((prev) => new Set(prev).add(questionQueueKey(selected)));
							setOpened(null);
						}}
						onNavigate={selected.rootConversationId || selected.conversationId ? () => navigate(selected) : undefined}
					/>
				</div>
			)}
		</section>
	);
}
