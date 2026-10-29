import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createDeviceTaskExecutor } from "../../server/device-center/executor.js";
import type { ClientMessage, UiState } from "../../server/protocol.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
const cwd = resolve(".");
let taskSequence = 0;
const task = () => ({ id: `executor-test-${++taskSequence}`, attemptId: "attempt-1", text: "Run the verification" });
const assistant = (text: string) => ({ id: "a-1", role: "assistant", content: [{ type: "text", text }] });

async function fixture(
	onPrompt?: (socket: WebSocket, state: UiState) => void,
	opts: {
		changeCwd?: boolean;
		gap?: boolean;
		refuseNew?: boolean;
		onSession?: (taskId: string, sessionId: string | undefined) => void;
	} = {},
) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	if (typeof address === "string" || !address) throw new Error("No address");
	const origin = `http://127.0.0.1:${address.port}`;
	const received: ClientMessage[] = [];
	let authorization: string | undefined;
	let initialId = "old-chat";
	let snapshot: UiState;
	const push = (socket: WebSocket, patch: Partial<UiState> = {}) => {
		snapshot = { ...snapshot, ...patch, rev: snapshot.rev + 1 };
		socket.send(JSON.stringify({ type: "snapshot", state: snapshot }));
	};
	server.on("connection", (socket, request) => {
		authorization = request.headers.authorization;
		expect(request.url).toBe("/ws");
		socket.on("message", (raw) => {
			const msg = JSON.parse(raw.toString()) as ClientMessage;
			received.push(msg);
			if (msg.type === "hello") {
				expect(msg.clientId).toMatch(/^device-task-/);
				snapshot = {
					clientId: msg.clientId,
					sessionId: "old-sdk-session",
					cwd: opts.changeCwd ? resolve("other") : cwd,
					conversationId: initialId,
					rev: 1,
					messages: [assistant("OLD HISTORY")],
					isStreaming: false,
					streamingMessage: null,
				} as UiState;
				socket.send(JSON.stringify({ type: "ready", clientId: msg.clientId }));
				// ready precedes attach completion: no new_chat until this snapshot.
				setImmediate(() => push(socket));
			} else if (msg.type === "set_cwd") {
				push(socket, { cwd, messages: [assistant("RESUMED HISTORY")] });
				socket.send(JSON.stringify({ type: "transition_progress", kind: "cwd", phase: "done" }));
			} else if (msg.type === "new_chat") {
				if (opts.refuseNew) {
					socket.send(
						JSON.stringify({
							type: "transition_progress",
							kind: "new_chat",
							phase: "error",
							text: "Conversation limit",
						}),
					);
					return;
				}
				initialId = "task-chat";
				push(socket, { conversationId: initialId, sessionId: "task-sdk-session", messages: [], isEphemeral: false });
			} else if (msg.type === "get_state") push(socket);
			else if (msg.type === "prompt") {
				if (opts.gap)
					socket.send(
						JSON.stringify({
							type: "snapshot_delta",
							conversationId: initialId,
							baseRev: -99,
							rev: 99,
							state: snapshot,
							appended: [assistant("FAKE GAP TEXT")],
						}),
					);
				onPrompt?.(socket, snapshot);
			}
		});
	});
	const executor = createDeviceTaskExecutor({
		localOrigin: origin,
		cwd,
		localAuthToken: "test-token",
		allowExecution: true,
		onSession: opts.onSession,
	});
	cleanup.push(async () => {
		void executor.close().catch(() => {});
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((done) => server.close(() => done()));
	});
	return { executor, received, origin, push, authorization: () => authorization };
}

function delta(socket: WebSocket, state: UiState, patch: Partial<UiState>, appended: unknown[] = []) {
	socket.send(
		JSON.stringify({
			type: "snapshot_delta",
			conversationId: state.conversationId,
			baseRev: state.rev,
			rev: state.rev + 1,
			state: { ...state, ...patch, rev: state.rev + 1, messages: undefined },
			appended,
		}),
	);
}

// These tests use real loopback sockets and the production protocol envelope,
// without invoking models or weakening the existing approval mechanism.
describe("device task executor", () => {
	it("handshakes, switches cwd, creates a persistent task chat and extracts actual assistant text from deltas", async () => {
		const f = await fixture(
			(socket, state) => {
				delta(socket, state, { isStreaming: true });
				delta(socket, { ...state, rev: state.rev + 1 }, { isStreaming: false }, [
					{ id: "tool", role: "toolResult", content: [{ type: "text", text: "SECRET TOOL OUTPUT" }] },
					{
						...assistant("Verified command: exit 0; repair commit abc123"),
						content: [
							{ type: "thinking", text: "HIDDEN THINKING" },
							{ type: "text", text: "Verified command: exit 0; repair commit abc123" },
						],
					},
				]);
			},
			{ changeCwd: true },
		);
		const t = {
			...task(),
			handoff: { repository: "repo", commit: "deadbeef", branch: "fix", instructions: "Verify first" },
		};
		const result = await f.executor.run(t);
		expect(result).toContain("Verified command: exit 0; repair commit abc123");
		expect(result).not.toContain("Local system:");
		expect(result).not.toContain("Conversation: task-chat");
		expect(result).not.toMatch(/OLD HISTORY|RESUMED HISTORY|SECRET TOOL OUTPUT|HIDDEN THINKING/);
		expect(f.authorization()).toBe("Bearer test-token");
		expect(f.received.map((m) => m.type)).toEqual([
			"hello",
			"set_cwd",
			"get_state",
			"new_chat",
			"rename_conversation",
			"prompt",
		]);
		expect(f.received.find((m) => m.type === "new_chat")).toEqual({ type: "new_chat", ephemeral: false });
		const prompt = f.received.find((m) => m.type === "prompt");
		expect(prompt?.text).toContain("deadbeef");
		expect(prompt?.text).toContain("dirty state");
		expect(prompt?.text).toContain("isolated worktree");
		expect(prompt?.text).toContain("greetings, questions and ordinary conversation");
		expect(prompt?.text).toContain("final answer is delivered automatically to the group");
	});

	it("is disabled by default and rejects non-loopback, credentials and non-origin URLs", async () => {
		for (const localOrigin of [
			"https://localhost",
			"http://example.com",
			"http://127.0.0.1.evil.test",
			"http://user:secret@localhost",
			"http://localhost/?token=secret",
			"http://localhost/proxy",
			"http://localhost/#x",
		]) {
			expect(() => createDeviceTaskExecutor({ localOrigin, cwd })).toThrow(/localOrigin/);
		}
		const executor = createDeviceTaskExecutor({ localOrigin: "http://localhost:8999", cwd });
		await expect(executor.run(task())).rejects.toThrow("disabled");
		executor.close();
	});

	it("rejects busy work across instances, cancels only its own session and forbids repeated task IDs", async () => {
		const f = await fixture();
		const t = task();
		const running = f.executor.run(t);
		const rejected = expect(running).rejects.toThrow("cancelled");
		await expect(f.executor.run(task())).rejects.toThrow("busy");
		const other = createDeviceTaskExecutor({ localOrigin: f.origin, cwd, allowExecution: true });
		await expect(other.run(task())).rejects.toThrow("busy");
		await vi.waitFor(() => expect(f.received.some((m) => m.type === "prompt")).toBe(true));
		f.executor.close();
		await rejected;
		await vi.waitFor(() => expect(f.received.filter((m) => m.type === "abort")).toHaveLength(1));
		await vi.waitFor(async () => {
			await expect(other.run({ ...t, attemptId: "different-attempt" })).rejects.toThrow("Duplicate task");
		});
		other.close();
	});

	it.each(["question_pending", "tool_approval_pending", "pendingQuestion", "pendingApproval"])(
		"aborts for %s without approving or changing settings",
		async (kind) => {
			const f = await fixture((socket, state) => {
				if (kind.startsWith("pending")) delta(socket, state, { [kind]: { id: "approval" } } as Partial<UiState>);
				else socket.send(JSON.stringify({ type: kind, id: "approval", conversationId: state.conversationId }));
			});
			await expect(f.executor.run(task())).rejects.toThrow(/paused.*human/);
			await vi.waitFor(() => expect(f.received.some((m) => m.type === "abort")).toBe(true));
			expect(f.received.map((m) => m.type)).not.toEqual(expect.arrayContaining(["tool_approval_answer"]));
			expect(
				f.received.every((m) =>
					["hello", "new_chat", "rename_conversation", "prompt", "abort", "get_state"].includes(m.type),
				),
			).toBe(true);
		},
	);

	it("close waits for the same SDK session to acknowledge idle after abort", async () => {
		let socket!: WebSocket;
		const f = await fixture((ws) => {
			socket = ws;
			f.push(ws, { isStreaming: true });
		});
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(socket).toBeDefined());
		let stopped = false;
		const closing = f.executor.close().then(() => {
			stopped = true;
		});
		await rejected;
		await vi.waitFor(() => expect(f.received.some((m) => m.type === "get_state")).toBe(true));
		expect(stopped).toBe(false);
		f.push(socket, { isStreaming: false });
		await closing;
		expect(stopped).toBe(true);
	});

	it("close times out after 20 seconds without an idle acknowledgement", async () => {
		let started = false;
		const f = await fixture((socket) => {
			started = true;
			f.push(socket, { isStreaming: true });
		});
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(started).toBe(true));
		vi.useFakeTimers();
		const closing = f.executor.close();
		const uncertain = expect(closing).rejects.toThrow("stop unconfirmed");
		await rejected;
		await vi.advanceTimersByTimeAsync(20_000);
		await uncertain;
		vi.useRealTimers();
	});

	it("close rejects uncertain disconnect instead of confirming idle", async () => {
		const f = await fixture((socket) => socket.close());
		await expect(f.executor.run(task())).rejects.toThrow("uncertain");
		await expect(f.executor.close()).rejects.toThrow("stop unconfirmed");
	});

	it("reports disconnect as uncertain and never reconnects or reruns", async () => {
		const f = await fixture((socket) => socket.close());
		await expect(f.executor.run(task())).rejects.toThrow(/disconnected.*uncertain/);
		expect(f.received.filter((m) => m.type === "hello")).toHaveLength(1);
		expect(f.received.filter((m) => m.type === "prompt")).toHaveLength(1);
	});

	it("refuses to abort a different current conversation", async () => {
		const f = await fixture((socket, state) =>
			socket.send(JSON.stringify({ type: "snapshot", state: { ...state, conversationId: "user-chat" } })),
		);
		await expect(f.executor.run(task())).rejects.toThrow("ownership changed");
		expect(f.received.some((m) => m.type === "abort")).toBe(false);
	});

	it("does not send a prompt when new_chat is refused", async () => {
		const f = await fixture(undefined, { refuseNew: true });
		await expect(f.executor.run(task())).rejects.toThrow("Conversation limit");
		expect(f.received.some((m) => m.type === "prompt")).toBe(false);
	});

	it("resynchronizes missing deltas and waits for actual final snapshots", async () => {
		const f = await fixture(
			(socket) => {
				f.push(socket, { isStreaming: true });
				f.push(socket, { isStreaming: false, messages: [assistant("ACTUAL RESULT")] });
			},
			{ gap: true },
		);
		const result = await f.executor.run(task());
		expect(result).toContain("ACTUAL RESULT");
		expect(result).not.toContain("FAKE GAP TEXT");
		expect(f.received.filter((m) => m.type === "prompt")).toHaveLength(1);
	});

	it("rejects assistant failures and empty results", async () => {
		for (const messages of [[], [{ ...assistant("partial"), stopReason: "error", errorMessage: "Model failed" }]]) {
			const f = await fixture((socket, state) => {
				delta(socket, state, { isStreaming: true });
				delta(socket, { ...state, rev: state.rev + 1 }, { isStreaming: false }, messages);
			});
			await expect(f.executor.run(task())).rejects.toThrow(/without assistant text|Model failed/);
		}
	});

	it("limits UTF-8 reports to 16 KiB with a truncation notice", async () => {
		const f = await fixture((socket, state) =>
			delta(socket, state, { isStreaming: false }, [assistant("实际结果".repeat(10000))]),
		);
		const result = await f.executor.run(task());
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(16 * 1024);
		expect(result).toContain("Report truncated");
	});

	it.each(["completed", "approval", "disconnect", "close", "timeout"])(
		"binds the SDK session before prompt and clears ownership on %s",
		async (outcome) => {
			const sessions = new Map<string, string>();
			const onSession = vi.fn((taskId: string, sessionId: string | undefined) => {
				if (sessionId) sessions.set(sessionId, taskId);
				else for (const [id, parent] of sessions) if (parent === taskId) sessions.delete(id);
			});
			const t = task();
			const f = await fixture(
				(socket, state) => {
					expect(state.sessionId).toBe("task-sdk-session");
					expect(sessions.get(state.sessionId)).toBe(t.id);
					expect(sessions.get(state.conversationId)).toBeUndefined();
					expect(sessions.get("same-root-human-sdk-session")).toBeUndefined();
					if (outcome === "completed") delta(socket, state, { isStreaming: false }, [assistant("done")]);
					if (outcome === "approval")
						socket.send(JSON.stringify({ type: "tool_approval_pending", conversationId: state.conversationId }));
					if (outcome === "disconnect") socket.close();
				},
				{ onSession },
			);
			if (outcome === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const running = f.executor.run(t);
			const checked =
				outcome === "completed" ? expect(running).resolves.toContain("done") : expect(running).rejects.toThrow();
			if (outcome === "close" || outcome === "timeout") {
				for (let i = 0; i < 1000 && !f.received.some((m) => m.type === "prompt"); i++)
					await new Promise<void>((done) => setImmediate(done));
				expect(f.received.some((m) => m.type === "prompt")).toBe(true);
				if (outcome === "close") f.executor.close();
				else await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
			}
			await checked;
			vi.useRealTimers();
			expect(onSession.mock.calls).toEqual([
				[t.id, "task-sdk-session"],
				[t.id, undefined],
			]);
			expect(sessions.size).toBe(0);
			f.executor.close();
			expect(onSession).toHaveBeenCalledTimes(2);
			await expect(f.executor.run(task())).rejects.toThrow("closed");
		},
	);

	it("cleans up a failed ownership registration before any prompt", async () => {
		const onSession = vi.fn((_taskId: string, sessionId: string | undefined) => {
			if (sessionId) throw new Error("Registration failed");
		});
		const f = await fixture(undefined, { onSession });
		const t = task();
		await expect(f.executor.run(t)).rejects.toThrow("registration failed");
		expect(onSession.mock.calls).toEqual([
			[t.id, "task-sdk-session"],
			[t.id, undefined],
		]);
		expect(f.received.some((m) => m.type === "prompt")).toBe(false);
	});

	it("times out after 20 minutes and sends abort", async () => {
		const f = await fixture();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("20 minute timeout");
		// Native socket events are still real; poll with native setImmediate.
		for (let i = 0; i < 1000 && !f.received.some((m) => m.type === "prompt"); i++)
			await new Promise<void>((done) => setImmediate(done));
		expect(f.received.some((m) => m.type === "prompt")).toBe(true);
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
		await rejected;
		vi.useRealTimers();
		await vi.waitFor(() => expect(f.received.some((m) => m.type === "abort")).toBe(true));
	});
});
