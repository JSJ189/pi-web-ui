export function selectPending<T>(
	items: readonly T[],
	key: (item: T) => string,
	opened: string | null,
	deferred: ReadonlySet<string>,
	canOpen: (item: T) => boolean,
): T | undefined {
	return items.find((item) => key(item) === opened) ?? items.find((item) => !deferred.has(key(item)) && canOpen(item));
}

export function updateApprovalQueue<T extends { id: string }>(
	items: T[],
	incoming: T | null,
	resolvedId?: string,
): T[] {
	if (resolvedId) return items.filter((item) => item.id !== resolvedId);
	if (!incoming) return items;
	const index = items.findIndex((item) => item.id === incoming.id);
	return index < 0 ? [...items, incoming] : items.map((item, i) => (i === index ? incoming : item));
}
