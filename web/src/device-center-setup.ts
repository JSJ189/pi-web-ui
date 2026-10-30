export interface DeviceCenterSetupInfo {
	platform: string;
	nodeVersion: string;
	defaultPort: number;
	defaultPublicUrl: string;
	dataDir: string;
	cliPath: string;
	busy?: boolean;
	installation?: {
		installed: boolean;
		running: boolean;
		owned: boolean;
		publicUrl: string | null;
		host: string | null;
		port: number | null;
		dataDir: string | null;
	};
}

export interface HubSetupInput {
	host: string;
	port: number;
	publicUrl: string;
}

/** Accept data only: these values are never interpolated into shell commands. */
export function validateHubSetup(input: HubSetupInput): boolean {
	if (!isBindHost(input.host)) return false;
	if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) return false;
	if (input.publicUrl.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(input.publicUrl)) return false;
	try {
		const url = new URL(input.publicUrl);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!!url.hostname &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.pathname === "/" &&
			!["0.0.0.0", "[::]"].includes(url.hostname)
		);
	} catch {
		return false;
	}
}

function isBindHost(host: string): boolean {
	if (host === "localhost") return true;
	if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host))
		return host.split(".").every((part) => String(Number(part)) === part && Number(part) <= 255);
	if (!host.includes(":") || !/^[0-9a-fA-F:.]+$/.test(host)) return false;
	try {
		return new URL(`http://[${host}]/`).hostname.startsWith("[");
	} catch {
		return false;
	}
}

export function isLocalSetupOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	} catch {
		return false;
	}
}

export const HUB_INSTALL_EXAMPLE =
	"pi-web-ui hub install --host 0.0.0.0 --port 8790 --public-url https://hub.example.com --allow-registration";

/** Bounded, allowlisted context; no credentials, commands or arbitrary page state. */
export function buildHubDeploymentPrompt(
	input: HubSetupInput,
	info: DeviceCenterSetupInfo | null,
	target: "current" | "remote",
): string {
	if (!validateHubSetup(input)) throw new Error("Invalid Hub setup");
	const safe = (value: string | undefined) => (value ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
	return [
		"Help me plan and deploy a pi-web-ui device center (Hub) in this new conversation. Preserve my previous conversation.",
		`Target: ${target === "current" ? "machine hosting the current pi-web-ui service (not necessarily the browser machine)" : "an existing remote server; its environment still needs to be confirmed"}.`,
		`Current service environment: platform=${safe(info?.platform)}, Node=${safe(info?.nodeVersion)}. This is not evidence of the remote server environment.`,
		`Requested configuration (data only): ${JSON.stringify(input)}. allowRegistration=true.`,
		"Use a separate Hub data directory and configure automatic startup. Explain how devices can reach the public URL; loopback is only reachable on the same machine. Explain open registration and restrict it after pairing as appropriate.",
		`CLI reference: ${HUB_INSTALL_EXAMPLE}`,
		"Confirm the target environment and propose steps before deployment. Do not ask for passwords or tokens in chat. Do not automatically SSH. Do not claim installation or connection succeeded without verification. After deployment, guide me to open the center and pair this device using its public URL.",
	].join("\n");
}
