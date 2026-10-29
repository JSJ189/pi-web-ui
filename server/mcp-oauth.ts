/**
 * OAuth 保护的远端 MCP 服务器的凭据（Issue #786）。
 *
 * pi 的内置 MCP 集成会把登录结果存进 `<agent-dir>/mcp-auth.json`，键为 `mcp__<服务器名>|<url>`
 * （旧版本只写 URL 做键；那种状态这里同样接管）。pi-web-ui 自己的桥从不登录，以前也完全无视这份
 * 凭据，于是每个 OAuth 保护的服务器都止步于 `HTTP 401`。
 *
 * 本模块**复用 pi 的凭据库**，而不是再建一份：
 *  - 读出存好的 access token，随请求发 `Authorization: Bearer …`；
 *  - 临近过期或收到 401 时，用存好的 refresh token 换新的；
 *  - 刷新结果按 pi 的格式写回，并复用 pi 的刷新锁（两个进程不会同时刷新）。
 *
 * 登录本身（授权码 + PKCE + 浏览器回调）仍由 `pi mcp login <服务器>` 负责，直到 pi-web-ui 有了
 * 自己的登录界面 —— 见 Issue #786 的后续步骤。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeAtomicSync } from "./atomic-file.js";

/** 离过期这么近的 access token 先刷新再发出去（与 pi 同口径）。 */
export const MCP_REFRESH_SKEW_MS = 30_000;
/** 刷新锁被持有超过这个时间就视为遗弃（持锁进程被杀），后来者接管。 */
const REFRESH_LOCK_STALE_MS = 20_000;
/** 等别的进程刷新的最长时间；比一个过期锁的寿命更长。 */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;
/** 单次授权服务器请求的上限：不响应的服务器不能一直占着锁。 */
const REFRESH_REQUEST_TIMEOUT_MS = 20_000;
/** 凭据库锁只在「读-合并-写」这一小段持有；等别的进程的最长时间远小于刷新锁。 */
const STORE_LOCK_WAIT_MS = 2_000;
/** pi 的 proper-lockfile 默认把超过 10 s 没续期的锁视为遗弃，这里保持一致。 */
const STORE_LOCK_STALE_MS = 10_000;
const STORE_LOCK_RETRY_MS = 20;

/** pi 存下的 OAuth 令牌（`expires_in` 是服务器原样返回的，`tokensExpireAt` 是绝对毫秒）。 */
export interface McpOAuthTokens {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
	scope?: string;
}

/** `mcp-auth.json` 里单个服务器的 OAuth 状态；只标注本模块用到的字段。 */
export interface McpOAuthState {
	tokens?: McpOAuthTokens;
	/** `tokens.access_token` 的绝对过期时间（epoch 毫秒）。 */
	tokensExpireAt?: number;
	clientInformation?: {
		client_id?: string;
		client_secret?: string;
		token_endpoint_auth_method?: string;
	};
	discovery?: {
		authorizationServerMetadata?: {
			token_endpoint?: string;
			token_endpoint_auth_methods_supported?: string[];
		};
		resourceMetadata?: { resource?: string };
	};
}

export type McpAuthStore = Record<string, McpOAuthState>;

/** 该 OAuth 服务器需要重新登录（没有可用的刷新令牌，或刷新被拒绝）。 */
export class McpOAuthSignInRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpOAuthSignInRequiredError";
	}
}

export interface McpAuthStoreOptions {
	/** 放着 `mcp-auth.json` 的 agent 目录；缺省用 pi 的口径（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）。 */
	agentDir?: string;
	/** 显式指定凭据库路径（测试用）；优先于 `agentDir`。 */
	storePath?: string;
}

export interface McpOAuthTokenOptions extends McpAuthStoreOptions {
	/** `mcp.json` 里配置的服务器名（是命名空间，不是工具名前缀）。 */
	name: string;
	serverUrl: string;
	/** 可注入（测试用）；缺省用全局 `fetch`。 */
	fetch?: typeof fetch;
	/** 可注入的时钟（测试用）；缺省 `Date.now`。 */
	now?: () => number;
}

export interface McpRefreshOptions extends McpOAuthTokenOptions {
	/**
	 * 调用方刚用（或刚读到）的 access token。库里已经换过就说明别的进程刷过了，直接用它的结果，
	 * 不再刷第二次 —— 刷新令牌会轮换，二次刷新会毁掉授权。
	 */
	staleToken?: string;
}

/** 缺省 agent 目录，与 `getGlobalMcpPath` 的解析顺序一致。 */
export function defaultMcpAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** pi 的 MCP 凭据库绝对路径。 */
export function getMcpAuthStorePath(options: McpAuthStoreOptions = {}): string {
	if (options.storePath) return options.storePath;
	return join(options.agentDir || defaultMcpAgentDir(), "mcp-auth.json");
}

/**
 * 凭据库键里用的 URL。pi 走 `new URL()` 归一化：`…/mcp` 与 `…/mcp/` 仍是不同的键，但
 * origin 上缺的斜杠会补成 `/`。
 */
function normalizeServerUrl(serverUrl: string): string {
	try {
		return String(new URL(serverUrl));
	} catch {
		return serverUrl;
	}
}

/** pi 从服务器名推导出的命名空间：连字符换成下划线（`mcp__my_server`）。 */
function mcpNamespace(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`;
}

/** 一个服务器的存储键：名字 + URL，同一 URL 上的两个账号各存各的。 */
export function mcpAuthStoreKey(name: string, serverUrl: string): string {
	return `${mcpNamespace(name)}|${normalizeServerUrl(serverUrl)}`;
}

/** 旧版本 pi 写的键（只有 URL）；照样读，下一次写入时被替换。 */
export function mcpAuthLegacyKey(serverUrl: string): string {
	return normalizeServerUrl(serverUrl);
}

/** 读整个凭据库；文件缺失或读不出来就当空库，绝不抛错。 */
export function readMcpAuthStore(options: McpAuthStoreOptions = {}): McpAuthStore {
	try {
		const parsed = JSON.parse(readFileSync(getMcpAuthStorePath(options), "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as McpAuthStore;
	} catch {
		/* missing or corrupt: behave like pi, an unauthenticated server */
	}
	return {};
}

/**
 * 按 pi 的格式写回（2 空格 JSON + 换行，仅本人可读写）—— pi 与本模块共用这一个文件。
 * 新建文件必须显式给 0600：默认的 0666 & umask 在常见 umask 下会写出 0644，凭据就变成可读了。
 */
export function writeMcpAuthStore(store: McpAuthStore, options: McpAuthStoreOptions = {}): void {
	writeAtomicSync(getMcpAuthStorePath(options), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** 单个服务器已存的状态：优先新键，回落旧版 URL 键。 */
export function loadMcpAuthState(options: McpAuthStoreOptions & { name: string; serverUrl: string }): {
	key: string;
	legacyKey: string;
	state: McpOAuthState | undefined;
} {
	const key = mcpAuthStoreKey(options.name, options.serverUrl);
	const legacyKey = mcpAuthLegacyKey(options.serverUrl);
	const store = readMcpAuthStore(options);
	return { key, legacyKey, state: store[key] ?? store[legacyKey] };
}

function isExpired(state: McpOAuthState, nowMs: number): boolean {
	const expireAt = state.tokensExpireAt;
	if (typeof expireAt !== "number") return false;
	return expireAt - MCP_REFRESH_SKEW_MS <= nowMs;
}

function lockPathFor(storePath: string, key: string): string {
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
	return `${storePath.replace(/mcp-auth\.json$/, "")}mcp-auth-refresh-${hash}.lock`;
}

/**
 * 用凭据库旁边的锁目录把跨进程刷新串行化 —— 名字与过期窗口都与 pi 的存储一致，因此 pi 与
 * pi-web-ui 的刷新不会同时发生。
 */
async function withRefreshLock<T>(storePath: string, key: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = lockPathFor(storePath, key);
	mkdirSync(join(lockPath, ".."), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lockPath);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue; // the holder released it in the meantime
			}
			if (Date.now() > deadline)
				throw new Error("Timed out waiting for the MCP refresh lock (another process is refreshing)");
			await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_RETRY_MS));
		}
	}
	// 刷新期间持续续期锁，慢的授权服务器不会被别人当成遗弃锁接管。
	const renewal = setInterval(
		() => {
			try {
				const now = new Date();
				utimesSync(lockPath, now, now);
			} catch {
				/* released under us: nothing to renew */
			}
		},
		Math.max(1_000, Math.floor(REFRESH_LOCK_STALE_MS / 4)),
	);
	renewal.unref?.();
	try {
		return await fn();
	} finally {
		clearInterval(renewal);
		rmSync(lockPath, { recursive: true, force: true });
	}
}

/**
 * 用 pi 自己的文件锁（`mcp-auth.json.lock`）保护整份凭据库的读-改-写。
 *
 * pi 的 `FileAuthStorageBackend.withLock` 对**每次**读写都用 proper-lockfile 锁住这个路径，
 * 所以我们也用同名目录锁，两边互斥。两条约束：
 *  - 锁只覆盖读、合并、写这一小段，**绝不跨网络请求** —— pi 抢锁只重试 10 × 20 ms，
 *    超时就抛错，会把 pi 自己的 MCP 调用拖挂；
 *  - mtime 超过 10 s 没续期就按遗弃处理（与 proper-lockfile 的默认 stale 一致），
 *    崩溃留下的空锁目录不会永久堵住 pi。
 */
async function withStoreLock<T>(storePath: string, fn: () => T): Promise<T> {
	const lockPath = `${storePath}.lock`;
	mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + STORE_LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > STORE_LOCK_STALE_MS) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue; // the holder released it in the meantime
			}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for the MCP credential store lock (${lockPath})`);
			await sleep(STORE_LOCK_RETRY_MS);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

interface RefreshResponseTokens extends McpOAuthTokens {
	access_token: string;
}

function parseTokenResponse(value: unknown, fallbackRefreshToken: string): RefreshResponseTokens {
	if (!value || typeof value !== "object") {
		throw new McpOAuthSignInRequiredError(
			"The authorization server answered the refresh with something that is not a JSON object",
		);
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.error === "string") {
		const description = typeof raw.error_description === "string" ? raw.error_description : String(raw.error);
		throw new McpOAuthSignInRequiredError(`The authorization server rejected the refresh token: ${description}`);
	}
	if (typeof raw.access_token !== "string" || !raw.access_token) {
		throw new McpOAuthSignInRequiredError("The authorization server answered the refresh without an access_token");
	}
	return {
		access_token: raw.access_token,
		// Servers that rotate refresh tokens send a new one; otherwise the grant keeps the old.
		refresh_token:
			typeof raw.refresh_token === "string" && raw.refresh_token ? raw.refresh_token : fallbackRefreshToken,
		token_type: typeof raw.token_type === "string" ? raw.token_type : undefined,
		expires_in: typeof raw.expires_in === "number" ? raw.expires_in : undefined,
		scope: typeof raw.scope === "string" ? raw.scope : undefined,
	};
}

function selectClientAuthMethod(state: McpOAuthState): "client_secret_basic" | "client_secret_post" | "none" {
	const information = state.clientInformation ?? {};
	const hinted = information.token_endpoint_auth_method;
	if (hinted === "client_secret_basic" || hinted === "client_secret_post" || hinted === "none") return hinted;
	return information.client_secret ? "client_secret_basic" : "none";
}

/**
 * 用存好的 refresh token 换新的 access token（RFC 6749 §6），客户端认证方式跟随注册时的选择。
 */
async function requestRefreshToken(state: McpOAuthState, options: McpRefreshOptions): Promise<RefreshResponseTokens> {
	const tokenEndpoint = state.discovery?.authorizationServerMetadata?.token_endpoint;
	const clientId = state.clientInformation?.client_id;
	const refreshToken = state.tokens?.refresh_token;
	if (!tokenEndpoint) {
		throw new McpOAuthSignInRequiredError("The stored credentials have no token endpoint; sign in again");
	}
	if (!clientId) {
		throw new McpOAuthSignInRequiredError("The stored credentials have no client_id; sign in again");
	}
	if (!refreshToken) {
		throw new McpOAuthSignInRequiredError("The stored credentials have no refresh token; sign in again");
	}

	const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
	const resource = state.discovery?.resourceMetadata?.resource ?? options.serverUrl;
	if (resource) params.set("resource", resource);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	};
	const method = selectClientAuthMethod(state);
	const secret = state.clientInformation?.client_secret;
	if (method === "client_secret_basic" && secret) {
		headers.Authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
	} else {
		params.set("client_id", clientId);
		if (method === "client_secret_post" && secret) params.set("client_secret", secret);
	}

	const doFetch = options.fetch ?? fetch;
	const timeout = AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await doFetch(tokenEndpoint, { method: "POST", headers, body: params.toString(), signal: timeout });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`MCP token refresh request failed: ${detail}`);
	}
	const text = await response.text().catch(() => "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	// OAuth servers may report errors with any status, so the body wins over the status code.
	if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
		return parseTokenResponse(parsed, refreshToken);
	}
	if (!response.ok) {
		throw new McpOAuthSignInRequiredError(`MCP token refresh failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
	}
	return parseTokenResponse(parsed, refreshToken);
}

/**
 * 强制刷新（401 之后，或 token 即将过期）并把结果落盘。返回新的 access token。
 * 带 `staleToken` 时，若库里已被别的进程换掉就直接用那个 token，不再刷第二次 —— 刷新令牌轮换后
 * 第二次尝试会失败。
 */
export async function refreshMcpAccessToken(options: McpRefreshOptions): Promise<string | null> {
	const storePath = getMcpAuthStorePath(options);
	const key = mcpAuthStoreKey(options.name, options.serverUrl);
	return withRefreshLock(storePath, key, async () => {
		const legacyKey = mcpAuthLegacyKey(options.serverUrl);
		const state = await withStoreLock(storePath, () => {
			const store = readMcpAuthStore(options);
			return store[key] ?? store[legacyKey];
		});
		if (!state?.tokens?.access_token && !state?.tokens?.refresh_token) {
			throw new McpOAuthSignInRequiredError(
				`MCP server "${options.name}" needs an OAuth sign-in (no stored credentials found)`,
			);
		}
		const storedToken = state?.tokens?.access_token;
		if (options.staleToken && storedToken && storedToken !== options.staleToken) {
			return storedToken; // refreshed by another process while we waited for the lock
		}
		if (!state) return null;
		// 网络请求期间不持任何锁：pi 可能同时写入别的服务器（甚至同一台）。
		const tokens = await requestRefreshToken(state, options);
		const nowMs = (options.now ?? Date.now)();
		const expiresAt = typeof tokens.expires_in === "number" ? nowMs + tokens.expires_in * 1000 : undefined;
		await withStoreLock(storePath, () => {
			// 重新读一遍再合并：刷新期间 pi 写的其它键（以及这台服务器的其它字段）不能被旧快照覆盖。
			const fresh = readMcpAuthStore(options);
			const base = fresh[key] ?? fresh[legacyKey] ?? state;
			const next: McpOAuthState = {
				...base,
				tokens: { ...base.tokens, ...trimUndefined(tokens) },
			};
			// 授权服务器没给 `expires_in` 时必须删掉旧的绝对过期时间：否则它一直是「已过期」，
			// 每个请求都会再走一次刷新（pi 的 provider 也是这么处理的）。
			if (expiresAt === undefined) delete next.tokensExpireAt;
			else next.tokensExpireAt = expiresAt;
			fresh[key] = next;
			if (legacyKey !== key) delete fresh[legacyKey];
			writeMcpAuthStore(fresh, options);
		});
		return tokens.access_token;
	});
}

function trimUndefined(tokens: McpOAuthTokens): McpOAuthTokens {
	const out: McpOAuthTokens = {};
	for (const [k, v] of Object.entries(tokens)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/**
 * 该发的 access token；这个服务器没有凭据（匿名服务器）时返回 `null`。
 * 即将过期的会先刷新；刷新失败则返回旧 token，交给服务器自己的 401 定论。
 */
export async function getMcpAccessToken(options: McpOAuthTokenOptions): Promise<string | null> {
	const { state } = loadMcpAuthState(options);
	const token = state?.tokens?.access_token;
	if (!state || !token) return null;
	if (!isExpired(state, (options.now ?? Date.now)())) return token;
	if (!state.tokens?.refresh_token) return token;
	try {
		return await refreshMcpAccessToken({ ...options, staleToken: token });
	} catch {
		return token;
	}
}
