/**
 * 权限预设相关辅助逻辑与会话回放。
 */

/**
 * 从会话 sessionManager entries 回放恢复最后设定的权限预设（若从未设定则返回 undefined）。
 * customType 为 "permission/preset"，载荷结构为 { preset: string }。
 */
export function readPermissionFromSession(sm: unknown): string | undefined {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return undefined;
		const entries = mgr.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; data?: { preset?: string } } | undefined;
			if (e?.type === "custom" && e.customType === "permission/preset" && typeof e.data?.preset === "string") {
				return e.data.preset;
			}
		}
	} catch {
		// ignore
	}
	return undefined;
}
