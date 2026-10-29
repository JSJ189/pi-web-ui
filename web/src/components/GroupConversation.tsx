import { useEffect, useMemo, useRef, useState } from "react";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { GroupWorkspace } from "./GroupWorkspace";
import { appUrl } from "../base-url";
import { randomUuid } from "../uuid";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import { groupConversationState, groupSendAttempt, type GroupDetail, type GroupDevice } from "../device-group-messages";

class GroupRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = "",
	) {
		super(message);
	}
}
async function request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal,
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new GroupRequestError(response.status, data.error || String(response.status), data.code ?? "");
	return data;
}
const emptyMap = new Map();
const noop = () => {};
export function GroupConversation({
	roomId,
	active = true,
	onBack,
}: {
	roomId: string;
	active?: boolean;
	onBack?: () => void;
}) {
	// Key the entire stream/composer lifecycle by room, including in-flight mutations and drafts.
	return <GroupRoom key={roomId} roomId={roomId} active={active} onBack={onBack} />;
}
function GroupRoom({ roomId, active, onBack }: { roomId: string; active: boolean; onBack?: () => void }) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [detail, setDetail] = useState<GroupDetail | null>(null);
	const [devices, setDevices] = useState<GroupDevice[]>([]);
	const [error, setError] = useState("");
	const [unavailable, setUnavailable] = useState(false);
	const [refresh, setRefresh] = useState(0);
	function invalidatesRoom(cause: unknown): boolean {
		return (
			cause instanceof GroupRequestError &&
			(cause.status === 404 || cause.status === 403 || (cause.status === 409 && cause.code === "REPAIR_REQUIRED"))
		);
	}
	function explain(cause: unknown): string {
		if (cause instanceof GroupRequestError && cause.status === 409 && cause.code === "REPAIR_REQUIRED")
			return zh
				? "设备绑定已失效，请返回设备设置重新绑定。"
				: "Device binding expired. Return to device settings and bind again.";
		return cause instanceof Error ? cause.message : String(cause);
	}
	const generation = useRef(0);
	const mutation = useRef<AbortController | null>(null);
	const retry = useRef<{ fingerprint: string; key: string } | null>(null);
	const sending = useRef(false);
	useEffect(() => {
		const token = ++generation.current;
		let controller: AbortController | null = null;
		let inflight = false;
		async function poll() {
			if (!active || inflight || document.visibilityState === "hidden") return;
			inflight = true;
			controller = new AbortController();
			const signal = controller.signal;
			try {
				const [next, deviceData] = await Promise.all([
					request<GroupDetail>(`rooms/${encodeURIComponent(roomId)}`, signal),
					request<{ devices: GroupDevice[] }>("devices", signal),
				]);
				if (generation.current !== token || signal.aborted) return;
				setDetail(next);
				setDevices(deviceData.devices);
				setUnavailable(false);
				setError("");
			} catch (cause) {
				if (generation.current !== token || signal.aborted) return;
				if (invalidatesRoom(cause)) {
					setDetail(null);
					setUnavailable(true);
				}
				setError(explain(cause));
			} finally {
				inflight = false;
			}
		}
		void poll();
		const timer = window.setInterval(() => void poll(), 2000);
		const visibility = () => {
			if (document.visibilityState === "hidden") controller?.abort();
			else void poll();
		};
		document.addEventListener("visibilitychange", visibility);
		return () => {
			++generation.current;
			controller?.abort();
			mutation.current?.abort();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [roomId, active, refresh]);
	const { state, labels } = useMemo(
		() => groupConversationState(roomId, detail, devices, zh),
		[roomId, detail, devices, zh],
	);
	const members = devices.filter((d) => detail?.room.deviceIds.includes(d.id));
	async function send(text: string, targets: string[]): Promise<boolean> {
		if (!active || unavailable || !detail || sending.current) return false;
		// Revalidate explicit targets against the current Hub membership.
		if (targets.some((id) => !detail.room.deviceIds.includes(id))) return false;
		retry.current = groupSendAttempt(retry.current, roomId, text, targets, randomUuid);
		const controller = new AbortController();
		mutation.current = controller;
		const token = generation.current;
		sending.current = true;
		try {
			await request(`rooms/${encodeURIComponent(roomId)}/messages`, controller.signal, {
				text,
				targetDeviceIds: targets,
				idempotencyKey: retry.current.key,
			});
			if (controller.signal.aborted || generation.current !== token) return false;
			retry.current = null;
			setError("");
			setRefresh((n) => n + 1);
			return true;
		} catch (cause) {
			if (!controller.signal.aborted && generation.current === token) {
				if (invalidatesRoom(cause)) {
					setDetail(null);
					setUnavailable(true);
				}
				setError(explain(cause));
			}
			return false;
		} finally {
			if (mutation.current === controller) {
				sending.current = false;
				mutation.current = null;
			}
		}
	}
	return (
		<>
			<div className="dg-head">
				<strong>{detail?.room.name ?? (zh ? "群聊" : "Group")}</strong>
				<GroupWorkspace roomId={roomId} active={active && !unavailable} />
				{onBack && (
					<button type="button" className="btn" onClick={onBack}>
						{zh ? "返回对话" : "Back to chat"}
					</button>
				)}
			</div>
			{error && (
				<div role="alert">
					{error}
					{unavailable
						? zh
							? "此群聊已删除或你已不在群中，请返回。"
							: "This group is unavailable or you are no longer a member. Return to chat."
						: error}
				</div>
			)}
			<MessageList state={state} liveOutputs={emptyMap} toolStatuses={emptyMap} messageLabels={labels} readOnly />
			<ChatInput
				groupDevices={members}
				onGroupSend={send}
				streaming={false}
				messages={state.messages}
				slashCommands={[]}
				modelState={null}
				models={[]}
				modelsLoading={false}
				attachments={[]}
				onRemoveAttachment={noop}
				onAddImageFiles={noop}
				onAddLocalFiles={noop}
				onNotice={(_level, text) => setError(text)}
				onSent={noop}
				onManageModels={noop}
				providerKeys={{}}
				quickPhrases={[]}
				quickPhrasesEnabled={false}
				groupReady={active && !!detail && !unavailable}
				sessionId={`device-group:${roomId}`}
				conversationId={`device-group:${roomId}`}
			/>
		</>
	);
}
