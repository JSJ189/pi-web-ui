import { resolve } from "node:path";
import { createDeviceCollabService } from "./collab-service.js";
import { createDeviceTaskExecutor, type DeviceExecutorTask, type DeviceTaskExecutorOptions } from "./executor.js";
import { createDeviceFileSync } from "./file-sync.js";
import { DeviceTaskError } from "./task-error.js";
import type { LocalBotRegistry } from "./bots.js";

type Config = { hubUrl: string; deviceId: string; credential: string; allowExecution: boolean };
type Files = ReturnType<typeof createDeviceFileSync>;
type Executor = { run(task: DeviceExecutorTask): Promise<string>; close(): void | Promise<void> };
type Owner = { roomId: string; taskId: string; root: string; botId: string };
type TaskOwner = { controller: AbortController; executor?: Executor; done?: Promise<unknown> };

export function createDeviceRuntime(options: {
	config: Config;
	localOrigin: string;
	localAuthToken?: string;
	dataDir: string;
	bots: LocalBotRegistry;
	executorFactory?: (options: DeviceTaskExecutorOptions) => Executor;
}) {
	const { config, bots } = options;
	const sessions = new Map<string, Owner>();
	const files = new Map<string, { roomId: string; botId: string; revision: string; files: Files }>();
	const receipts = new Map<string, { roomId: string; botId: string; revision: string; files: Files }>();
	const operations = new Set<Promise<unknown>>();
	let closed = false;
	let blocked: unknown;
	let generation = new AbortController();
	let active: TaskOwner | undefined;
	function enabled(signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (closed) throw new Error("Device runtime closed");
		if (blocked)
			throw new DeviceTaskError(
				"群任务停止状态不确定，项目已隔离。请在本机确认后重启服务。 / Task stop unconfirmed; workspace blocked until service restart.",
			);
		if (!config.allowExecution)
			throw new DeviceTaskError("目标设备未开启群任务执行权限。 / Local task execution is disabled.");
	}
	function track<T>(operation: Promise<T>): Promise<T> {
		operations.add(operation);
		void operation.finally(() => operations.delete(operation)).catch(() => {});
		return operation;
	}
	async function sweep() {
		for (const [key, entry] of files) {
			const bot = bots.get(entry.botId);
			if (bot?.enabled && `${bot.id}:${bot.revision}` === entry.revision) continue;
			files.delete(key);
			for (const [id, receipt] of receipts) if (receipt.files === entry.files) receipts.delete(id);
			await entry.files.close();
		}
	}
	async function acquire(botId: string, signal?: AbortSignal) {
		enabled(signal);
		await sweep();
		const lease = await bots.acquire(botId);
		try {
			enabled(signal);
			return lease;
		} catch (error) {
			lease.release();
			throw error;
		}
	}
	function roomFiles(roomId: string, botId: string, lease: { root: string; revision: string }) {
		const key = JSON.stringify([roomId, botId, lease.revision]);
		let entry = files.get(key);
		if (!entry) {
			entry = {
				roomId,
				botId,
				revision: lease.revision,
				files: createDeviceFileSync({
					root: lease.root,
					dataDir: options.dataDir,
					allowReceive: config.allowExecution,
				}),
			};
			files.set(key, entry);
		}
		return entry;
	}
	const service = createDeviceCollabService({
		getConfig: () => (closed ? undefined : config),
		getParentTask: (context) => (context?.sessionId ? sessions.get(context.sessionId)?.taskId : undefined),
		getSourceBot: (context) => (context?.sessionId ? sessions.get(context.sessionId)?.botId : undefined),
		async workspaceResolver({ roomId, sourceBotId, context, signal }) {
			const boundSignal = AbortSignal.any([generation.signal, ...(signal ? [signal] : [])]);
			const lease = await acquire(sourceBotId, boundSignal);
			try {
				const owner = context.sessionId ? sessions.get(context.sessionId) : undefined;
				if (
					!owner ||
					resolve(context.cwd) !== resolve(lease.root) ||
					(roomId && owner.roomId !== roomId) ||
					owner.root !== lease.root ||
					owner.botId !== sourceBotId
				)
					throw new Error("Task workspace ownership mismatch");
				return { ...lease, botId: sourceBotId, files: roomFiles(roomId, sourceBotId, lease).files };
			} catch (error) {
				lease.release();
				throw error;
			}
		},
	});
	const collabService: typeof service = {
		execute(action, args, signal, context) {
			if (action === "send_task" && (!context?.sessionId || sessions.get(context.sessionId)?.roomId !== args.roomId))
				return Promise.reject(new Error("Task session is not bound to this room"));
			const commandSignal = AbortSignal.any([generation.signal, ...(signal ? [signal] : [])]);
			return track(service.execute(action, args, commandSignal, context));
		},
	};
	function onTask(task: DeviceExecutorTask & { roomId: string }, signal?: AbortSignal): Promise<string> {
		try {
			enabled(signal);
		} catch (error) {
			return Promise.reject(error);
		}
		if (active)
			return Promise.reject(
				new DeviceTaskError("目标设备正在执行另一个群任务，请稍后再试。 / Local task executor busy."),
			);
		const owner: TaskOwner = { controller: new AbortController() };
		active = owner;
		const taskSignal = AbortSignal.any([owner.controller.signal, generation.signal, ...(signal ? [signal] : [])]);
		const operation = (async () => {
			let lease: Awaited<ReturnType<typeof acquire>> | undefined;
			let stopping: Promise<void> | undefined;
			const stop = () => {
				if (!stopping) stopping = Promise.resolve().then(() => owner.executor?.close());
				void stopping.catch(() => {});
			};
			const confirmStop = async () => {
				stop();
				try {
					await stopping;
				} catch (error) {
					blocked = error;
					throw error;
				}
			};
			try {
				if (!task.roomId) throw new DeviceTaskError("Task room required");
				try {
					if (task.deviceId !== config.deviceId || !task.botId) throw new Error("Task Bot route mismatch");
					lease = await acquire(task.botId, taskSignal);
					if (task.botRevision !== lease.bot.revision) throw new Error("Task Bot revision mismatch");
				} catch (error) {
					if (taskSignal.aborted) throw error;
					throw new DeviceTaskError("目标 Bot 不可用、配置已变更或正在忙碌。 / Target Bot unavailable or busy.");
				}
				owner.executor = (options.executorFactory ?? createDeviceTaskExecutor)({
					localOrigin: options.localOrigin,
					localAuthToken: options.localAuthToken,
					cwd: lease.root,
					bot: lease.bot,
					allowExecution: config.allowExecution,
					onSession(taskId, sessionId) {
						for (const [id, bound] of sessions)
							if (bound.taskId === taskId && bound.roomId === task.roomId) sessions.delete(id);
						if (sessionId && !taskSignal.aborted)
							sessions.set(sessionId, { taskId, roomId: task.roomId, root: lease!.root, botId: task.botId });
					},
				});
				taskSignal.addEventListener("abort", stop, { once: true });
				taskSignal.throwIfAborted();
				const result = await owner.executor.run(task);
				taskSignal.throwIfAborted();
				return result;
			} finally {
				taskSignal.removeEventListener("abort", stop);
				await confirmStop();
				for (const [id, bound] of sessions)
					if (bound.taskId === task.id && bound.roomId === task.roomId) sessions.delete(id);
				lease?.release();
				if (active === owner) active = undefined;
			}
		})();
		owner.done = operation;
		return track(operation);
	}
	function onCommand(action: string, payload: unknown, signal: AbortSignal) {
		const commandSignal = AbortSignal.any([signal, generation.signal]);
		return track(
			(async () => {
				enabled(commandSignal);
				if (!payload || typeof payload !== "object" || Array.isArray(payload))
					throw new Error("Invalid transfer command");
				const command = payload as Record<string, unknown>;
				if (typeof command.roomId !== "string" || !command.roomId) throw new Error("Room required");
				if (typeof command.targetBotId !== "string" || !command.targetBotId) throw new Error("Target Bot required");
				const lease = await acquire(command.targetBotId, commandSignal);
				try {
					if (command.targetBotRevision !== lease.bot.revision) throw new Error("Transfer Bot revision mismatch");
					if (action === "transfer_stage") {
						const entry = roomFiles(command.roomId, command.targetBotId, lease);
						const preview = await entry.files.stage(command.bundle, { signal: commandSignal });
						commandSignal.throwIfAborted();
						receipts.set(preview.id, entry);
						return preview;
					}
					const receipt = typeof command.transferId === "string" ? receipts.get(command.transferId) : undefined;
					if (
						!receipt ||
						receipt.roomId !== command.roomId ||
						receipt.botId !== command.targetBotId ||
						receipt.revision !== lease.revision
					)
						throw new Error("Transfer workspace changed or transfer unavailable");
					if (action === "transfer_preview")
						return await receipt.files.preview(command.transferId as string, { signal: commandSignal });
					if (
						action === "transfer_apply" &&
						typeof command.revision === "string" &&
						Array.isArray(command.overwritePaths) &&
						command.overwritePaths.every((path) => typeof path === "string")
					)
						return await receipt.files.apply({
							id: command.transferId as string,
							revision: command.revision,
							decisions: Object.fromEntries(command.overwritePaths.map((path) => [path, "overwrite" as const])),
							signal: commandSignal,
						});
					throw new Error("Unsupported device command");
				} finally {
					lease.release();
				}
			})(),
		);
	}
	async function onDisconnect() {
		const previous = generation;
		generation = new AbortController();
		previous.abort();
		active?.controller.abort();
		await Promise.allSettled(operations);
		await sweep();
		if (blocked) throw blocked;
	}
	return {
		onTask,
		onCommand,
		collabService,
		onDisconnect,
		async close() {
			closed = true;
			await onDisconnect();
			await Promise.allSettled([...files.values()].map((entry) => entry.files.close()));
			files.clear();
			receipts.clear();
		},
	};
}
