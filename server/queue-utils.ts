import type { PromptAttachment, QueuedPromptItem } from "./protocol.js";

/**
 * 排队消息（插队 steer / 排队 followUp）纯函数 —— 独立成模块是为了可单测
 * （`AgentService` 依赖 SDK 与运行时，不适合在单测里 import）。
 *
 * 背景：pi SDK 没有「按条操作队列」的 API，服务端移除一条排队消息的做法是
 * `clearQueue()` 之后把幸存者按原顺序重新入队（见 `AgentService.removeQueued`）。
 * 重建时若用值过滤（`list.filter((t) => t !== text)`），会把**所有**同文本项一起删掉；
 * 而气泡上的 ✕ 只对应一条消息、本地显示镜像也只移除一条 → 同一条文本被排队两次时
 * 「点一次 ✕ 删两条」，且显示与真实队列在下次 `queue_update` 之前不一致。
 * 因此统一按「只移除第一处匹配」处理。
 */

/** 移除列表中第一处等于 `text` 的项；找不到时返回入参的拷贝（不修改入参）。 */
export function removeFirstOccurrence(list: readonly string[], text: string): string[] {
	const index = list.indexOf(text);
	if (index < 0) return [...list];
	return [...list.slice(0, index), ...list.slice(index + 1)];
}

/**
 * 按气泡下标移除一条排队消息（✕ 对应的是「第几个气泡」，不是「哪段文本」）。
 * `index` 越界、非整数、或该位置文本与 `text` 对不上（点击与执行之间队列
 * 已变化——有条消息刚送达或新入队）时，回落到 `removeFirstOccurrence` 的文本匹配，
 * 保持旧客户端（只发 text）行为不变。不修改入参。
 */
export function removeQueuedByIndexOrText(list: readonly string[], text: string, index?: number): string[] {
	if (
		typeof index === "number" &&
		Number.isInteger(index) &&
		index >= 0 &&
		index < list.length &&
		list[index] === text
	) {
		return [...list.slice(0, index), ...list.slice(index + 1)];
	}
	return removeFirstOccurrence(list, text);
}

export interface QueuedImagePayload {
	type: "image";
	data: string;
	mimeType: string;
}

export interface QueuedMessageEntry {
	/** 跨引擎唯一条目 ID */
	id: string;
	text: string;
	images?: QueuedImagePayload[];
	attachments?: PromptAttachment[];
	createdAt?: number;
}

let queueSeq = 0;
export function generateQueueId(): string {
	return `q-${Date.now().toString(36)}-${(++queueSeq).toString(36)}`;
}

export function createQueuedEntry(
	text: string,
	opts?: {
		id?: string;
		images?: QueuedImagePayload[];
		attachments?: PromptAttachment[];
		createdAt?: number;
	},
): QueuedMessageEntry {
	return {
		id: opts?.id || generateQueueId(),
		text,
		images: opts?.images,
		attachments: opts?.attachments,
		createdAt: opts?.createdAt ?? Date.now(),
	};
}

/**
 * 跨端/跨引擎统一剔除排队条目：
 * 1. 优先按 `query.id` 绝对精准匹配（免疫并发下标漂移与同文本覆盖）；
 * 2. 其次按 `query.index`（需校验文本相符）；
 * 3. 兜底按 `query.text` 匹配首处项（兼容旧客户端）。
 */
export function removeQueuedEntry(
	list: readonly QueuedMessageEntry[],
	query: { id?: string; text?: string; index?: number },
): QueuedMessageEntry[] {
	if (query.id) {
		const idx = list.findIndex((e) => e.id === query.id);
		if (idx >= 0) {
			return [...list.slice(0, idx), ...list.slice(idx + 1)];
		}
	}
	if (
		typeof query.index === "number" &&
		Number.isInteger(query.index) &&
		query.index >= 0 &&
		query.index < list.length &&
		(!query.text || list[query.index]?.text === query.text)
	) {
		return [...list.slice(0, query.index), ...list.slice(query.index + 1)];
	}
	if (query.text !== undefined) {
		const idx = list.findIndex((e) => e.text === query.text);
		if (idx >= 0) {
			return [...list.slice(0, idx), ...list.slice(idx + 1)];
		}
	}
	return [...list];
}

/**
 * 按气泡下标移除一个排队条目（兼容历史调用签名）。
 */
export function removeQueuedEntryByIndexOrText(
	list: readonly QueuedMessageEntry[],
	text: string,
	index?: number,
): QueuedMessageEntry[] {
	return removeQueuedEntry(list, { text, index });
}

/**
 * 入队 prompt 抛错时的快速回滚：从末尾向前查找第一个匹配文本的条目并弹出（issue #718）。
 */
export function rollbackQueuedEntry(list: readonly QueuedMessageEntry[], text: string): QueuedMessageEntry[] {
	for (let i = list.length - 1; i >= 0; i--) {
		if (list[i]?.text === text) {
			return [...list.slice(0, i), ...list.slice(i + 1)];
		}
	}
	return [...list];
}

/**
 * 将本地条目列表与 SDK 权威的 `newTexts` 队列文本对账（issue #718）。
 * 遵循 SDK 先进先出（FIFO）头部出队机制，优先保留尾部幸存者的完整条目元数据；
 * 保证对账后返回的条目数量与顺序与 `newTexts` 严格一致。
 */
export function reconcileQueuedEntries(
	currentEntries: readonly QueuedMessageEntry[],
	newTexts: readonly string[],
): QueuedMessageEntry[] {
	if (!newTexts || newTexts.length === 0) {
		return [];
	}
	if (!currentEntries || currentEntries.length === 0) {
		return newTexts.map((text) => createQueuedEntry(text));
	}

	// 1. 长度一致且文本逐项吻合
	if (currentEntries.length === newTexts.length) {
		let allMatch = true;
		for (let i = 0; i < newTexts.length; i++) {
			if (currentEntries[i]?.text !== newTexts[i]) {
				allMatch = false;
				break;
			}
		}
		if (allMatch) {
			return [...currentEntries];
		}
	}

	// 2. 队列缩短（常见场景：SDK 头部 FIFO 出队消费一条或多条消息）
	if (currentEntries.length > newTexts.length) {
		const dropCount = currentEntries.length - newTexts.length;
		const headDropped = currentEntries.slice(dropCount);
		let matchesTail = true;
		for (let i = 0; i < newTexts.length; i++) {
			if (headDropped[i]?.text !== newTexts[i]) {
				matchesTail = false;
				break;
			}
		}
		if (matchesTail) {
			return headDropped;
		}
	}

	// 3. 队列增长（常见场景：前缀保持，尾部追加）
	if (currentEntries.length < newTexts.length) {
		let prefixMatch = true;
		for (let i = 0; i < currentEntries.length; i++) {
			if (currentEntries[i]?.text !== newTexts[i]) {
				prefixMatch = false;
				break;
			}
		}
		if (prefixMatch) {
			const res = [...currentEntries];
			for (let i = currentEntries.length; i < newTexts.length; i++) {
				res.push(createQueuedEntry(newTexts[i]!));
			}
			return res;
		}
	}

	// 4. 容错通用对齐（例如中间删除或非对齐位移）：
	// 倒序优先匹配尾部幸存条目（排队为追加写入，尾部条目存活概率更高）
	const available = currentEntries.map((e, idx) => ({ ...e, idx, used: false }));
	const result: QueuedMessageEntry[] = new Array(newTexts.length);

	for (let i = newTexts.length - 1; i >= 0; i--) {
		const targetText = newTexts[i]!;
		let foundIdx = -1;
		for (let j = available.length - 1; j >= 0; j--) {
			if (!available[j]!.used && available[j]!.text === targetText) {
				foundIdx = j;
				break;
			}
		}
		if (foundIdx !== -1) {
			available[foundIdx]!.used = true;
			const matched = available[foundIdx]!;
			result[i] = {
				id: matched.id,
				text: targetText,
				images: matched.images,
				attachments: matched.attachments,
				createdAt: matched.createdAt,
			};
		} else {
			result[i] = createQueuedEntry(targetText);
		}
	}

	return result;
}

export function toQueuedPromptItems(entries: readonly QueuedMessageEntry[]): QueuedPromptItem[] {
	return entries.map((e) => ({
		id: e.id,
		text: e.text,
		attachments: e.attachments,
		createdAt: e.createdAt,
	}));
}

export function toQueuedPromptTexts(entries: readonly QueuedMessageEntry[]): string[] {
	return entries.map((e) => e.text);
}
