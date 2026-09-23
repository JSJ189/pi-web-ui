import { describe, it, expect } from "vitest";
import {
	PI_AGENT_PRESETS,
	PI_PERMISSION_OPTIONS,
	filterToolsByPreset,
	applyAgentToolsGating,
	type ActiveToolSet,
} from "../../server/tool-manager.js";

describe("pi 引擎 Agent 预设（Agent Presets）", () => {
	it("包含 standard/minimal/code/reader/ask 五种预设", () => {
		const ids = PI_AGENT_PRESETS.map((p) => p.id);
		expect(ids).toEqual(["standard", "minimal", "code", "reader", "ask"]);
		expect(PI_AGENT_PRESETS.find((p) => p.id === "standard")?.isDefault).toBe(true);
	});

	it("filterToolsByPreset: standard 保持全部工具", () => {
		const tools = ["bash", "read", "edit", "write", "edit_soft", "browser_page", "custom_tool"];
		expect(filterToolsByPreset(tools, "standard")).toEqual(tools);
		expect(filterToolsByPreset(tools, undefined)).toEqual(tools);
	});

	it("filterToolsByPreset: minimal 仅保留 bash 与 read", () => {
		const tools = ["bash", "read", "edit", "write", "edit_soft", "browser_page"];
		expect(filterToolsByPreset(tools, "minimal")).toEqual(["bash", "read"]);
	});

	it("filterToolsByPreset: code 仅保留代码读写与执行工具", () => {
		const tools = ["bash", "read", "edit", "write", "edit_soft", "browser_page", "notes_list"];
		expect(filterToolsByPreset(tools, "code")).toEqual(["bash", "read", "edit", "write", "edit_soft"]);
	});

	it("filterToolsByPreset: reader 过滤掉所有写/执行工具", () => {
		const tools = ["bash", "read", "edit", "write", "edit_soft", "terminal_create", "office_read", "notes_list"];
		const filtered = filterToolsByPreset(tools, "reader");
		expect(filtered).toEqual(["read", "office_read", "notes_list"]);
	});

	it("filterToolsByPreset: ask 禁用全部工具（纯对话）", () => {
		const tools = ["bash", "read", "edit", "write"];
		expect(filterToolsByPreset(tools, "ask")).toEqual([]);
	});

	it("applyAgentToolsGating 支持传入 preset 白名单过滤", () => {
		let current = ["bash", "read", "edit", "write", "edit_soft"];
		const mockSession: ActiveToolSet = {
			getActiveToolNames: () => [...current],
			setActiveToolsByName: (names) => {
				current = [...names];
			},
		};

		// 极简模式：只留 bash 与 read
		applyAgentToolsGating(mockSession, [], "minimal");
		expect(current).toEqual(["bash", "read"]);

		// 纯对话模式：无工具
		applyAgentToolsGating(mockSession, [], "ask");
		expect(current).toEqual([]);
	});
});

describe("pi 引擎权限预设（Permission Presets）", () => {
	it("包含三档权限选项", () => {
		const values = PI_PERMISSION_OPTIONS.map((o) => o.value);
		expect(values).toEqual(["read-only", "workspace-write-never", "danger-full-access"]);
	});
});
