import { describe, expect, it } from "vitest";
import { isTerminalQueryResponse, TerminalManager } from "../../server/terminals.js";

/** issue #181：残留的 AI bash 终端（agentBash）不得阻断会话移出。
 *  countBlockingLive 保持老口径（含 AI bash，供切对话保留用——切走不杀后台活）；
 *  dismiss 口径改用 countUserBlockingLive（只看用户亲手开且用过的终端）。 */
function makeManager(): TerminalManager {
	return new TerminalManager(() => {}, "/tmp");
}

function putEntry(
	mgr: TerminalManager,
	id: string,
	partial: { exited: boolean; used: boolean; agentBash: boolean },
): void {
	(mgr as unknown as { terms: Map<string, unknown> }).terms.set(id, { id, ...partial });
}

describe("countUserBlockingLive（issue #181）", () => {
	it("空管理器：两口径都为 0", () => {
		const mgr = makeManager();
		expect(mgr.countBlockingLive()).toBe(0);
		expect(mgr.countUserBlockingLive()).toBe(0);
	});

	it("残留 ai-bash 不阻断移出：老口径 >0，新口径 =0", () => {
		const mgr = makeManager();
		putEntry(mgr, "ai-bash-98", { exited: false, used: true, agentBash: true });
		putEntry(mgr, "ai-bash-99", { exited: false, used: true, agentBash: true });
		expect(mgr.countBlockingLive()).toBe(2);
		expect(mgr.countUserBlockingLive()).toBe(0);
	});

	it("用户用过的存活终端：两口径都计数", () => {
		const mgr = makeManager();
		putEntry(mgr, "term-1", { exited: false, used: true, agentBash: false });
		expect(mgr.countBlockingLive()).toBe(1);
		expect(mgr.countUserBlockingLive()).toBe(1);
	});

	it("没动过的空 shell：两口径都不计数", () => {
		const mgr = makeManager();
		putEntry(mgr, "term-pristine", { exited: false, used: false, agentBash: false });
		expect(mgr.countBlockingLive()).toBe(0);
		expect(mgr.countUserBlockingLive()).toBe(0);
	});

	it("已退出的终端：两口径都不计数", () => {
		const mgr = makeManager();
		putEntry(mgr, "ai-bash-100", { exited: true, used: true, agentBash: true });
		putEntry(mgr, "term-old", { exited: true, used: true, agentBash: false });
		expect(mgr.countBlockingLive()).toBe(0);
		expect(mgr.countUserBlockingLive()).toBe(0);
	});

	it("混合：1 个用户终端 + N 个残留 ai-bash → 用户口径只算 1", () => {
		const mgr = makeManager();
		putEntry(mgr, "term-1", { exited: false, used: true, agentBash: false });
		putEntry(mgr, "ai-bash", { exited: false, used: true, agentBash: true });
		putEntry(mgr, "ai-bash-101", { exited: false, used: true, agentBash: true });
		expect(mgr.countBlockingLive()).toBe(3);
		expect(mgr.countUserBlockingLive()).toBe(1);
	});
});

describe("isTerminalQueryResponse 与空 shell 保持 pristine", () => {
	it("精确识别 xterm 自动探测回传序列，不误判用户输入", () => {
		// 光标位置报告 CPR
		expect(isTerminalQueryResponse("\x1b[1;1R")).toBe(true);
		expect(isTerminalQueryResponse("\x1b[24;80R")).toBe(true);
		// 设备属性 DA1
		expect(isTerminalQueryResponse("\x1b[?1;2c")).toBe(true);
		expect(isTerminalQueryResponse("\x1b[0c")).toBe(true);
		expect(isTerminalQueryResponse("\x1b[?62;1;2;4;6;7;8;9;15;18;21;22;28;29c")).toBe(true);
		// 设备属性 DA2 / DA3
		expect(isTerminalQueryResponse("\x1b[>0;10;1c")).toBe(true);
		expect(isTerminalQueryResponse("\x1b[<0;10;1c")).toBe(true);
		// 焦点通知与模式
		expect(isTerminalQueryResponse("\x1b[I")).toBe(true);
		expect(isTerminalQueryResponse("\x1b[O")).toBe(true);
		expect(isTerminalQueryResponse("\x1b[?25;1$y")).toBe(true);
		// 窗口状态
		expect(isTerminalQueryResponse("\x1b[4;300;400t")).toBe(true);
		// 批量应答（CPR + DA1 粘包）
		expect(isTerminalQueryResponse("\x1b[1;1R\x1b[?1;2c")).toBe(true);

		// 用户真实输入：绝对不得被判为自动探测序列
		expect(isTerminalQueryResponse("ls\r")).toBe(false);
		expect(isTerminalQueryResponse("a")).toBe(false);
		expect(isTerminalQueryResponse("\r")).toBe(false);
		expect(isTerminalQueryResponse("\n")).toBe(false);
		expect(isTerminalQueryResponse("\x03")).toBe(false);
		expect(isTerminalQueryResponse("\x1b[A")).toBe(false); // 方向键 上
		expect(isTerminalQueryResponse("\x1b[B")).toBe(false); // 方向键 下
		expect(isTerminalQueryResponse("\x1b[C")).toBe(false); // 方向键 右
		expect(isTerminalQueryResponse("\x1b[D")).toBe(false); // 方向键 左
		expect(isTerminalQueryResponse("\x1b[13;5u")).toBe(false); // Ctrl+Enter
	});

	it("空 shell 收到自动探测回传时保持 used: false，收到真实输入才置 used: true", () => {
		const mgr = makeManager();
		const mockPty = { write: () => {}, kill: () => {}, onData: () => ({ dispose: () => {} }) };
		const entry = {
			id: "shell-1",
			pty: mockPty,
			command: undefined,
			title: "终端 1",
			cwd: "/tmp",
			output: "",
			outputOffset: 0,
			agentTouched: false,
			agentBash: false,
			lastActivityAt: Date.now(),
			exited: false,
			exitCode: null,
			used: false,
			watches: [],
			sentinelPending: false,
			idleTimer: null,
			waiters: new Set(),
		};
		(mgr as unknown as { terms: Map<string, unknown> }).terms.set("shell-1", entry);

		// 收到 xterm 自动探测回传，依然不算 used
		mgr.inputChecked("shell-1", "\x1b[1;1R");
		expect(entry.used).toBe(false);
		expect(mgr.countUserBlockingLive()).toBe(0);

		mgr.inputChecked("shell-1", "\x1b[?1;2c");
		expect(entry.used).toBe(false);
		expect(mgr.countUserBlockingLive()).toBe(0);

		// 用户真实按键输入（敲回车），正式置为 used
		mgr.inputChecked("shell-1", "\r");
		expect(entry.used).toBe(true);
		expect(mgr.countUserBlockingLive()).toBe(1);
	});
});
