import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isZhLocale, useI18n } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { LocalBots } from "./LocalBots";
import { DEVICE_GROUPS_CHANGED, deviceGroupRequest, type SidebarDeviceGroup } from "./DeviceGroupSection";

type Bot = { id: string; name: string; enabled: boolean; deviceName?: string };
export function DeviceGroupBotDialog({ room, onClose }: { room: SidebarDeviceGroup; onClose: () => void }) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [bots, setBots] = useState<Bot[]>([]);
	const [members, setMembers] = useState(room.botIds);
	const [selected, setSelected] = useState<string[]>([]);
	const [creating, setCreating] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	const mutation = useRef<AbortController | null>(null);
	const close = () => {
		if (!busy && !creating) onClose();
	};
	useEscapeKey(close);
	useEffect(() => () => mutation.current?.abort(), []);
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		void Promise.all([
			deviceGroupRequest<{ bots: Bot[] }>("bots", controller.signal),
			deviceGroupRequest<{ room: SidebarDeviceGroup }>(`rooms/${encodeURIComponent(room.id)}`, controller.signal),
		])
			.then(([data, detail]) => {
				if (controller.signal.aborted) return;
				setBots(data.bots);
				setMembers(detail.room.botIds);
			})
			.catch((cause) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [room.id, refresh]);
	async function add(ids: string[]) {
		if (mutation.current) return;
		const controller = new AbortController();
		mutation.current = controller;
		setBusy(true);
		setError("");
		try {
			const path = `rooms/${encodeURIComponent(room.id)}`;
			const latest = await deviceGroupRequest<{ room: SidebarDeviceGroup }>(path, controller.signal);
			if (controller.signal.aborted) return;
			await deviceGroupRequest(`${path}/members`, controller.signal, {
				botIds: [...new Set([...latest.room.botIds, ...ids])],
			});
			if (controller.signal.aborted) return;
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
			onClose();
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			mutation.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return createPortal(
		<div className="modal-backdrop" onClick={close}>
			<div
				className="device-group-bot-dialog"
				role="dialog"
				aria-modal="true"
				aria-label={zh ? "添加或新建 Bot" : "Add or create Bot"}
				onClick={(event) => event.stopPropagation()}
			>
				<div className="dg-heading">
					<h2>
						{zh ? "添加 Bot" : "Add Bot"} · {room.name}
					</h2>
					<button type="button" className="dc-button" disabled={busy || creating} onClick={close}>
						{zh ? "关闭" : "Close"}
					</button>
				</div>
				{error && (
					<p className="dc-notice is-error" role="alert">
						{error}
					</p>
				)}
				<p>
					{zh
						? "选择已有 Bot 加入群组，或在本机新建 Bot。"
						: "Add existing Bots to this group or create a Bot on this computer."}
				</p>
				{loading ? (
					<p>{zh ? "加载中…" : "Loading…"}</p>
				) : (
					<div className="dg-bot-choices">
						{bots
							.filter((bot) => bot.enabled && !members.includes(bot.id))
							.map((bot) => (
								<label className="dg-bot-choice" key={bot.id}>
									<input
										type="checkbox"
										disabled={busy || creating}
										checked={selected.includes(bot.id)}
										onChange={(event) =>
											setSelected((old) =>
												event.target.checked ? [...old, bot.id] : old.filter((id) => id !== bot.id),
											)
										}
									/>
									<span>
										{bot.name}
										{bot.deviceName && <small>{bot.deviceName}</small>}
									</span>
								</label>
							))}
						{!bots.some((bot) => bot.enabled && !members.includes(bot.id)) && (
							<p>{zh ? "没有可添加的 Bot，可以新建一个。" : "No Bots available to add. Create a new one."}</p>
						)}
					</div>
				)}
				<div className="dc-actions">
					<button
						type="button"
						className="dc-button"
						disabled={busy || creating}
						onClick={() => {
							setCreating(true);
							setError("");
						}}
					>
						{zh ? "新建 Bot" : "Create Bot"}
					</button>
					<button
						type="button"
						className="dc-button"
						disabled={loading || busy || creating || !selected.length}
						onClick={() => void add(selected)}
					>
						{busy ? (zh ? "正在添加…" : "Adding…") : zh ? "添加到群组" : "Add to group"}
					</button>
				</div>
				{creating && (
					<LocalBots
						createOnly
						onCancel={() => setCreating(false)}
						onCreated={(bot, synced) => {
							setCreating(false);
							setRefresh((old) => old + 1);
							if (!synced || !bot.enabled) {
								setError(
									zh
										? "Bot 已保存；请启用并同步到中心后，再添加到群组。"
										: "Bot saved. Enable and sync it to the hub before adding it to the group.",
								);
								return;
							}
							void add([bot.id]);
						}}
					/>
				)}
			</div>
		</div>,
		document.body,
	);
}
