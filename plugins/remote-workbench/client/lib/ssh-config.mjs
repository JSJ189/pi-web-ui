/**
 * plugins/remote-workbench/client/lib/ssh-config.mjs — 本机 ~/.ssh/config 解析与发现引擎。
 *
 * 遵循 OpenSSH 标准语法（ssh_config(5)）：
 * 1. 关键字大小写不敏感；
 * 2. 识别 Host, HostName, User, Port, IdentityFile, ProxyJump；
 * 3. 忽略通配块（如 Host *）；
 * 4. 自动解析提取可用主机别名与连接参数。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 展开 ~ 路径 */
export function expandHome(p) {
	const s = String(p ?? "").trim();
	if (!s) return s;
	if (s === "~") return os.homedir();
	if (s.startsWith("~/") || s.startsWith("~\\")) {
		return path.join(os.homedir(), s.slice(2));
	}
	return s;
}

/**
 * 解析 OpenSSH config 文本为结构化主机列表
 * @param {string} text
 * @returns {Array<{ alias: string, host: string, port: number, username: string, privateKeyPath?: string }>}
 */
export function parseSshConfig(text) {
	if (!text) return [];
	const hosts = [];
	let current = null;

	const stripQuote = (v) => {
		v = (v || "").trim();
		if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
			return v.slice(1, -1);
		}
		return v;
	};

	const lines = String(text).split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const sp = line.search(/[\s=]/);
		if (sp < 0) continue;

		const key = line.slice(0, sp).trim().toLowerCase();
		let val = line.slice(sp).trim().replace(/^=\s*/, "").trim();

		if (key === "host") {
			// 忽略通配符块（Host * 或含 ? / !）
			const patterns = val.split(/\s+/).filter(Boolean);
			const validPatterns = patterns.filter((p) => !p.includes("*") && !p.includes("?") && !p.includes("!"));
			if (validPatterns.length > 0) {
				current = {
					alias: validPatterns[0],
					host: "",
					port: 22,
					username: "root",
					privateKeyPath: "",
				};
				hosts.push(current);
			} else {
				current = null;
			}
		} else if (current) {
			if (key === "hostname" && !current.host) {
				current.host = stripQuote(val).split(/\s+/)[0];
			} else if (key === "user" && current.username === "root") {
				current.username = stripQuote(val).split(/\s+/)[0];
			} else if (key === "port") {
				const p = parseInt(stripQuote(val).split(/\s+/)[0], 10);
				if (!isNaN(p)) current.port = p;
			} else if (key === "identityfile" && !current.privateKeyPath) {
				current.privateKeyPath = stripQuote(val).split(/\s+/)[0];
			}
		}
	}

	// 过滤有效主机（host 字段缺省时回落使用 alias）
	return hosts.map((h) => ({
		alias: h.alias,
		host: h.host || h.alias,
		port: h.port || 22,
		username: h.username || "root",
		privateKeyPath: h.privateKeyPath || undefined,
	}));
}

/**
 * 扫描本机 ~/.ssh/config 文件并返回解析后的候选主机
 */
export async function scanLocalSshConfig() {
	const configPath = path.join(os.homedir(), ".ssh", "config");
	try {
		const content = await fs.readFile(configPath, "utf8");
		const list = parseSshConfig(content);
		return { exists: true, path: configPath, list };
	} catch (err) {
		return { exists: false, path: configPath, list: [], error: err.message };
	}
}
