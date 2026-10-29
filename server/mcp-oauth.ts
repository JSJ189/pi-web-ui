/**
 * OAuth credentials for remote MCP servers (Issue #786).
 *
 * pi's built-in MCP integration signs in to OAuth-protected servers and keeps the result in
 * `<agent-dir>/mcp-auth.json`, keyed `mcp__<server>|<url>` (older versions wrote the bare URL as key;
 * such state is taken over here too). pi-web-ui's own bridge never signs in — it used to ignore those
 * credentials entirely, so every OAuth-protected server ended in `HTTP 401`.
 *
 * This module shares pi's store instead of adding a second one:
 *  - read the stored access token and send it as `Authorization: Bearer …`;
 *  - refresh it with the stored refresh token when it is about to expire, or after a 401;
 *  - write the refreshed tokens back in pi's format, under the same refresh lock as pi.
 *
 * Sign-in itself (authorization code + PKCE + browser callback) stays with `pi mcp login <server>`
 * until pi-web-ui gets a sign-in UI of its own; see Issue #786 for that follow-up.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

/** Access tokens this close to expiry are refreshed before they are sent (pi uses the same skew). */
export const MCP_REFRESH_SKEW_MS = 30_000;
/** A refresh held longer than this is considered abandoned (its owner was killed) and is taken over. */
const REFRESH_LOCK_STALE_MS = 20_000;
/** How long to wait for another process's refresh; longer than a stale lock lives. */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;
/** Bounds a single request to the authorization server, so an unresponsive one cannot hold the lock. */
const REFRESH_REQUEST_TIMEOUT_MS = 20_000;

/** OAuth tokens as stored by pi (`expires_in` is what the server returned, `tokensExpireAt` is absolute ms). */
export interface McpOAuthTokens {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
	scope?: string;
}

/** Per-server OAuth state in `mcp-auth.json`. Only the fields this module needs are typed. */
export interface McpOAuthState {
	tokens?: McpOAuthTokens;
	/** Absolute expiry of `tokens.access_token` in epoch milliseconds. */
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

/** The OAuth-protected server needs a sign-in (no usable refresh token, or the refresh was rejected). */
export class McpOAuthSignInRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpOAuthSignInRequiredError";
	}
}

export interface McpAuthStoreOptions {
	/** Agent directory holding `mcp-auth.json`; defaults to pi's (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
	agentDir?: string;
	/** Explicit store path, for tests. Wins over `agentDir`. */
	storePath?: string;
}

export interface McpOAuthTokenOptions extends McpAuthStoreOptions {
	/** Server name as configured in `mcp.json` (the namespace, not the tool prefix). */
	name: string;
	serverUrl: string;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Injectable clock for tests; defaults to `Date.now`. */
	now?: () => number;
}

export interface McpRefreshOptions extends McpOAuthTokenOptions {
	/**
	 * The access token the caller just used (or read). When the stored token already changed, another
	 * process refreshed it, and its result is used instead of a second refresh — refresh tokens rotate.
	 */
	staleToken?: string;
}

/** Default agent directory, matching `getGlobalMcpPath`'s resolution order. */
export function defaultMcpAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Absolute path of pi's MCP credential store. */
export function getMcpAuthStorePath(options: McpAuthStoreOptions = {}): string {
	if (options.storePath) return options.storePath;
	return join(options.agentDir || defaultMcpAgentDir(), "mcp-auth.json");
}

/**
 * URL as used in the store key. pi normalizes through `new URL()`, so `…/mcp` and `…/mcp/` stay
 * different keys but a missing trailing slash on an origin becomes `/`.
 */
function normalizeServerUrl(serverUrl: string): string {
	try {
		return String(new URL(serverUrl));
	} catch {
		return serverUrl;
	}
}

/** Namespace pi derives from a server name: dashes become underscores (`mcp__my_server`). */
function mcpNamespace(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`;
}

/** Store key of a server: name and URL, so two accounts on one URL stay separate. */
export function mcpAuthStoreKey(name: string, serverUrl: string): string {
	return `${mcpNamespace(name)}|${normalizeServerUrl(serverUrl)}`;
}

/** Key older pi versions wrote (URL only); still read, and replaced on the next write. */
export function mcpAuthLegacyKey(serverUrl: string): string {
	return normalizeServerUrl(serverUrl);
}

/** Read the whole store; a missing or unreadable file is an empty store, never an error. */
export function readMcpAuthStore(options: McpAuthStoreOptions = {}): McpAuthStore {
	try {
		const parsed = JSON.parse(readFileSync(getMcpAuthStorePath(options), "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as McpAuthStore;
	} catch {
		/* missing or corrupt: behave like pi, an unauthenticated server */
	}
	return {};
}

/** Write the store in pi's format (2-space JSON + newline, owner-only) — pi and this module share it. */
export function writeMcpAuthStore(store: McpAuthStore, options: McpAuthStoreOptions = {}): void {
	writeJsonAtomicSync(getMcpAuthStorePath(options), store, 2);
}

/** Stored state of one server, preferring the current key and falling back to the legacy URL key. */
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
 * Serialize refreshes across processes with a lock directory next to the store — the same name and
 * staleness window pi's store uses, so a refresh from pi and one from pi-web-ui cannot both run.
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
			if (Date.now() > deadline) throw new Error("MCP 刷新令牌锁等待超时（另一个进程正在刷新）");
			await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_RETRY_MS));
		}
	}
	// Keep the lock fresh while the refresh runs, so a slow authorization server is not taken over.
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

interface RefreshResponseTokens extends McpOAuthTokens {
	access_token: string;
}

function parseTokenResponse(value: unknown, fallbackRefreshToken: string): RefreshResponseTokens {
	if (!value || typeof value !== "object") {
		throw new McpOAuthSignInRequiredError("MCP 授权服务器的刷新应答不是 JSON 对象");
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.error === "string") {
		const description = typeof raw.error_description === "string" ? raw.error_description : String(raw.error);
		throw new McpOAuthSignInRequiredError(`MCP 刷新令牌被授权服务器拒绝：${description}`);
	}
	if (typeof raw.access_token !== "string" || !raw.access_token) {
		throw new McpOAuthSignInRequiredError("MCP 授权服务器的刷新应答里没有 access_token");
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
 * Exchange the stored refresh token for a new access token (RFC 6749 §6), picking client
 * authentication the way the authorization server's registration did.
 */
async function requestRefreshToken(state: McpOAuthState, options: McpRefreshOptions): Promise<RefreshResponseTokens> {
	const tokenEndpoint = state.discovery?.authorizationServerMetadata?.token_endpoint;
	const clientId = state.clientInformation?.client_id;
	const refreshToken = state.tokens?.refresh_token;
	if (!tokenEndpoint) {
		throw new McpOAuthSignInRequiredError("MCP 凭据里没有授权服务器令牌端点，需要重新登录");
	}
	if (!clientId) {
		throw new McpOAuthSignInRequiredError("MCP 凭据里没有 client_id，需要重新登录");
	}
	if (!refreshToken) {
		throw new McpOAuthSignInRequiredError("MCP 凭据里没有刷新令牌，需要重新登录");
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
		throw new Error(`MCP 刷新令牌请求失败：${detail}`);
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
		throw new McpOAuthSignInRequiredError(`MCP 刷新令牌失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
	}
	return parseTokenResponse(parsed, refreshToken);
}

/**
 * Force a refresh (after a 401, or for a token that is about to expire) and persist the result.
 * Returns the new access token. With `staleToken` set, a token that another process already replaced
 * is used as-is instead of refreshing twice — a rotated refresh token makes the second attempt fail.
 */
export async function refreshMcpAccessToken(options: McpRefreshOptions): Promise<string | null> {
	const storePath = getMcpAuthStorePath(options);
	const key = mcpAuthStoreKey(options.name, options.serverUrl);
	return withRefreshLock(storePath, key, async () => {
		const store = readMcpAuthStore(options);
		const legacyKey = mcpAuthLegacyKey(options.serverUrl);
		const state = store[key] ?? store[legacyKey];
		if (!state?.tokens?.access_token && !state?.tokens?.refresh_token) {
			throw new McpOAuthSignInRequiredError(`MCP 服务器「${options.name}」需要 OAuth 登录（找不到已保存的凭据）`);
		}
		const storedToken = state?.tokens?.access_token;
		if (options.staleToken && storedToken && storedToken !== options.staleToken) {
			return storedToken; // refreshed by another process while we waited for the lock
		}
		if (!state) return null;
		const tokens = await requestRefreshToken(state, options);
		const nowMs = (options.now ?? Date.now)();
		const expireAt = typeof tokens.expires_in === "number" ? nowMs + tokens.expires_in * 1000 : undefined;
		const next: McpOAuthState = {
			...state,
			tokens: { ...state.tokens, ...trimUndefined(tokens) },
			...(expireAt === undefined ? {} : { tokensExpireAt: expireAt }),
		};
		store[key] = next;
		if (legacyKey !== key) delete store[legacyKey];
		writeMcpAuthStore(store, options);
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
 * The access token to send, or `null` when this server has no stored credentials (anonymous server).
 * A token that is about to expire is refreshed; when that fails the old token is returned, so the
 * server's own 401 decides what happens next.
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
