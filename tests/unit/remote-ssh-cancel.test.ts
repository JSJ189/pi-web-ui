import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RemoteSshService } from "../../server/remote-ssh-service.js";

const uri = "ssh://tester@example.test/work";
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function setup() {
	const service = Object.create(RemoteSshService.prototype) as RemoteSshService;
	const connecting = deferred<any>();
	const getConnection = vi.spyOn(service as any, "getOrConnectByUri").mockReturnValue(connecting.promise);
	let callback: any;
	const client = {
		exec: vi.fn((_cmd, cb) => {
			callback = cb;
		}),
		end: vi.fn(),
	};
	const stream = Object.assign(new EventEmitter(), {
		stderr: new EventEmitter(),
		signal: vi.fn(),
		close: vi.fn(),
	});
	const controller = new AbortController();
	return {
		service,
		connecting,
		getConnection,
		client,
		stream,
		controller,
		connect: async () => {
			connecting.resolve({ conn: { client }, parsed: { remotePath: "/work" } });
			await Promise.resolve();
		},
		open: () => callback(null, stream),
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("remote exec operation cancellation", () => {
	it("does not connect when already cancelled", async () => {
		const s = setup();
		s.controller.abort(new Error("pre-cancelled"));
		await expect(s.service.execInWorkspace(uri, "pwd", { signal: s.controller.signal })).rejects.toThrow(
			"pre-cancelled",
		);
		expect(s.getConnection).not.toHaveBeenCalled();
	});
	it("rejects immediately during connection wait, never starts exec, and preserves the shared client", async () => {
		const s = setup();
		const result = s.service.execInWorkspace(uri, "pwd", { signal: s.controller.signal });
		const rejected = expect(result).rejects.toThrow("during connect");
		s.controller.abort(new Error("during connect"));
		await rejected;
		await s.connect();
		expect(s.client.exec).not.toHaveBeenCalled();
		expect(s.client.end).not.toHaveBeenCalled();
	});
	it("handles a connection rejection arriving after cancellation", async () => {
		const s = setup();
		const result = s.service.execInWorkspace(uri, "pwd", { signal: s.controller.signal });
		const rejected = expect(result).rejects.toThrow();
		s.controller.abort();
		await rejected;
		s.connecting.reject(new Error("late connect error"));
		await Promise.resolve();
	});
	it("closes a channel arriving after cancellation while exec opens", async () => {
		const s = setup();
		const onData = vi.fn();
		const result = s.service.execInWorkspace(uri, "pwd", { signal: s.controller.signal, onData });
		await s.connect();
		const rejected = expect(result).rejects.toThrow("opening");
		s.controller.abort(new Error("opening"));
		await rejected;
		s.open();
		expect(s.stream.signal).toHaveBeenCalledWith("TERM");
		expect(s.stream.close).toHaveBeenCalledOnce();
		s.stream.emit("error", new Error("late error"));
		s.stream.emit("data", Buffer.from("late"));
		expect(onData).not.toHaveBeenCalled();
		expect(s.client.end).not.toHaveBeenCalled();
	});
	it("cancels mid-output, closes even when signalling throws, and ignores later output", async () => {
		const s = setup();
		const onData = vi.fn();
		const remove = vi.spyOn(s.controller.signal, "removeEventListener");
		const result = s.service.execInWorkspace(uri, "pwd", { signal: s.controller.signal, onData });
		await s.connect();
		s.open();
		s.stream.emit("data", Buffer.from("first"));
		s.stream.signal.mockImplementation(() => {
			throw new Error("signal rejected");
		});
		s.stream.close.mockImplementation(() => {
			s.stream.emit("close", 0);
		});
		const rejected = expect(result).rejects.toThrow("mid-output");
		s.controller.abort(new Error("mid-output"));
		await rejected;
		s.stream.stderr.emit("data", Buffer.from("late"));
		expect(onData).toHaveBeenCalledTimes(1);
		expect(s.stream.close).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});
	it("collects successful output and removes the abort listener", async () => {
		const s = setup();
		const remove = vi.spyOn(s.controller.signal, "removeEventListener");
		const result = s.service.execInWorkspace(uri, "pwd", { signal: s.controller.signal });
		await s.connect();
		s.open();
		s.stream.emit("data", Buffer.from("out"));
		s.stream.stderr.emit("data", Buffer.from("err"));
		s.stream.emit("close", 7);
		await expect(result).resolves.toEqual({ stdout: "out", stderr: "err", exitCode: 7 });
		expect(remove).toHaveBeenCalled();
		s.controller.abort();
		expect(s.stream.close).not.toHaveBeenCalled();
	});
	it("times out even when close synchronously reports success", async () => {
		vi.useFakeTimers();
		const s = setup();
		const result = s.service.execInWorkspace(uri, "pwd", { timeoutMs: 10 });
		const rejected = expect(result).rejects.toThrow("timed out");
		await s.connect();
		s.open();
		s.stream.close.mockImplementation(() => {
			s.stream.emit("close", 0);
		});
		await vi.advanceTimersByTimeAsync(10);
		await rejected;
		expect(s.stream.signal).toHaveBeenCalledWith("KILL");
	});
	it("propagates a synchronous exec failure", async () => {
		const s = setup();
		s.client.exec.mockImplementation(() => {
			throw new Error("exec failed");
		});
		const result = s.service.execInWorkspace(uri, "pwd");
		await s.connect();
		await expect(result).rejects.toThrow("exec failed");
	});
});
