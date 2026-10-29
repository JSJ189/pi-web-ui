/**
 * 宿主插件重资产流水线（Heavy Asset Pipeline）：
 *
 * 为插件提供体系化的重型依赖/二进制资产生命周期管理：
 * 1. 规范化资产声明与探测（存在即秒过）；
 * 2. 多源候选与国内透明镜像自动回落（GitHub Release -> 镜像加速）；
 * 3. 并发防重入单例锁（同资产并发请求安全合并）；
 * 4. SHA-256 流式强完整性验签（防篡改与坏包解压）；
 * 5. Staging 隔离解压与原子安全替换；
 * 6. 细粒度下载进度透传与日志归因。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface PluginAssetSpec {
	/** 资产唯一标识，如 "univer-runtime" */
	id: string;
	/** 解压落盘的目标目录（相对 pluginDir 或绝对路径，如 "artifacts"） */
	targetDir: string;
	/** 候选下载 URL 列表，按顺序优先尝试 */
	urls: string[];
	/** 预期 SHA-256 校验和（小写 hex），若提供则在解压前强制验签 */
	sha256?: string;
	/** 标志文件（相对 targetDir），若已存在且有效则视为已就绪，如 "gateway.cjs" */
	testFile?: string;
	/** 预估文件字节大小（用于无 Content-Length 时的进度估算） */
	size?: number;
	/** 资产简要描述，如 "Univer 核心渲染引擎" */
	description?: string;
}

export interface PluginAssetProgress {
	downloaded: number;
	total: number;
	percent: number;
	url: string;
}

export interface PluginAssetStatus {
	ready: boolean;
	downloading: boolean;
	progress: number;
	downloaded: number;
	total: number;
	error: string | null;
}

export interface PluginAssetResult {
	ok: boolean;
	targetDir: string;
	cached?: boolean;
	sha256?: string;
	error?: string;
}

export interface EnsureAssetOptions {
	onProgress?: (progress: PluginAssetProgress) => void;
	timeoutMs?: number;
	signal?: AbortSignal;
	log?: (msg: string) => void;
}

// 模块级并发单例锁：Key 为 `pluginDir:assetId`
const activeAssetPromises = new Map<string, Promise<PluginAssetResult>>();
const assetProgressState = new Map<string, PluginAssetStatus>();

/**
 * 构建多源候选 URL 列表：
 * 1. 用户自定义环境变量（PI_WEB_ASSET_MIRROR）优先拼装；
 * 2. 保留原 Spec 列表；
 * 3. 若含 GitHub 官方 Release，自动追加国内知名稳定加速镜像（如 ghfast.top）。
 */
export function buildAssetCandidateUrls(specUrls: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();

	function push(u: string | undefined | null) {
		if (!u) return;
		const trimmed = u.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		out.push(trimmed);
	}

	const mirrorPrefix = process.env.PI_WEB_ASSET_MIRROR?.trim();

	for (const url of specUrls) {
		if (!url) continue;
		// 用户自定义镜像前缀置顶
		if (mirrorPrefix) {
			const prefix = mirrorPrefix.endsWith("/") ? mirrorPrefix : `${mirrorPrefix}/`;
			if (url.startsWith("http://") || url.startsWith("https://")) {
				push(`${prefix}${url}`);
			}
		}

		// 官方直链
		push(url);

		// 若为 GitHub 链接且未关闭镜像，自动追加通用透明反代镜像回落
		if (
			process.env.PI_WEB_ASSET_AUTO_MIRROR !== "0" &&
			process.env.PI_WEB_ASSET_AUTO_MIRROR !== "false" &&
			(url.includes("github.com/") || url.includes("githubusercontent.com/"))
		) {
			push(`https://ghfast.top/${url}`);
		}
	}

	return out;
}

/** 规范化目标绝对路径 */
export function resolveTargetDir(pluginDir: string, targetDir: string): string {
	return isAbsolute(targetDir) ? resolve(targetDir) : resolve(pluginDir, targetDir);
}

/** 查询指定资产在本地的就绪状态与实时进度 */
export function getPluginAssetStatus(pluginDir: string, spec: PluginAssetSpec): PluginAssetStatus {
	const absTarget = resolveTargetDir(pluginDir, spec.targetDir);
	const lockKey = `${pluginDir}:${spec.id}`;
	const current = assetProgressState.get(lockKey);

	const isReady = spec.testFile ? existsSync(join(absTarget, spec.testFile)) : existsSync(absTarget);

	return {
		ready: isReady,
		downloading: Boolean(current?.downloading),
		progress: current?.progress ?? (isReady ? 100 : 0),
		downloaded: current?.downloaded ?? 0,
		total: current?.total ?? spec.size ?? 0,
		error: current?.error ?? null,
	};
}

/**
 * 确保资产就绪：
 * 若本地已就绪则秒级通过；否则进入流式多源下载、SHA-256 验签、Staging 解压替换流水线。
 */
export async function ensurePluginAsset(
	pluginDir: string,
	spec: PluginAssetSpec,
	opts: EnsureAssetOptions = {},
): Promise<PluginAssetResult> {
	const absTarget = resolveTargetDir(pluginDir, spec.targetDir);
	const lockKey = `${pluginDir}:${spec.id}`;

	// 1. 检查本地已有状态
	const readyNow = spec.testFile ? existsSync(join(absTarget, spec.testFile)) : existsSync(absTarget);
	if (readyNow) {
		return { ok: true, targetDir: absTarget, cached: true };
	}

	// 2. 并发合并锁：避免前台并发请求多次写盘
	const inFlight = activeAssetPromises.get(lockKey);
	if (inFlight) {
		return await inFlight;
	}

	const promise = (async (): Promise<PluginAssetResult> => {
		const log = opts.log ?? ((m: string) => console.log(`[asset:${spec.id}] ${m}`));
		const candidateUrls = buildAssetCandidateUrls(spec.urls);
		if (candidateUrls.length === 0) {
			throw new Error(`未为资产 ${spec.id} 配置有效的下载源`);
		}

		const status: PluginAssetStatus = {
			ready: false,
			downloading: true,
			progress: 0,
			downloaded: 0,
			total: spec.size ?? 0,
			error: null,
		};
		assetProgressState.set(lockKey, status);

		const timeoutMs = opts.timeoutMs ?? 600_000;
		const tempTar = join(pluginDir, `.${spec.id}-download-${Date.now()}.tar.gz`);

		let lastError: Error | null = null;
		let successUrl = "";
		let computedSha = "";

		try {
			for (let i = 0; i < candidateUrls.length; i++) {
				const currentUrl = candidateUrls[i]!;
				try {
					log(`[${i + 1}/${candidateUrls.length}] 正在从 ${currentUrl} 下载重资产...`);

					const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
					if (opts.signal) signals.push(opts.signal);
					const signal = (AbortSignal as any).any ? (AbortSignal as any).any(signals) : AbortSignal.timeout(timeoutMs);

					const res = await fetch(currentUrl, { signal });
					if (!res.ok) {
						throw new Error(`HTTP 响应非预期: ${res.status} ${res.statusText}`);
					}

					const contentLength = Number(res.headers.get("content-length") || 0);
					const totalBytes = contentLength > 0 ? contentLength : (spec.size ?? 0);
					status.total = totalBytes;

					const fileStream = createWriteStream(tempTar);
					let streamError: Error | null = null;
					fileStream.on("error", (e) => {
						streamError = e;
					});

					const hash = createHash("sha256");
					const reader = res.body?.getReader();
					if (!reader) throw new Error("无法读取响应体数据流");

					let downloaded = 0;
					while (true) {
						if (streamError) throw streamError;
						const { done, value } = await reader.read();
						if (done) break;
						if (value) {
							hash.update(value);
							if (!fileStream.write(Buffer.from(value))) {
								await new Promise((r) => fileStream.once("drain", r));
							}
							downloaded += value.length;
							status.downloaded = downloaded;
							if (totalBytes > 0) {
								status.progress = Math.min(100, Math.round((downloaded / totalBytes) * 100));
							}
							opts.onProgress?.({
								downloaded,
								total: totalBytes,
								percent: status.progress,
								url: currentUrl,
							});
						}
					}

					await new Promise((r) => fileStream.end(r));
					if (streamError) throw streamError;

					computedSha = hash.digest("hex").toLowerCase();

					// 强完整性验签（Fail-Closed）：若哈希不符立即销毁，不进入解压步骤
					if (spec.sha256) {
						const expected = spec.sha256.trim().toLowerCase();
						if (computedSha !== expected) {
							throw new Error(`SHA-256 完整性验签失败！期望: ${expected}，实际: ${computedSha}`);
						}
						log(`SHA-256 强校验通过: ${computedSha}`);
					}

					successUrl = currentUrl;
					break; // 下载且验签成功，退出候选重试循环
				} catch (err: any) {
					lastError = err;
					log(`下载源 ${currentUrl} 失败: ${err.message || String(err)}`);
					try {
						unlinkSync(tempTar);
					} catch {}
				}
			}

			if (!successUrl) {
				throw lastError || new Error(`所有 ${candidateUrls.length} 个候选下载源均尝试失败`);
			}

			log(`下载完成，正在进行 Staging 隔离解压与原子就绪...`);
			const stagingDir = join(pluginDir, `.staging-${spec.id}-${Date.now()}`);
			mkdirSync(stagingDir, { recursive: true });

			try {
				// Relative archive names avoid GNU tar treating drive letters as remote hosts.
				// BSD/Windows tar does not support GNU-only --force-local.
				execFileSync("tar", ["-xzf", `./${basename(tempTar)}`, "-C", resolve(stagingDir)], {
					cwd: dirname(resolve(tempTar)),
					windowsHide: true,
				});

				// 检查 staging 内部形态（若内部包装了同名子目录，取子目录内容）
				const subDir = join(stagingDir, spec.targetDir);
				const sourceRoot = existsSync(subDir) ? subDir : stagingDir;

				// 替换目标目录
				rmSync(absTarget, { recursive: true, force: true });
				mkdirSync(resolve(absTarget, ".."), { recursive: true });
				renameSync(sourceRoot, absTarget);
			} catch (e: any) {
				rmSync(absTarget, { recursive: true, force: true });
				throw new Error(`解压资产失败: ${e.message}`);
			} finally {
				rmSync(stagingDir, { recursive: true, force: true });
				try {
					unlinkSync(tempTar);
				} catch {}
			}

			status.downloading = false;
			status.ready = true;
			status.progress = 100;

			log(`资产 [${spec.id}] 就绪完毕并已安全挂载至 ${absTarget}`);
			return { ok: true, targetDir: absTarget, sha256: computedSha };
		} catch (err: any) {
			status.downloading = false;
			status.ready = false;
			status.error = err.message || String(err);
			try {
				unlinkSync(tempTar);
			} catch {}
			throw err;
		}
	})().finally(() => {
		activeAssetPromises.delete(lockKey);
	});

	activeAssetPromises.set(lockKey, promise);
	return await promise;
}
