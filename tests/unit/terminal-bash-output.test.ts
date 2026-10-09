import { describe, expect, it } from "vitest";
import {
	cleanBashOutput,
	makeTerminalBashTool,
	newSentinelNonce,
	type TerminalManager,
} from "../../server/terminals.js";

/** 终端接管 bash 的输出清洗与退出码判定（#572）。
 *
 * 旧实现的两个缺陷：
 *  ① 清洗按「字面量 [pi-exit:%s] 的位置」整段截——readline 在命令结束后重绘哨兵行，
 *     那一次把真实输出整段吃掉，只剩哨兵 → 返回空正文 + [exit:0]；
 *  ② 哨兵没有 nonce——真实输出里的 `[pi-exit:42]` 被当成真哨兵，提前返回假退出码。
 * 修复：哨兵带每次调用随机的 nonce；清洗只删注入回显行本身（前缀回显整段丢弃，
 * 重绘行只删该行）。下面的假 PTY 按真实终端的字节序列喂数据：回显 → 真实输出 →
 * 重绘哨兵行 → 哨兵输出。 */

/** 假 PTY：收到命令行时按真实终端的顺序写入缓冲区。 */
function fakePty(realOutput: string): TerminalManager {
	let buf = "";
	return {
		create: () => "ai-bash-1",
		suspendIdleWatch: () => {},
		endCursor: () => 0,
		setSentinelPending: () => {},
		watchOutput: () => () => {},
		read: (_id: string, cursor: number) => {
			if (cursor >= buf.length) return null;
			return { data: buf.slice(cursor), cursor: buf.length };
		},
		inputChecked: (_id: string, data: string): string | null => {
			if (data === "exit\r" || data === "\x03") return null;
			const body = data.replace(/\r$/, "");
			const nonce = /\[pi-exit-([0-9a-f]{12}):%s\]/.exec(body)?.[1];
			if (!nonce) return "fake pty: no sentinel in input";
			const sentinelLine = body.split("\n").pop() ?? "";
			const echo = body.replace(/\n/g, "\r\n") + "\r\n"; // ① PTY 硬件回显（真实输出之前）
			const out = realOutput.replace(/\n/g, "\r\n"); // ② 真实输出
			const redraw = "\r" + sentinelLine + "\r\n"; // ③ readline 重绘哨兵行（真实输出之后）
			const exit = `\r\n[pi-exit-${nonce}:0]\r\n`; // ④ 哨兵输出
			buf += echo + out + redraw + exit;
			return null;
		},
	} as unknown as TerminalManager;
}

async function run(command: string, realOutput: string): Promise<{ output: string; exitCode: number }> {
	const tool = makeTerminalBashTool(fakePty(realOutput), {
		cwd: process.cwd(),
		defaultPersist: () => false,
		idleMs: () => 0,
		kills: new Set(),
		notifyBackgroundDone: () => {},
	});
	const res = await tool.execute("t1", { command }, undefined, undefined, undefined as never);
	const details = res.details as { output: string; exitCode: number };
	return { output: details.output, exitCode: details.exitCode };
}

describe("cleanBashOutput：按注入位置清洗（#572 ①）", () => {
	it("回显 + 真实输出 + 重绘哨兵行：只删注入行，真实输出完整保留", () => {
		const nonce = "0123456789ab";
		const raw =
			"echo hello; whoami\r\n" +
			`__pi_rc=\${PIPESTATUS:-$?}; printf '\\n[pi-exit-${nonce}:%s]\\n' "$__pi_rc"\r\n` +
			"hello\r\nuser\r\n" +
			`__pi_rc=\${PIPESTATUS:-$?}; printf '\\n[pi-exit-${nonce}:%s]\\n' "$__pi_rc"\r\n` +
			`\n[pi-exit-${nonce}:0]\n`;
		expect(cleanBashOutput(raw, nonce)).toBe("hello\nuser");
	});
});

describe("cleanBashOutput / 退出码：nonce 隔离真实输出里的哨兵字面量（#572 ②）", () => {
	it("真实输出含 [pi-exit:%s] 与 [pi-exit:42]：不被清掉、不被当成真哨兵", () => {
		const nonce = "0123456789ab";
		const raw =
			"grep out\r\n" +
			`__pi_rc=\${PIPESTATUS:-$?}; printf '\\n[pi-exit-${nonce}:%s]\\n' "$__pi_rc"\r\n` +
			"hello\r\n[pi-exit:42]\r\n[pi-exit:%s]\r\n" +
			`\n[pi-exit-${nonce}:0]\n`;
		expect(cleanBashOutput(raw, nonce)).toBe("hello\n[pi-exit:42]\n[pi-exit:%s]");
	});
});

describe("终端接管 bash 工具端到端（假 PTY）", () => {
	it("正常命令：正文非空、退出码真实（不再是 [exit:0] + 空正文）", async () => {
		const r = await run("echo hello; whoami", "hello\nuser\n");
		expect(r.output).toBe("hello\nuser");
		expect(r.exitCode).toBe(0);
	});

	it("输出含 [pi-exit:42]：退出码仍是真实的 0，后续输出不被截断", async () => {
		const r = await run("grep -n x file", "before\n[pi-exit:42]\nafter\n");
		expect(r.exitCode).toBe(0);
		expect(r.output).toBe("before\n[pi-exit:42]\nafter");
	});

	it("输出含 printf 格式串字面量 [pi-exit:%s]：不吞行、不丢真实输出", async () => {
		const r = await run("grep -n 'pi-exit:%s' server/terminals.ts", "A\n[pi-exit:%s]\nB\n");
		expect(r.exitCode).toBe(0);
		expect(r.output).toBe("A\n[pi-exit:%s]\nB");
	});

	it("nonce 每次调用不同（同一输出不会跨调用串号）", () => {
		expect(newSentinelNonce()).not.toBe(newSentinelNonce());
		expect(newSentinelNonce()).toMatch(/^[0-9a-f]{12}$/);
	});
});
