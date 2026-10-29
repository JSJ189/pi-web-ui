import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, relative, isAbsolute } from "node:path";
import { writeAtomicSync } from "../atomic-file.js";

export const DESKTOP_SETUP_LIMITS = Object.freeze({ installMs: 120_000, logBytes: 4096, probeMs: 1000 });
export const DESKTOP_INSTALL_ARGS = Object.freeze([
	"install",
	"--no-save",
	"--package-lock=false",
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
	"@novnc/novnc@1.7.0",
]);
export type DesktopInstaller = (directory: string, signal: AbortSignal) => Promise<void>;

/** Find npm's JavaScript entrypoint; never execute npm.cmd through a shell. */
export function desktopNpmCli(): string {
	const directories = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)];
	for (const directory of directories) {
		for (const candidate of [
			join(directory, "node_modules/npm/bin/npm-cli.js"),
			join(directory, "../lib/node_modules/npm/bin/npm-cli.js"),
			join(directory, "npm"),
		]) {
			try {
				const file = realpathSync(candidate);
				if (file.endsWith(`${process.platform === "win32" ? "\\" : "/"}npm-cli.js`)) return file;
			} catch {
				/* Try the next fixed npm location. */
			}
		}
	}
	throw new Error("npm CLI unavailable");
}

/** Output is deliberately discarded: npm errors may contain registry credentials. */
export const installDesktopAssets: DesktopInstaller = async (directory, signal) => {
	const cli = desktopNpmCli();
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	const config = join(directory, "npm-empty-config");
	writeFileSync(config, "", { mode: 0o600 });
	env.npm_config_userconfig = config;
	env.npm_config_globalconfig = config;
	env.npm_config_cache = join(directory, "npm-cache");
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cli, ...DESKTOP_INSTALL_ARGS], {
			cwd: directory,
			env,
			shell: false,
			windowsHide: true,
			stdio: "ignore",
		});
		const abort = () => {
			child.kill();
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		child.once("error", () => {
			signal.removeEventListener("abort", abort);
			reject(new Error("npm could not start"));
		});
		child.once("close", (code) => {
			signal.removeEventListener("abort", abort);
			if (code === 0 && !signal.aborted) {
				try {
					const root = realpathSync(directory);
					const file = realpathSync(join(directory, "node_modules/@novnc/novnc/core/rfb.js"));
					const rel = relative(root, file);
					if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(file).isFile())
						throw new Error("Invalid package");
					resolvePromise();
				} catch {
					reject(new Error("Installed browser components missing"));
				}
			} else reject(new Error("npm installation failed"));
		});
	});
};

const installations = new Set<string>();
export function createDesktopSetup(options: {
	dataDir?: string;
	environmentEnabled: boolean;
	installer?: DesktopInstaller;
	installMs?: number;
}) {
	const dataDir = resolve(options.dataDir ?? join(homedir(), ".pi-web"));
	const runtimeDir = join(dataDir, "desktop-runtime");
	const settingsFile = join(dataDir, "desktop-settings.json");
	let storedEnabled = false;
	try {
		const parsed = JSON.parse(readFileSync(settingsFile, "utf8"));
		storedEnabled = parsed?.enabled === true;
	} catch {
		/* Missing or unreadable settings fail closed. */
	}
	let closed = false;
	let controller: AbortController | undefined;
	let installation: { state: "idle" | "running" | "succeeded" | "failed"; log: string } = { state: "idle", log: "" };
	return {
		runtimeDir,
		get enabled() {
			return options.environmentEnabled || storedEnabled;
		},
		get installation() {
			return { ...installation };
		},
		setEnabled(enabled: boolean) {
			if (closed) throw new Error("Desktop setup closed");
			// Synchronous commit serializes writes within the supported single server process.
			writeAtomicSync(settingsFile, JSON.stringify({ enabled }) + "\n", { mode: 0o600 });
			storedEnabled = enabled;
		},
		install() {
			if (closed) throw new Error("Desktop setup closed");
			if (installations.has(runtimeDir)) return false;
			mkdirSync(runtimeDir, { recursive: true });
			// Establish an isolated package root so npm never selects a repository ancestor.
			if (!existsSync(join(runtimeDir, "package.json")))
				writeAtomicSync(join(runtimeDir, "package.json"), '{"name":"pi-desktop-runtime","private":true}\n', {
					mode: 0o600,
				});
			installations.add(runtimeDir);
			const current = new AbortController();
			controller = current;
			installation = { state: "running", log: "Installing noVNC 1.7.0 browser components." };
			const timer = setTimeout(() => current.abort(), options.installMs ?? DESKTOP_SETUP_LIMITS.installMs);
			timer.unref();
			void Promise.resolve()
				.then(() => {
					if (current.signal.aborted) throw new Error("Cancelled");
					return (options.installer ?? installDesktopAssets)(runtimeDir, current.signal);
				})
				.then(() => {
					if (closed || current.signal.aborted) throw new Error("Cancelled");
					installation = {
						state: "succeeded",
						log: "Browser components installed. Configure the operating system VNC service separately.",
					};
				})
				.catch(() => {
					installation = {
						state: "failed",
						log: current.signal.aborted
							? "Installation cancelled or timed out."
							: "Installation failed. Check local npm availability and network access, then retry.",
					};
				})
				.finally(() => {
					clearTimeout(timer);
					installations.delete(runtimeDir);
					if (controller === current) controller = undefined;
				});
			return true;
		},
		close() {
			closed = true;
			controller?.abort();
		},
	};
}

/** Only call with the literal loopback endpoint already validated by desktop.ts. */
export function probeDesktopVnc(host: string, port: number): Promise<boolean> {
	if (!["127.0.0.1", "::1"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535)
		return Promise.resolve(false);
	return new Promise((resolveProbe) => {
		const socket = createConnection({ host, port });
		const finish = (value: boolean) => {
			socket.destroy();
			resolveProbe(value);
		};
		socket.setTimeout(DESKTOP_SETUP_LIMITS.probeMs, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
