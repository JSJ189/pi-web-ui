import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, lstat, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "mac", "DesktopUse.swift");
let compiling;
let cacheDir;

function compile(signal) {
	return (async () => {
		const bytes = await readFile(source);
		const key = createHash("sha256").update(bytes).update(process.arch).digest("hex").slice(0, 20);
		if (!cacheDir) cacheDir = await mkdtemp(join(tmpdir(), "pi-desktop-use-"));
		const dir = cacheDir;
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077)
			throw new Error("Unsafe macOS helper cache directory");
		const binary = join(dir, `desktop-use-${key}`);
		const staging = `${binary}-${randomUUID()}`;
		const { access } = await import("node:fs/promises");
		try {
			await access(binary);
			return binary;
		} catch {}
		await new Promise((resolve, reject) => {
			execFile(
				"/usr/bin/xcrun",
				["swiftc", source, "-o", staging],
				{ timeout: 120000, signal, maxBuffer: 1024 * 1024 },
				(err, _out, stderr) => {
					if (err)
						reject(
							new Error(
								`macOS helper compilation failed. Install Apple Command Line Tools with xcode-select --install. ${String(stderr).slice(-1500)}`,
							),
						);
					else resolve();
				},
			);
		});
		try {
			await rename(staging, binary);
		} catch (err) {
			await rm(staging, { force: true });
			throw err;
		}
		return binary;
	})();
}

export async function runMac(op, fields = {}, { signal, timeout = 45000 } = {}) {
	signal?.throwIfAborted();
	if (!compiling)
		compiling = compile().catch((err) => {
			compiling = undefined;
			throw err;
		});
	const binary = await compiling;
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], signal });
		const decoder = new StringDecoder("utf8");
		let output = "",
			error = "",
			settled = false;
		const finish = (err, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error("macOS desktop operation timed out"));
		}, timeout);
		child.stdout.on("data", (buf) => {
			output += decoder.write(buf);
			if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
				child.kill();
				finish(new Error("macOS desktop output exceeds budget"));
			}
		});
		child.stderr.on("data", (buf) => {
			error = (error + buf.toString()).slice(-1500);
		});
		child.on("error", (err) => finish(err));
		child.stdin.on("error", (err) => finish(err));
		child.on("close", (code) => {
			try {
				if (code !== 0) throw new Error(`macOS helper exited ${code}: ${error}`);
				const result = JSON.parse(output + decoder.end());
				if (!result.ok) throw new Error(result.error || "macOS desktop operation failed");
				finish(null, result);
			} catch (err) {
				finish(err);
			}
		});
		child.stdin.end(JSON.stringify({ Op: op, ...fields }));
	});
}
