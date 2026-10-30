import type { UiMessage, UiState } from "./types";
import type { AtHit } from "./at-mention";

export type GroupDevice = { id: string; name: string; deviceId?: string; enabled?: boolean; online?: boolean };
export type GroupMessage = {
	id: string;
	text: string;
	createdAt: number;
	sender: { name: string; type?: "human" | "bot" };
	targetBotIds?: string[];
};
export type GroupTask = {
	id: string;
	deviceId: string;
	botId: string;
	text: string;
	report?: string;
	status: "queued" | "running" | "completed" | "failed" | "interrupted";
	createdAt: number;
};
export type GroupDetail = {
	room: { id: string; name: string; botIds: string[] };
	bots: GroupDevice[];
	messages: GroupMessage[];
	tasks: GroupTask[];
};

export function groupDeviceToken(device: GroupDevice): string {
	return `@${device.name}(${device.id})`;
}
export function groupDeviceHits(devices: readonly GroupDevice[], query: string): AtHit[] {
	return devices
		.filter((d) => `${d.name} ${d.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
		.map((d) => ({
			providerId: "host:group-devices",
			providerLabel: "Bot",
			title: d.name,
			hint: d.id,
			text: groupDeviceToken(d),
		}));
}
/** Targets come only from explicit stable-id tokens, never ambiguous display names. */
export function groupMessageTargets(text: string, devices: readonly GroupDevice[]): string[] {
	return [...new Set(devices.filter((d) => text.includes(groupDeviceToken(d))).map((d) => d.id))];
}
export function groupConversationState(
	roomId: string,
	detail: GroupDetail | null,
	devices: readonly GroupDevice[],
	zh = false,
): { state: UiState; labels: ReadonlyMap<string, string> } {
	const labels = new Map<string, string>();
	const entries: UiMessage[] = [];
	for (const message of detail?.messages ?? []) {
		const id = `group-message:${message.id}`;
		entries.push({
			id,
			role: message.sender.type === "bot" ? "assistant" : "user",
			timestamp: message.createdAt,
			content: [{ type: "text", text: message.text }],
		});
		labels.set(id, message.sender.name);
	}
	const statuses = zh
		? { queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断" }
		: { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed", interrupted: "Interrupted" };
	for (const task of detail?.tasks ?? []) {
		const id = `group-task:${task.id}`;
		const device = devices.find((d) => d.id === task.botId);
		labels.set(id, `${device?.name ?? task.botId} · ${statuses[task.status]}`);
		entries.push({
			id,
			role: "assistant",
			timestamp: task.createdAt,
			content: [{ type: "text", text: task.report || `${statuses[task.status]}\n\n${task.text}` }],
		});
	}
	entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	const state: UiState = {
		clientId: "device-group",
		cwd: "",
		sessionId: `device-group:${roomId}`,
		conversationId: `device-group:${roomId}`,
		rev: 0,
		messages: entries,
		streamingMessage: null,
		isStreaming: false,
		model: null,
		thinkingLevel: "",
		availableThinkingLevels: [],
		queue: { steering: [], followUp: [] },
		tools: [],
		version: 0,
		piConfigured: true,
		piAgentInstalled: true,
		stats: {
			totalMessages: entries.length,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		},
	};
	return { state, labels };
}

export function groupSendAttempt(
	previous: { fingerprint: string; key: string } | null,
	roomId: string,
	text: string,
	targets: readonly string[],
	newKey: () => string,
) {
	const fingerprint = JSON.stringify({ roomId, text, targetBotIds: [...targets].sort() });
	return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: newKey() };
}
