import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../bin/pi-web-ui.mjs", import.meta.url), "utf8");

/** Evaluate the actual CLI functions, not copies, without its main() or real sudo/systemctl calls. */
function functionSource(name: string): string {
	const start = source.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`Missing CLI function: ${name}`);
	const end = source.indexOf("\n}", start);
	if (end < 0) throw new Error(`Missing function terminator: ${name}`);
	return source.slice(start, end + 2);
}

type Env = Record<string, string | undefined>;
interface Options {
	print?: boolean;
	port?: string;
	cwd?: string;
	name?: string;
	host?: string;
}
interface Invocation {
	command: string;
	args: string[];
	options: { input?: string; stdio: string | string[] };
}
interface Cli {
	installSystemd(opts: Options): void;
	buildUnit(cwd: string, env: Record<string, string>): string;
}
function harness(env: Env = {}, uid = 1000, failure?: { status: number | null; error?: Error }) {
	const calls: Invocation[] = [];
	const output: string[] = [];
	const writtenFiles = new Map<string, { content: string; options?: unknown }>();
	const removedFiles: string[] = [];
	const names = [
		"isZhLang",
		"systemdQuote",
		"systemdPath",
		"buildUnit",
		"systemdUnitPath",
		"effectivePort",
		"serviceOptions",
		"serviceEnv",
		"runSystemdRoot",
		"installSystemd",
	];
	const cli = runInNewContext(
		`${names.map(functionSource).join("\n")}\nconst ZH = isZhLang();
({ installSystemd, buildUnit })`,
		{
			process: {
				env: { PATH: "/home/installer/bin:/usr/bin", LANG: "C.UTF-8", ...env },
				pid: 1000,
				getuid: () => uid,
				exit: (code: number) => {
					throw new Error(`exit:${code}`);
				},
			},
			userInfo: () => ({ username: uid === 0 ? "root" : "installer" }),
			homedir: () => "/home/installer",
			tmpdir: () => "/tmp",
			join: posix.join,
			writeFileSync: (path: string, content: string, options?: unknown) => {
				writtenFiles.set(path, { content, options });
			},
			rmSync: (path: string) => {
				removedFiles.push(path);
			},
			resolve: posix.resolve,
			existsSync: () => true,
			isWin: false,
			NODE: "/home/installer/node/bin/node",
			SERVER_ENTRY: "/home/installer/pkg/dist/server/index.js",
			// 「优先用全局 pi SDK」钩子（issue #260）——buildUnit 会把它当 --import 写进 ExecStart。
			SDK_HOOK: "/home/installer/pkg/dist/server/resolve-global-sdk.js",
			HAS_SDK_HOOK: true,
			console: { log: (value: string) => output.push(value) },
			fail: (message: string) => {
				throw new Error(message);
			},
			spawnSync: (command: string, args: string[], options: Invocation["options"]) => {
				calls.push({ command, args: Array.from(args), options });
				return failure ?? { status: 0 };
			},
		},
	) as Cli;
	return { cli, calls, output, writtenFiles, removedFiles };
}

function environment(unit: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of unit.split("\n")) {
		if (!line.startsWith("Environment=")) continue;
		// Generated C-style escapes are a subset of JSON escapes; undo systemd %% specifiers too.
		const assignment: string = JSON.parse(line.slice("Environment=".length));
		const split = assignment.indexOf("=");
		result[assignment.slice(0, split)] = assignment.slice(split + 1).replace(/%%/g, "%");
	}
	return result;
}

describe("Linux systemd installation", () => {
	it("prints the actual Linux CLI configuration without running privileged commands", () => {
		const cliUrl = new URL("../../bin/pi-web-ui.mjs", import.meta.url).href;
		const script = `
			import cp from 'node:child_process';
			import { syncBuiltinESMExports } from 'node:module';
			cp.spawnSync = () => { throw new Error('Unexpected external command during --print'); };
			syncBuiltinESMExports();
			Object.defineProperty(process, 'platform', { value: 'linux' });
			process.argv = [process.execPath, 'pi-web-ui', 'server', 'install', '--print', '--cwd', ${JSON.stringify(tmpdir())}];
			await import(${JSON.stringify(cliUrl)});
		`;
		const unit = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				LANG: "C.UTF-8",
				PI_WEB_PORT: "80",
				PI_WEB_HOST: "0.0.0.0",
				PI_WEB_TOKEN: "cli-test-token",
			},
		});
		expect(unit).toContain("CapabilityBoundingSet=CAP_NET_BIND_SERVICE");
		expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
		expect(environment(unit)).toMatchObject({
			PI_WEB_PORT: "80",
			PI_WEB_HOST: "0.0.0.0",
			PI_WEB_TOKEN: "cli-test-token",
		});
	});
	it("ExecStart 带上「优先用全局 pi SDK」钩子（issue #260）", () => {
		const h = harness({ PI_WEB_PORT: "8787" });
		h.cli.installSystemd({ print: true });
		const unit = h.output[0] ?? "";
		// 钩子必须在服务入口之前作为 --import 传入，否则它无法抢在 SDK 静态 import 之前生效。
		expect(unit).toContain(
			`ExecStart="/home/installer/node/bin/node" --import "/home/installer/pkg/dist/server/resolve-global-sdk.js" "/home/installer/pkg/dist/server/index.js"`,
		);
	});
	it.each(["1", "80", "443", "1023"])("grants only CAP_NET_BIND_SERVICE for port %s", (port) => {
		const h = harness({ PI_WEB_PORT: port, PI_WEB_HOST: "0.0.0.0", PI_WEB_TOKEN: "test-only-token" });
		h.cli.installSystemd({ print: true });
		const unit = h.output[0];
		expect(unit).toContain("CapabilityBoundingSet=CAP_NET_BIND_SERVICE\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n");
		expect(unit).toContain("User=installer\n");
		expect(environment(unit)).toMatchObject({
			PI_WEB_PORT: port,
			PI_WEB_HOST: "0.0.0.0",
			PI_WEB_TOKEN: "test-only-token",
			PI_WEB_CWD: "/home/installer",
		});
		expect(h.calls).toEqual([]); // --print never elevates or changes a service.
	});
	it.each(["1024", "8787", "65535"])("does not grant capabilities for port %s", (port) => {
		const h = harness({ PI_WEB_PORT: port });
		h.cli.installSystemd({ print: true });
		expect(h.output[0]).not.toContain("Capabilities=");
		expect(h.output[0]).not.toContain("CapabilityBoundingSet=");
		expect(environment(h.output[0])).not.toHaveProperty("PI_WEB_TOKEN");
	});
	it("honors flags over environment values", () => {
		const h = harness({ PI_WEB_PORT: "80", PI_WEB_HOST: "0.0.0.0" });
		h.cli.installSystemd({ print: true, port: "9000", host: "127.0.0.1", cwd: "/srv/project" });
		expect(h.output[0]).not.toContain("AmbientCapabilities=");
		expect(environment(h.output[0])).toMatchObject({
			PI_WEB_PORT: "9000",
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_CWD: "/srv/project",
		});
	});
	it("escapes whitespace, quotes, backslashes, percent specifiers and line breaks without unit injection", () => {
		const token = 'test "quoted" \\ %n %% $HOME\t\nRestart=no\r尾';
		const h = harness({ PI_WEB_TOKEN: token });
		h.cli.installSystemd({ print: true, cwd: "/srv/space and %n" });
		const unit = h.output[0];
		expect(environment(unit).PI_WEB_TOKEN).toBe(token);
		expect(unit).toContain("WorkingDirectory=/srv/space and %%n");
		expect(
			unit.split("\n").filter((line) => line.startsWith("Environment=") && line.includes("PI_WEB_TOKEN=")),
		).toHaveLength(1);
		expect(unit.split("\n")).not.toContain("Restart=no");
	});
	it("uses the same captured unit for --print and installation without putting the token in argv or success logs", () => {
		const env = {
			PI_WEB_PORT: "80",
			PI_WEB_HOST: "0.0.0.0",
			PI_WEB_TOKEN: "test-only-sensitive-value",
			PI_WEB_CWD: "/home/installer/project",
			PI_WEB_DATA_DIR: "/home/installer/data",
			PI_WEB_ENGINE: "dsh",
			PI_CODING_AGENT_DIR: "/home/installer/agent",
		};
		const preview = harness(env);
		preview.cli.installSystemd({ print: true });
		const h = harness(env);
		h.cli.installSystemd({});
		expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
			[
				"sudo",
				"--",
				"install",
				"-m",
				"600",
				"/tmp/pi-web-ui-pi-web-ui-1000.service",
				"/etc/systemd/system/pi-web-ui.service",
			],
			["sudo", "--", "systemctl", "daemon-reload"],
			["sudo", "--", "systemctl", "enable", "pi-web-ui.service"],
			["sudo", "--", "systemctl", "restart", "pi-web-ui.service"],
		]);
		const staged = "/tmp/pi-web-ui-pi-web-ui-1000.service";
		const stagedFile = h.writtenFiles.get(staged);
		expect(stagedFile).toBeDefined();
		expect(stagedFile?.options).toEqual({ mode: 0o600 });
		expect(h.removedFiles).toContain(staged);
		const unit = stagedFile!.content;
		expect(preview.output[0]).toBe(`# /etc/systemd/system/pi-web-ui.service\n${unit}`);
		expect(h.calls[0].options.stdio).toBe("inherit");
		expect(environment(unit)).toMatchObject({ ...env, PATH: "/home/installer/bin:/usr/bin" });
		expect(JSON.stringify(h.calls.map((c) => c.args))).not.toContain(env.PI_WEB_TOKEN);
		expect(h.output.join("\n")).not.toContain(env.PI_WEB_TOKEN);
	});
	it("runs privileged commands directly as root and retains SUDO_USER", () => {
		const h = harness({ SUDO_USER: "installer", PI_WEB_TOKEN: "test-only-token" }, 0);
		h.cli.installSystemd({ name: "custom" });
		expect(h.calls[0].command).toBe("install");
		expect(h.calls[0].args.at(-1)).toBe("/etc/systemd/system/custom.service");
		const staged = h.calls[0].args[2];
		expect(h.writtenFiles.get(staged)?.content).toContain("User=installer");
		expect(h.removedFiles).toContain(staged);
		expect(h.calls.at(-1)?.args).toEqual(["restart", "custom.service"]);
	});
	it("preserves an explicitly empty token", () => {
		const h = harness({ PI_WEB_TOKEN: "" });
		h.cli.installSystemd({ print: true });
		expect(environment(h.output[0]).PI_WEB_TOKEN).toBe("");
	});
	it("stops without systemctl side effects when installation fails", () => {
		const h = harness({}, 1000, { status: 1 });
		expect(() => h.cli.installSystemd({})).toThrow("exit:1");
		expect(h.calls).toHaveLength(1);
	});
	it("reports a missing sudo/install executable rather than claiming success", () => {
		const h = harness({}, 1000, { status: null, error: new Error("ENOENT") });
		expect(() => h.cli.installSystemd({})).toThrow("ENOENT");
		expect(h.calls).toHaveLength(1);
	});
});
