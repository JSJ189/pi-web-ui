/**
 * markers-list-tool — 任务列表只读查询工具（todo_list）。
 *
 * 读操作仍走真工具；所有写操作由模型在回复正文中使用行内标记（[[todo:new:...]] 等）。
 * 从 agent-service.ts 抽出为独立模块。
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MARKERS_LIST_TOOL_NAME } from "./tool-manager.js";

export function makeMarkersListTool(
	getActiveId: () => string,
	markerSvc: {
		describe: (id: string, tool: string, inc?: boolean) => string;
		getRawState: (id: string, ns: string) => unknown;
	},
): ToolDefinition {
	return {
		name: MARKERS_LIST_TOOL_NAME,
		promptSnippet: "list inline-marker tasks (read-only; writes use [[todo:...]])",
		label: "List marker state",
		description:
			"Read-only query of inline marker state. All WRITE operations must use inline markers ([[todo:new:...]] etc.) in the reply body — never this tool.",
		parameters: Type.Object({
			action: Type.Unsafe<string>({ enum: ["list"] }),
			tool: Type.Optional(Type.Literal("todo")),
			includeDeleted: Type.Optional(
				Type.Boolean({
					description: "Include deleted tasks (tombstones, todo only).",
				}),
			),
		}),
		execute: async (_id: string, params: unknown) => {
			const p = params as { action: string; tool?: string; includeDeleted?: boolean };
			const convId = getActiveId();
			const text = markerSvc.describe(convId, "todo", !!p.includeDeleted);
			const state = markerSvc.getRawState(convId, "todo") as { tasks: unknown[]; nextId: number } | undefined;
			const visible = (state?.tasks ?? []).filter(
				(t: unknown) => p.includeDeleted || (t as { status: string }).status !== "deleted",
			);
			return {
				content: [{ type: "text", text }],
				details: { action: "list", todos: visible, nextId: state?.nextId },
			} as never;
		},
	} as unknown as ToolDefinition;
}
