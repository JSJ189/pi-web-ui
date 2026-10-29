import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export interface Handoff {
	repository: string;
	commit: string;
	branch?: string;
	instructions: string;
}
export interface Account {
	id: string;
	username: string;
	passwordHash: string;
	createdAt: number;
}
export interface Device {
	id: string;
	accountId: string;
	name: string;
	credentialHash: string;
	uiCredentialHash?: string;
	createdAt: number;
}
export interface HubTask {
	id: string;
	attemptId: string;
	roomId: string;
	accountId: string;
	deviceId: string;
	text: string;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
	parentTaskId?: string;
	rootTaskId?: string;
	dispatchDepth?: number;
	dispatchCount?: number;
	handoff?: Handoff;
	report?: string;
}
export interface Room {
	id: string;
	accountId: string;
	name: string;
	deviceIds: string[];
	createdAt: number;
}
export interface RoomMessage {
	id: string;
	roomId: string;
	accountId: string;
	text: string;
	sender: { type: "human" | "device"; id: string; name: string; sourceDeviceId?: string };
	createdAt: number;
	taskIds: string[];
	targetDeviceIds?: string[];
}
export interface HubState {
	version: 1;
	accounts: Account[];
	devices: Device[];
	sessions: { hash: string; accountId: string; expiresAt: number }[];
	rooms: Room[];
	messages: RoomMessage[];
	tasks: HubTask[];
	receipts: { accountId: string; roomId: string; key: string; fingerprint: string; messageId: string }[];
}
export const isTerminal = (status: TaskStatus) => ["completed", "failed", "interrupted"].includes(status);
export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
export function secretMatches(secret: string, hash: string): boolean {
	const actual = Buffer.from(hashSecret(secret), "hex");
	const expected = Buffer.from(hash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function publicDevice(device: Device) {
	const { credentialHash: _hash, uiCredentialHash: _uiHash, ...visible } = device;
	return visible;
}

/** A single process owns a data directory. Transactions publish only after atomic replacement. */
export class DeviceHubStore {
	private state: HubState;
	private tail: Promise<unknown> = Promise.resolve();
	readonly path: string;
	private constructor(dataDir: string, state: HubState) {
		this.path = join(dataDir, "device-hub.json");
		this.state = state;
	}
	static async open(dataDir: string): Promise<DeviceHubStore> {
		await mkdir(dataDir, { recursive: true, mode: 0o700 });
		let state: HubState;
		try {
			state = JSON.parse(await readFile(join(dataDir, "device-hub.json"), "utf8"));
			if (
				state.version !== 1 ||
				![
					state.accounts,
					state.devices,
					state.sessions,
					state.rooms,
					state.messages,
					state.tasks,
					state.receipts,
				].every(Array.isArray)
			) {
				throw new Error("Invalid device hub store");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			state = { version: 1, accounts: [], devices: [], sessions: [], rooms: [], messages: [], tasks: [], receipts: [] };
		}
		const store = new DeviceHubStore(dataDir, state);
		if (state.tasks.some((task) => task.status === "running")) {
			await store.transact((draft) => {
				for (const task of draft.tasks)
					if (task.status === "running") {
						task.status = "interrupted";
						task.updatedAt = Date.now();
					}
			});
		}
		return store;
	}
	snapshot(): HubState {
		return structuredClone(this.state);
	}
	getDeviceOwner(id: string): string | undefined {
		return this.state.devices.find((device) => device.id === id)?.accountId;
	}
	getDevice(id: string) {
		const device = this.state.devices.find((item) => item.id === id);
		return device ? publicDevice(device) : undefined;
	}
	async authenticateDevice(id: string, credential: string): Promise<boolean> {
		const device = this.state.devices.find((item) => item.id === id);
		return (
			!!device &&
			typeof credential === "string" &&
			credential.length <= 256 &&
			secretMatches(credential, device.credentialHash)
		);
	}
	async transact<T>(update: (draft: HubState) => T): Promise<T> {
		const operation = this.tail.then(async () => {
			const draft = structuredClone(this.state);
			const result = update(draft);
			await this.persist(draft);
			this.state = draft;
			return structuredClone(result);
		});
		this.tail = operation.catch(() => {});
		return operation;
	}
	/** Kept as a method so I/O failures can be injected without replacing transaction semantics. */
	async persist(state: HubState): Promise<void> {
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(state));
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, this.path);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
	async close(): Promise<void> {
		await this.tail;
	}
}
