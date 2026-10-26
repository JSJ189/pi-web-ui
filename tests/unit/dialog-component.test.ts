// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Dialog, parseCommandPrompt } from "../../web/src/components/Dialog.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import * as composerBridge from "../../web/src/composer-bridge.js";

let root: Root | null = null;
let currentContainer: HTMLDivElement | null = null;

function setNativeValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function mount(dialog: Parameters<typeof Dialog>[0]["dialog"]) {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	if (currentContainer) {
		currentContainer.remove();
		currentContainer = null;
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	currentContainer = container;
	root = createRoot(container);
	const sent: unknown[] = [];
	setAppSend((msg) => {
		sent.push(msg);
		return true;
	});
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(Dialog, { dialog })));
	});
	return { container, sent };
}

afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	if (currentContainer) {
		currentContainer.remove();
		currentContainer = null;
	}
	vi.restoreAllMocks();
});

describe("Command Prompt Parser (issue #747)", () => {
	it("parses multiline command with risk keywords into structured command box", () => {
		const raw = `⚠️ Dangerous command:\n\n  printf 'DISPLAY ONLY line 1'\n  printf 'DISPLAY ONLY line 2'\n\nAllow?`;
		const parsed = parseCommandPrompt(raw);
		expect(parsed.hasRisk).toBe(true);
		expect(parsed.intro).toBe("⚠️ Dangerous command:");
		expect(parsed.command).toContain("printf 'DISPLAY ONLY line 1'");
		expect(parsed.command).toContain("printf 'DISPLAY ONLY line 2'");
		expect(parsed.outro).toBe("Allow?");
	});

	it("detects dangerous destructive commands like rm -rf", () => {
		const raw = `Please confirm:\n\`\`\`bash\nrm -rf /tmp/test-dir\n\`\`\`\nProceed?`;
		const parsed = parseCommandPrompt(raw);
		expect(parsed.hasRisk).toBe(true);
		expect(parsed.command).toBe("rm -rf /tmp/test-dir");
	});

	it("leaves plain non-command text intact", () => {
		const raw = "Please select the target environment to deploy.";
		const parsed = parseCommandPrompt(raw);
		expect(parsed.command).toBeNull();
		expect(parsed.intro).toBe(raw);
	});
});

describe("Dialog component: 3-tier layout, command inspector, and reject-with-feedback", () => {
	it("renders 3-tier viewport layout with command inspector box", () => {
		const longCommand = Array.from(
			{ length: 20 },
			(_, i) => `printf 'DISPLAY ONLY line ${i + 1} long-path-segment/'`,
		).join("\n");
		const fullTitle = `⚠️ Dangerous command:\n\n  ${longCommand}\n\nAllow?`;

		const { container } = mount({
			id: 1,
			kind: "select",
			title: fullTitle,
			args: [["Yes", "No"]],
		});

		// 1. 三段式布局结构完整存在
		const head = container.querySelector(".dialog-head");
		const scrollBody = container.querySelector(".dialog-scroll-body");
		const footer = container.querySelector(".dialog-footer");
		expect(head).not.toBeNull();
		expect(scrollBody).not.toBeNull();
		expect(footer).not.toBeNull();

		// 2. 顶栏标题单行紧凑并带完整 title 提示
		const headTitle = head?.querySelector(".dialog-title");
		expect(headTitle?.textContent).toBe("⚠️ Dangerous command:");
		expect(headTitle?.getAttribute("title")).toBe(fullTitle);

		// 3. 命令专用审计盒：高危警告、行号、行数微标、展开/折叠
		const cmdBox = scrollBody?.querySelector(".dialog-cmd-box");
		expect(cmdBox).not.toBeNull();
		expect(cmdBox?.classList.contains("has-risk")).toBe(true);
		expect(cmdBox?.querySelector(".dialog-cmd-risk")).not.toBeNull();

		const lines = cmdBox?.querySelectorAll(".dialog-cmd-line");
		expect(lines).toHaveLength(20);

		// 超过 8 行提供展开/收起按钮
		const toggleBtn = cmdBox?.querySelector(".dialog-cmd-actions button");
		expect(toggleBtn).not.toBeNull();

		// 4. 常驻底栏操作按钮：首屏立即可见且带快捷键微标
		const options = footer?.querySelectorAll(".dialog-option");
		expect(options).toHaveLength(2);
		expect(options?.[0].textContent).toContain("Yes");
		expect(options?.[0].querySelector(".dialog-opt-badge")?.textContent).toBe("Y");
		expect(options?.[1].textContent).toContain("No");
		expect(options?.[1].querySelector(".dialog-opt-badge")?.textContent).toBe("N");

		// 杜绝旧版粘性遮挡的 dialog-custom-row
		expect(container.querySelector(".dialog-custom-row")).toBeNull();
	});

	it("supports Y and N single-key shortcuts", () => {
		const { container, sent } = mount({
			id: 2,
			kind: "select",
			title: "Dangerous operation",
			args: [["Yes", "No"]],
		});

		// 按 Y 键触发 Yes 提交
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 2, value: "Yes" }]);

		// 重新挂载测试 N 键
		const { sent: sent2 } = mount({
			id: 3,
			kind: "select",
			title: "Dangerous operation",
			args: [["Yes", "No"]],
		});
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
		});
		expect(sent2).toEqual([{ type: "dialog_response", id: 3, value: "No" }]);
	});

	it("handles reject-with-feedback: submits clean 'No' and injects feedback into composer", () => {
		const composeSpy = vi.spyOn(composerBridge, "composeToComposer").mockImplementation(() => true);
		const focusSpy = vi.spyOn(composerBridge, "focusComposer").mockImplementation(() => true);

		const { container, sent } = mount({
			id: 4,
			kind: "select",
			title: "Dangerous command",
			args: [["Yes", "No"]],
		});

		// 点击“拒绝并说明原因...”展开附言输入框
		const rejectToggle = container.querySelector(".dialog-reject-toggle") as HTMLButtonElement;
		expect(rejectToggle).not.toBeNull();
		act(() => {
			rejectToggle.click();
		});

		const rejectInput = container.querySelector(".dialog-reject-input") as HTMLInputElement;
		expect(rejectInput).not.toBeNull();

		// 输入拒绝原因
		setNativeValue(rejectInput, "请改去清空 temp 目录，不要删除整库");

		// 点击提交
		const submitBtn = container.querySelector(".dialog-reject-input-row .btn") as HTMLButtonElement;
		act(() => {
			submitBtn.click();
		});

		// 1. 发给扩展的仍然是合法的 "No"，扩展不会崩溃且能识别拒绝
		expect(sent).toEqual([{ type: "dialog_response", id: 4, value: "No" }]);

		// 2. 拒绝附言自动注入输入框草稿并聚焦，形成完整闭环
		expect(composeSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("请改去清空 temp 目录，不要删除整库"),
			}),
		);
		expect(focusSpy).toHaveBeenCalled();
	});

	it("keyboard arrow keys navigate options and Enter submits selection", () => {
		const { container, sent } = mount({
			id: 5,
			kind: "select",
			title: "Branch",
			args: [["main", "dev", "test"]],
		});

		const options = container.querySelectorAll(".dialog-option");
		expect(options[0].classList.contains("sel")).toBe(true);

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
		});
		expect(options[1].classList.contains("sel")).toBe(true);

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 5, value: "dev" }]);
	});

	it("dismiss button sends null response", () => {
		const { container, sent } = mount({
			id: 6,
			kind: "select",
			title: "Simple select",
			args: [["A", "B"]],
		});

		const dismissBtn = container.querySelector(".dialog-dismiss") as HTMLButtonElement;
		expect(dismissBtn).not.toBeNull();
		act(() => {
			dismissBtn.click();
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 6, value: null }]);
	});

	it("confirm dialog renders 3-tier structure and handles OK / Cancel with Y/N", () => {
		const { container, sent } = mount({
			id: 7,
			kind: "confirm",
			title: "Delete file",
			args: ["Are you sure you want to delete this file?"],
		});

		const headTitle = container.querySelector(".dialog-head .dialog-title");
		expect(headTitle?.textContent).toBe("Delete file");

		const scrollBody = container.querySelector(".dialog-scroll-body");
		expect(scrollBody?.textContent).toContain("Are you sure you want to delete this file?");

		const footer = container.querySelector(".dialog-footer");
		const buttons = footer?.querySelectorAll(".dialog-actions .btn");
		expect(buttons).toHaveLength(2);

		// 按 Y 键确认
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
		});
		expect(sent).toEqual([{ type: "dialog_response", id: 7, value: true }]);
	});
});
