import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { buildTerminalBashLine, makeTerminalBashTool, TerminalManager } from "../../server/terminals.js";

const nonce = "123456abcdef";
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";

function fixture(extra: Record<string, unknown> = {}) {
	const manager = new TerminalManager(() => {}, process.cwd());
	const entry = {
		id: "ai-bash",
		output: "",
		outputOffset: 0,
		exited: false,
		exitCode: null as number | null,
		watches: [],
		waiters: new Set(),
		lastActivityAt: Date.now(),
		idleTimer: null,
		pendingOut: "",
		flushTimer: null,
		pty: { kill: vi.fn(), write: vi.fn() },
	};
	const terms = (manager as any).terms as Map<string, typeof entry>;
	terms.set(entry.id, entry);
	const create = vi.spyOn(manager, "create").mockReturnValue({} as any);
	const input = vi.spyOn(manager, "inputChecked").mockReturnValue(null);
	const kill = vi.spyOn(manager, "kill").mockImplementation((id) => {
		const current = terms.get(id);
		if (!current) return;
		current.exited = true;
		const watches = current.watches.splice(0) as any[];
		for (const watch of watches) watch.cb(null);
		terms.delete(id);
	});
	const kills = new Set<AbortController>();
	const notify = vi.fn();
	const tool = makeTerminalBashTool(manager, {
		cwd: process.cwd(),
		defaultPersist: () => true,
		idleMs: () => 1,
		kills,
		notifyBackgroundDone: notify,
		...extra,
	});
	const run = (signal?: AbortSignal, params = {}) =>
		tool.execute("test", { command: "read answer", ...params } as any, signal, undefined, {} as any);
	const output = (data: string) => (manager as any).appendOutput(entry, data);
	const complete = (code = 0) => {
		const line = input.mock.calls[0][1];
		const token = /pi-exit-([0-9a-f]{12}):/.exec(line)![1];
		output(`\r\n[pi-exit-${token}:${code}]\r\n`);
	};
	return { manager, entry, terms, create, input, kill, kills, notify, run, output, complete };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("terminal bash task ownership", () => {
	it("rejects busy bash before create/input, retains background cancellation and cancels once", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const result = f.run();
		await vi.advanceTimersByTimeAsync(60);
		expect((await result).details).toMatchObject({ running: true });
		expect(f.kills.size).toBe(1);
		await expect(f.run()).rejects.toThrow(/busy/);
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(f.input).toHaveBeenCalledTimes(1);
		const controller = [...f.kills][0];
		controller.abort();
		controller.abort();
		expect(f.kill).toHaveBeenCalledTimes(1);
		expect(f.kills.size).toBe(0);
		expect(f.notify).toHaveBeenCalledTimes(1);
	});

	it.each(["signal", "timeout"])("keeps %s active after background return", async (kind) => {
		vi.useFakeTimers();
		const f = fixture();
		const signal = new AbortController();
		const result = f.run(signal.signal, { timeout: 1 });
		await vi.advanceTimersByTimeAsync(60);
		await result;
		if (kind === "signal") signal.abort();
		else await vi.advanceTimersByTimeAsync(1000);
		expect(f.kill).toHaveBeenCalledTimes(1);
		expect(f.kills.size).toBe(0);
		expect(f.entry.watches).toHaveLength(0);
	});

	it("cleans up on completion and old cancellation cannot affect the next generation", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const signal = new AbortController();
		const first = f.run(signal.signal, { timeout: 1 });
		const old = [...f.kills][0];
		await vi.advanceTimersByTimeAsync(60);
		await first;
		f.complete(7);
		expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 7 }));
		expect(f.entry.watches).toHaveLength(0);
		const second = f.run();
		await vi.advanceTimersByTimeAsync(60);
		await second;
		old.abort();
		signal.abort();
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.kill).not.toHaveBeenCalled();
		expect(f.manager.isSentinelPending("ai-bash")).toBe(true);
		[...f.kills][0].abort();
	});

	it.each(["abort", "timeout"])("foreground %s settles and releases task ownership", async (kind) => {
		vi.useFakeTimers();
		const f = fixture({ idleMs: () => 0 });
		const signal = new AbortController();
		const result = f.run(signal.signal, { timeout: 1 });
		const assertion = expect(result).rejects.toThrow(kind === "abort" ? /aborted/ : /timed out/);
		if (kind === "abort") signal.abort();
		await vi.advanceTimersByTimeAsync(1100);
		await assertion;
		expect(f.kills.size).toBe(0);
		expect(f.entry.watches).toHaveLength(0);
		expect(f.notify).not.toHaveBeenCalled();
	});

	it("long deadlines use timer chunks instead of overflowing Node's timeout", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const result = f.run(undefined, { timeout: 30 * 24 * 60 * 60 });
		await vi.advanceTimersByTimeAsync(1000);
		await result;
		expect(f.kill).not.toHaveBeenCalled();
		expect(f.kills.size).toBe(1);
		[...f.kills][0].abort();
	});

	it("natural shell exit publishes its known status before invoking completion observers", async () => {
		vi.useFakeTimers();
		const f = fixture({ idleMs: () => 0 });
		vi.spyOn(f.manager as any, "killNative").mockImplementation(() => {});
		const result = f.run();
		(f.manager as any).exit("ai-bash", 17);
		await vi.advanceTimersByTimeAsync(60);
		expect(await result).toMatchObject({ details: { exitCode: 17 } });
		expect(f.kills.size).toBe(0);
	});

	it("pre-aborted requests never create or inject a command", async () => {
		const f = fixture();
		const signal = new AbortController();
		signal.abort();
		await expect(f.run(signal.signal)).rejects.toThrow(/aborted/);
		expect(f.create).not.toHaveBeenCalled();
		expect(f.input).not.toHaveBeenCalled();
	});

	it.each([23, null])("stops foreground waiting when shell closes (status %s)", async (code) => {
		vi.useFakeTimers();
		const f = fixture({ idleMs: () => 0 });
		const result = f.run();
		const assertion =
			code === null
				? expect(result).rejects.toThrow(/closed/)
				: expect(result).resolves.toMatchObject({ details: { exitCode: code } });
		f.entry.exitCode = code;
		f.kill("ai-bash");
		await vi.advanceTimersByTimeAsync(60);
		await assertion;
		expect(f.kills.size).toBe(0);
	});

	it("wait joins the current nonce and ignores old sentinels even at cursor zero", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.output(`\n[pi-exit-${nonce}:0]\n`);
		f.manager.setSentinelPending("ai-bash", true, "abcdef123456");
		let resolved = false;
		const wait = f.manager.waitForCompletion("ai-bash", 1000).then((r) => {
			resolved = true;
			return r;
		});
		f.output(`\n[pi-exit-${nonce}:9]\n`);
		await Promise.resolve();
		expect(resolved).toBe(false);
		f.output("\n[pi-exit-abcdef123456:4]\n");
		expect(await wait).toEqual({ finished: true, exitCode: 4 });
		expect(f.entry.watches).toHaveLength(0);
	});

	it.each(["kill", "killAll", "runCommand"])(
		"%s retires observers/waiters without faking native exit",
		async (operation) => {
			const f = fixture();
			f.kill.mockRestore();
			f.entry.exited = false;
			const native = vi.spyOn(f.manager as any, "killNative").mockImplementation((entry: any) => {
				expect(entry.exited).toBe(false);
			});
			const callback = vi.fn();
			const wake = vi.fn();
			f.entry.waiters.add(wake);
			f.manager.setSentinelPending("ai-bash", true, nonce);
			f.manager.watchOutput("ai-bash", /never/, callback);
			const wait = f.manager.waitForCompletion("ai-bash", 1000);
			if (operation === "kill") f.manager.kill("ai-bash");
			else if (operation === "killAll") f.manager.killAll();
			else {
				vi.spyOn(f.manager as any, "spawnShell").mockReturnValue(false);
				f.manager.runCommand("ai-bash", { command: "echo next", cwd: process.cwd() } as any, 80, 24, process.cwd());
			}
			expect(native).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledExactlyOnceWith(null);
			expect(wake).toHaveBeenCalledTimes(1);
			expect(f.entry.watches).toHaveLength(0);
			expect(f.entry.waiters.size).toBe(0);
			expect(await wait).toEqual({ finished: true, exitCode: null });
		},
	);

	it("pre-aborted completion waits unregister immediately", async () => {
		const f = fixture();
		const signal = new AbortController();
		signal.abort();
		expect(await f.manager.waitForCompletion("ai-bash", 1000, signal.signal)).toEqual({
			finished: false,
			exitCode: null,
		});
		expect(f.entry.watches).toHaveLength(0);
	});

	it("watch sees a marker before trimming a large output chunk and unregisters captured entry", () => {
		const f = fixture();
		const cb = vi.fn();
		const remove = f.manager.watchOutput("ai-bash", /finished/, cb);
		f.output("finished" + "x".repeat(100_000));
		expect(cb).toHaveBeenCalledTimes(1);
		const removeOther = f.manager.watchOutput("ai-bash", /never/, cb);
		f.terms.delete("ai-bash");
		removeOther();
		remove();
		expect(f.entry.watches).toHaveLength(0);
	});
});

describe.skipIf(!existsSync(bash))("physical bash framing and status", () => {
	it.each([
		["true | false", 1],
		["false | true", 0],
		["set -o pipefail; false | true", 1],
		["set -o pipefail; true | false | true", 1],
		["(exit 141)", 141],
		["false # trailing comment", 1],
		["cat <<'END'\nhello\nEND", 0],
		["printf '%s\\n' \"a'b\"\nfalse", 1],
		["echo syntax |", 2],
	])("preserves status for %s", (command, code) => {
		const line = buildTerminalBashLine(command as string, undefined, nonce);
		expect(line).not.toMatch(/[\r\n]/);
		const output = execFileSync(bash, ["--noprofile", "--norc", "-c", line], {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		expect(output).toContain(`[pi-exit-${nonce}:${code}]`);
	});

	it("read consumes the user's next line rather than the completion marker", () => {
		const line = buildTerminalBashLine("read value; printf 'value=%s' \"$value\"", undefined, nonce);
		const output = execFileSync(bash, ["--noprofile", "--norc"], {
			input: line + "\nanswer\n",
			encoding: "utf8",
		});
		expect(output).toContain("value=answer");
		expect(output).toContain(`[pi-exit-${nonce}:0]`);
	});
});
