/**
 * wallpaper-engine 客户端入口 (v0.3.13) —— 视频/WebGL2 Scene/Web 全能渲染、多套专属主题热切换、音频联动与自动轮播。
 */
import { DRAWER_CSS, getGlassThemeCss, WALLPAPER_THEMES } from "./styles.mjs";

const RUNTIME_KEY = "__piWallpaperEngineRuntime";

/** 从 bundle 自己的 URL 推 API 前缀：<base>/plugins/wallpaper-engine/client/entry.mjs → <base>/plugins-api/wallpaper-engine */
function getApiBase(importMetaUrl = import.meta.url) {
	try {
		const u = new URL(importMetaUrl);
		const m = u.pathname.match(/^(.*?)\/plugins\/wallpaper-engine\b/);
		const root = m ? m[1] : "";
		return `${root}/plugins-api/wallpaper-engine`;
	} catch {
		return "/plugins-api/wallpaper-engine";
	}
}

function getClientBase(importMetaUrl = import.meta.url) {
	try {
		const u = new URL(importMetaUrl);
		const m = u.pathname.match(/^(.*?)\/plugins\/wallpaper-engine\b/);
		const root = m ? m[1] : "";
		return `${root}/plugins/wallpaper-engine/client`;
	} catch {
		return "/plugins/wallpaper-engine/client";
	}
}

const API_BASE = getApiBase();
const CLIENT_BASE = getClientBase();

// ------------------------------------------------------------ 清理上一轮实例（可重入保护）
const prev = globalThis[RUNTIME_KEY];
if (prev?.destroy) {
	try {
		prev.destroy();
	} catch (err) {
		console.warn("[wallpaper-engine] 清理上一轮实例失败：", err);
	}
}

// ------------------------------------------------------------ 样式注入
function ensureStyles() {
	let s = document.getElementById("pi-we-drawer-styles");
	if (!s) {
		s = document.createElement("style");
		s.id = "pi-we-drawer-styles";
		document.head.appendChild(s);
	}
	s.textContent = DRAWER_CSS;
}
ensureStyles();

function updateGlassStyle(
	blur,
	opacity,
	enabled = true,
	interactive = false,
	themeKey = "obsidian",
	lightWallpaperMode = false,
) {
	let s = document.getElementById("pi-we-glass-theme");
	if (!enabled) {
		s?.remove();
		return;
	}
	if (!s) {
		s = document.createElement("style");
		s.id = "pi-we-glass-theme";
		document.head.appendChild(s);
	}
	s.textContent = getGlassThemeCss(blur, opacity, interactive, themeKey, lightWallpaperMode);
}

// ------------------------------------------------------------ WebWallGL 引擎动态载入（本地离线优先 + CDN 自动降级）
let webwallglModule = null;

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const s = document.createElement("script");
		s.src = src;
		s.async = true;
		s.onload = () => resolve();
		s.onerror = (err) => reject(err);
		document.head.appendChild(s);
	});
}

async function loadWebWallGL() {
	if (webwallglModule) return webwallglModule;
	if (globalThis.WebWallGL && typeof globalThis.WebWallGL.mount === "function") {
		webwallglModule = globalThis.WebWallGL;
		return webwallglModule;
	}

	// 1. 优先加载本地自带的离线包（零外网请求、零延迟、防 404 导致降级模糊）
	try {
		await loadScript(`${CLIENT_BASE}/vendor/webwallgl.js`);
		if (globalThis.WebWallGL && typeof globalThis.WebWallGL.mount === "function") {
			webwallglModule = globalThis.WebWallGL;
			return webwallglModule;
		}
	} catch {
		/* ignore local fail, try cdn */
	}

	// 2. 回退：esm.sh 自包含打包版本
	try {
		const mod = await import("https://esm.sh/webwallgl@3.0.0?bundle");
		if (mod && (typeof mod.mount === "function" || mod.default?.mount)) {
			webwallglModule = typeof mod.mount === "function" ? mod : mod.default;
			return webwallglModule;
		}
	} catch {
		/* ignore */
	}

	// 3. 回退：unpkg 全局 UMD 脚本
	try {
		await loadScript("https://unpkg.com/webwallgl@3.0.0");
		if (globalThis.WebWallGL && typeof globalThis.WebWallGL.mount === "function") {
			webwallglModule = globalThis.WebWallGL;
			return webwallglModule;
		}
	} catch (err) {
		console.warn("[wallpaper-engine] WebWallGL 模块加载失败，将自动降级为静态预览：", err);
	}

	return null;
}

// ------------------------------------------------------------ 音频响应律动模拟与采集
function createAudioReactiveEngine() {
	let active = false;
	let rafId = null;
	const spectrum = new Float32Array(64);
	const spectrumArray = new Array(64);

	function start() {
		if (active) return;
		active = true;
		tick();
	}

	function stop() {
		active = false;
		if (rafId) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
	}

	function tick() {
		if (!active) return;
		// 动态声学频谱波形模拟（高频平滑渐变与律动震荡）
		const time = Date.now() * 0.003;
		for (let i = 0; i < 64; i++) {
			const wave1 = Math.sin(time + i * 0.25) * 0.5 + 0.5;
			const wave2 = Math.cos(time * 0.7 - i * 0.15) * 0.5 + 0.5;
			const val = Math.min(1.0, Math.max(0.0, wave1 * 0.6 + wave2 * 0.4));
			spectrum[i] = val;
			spectrumArray[i] = val;
		}

		// 注入至 Web 网页壁纸与 Scene 场景壁纸（复用固定数组，杜绝每帧 GC 压力）
		if (typeof window.__weAudioCb === "function") {
			try {
				window.__weAudioCb(spectrumArray);
			} catch {
				/* ignore */
			}
		}

		rafId = requestAnimationFrame(tick);
	}

	return { start, stop };
}

// ------------------------------------------------------------ 专属黑曜冷月壁纸主题锁定机制
const THEME_MAP = {
	obsidian: "wallpaper-obsidian",
};
const ALL_WE_THEMES = new Set([
	"wallpaper-obsidian",
	"wallpaper-engine",
	"wallpaper-synthwave",
	"wallpaper-aurora",
	"wallpaper-amber",
]);
const PREV_THEME_KEY = "pi-we-prev-theme";
let themeLockActive = false;

function getActiveThemeKey() {
	return "obsidian";
}

function getActiveThemeId() {
	return "wallpaper-obsidian";
}

function activateThemeLock() {
	themeLockActive = true;
	try {
		const curTheme = localStorage.getItem("pi-web-ui:theme");
		if (!ALL_WE_THEMES.has(curTheme) && sessionStorage.getItem(PREV_THEME_KEY) === null) {
			sessionStorage.setItem(PREV_THEME_KEY, curTheme || "dark");
		}
		const targetTheme = getActiveThemeId();
		if (curTheme !== targetTheme) {
			localStorage.setItem("pi-web-ui:theme", targetTheme);
			let link = document.getElementById("theme-stylesheet");
			if (!link) {
				link = document.createElement("link");
				link.id = "theme-stylesheet";
				link.rel = "stylesheet";
				document.head.appendChild(link);
			}
			const hostBase = API_BASE.replace(/\/plugins-api\/wallpaper-engine$/, "");
			link.href = `${hostBase}/themes/${encodeURIComponent(targetTheme)}.css?v=0.3.33`;
			window.dispatchEvent(new CustomEvent("pi-web-ui:theme-change"));
		}
	} catch {
		/* ignore */
	}
}

function deactivateThemeLock() {
	themeLockActive = false;
	try {
		const prevTheme = sessionStorage.getItem(PREV_THEME_KEY);
		sessionStorage.removeItem(PREV_THEME_KEY);
		if (prevTheme) {
			if (prevTheme === "dark" || prevTheme === "null" || !prevTheme) {
				localStorage.removeItem("pi-web-ui:theme");
				document.getElementById("theme-stylesheet")?.remove();
			} else {
				localStorage.setItem("pi-web-ui:theme", prevTheme);
				let link = document.getElementById("theme-stylesheet");
				if (!link) {
					link = document.createElement("link");
					link.id = "theme-stylesheet";
					link.rel = "stylesheet";
					document.head.appendChild(link);
				}
				const hostBase = API_BASE.replace(/\/plugins-api\/wallpaper-engine$/, "");
				link.href = `${hostBase}/themes/${encodeURIComponent(prevTheme)}.css`;
			}
			window.dispatchEvent(new CustomEvent("pi-web-ui:theme-change"));
		}
	} catch {
		/* ignore */
	}
}

// 守卫：只要壁纸处于激活状态，任何尝试切换其他主题的行为自动锁定修正回当前选定的壁纸专属主题
function enforceThemeLock() {
	if (!themeLockActive) return;
	try {
		const targetTheme = getActiveThemeId();
		const curTheme = localStorage.getItem("pi-web-ui:theme");
		if (curTheme !== targetTheme) {
			localStorage.setItem("pi-web-ui:theme", targetTheme);
			let link = document.getElementById("theme-stylesheet");
			if (!link) {
				link = document.createElement("link");
				link.id = "theme-stylesheet";
				link.rel = "stylesheet";
				document.head.appendChild(link);
			}
			const hostBase = API_BASE.replace(/\/plugins-api\/wallpaper-engine$/, "");
			link.href = `${hostBase}/themes/${encodeURIComponent(targetTheme)}.css?v=0.3.33`;
			window.dispatchEvent(new CustomEvent("pi-web-ui:theme-change"));
		}
	} catch {
		/* ignore */
	}
}

window.addEventListener("pi-web-ui:theme-change", enforceThemeLock);
window.addEventListener("storage", (e) => {
	if (e.key === "pi-web-ui:theme") enforceThemeLock();
});

// ------------------------------------------------------------ 场景画质档位与智能性能配置
const QUALITY_PROFILES = {
	performance: {
		label: "节能极速",
		dprCap: 1.0,
		particles: "low",
		postProcessing: "low",
		videoTexScale: 1.0,
		defaultAa: "off",
	},
	balanced: {
		label: "平衡流畅",
		dprCap: 1.5,
		particles: "medium",
		postProcessing: "medium",
		videoTexScale: 1.0,
		defaultAa: "fxaa",
	},
	high: {
		label: "高清细腻",
		dprCap: 2.0,
		particles: "high",
		postProcessing: "high",
		videoTexScale: 1.0,
		defaultAa: "fxaa",
	},
	ultra: {
		label: "极致视网膜",
		dprCap: 2.5,
		particles: "high",
		postProcessing: "high",
		videoTexScale: 1.0,
		defaultAa: "msaa4",
	},
};

function getEffectiveQuality(settings = {}) {
	const presetKey = settings.qualityPreset in QUALITY_PROFILES ? settings.qualityPreset : "performance";
	const profile = QUALITY_PROFILES[presetKey];
	const aaMode = settings.antiAliasing || profile.defaultAa;
	const dpr = Math.min(profile.dprCap, Math.max(1.0, window.devicePixelRatio || 1));
	return {
		presetKey,
		profile,
		dpr,
		aaMode,
		particles: profile.particles,
		postProcessing: profile.postProcessing,
		videoTexScale: profile.videoTexScale,
	};
}

// ------------------------------------------------------------ 背景播放层管理
function createBackgroundLayer() {
	let container = document.getElementById("pi-we-bg-container");
	if (!container) {
		container = document.createElement("div");
		container.id = "pi-we-bg-container";
		document.body.prepend(container);
	}

	let currentMediaEl = null;
	let currentSceneInstance = null;
	let currentSceneResizeHandler = null;
	let currentItem = null;

	function cleanupCurrent() {
		if (currentSceneResizeHandler) {
			window.removeEventListener("resize", currentSceneResizeHandler);
			currentSceneResizeHandler = null;
		}
		if (currentSceneInstance) {
			try {
				currentSceneInstance.destroy?.();
			} catch {
				/* ignore */
			}
			currentSceneInstance = null;
		}
		if (currentMediaEl instanceof HTMLVideoElement) {
			try {
				currentMediaEl.pause();
				currentMediaEl.removeAttribute("src");
				currentMediaEl.load();
			} catch {
				/* ignore */
			}
		}
		container.innerHTML = "";
		currentMediaEl = null;
	}

	async function setWallpaper(item, settings) {
		currentItem = item;
		if (!item) {
			cleanupCurrent();
			container.classList.remove("interactive");
			updateGlassStyle(0, 100, false);
			deactivateThemeLock();
			return;
		}

		// 自动且只能使用专属主题
		activateThemeLock();

		if (settings.interactive) {
			container.classList.add("interactive");
		} else {
			container.classList.remove("interactive");
		}
		updateGlassStyle(
			settings.glassBlur,
			settings.glassOpacity,
			true,
			settings.interactive,
			settings.wallpaperTheme,
			settings.lightWallpaperMode,
		);

		cleanupCurrent();

		// 1. 视频壁纸播放（硬件直通与原生无损分辨率）
		if (item.type === "video" || item.hasVideo) {
			const video = document.createElement("video");
			video.className = "pi-we-bg-media";
			video.src = `${API_BASE}/api/media?id=${encodeURIComponent(item.id)}`;
			video.autoplay = true;
			video.loop = true;
			video.muted = Boolean(settings.muteAudio);
			video.volume = settings.muteAudio ? 0 : 1;
			video.playsInline = true;
			video.disablePictureInPicture = true;
			video.preload = "auto";
			video.setAttribute("playsinline", "true");
			video.setAttribute("webkit-playsinline", "true");

			video.oncanplay = () => {
				video.play().catch(() => {
					// 若浏览器 autoplay policy 拦截非静音播放，先静音起播并等待首个手势解锁声音
					video.muted = true;
					void video.play();
					if (!settings.muteAudio) {
						const unlockAudio = () => {
							video.muted = false;
							video.volume = 1;
							window.removeEventListener("pointerdown", unlockAudio);
						};
						window.addEventListener("pointerdown", unlockAudio, { once: true });
					}
				});
			};

			container.appendChild(video);
			currentMediaEl = video;
			return;
		}

		// 2. Scene 场景壁纸（原生全量支持打包的 scene.pkg 与官方内置/松散 scene.json 散装工程）
		if (item.type === "scene" || item.hasScene) {
			const mountEl = document.createElement("div");
			mountEl.className = "pi-we-scene-mount";
			container.appendChild(mountEl);
			currentMediaEl = mountEl;

			try {
				const engine = await loadWebWallGL();
				if (!engine) throw new Error("WebWallGL 引擎未就绪");

				const projectRes = await fetch(`${API_BASE}/api/project?id=${encodeURIComponent(item.id)}`);
				const projectJson = projectRes.ok ? await projectRes.json() : null;

				let source = null;
				// 优先拉取打包版 scene.pkg：除非明确标记为无 pkg 的纯散装工程，否则一律先试 pkg
				const shouldTryPkg = Boolean(item.hasPkg) || (!item.isLooseScene && item.hasPkg !== false);

				// 1. 对于打包版壁纸，优先尝试拉取 scene.pkg
				if (shouldTryPkg) {
					try {
						const pkgRes = await fetch(`${API_BASE}/api/pkg?id=${encodeURIComponent(item.id)}`);
						if (pkgRes.ok) {
							const pkgBuffer = await pkgRes.arrayBuffer();
							source = engine.bytesSource(pkgBuffer, projectJson, item.id);
						}
					} catch {
						source = null;
					}
				}

				// 2. 对于官方内置壁纸（如 demon_core、deep_space、beach、neon_sunset 等）或无 pkg 散装工程，使用松散源（Loose Source）
				if (!source) {
					const entryFile = (projectJson?.file || item.file || "scene.json").replace(/\\/g, "/");
					let totalBytes = 0;
					const fileCache = new Map();

					source = {
						key: item.id,
						async scenePkg() {
							return null;
						},
						async sceneDir(signal) {
							const read = async (relPath, sig) => {
								if (!relPath) return null;
								const safeRel = String(relPath).replace(/\\/g, "/").replace(/^\/+/, "");
								if (fileCache.has(safeRel)) return fileCache.get(safeRel);

								try {
									const res = await fetch(
										`${API_BASE}/api/scene-file?id=${encodeURIComponent(item.id)}&file=${encodeURIComponent(safeRel)}`,
										{ signal: sig || signal },
									);
									if (!res.ok) return null;
									const buf = new Uint8Array(await res.arrayBuffer());
									fileCache.set(safeRel, buf);
									totalBytes += buf.byteLength;
									return buf;
								} catch (err) {
									if (sig?.aborted || signal?.aborted) throw err;
									return null;
								}
							};

							// 读取入口场景配置
							const entryBuf = await read(entryFile, signal);
							if (!entryBuf) {
								const fallbackBuf = await read("scene.json", signal);
								if (!fallbackBuf) {
									throw new Error(`散装场景入口文件读取失败: ${entryFile}`);
								}
								return {
									entry: "scene.json",
									read,
									bytes: () => totalBytes,
								};
							}

							return {
								entry: entryFile,
								read,
								bytes: () => totalBytes,
							};
						},
						async project() {
							return projectJson;
						},
					};
				}

				const q = getEffectiveQuality(settings);
				const effectiveVolume = settings.muteAudio ? 0 : 1;
				const sceneInstance = await engine.mount(mountEl, {
					source,
					fit: "cover",
					renderDpr: q.dpr,
					fpsLimit: Number(settings.fpsLimit || 60),
					volume: effectiveVolume,
					quality: {
						antiAliasing: q.aaMode,
						particles: q.particles,
						postProcessing: q.postProcessing,
					},
					videoTexScale: q.videoTexScale,
				});

				currentSceneInstance = sceneInstance;
				if (sceneInstance && typeof sceneInstance.setVolume === "function") {
					try {
						sceneInstance.setVolume(effectiveVolume);
					} catch {}
				}

				// 响应窗口尺寸与 DPI 缩放变化，按当前画质上限计算 DPR
				currentSceneResizeHandler = () => {
					if (currentSceneInstance && typeof currentSceneInstance.setRenderDpr === "function") {
						const curQ = getEffectiveQuality(settings);
						currentSceneInstance.setRenderDpr(curQ.dpr);
					}
				};
				window.addEventListener("resize", currentSceneResizeHandler, { passive: true });

				return;
			} catch (err) {
				console.warn("[wallpaper-engine] Scene 壁纸渲染失败，平滑降级至缩略图预览：", err);
				mountEl.remove();
			}
		}

		// 3. Web 网页壁纸（沙箱 iframe 挂载，注入高清视口与音频权限）
		if (item.type === "web" || item.hasWeb) {
			const iframe = document.createElement("iframe");
			iframe.className = "pi-we-bg-media";
			const webFile = item.webFile || "index.html";
			iframe.src = `${API_BASE}/api/web?id=${encodeURIComponent(item.id)}&file=${encodeURIComponent(webFile)}`;
			iframe.sandbox = "allow-scripts allow-same-origin";
			iframe.setAttribute("allow", "autoplay; audio *");
			iframe.onload = () => {
				const vol = settings.muteAudio ? 0 : 1;
				try {
					iframe.contentWindow?.postMessage({ __we: 1, op: "setVolume", v: vol }, "*");
				} catch {}
			};
			container.appendChild(iframe);
			currentMediaEl = iframe;
			return;
		}

		// 4. 静态图片或高清原图展示
		const img = document.createElement("img");
		img.className = "pi-we-bg-media";
		const mediaSrc = item.hasImage
			? `${API_BASE}/api/media?id=${encodeURIComponent(item.id)}`
			: `${API_BASE}/api/preview?id=${encodeURIComponent(item.id)}`;
		img.src = mediaSrc;

		container.appendChild(img);
		currentMediaEl = img;
	}

	function pause() {
		if (currentMediaEl instanceof HTMLVideoElement && !currentMediaEl.paused) {
			currentMediaEl.pause();
		}
		if (currentSceneInstance && typeof currentSceneInstance.pause === "function") {
			try {
				currentSceneInstance.pause();
			} catch {
				/* ignore */
			}
		}
	}

	function resume() {
		if (currentMediaEl instanceof HTMLVideoElement && currentMediaEl.paused) {
			currentMediaEl.play().catch(() => {});
		}
		if (currentSceneInstance && typeof currentSceneInstance.resume === "function") {
			try {
				currentSceneInstance.resume();
			} catch {
				/* ignore */
			}
		}
	}

	function setMuted(muted) {
		const vol = muted ? 0 : 1;
		if (currentMediaEl instanceof HTMLVideoElement) {
			currentMediaEl.muted = muted;
			currentMediaEl.volume = vol;
		}
		if (currentSceneInstance && typeof currentSceneInstance.setVolume === "function") {
			try {
				currentSceneInstance.setVolume(vol);
			} catch (err) {
				console.warn("[wallpaper-engine] 设置 Scene 音量失败：", err);
			}
		}
		if (currentMediaEl instanceof HTMLIFrameElement) {
			try {
				currentMediaEl.contentWindow?.postMessage({ __we: 1, op: "setVolume", v: vol }, "*");
			} catch {}
		}
	}

	function setInteractive(interactive) {
		if (interactive) container.classList.add("interactive");
		else container.classList.remove("interactive");
	}

	function destroy() {
		cleanupCurrent();
		container?.remove();
		document.getElementById("pi-we-glass-theme")?.remove();
	}

	function getCurrentItem() {
		return currentItem;
	}

	return { setWallpaper, pause, resume, setMuted, setInteractive, getCurrentItem, destroy };
}

// ------------------------------------------------------------ 壁纸库抽屉组件
function createDrawer(bgLayer, state, onStateChange, triggerRotate) {
	const backdrop = document.createElement("div");
	backdrop.className = "pi-we-backdrop";

	const drawer = document.createElement("div");
	drawer.className = "pi-we-drawer";

	let wallpapers = [];
	let currentFilter = "all";
	let searchKeyword = "";
	const PAGE_SIZE = 12;
	let currentPage = 1;
	let displayMode = "paged"; // "paged" | "all"

	drawer.innerHTML = `
		<div class="pi-we-header">
			<h3 class="pi-we-title">🖼️ 壁纸库 · Wallpaper Engine <span class="pi-we-theme-badge" title="设置壁纸时自动开启且锁定专属炫酷主题，保证文字清晰度与最佳观感">🎨 专属主题已联动</span></h3>
			<div class="pi-we-header-actions">
				<button class="pi-we-icon-btn" id="pi-we-rescan-btn" title="重新扫描">🔄 刷新</button>
				<button class="pi-we-icon-btn" id="pi-we-close-btn" title="关闭">✕</button>
			</div>
		</div>

		<div class="pi-we-settings-bar">
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">专属主题:</span>
				<select class="pi-we-select" id="pi-we-theme-select" style="flex: 1;">
					<option value="obsidian" selected>🌑 黑曜冷月（纯黑极简）</option>
				</select>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">毛玻璃模糊度:</span>
				<input type="range" id="pi-we-blur-range" min="0" max="32" value="${state.settings.glassBlur}" />
				<span class="pi-we-slider-val" id="pi-we-blur-val">${state.settings.glassBlur}px</span>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">界面不透明度:</span>
				<input type="range" id="pi-we-opacity-range" min="0" max="100" value="${state.settings.glassOpacity}" />
				<span class="pi-we-slider-val" id="pi-we-opacity-val">${state.settings.glassOpacity}%</span>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">自动轮播:</span>
				<select class="pi-we-select" id="pi-we-rotate-select">
					<option value="0" ${state.settings.autoRotateMinutes === "0" ? "selected" : ""}>关闭轮播</option>
					<option value="5" ${state.settings.autoRotateMinutes === "5" ? "selected" : ""}>每 5 分钟</option>
					<option value="15" ${state.settings.autoRotateMinutes === "15" ? "selected" : ""}>每 15 分钟</option>
					<option value="30" ${state.settings.autoRotateMinutes === "30" ? "selected" : ""}>每 30 分钟</option>
					<option value="60" ${state.settings.autoRotateMinutes === "60" ? "selected" : ""}>每 1 小时</option>
				</select>
				<span class="pi-we-slider-label" style="width: auto; margin-left: 8px;">帧率:</span>
				<select class="pi-we-select" id="pi-we-fps-select">
					<option value="30" ${state.settings.fpsLimit === "30" ? "selected" : ""}>30 FPS</option>
					<option value="60" ${state.settings.fpsLimit === "60" ? "selected" : ""}>60 FPS</option>
					<option value="0" ${state.settings.fpsLimit === "0" || !state.settings.fpsLimit ? "selected" : ""}>无限制</option>
				</select>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">场景画质:</span>
				<select class="pi-we-select" id="pi-we-quality-select" style="flex: 1;">
					<option value="performance" ${state.settings.qualityPreset === "performance" || !state.settings.qualityPreset ? "selected" : ""}>⚡ 节能极速（核显推荐）</option>
					<option value="balanced" ${state.settings.qualityPreset === "balanced" ? "selected" : ""}>⚖️ 平衡流畅（默认推荐）</option>
					<option value="high" ${state.settings.qualityPreset === "high" ? "selected" : ""}>🎨 高清细腻（独显）</option>
					<option value="ultra" ${state.settings.qualityPreset === "ultra" ? "selected" : ""}>🌟 极致视网膜</option>
				</select>
				<span class="pi-we-slider-label" style="width: auto; margin-left: 8px;">抗锯齿:</span>
				<select class="pi-we-select" id="pi-we-aa-select">
					<option value="off" ${state.settings.antiAliasing === "off" || !state.settings.antiAliasing ? "selected" : ""}>关闭</option>
					<option value="fxaa" ${state.settings.antiAliasing === "fxaa" ? "selected" : ""}>FXAA 快速</option>
					<option value="msaa2" ${state.settings.antiAliasing === "msaa2" ? "selected" : ""}>MSAA 2x</option>
					<option value="msaa4" ${state.settings.antiAliasing === "msaa4" ? "selected" : ""}>MSAA 4x</option>
				</select>
			</div>
			<div class="pi-we-slider-row" style="justify-content: flex-start; gap: 14px;">
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-interactive-check" ${state.settings.interactive ? "checked" : ""} />
					<span>允许交互</span>
				</label>
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-audio-check" ${state.settings.audioReactive ? "checked" : ""} />
					<span>音乐频谱 🎵</span>
				</label>
				<label class="pi-we-checkbox-row" title="在纯白、日光或高光壁纸下启用微描边锐化与微偏光，保证白字清晰易读">
					<input type="checkbox" id="pi-we-lightmode-check" ${state.settings.lightWallpaperMode ? "checked" : ""} />
					<span>☀️ 亮色增强</span>
				</label>
				<label class="pi-we-checkbox-row">
					<input type="checkbox" id="pi-we-mute-check" ${state.settings.muteAudio ? "checked" : ""} />
					<span>静音</span>
				</label>
				<button class="pi-we-icon-btn" id="pi-we-clear-btn" style="margin-left: auto;">关闭壁纸</button>
			</div>
			<div class="pi-we-preset-row">
				<button class="pi-we-icon-btn" id="pi-we-export-btn">📤 导出预设</button>
				<button class="pi-we-icon-btn" id="pi-we-import-btn">📥 导入预设</button>
				<button class="pi-we-icon-btn" id="pi-we-rotate-now-btn" style="margin-left: auto;" title="立即随机切换下一张壁纸">🎲 切下一张</button>
			</div>
		</div>

		<div class="pi-we-filter-bar">
			<input type="text" class="pi-we-search-input" id="pi-we-search" placeholder="搜索壁纸名称或标签..." />
			<div class="pi-we-tabs">
				<button class="pi-we-tab active" data-tab="all">全部</button>
				<button class="pi-we-tab" data-tab="fav">⭐ 收藏</button>
				<button class="pi-we-tab" data-tab="video">视频</button>
				<button class="pi-we-tab" data-tab="scene">场景</button>
				<button class="pi-we-tab" data-tab="web">网页</button>
				<button class="pi-we-tab" data-tab="image">静态图</button>
				<button class="pi-we-mode-btn" id="pi-we-mode-btn" title="点击切换分页浏览与全部显示模式">📑 分页模式</button>
			</div>
		</div>

		<div class="pi-we-body" id="pi-we-grid">
			<div class="pi-we-empty">
				<span>正在加载壁纸...</span>
			</div>
		</div>

		<div class="pi-we-pagination" id="pi-we-pagination" style="display: none;">
			<div class="pi-we-page-info">
				<span id="pi-we-page-stats">共 0 张</span>
			</div>
			<div class="pi-we-page-nav">
				<button class="pi-we-page-btn" id="pi-we-page-prev" title="上一页" disabled>◀ 上一页</button>
				<div class="pi-we-page-numbers" id="pi-we-page-numbers"></div>
				<button class="pi-we-page-btn" id="pi-we-page-next" title="下一页" disabled>下一页 ▶</button>
			</div>
		</div>
	`;

	document.body.appendChild(backdrop);
	document.body.appendChild(drawer);

	const gridEl = drawer.querySelector("#pi-we-grid");
	const paginationEl = drawer.querySelector("#pi-we-pagination");
	const pageStatsEl = drawer.querySelector("#pi-we-page-stats");
	const pagePrevBtn = drawer.querySelector("#pi-we-page-prev");
	const pageNextBtn = drawer.querySelector("#pi-we-page-next");
	const pageNumbersEl = drawer.querySelector("#pi-we-page-numbers");
	const blurInput = drawer.querySelector("#pi-we-blur-range");
	const blurVal = drawer.querySelector("#pi-we-blur-val");
	const opacityInput = drawer.querySelector("#pi-we-opacity-range");
	const opacityVal = drawer.querySelector("#pi-we-opacity-val");
	const themeSelect = drawer.querySelector("#pi-we-theme-select");
	const fpsSelect = drawer.querySelector("#pi-we-fps-select");
	const qualitySelect = drawer.querySelector("#pi-we-quality-select");
	const aaSelect = drawer.querySelector("#pi-we-aa-select");
	const rotateSelect = drawer.querySelector("#pi-we-rotate-select");
	const interactiveCheck = drawer.querySelector("#pi-we-interactive-check");
	const audioCheck = drawer.querySelector("#pi-we-audio-check");
	const lightmodeCheck = drawer.querySelector("#pi-we-lightmode-check");
	const muteCheck = drawer.querySelector("#pi-we-mute-check");
	const searchInput = drawer.querySelector("#pi-we-search");
	const tabs = drawer.querySelectorAll(".pi-we-tab");
	const modeBtn = drawer.querySelector("#pi-we-mode-btn");

	function open() {
		ensureStyles();
		backdrop.classList.add("open");
		drawer.classList.add("open");
		void loadWallpapers();
	}

	function close() {
		backdrop.classList.remove("open");
		drawer.classList.remove("open");
	}

	function toggle() {
		if (drawer.classList.contains("open")) close();
		else open();
	}

	backdrop.addEventListener("click", close);
	drawer.querySelector("#pi-we-close-btn").addEventListener("click", close);

	const onKeyDown = (e) => {
		if (e.key === "Escape" && drawer.classList.contains("open")) {
			close();
		}
	};
	window.addEventListener("keydown", onKeyDown);

	blurInput.addEventListener("input", (e) => {
		const val = Number(e.target.value);
		blurVal.textContent = `${val}px`;
		state.settings.glassBlur = val;
		if (state.activeId)
			updateGlassStyle(
				val,
				state.settings.glassOpacity,
				true,
				state.settings.interactive,
				state.settings.wallpaperTheme,
				state.settings.lightWallpaperMode,
			);
		onStateChange();
	});

	opacityInput.addEventListener("input", (e) => {
		const val = Number(e.target.value);
		opacityVal.textContent = `${val}%`;
		state.settings.glassOpacity = val;
		if (state.activeId)
			updateGlassStyle(
				state.settings.glassBlur,
				val,
				true,
				state.settings.interactive,
				state.settings.wallpaperTheme,
				state.settings.lightWallpaperMode,
			);
		onStateChange();
	});

	if (themeSelect) {
		themeSelect.addEventListener("change", (e) => {
			state.settings.wallpaperTheme = e.target.value;
			if (state.activeId) {
				activateThemeLock();
				updateGlassStyle(
					state.settings.glassBlur,
					state.settings.glassOpacity,
					true,
					state.settings.interactive,
					state.settings.wallpaperTheme,
					state.settings.lightWallpaperMode,
				);
			}
			onStateChange();
		});
	}

	fpsSelect.addEventListener("change", (e) => {
		state.settings.fpsLimit = e.target.value;
		const cur = bgLayer.getCurrentItem();
		if (cur && (cur.type === "scene" || cur.hasScene)) {
			void bgLayer.setWallpaper(cur, state.settings);
		}
		onStateChange();
	});

	if (qualitySelect) {
		qualitySelect.addEventListener("change", (e) => {
			state.settings.qualityPreset = e.target.value;
			const cur = bgLayer.getCurrentItem();
			if (cur && (cur.type === "scene" || cur.hasScene)) {
				void bgLayer.setWallpaper(cur, state.settings);
			}
			onStateChange();
		});
	}

	if (aaSelect) {
		aaSelect.addEventListener("change", (e) => {
			state.settings.antiAliasing = e.target.value;
			const cur = bgLayer.getCurrentItem();
			if (cur && (cur.type === "scene" || cur.hasScene)) {
				void bgLayer.setWallpaper(cur, state.settings);
			}
			onStateChange();
		});
	}

	rotateSelect.addEventListener("change", (e) => {
		state.settings.autoRotateMinutes = e.target.value;
		onStateChange();
	});

	interactiveCheck.addEventListener("change", (e) => {
		state.settings.interactive = e.target.checked;
		bgLayer.setInteractive(e.target.checked);
		if (state.activeId)
			updateGlassStyle(
				state.settings.glassBlur,
				state.settings.glassOpacity,
				true,
				e.target.checked,
				state.settings.wallpaperTheme,
				state.settings.lightWallpaperMode,
			);
		onStateChange();
	});

	audioCheck.addEventListener("change", (e) => {
		state.settings.audioReactive = e.target.checked;
		onStateChange();
	});

	if (lightmodeCheck) {
		lightmodeCheck.addEventListener("change", (e) => {
			state.settings.lightWallpaperMode = e.target.checked;
			if (state.activeId) {
				updateGlassStyle(
					state.settings.glassBlur,
					state.settings.glassOpacity,
					true,
					state.settings.interactive,
					state.settings.wallpaperTheme,
					e.target.checked,
				);
			}
			onStateChange();
		});
	}

	muteCheck.addEventListener("change", (e) => {
		state.settings.muteAudio = e.target.checked;
		bgLayer.setMuted(e.target.checked);
		onStateChange();
	});

	drawer.querySelector("#pi-we-clear-btn").addEventListener("click", () => {
		state.activeId = "";
		bgLayer.setWallpaper(null, state.settings);
		renderGrid();
		onStateChange();
	});

	drawer.querySelector("#pi-we-rotate-now-btn").addEventListener("click", () => {
		triggerRotate();
	});

	// 导出预设
	drawer.querySelector("#pi-we-export-btn").addEventListener("click", async () => {
		try {
			const res = await fetch(`${API_BASE}/api/presets`);
			const json = await res.json();
			const text = JSON.stringify(json, null, 2);
			if (navigator.clipboard) {
				await navigator.clipboard.writeText(text);
				alert("外观预设已成功复制到剪贴板！");
			} else {
				prompt("请复制外观预设 JSON：", text);
			}
		} catch (err) {
			alert(`导出失败：${err.message}`);
		}
	});

	// 导入预设
	drawer.querySelector("#pi-we-import-btn").addEventListener("click", async () => {
		const input = prompt("请粘贴外观预设 JSON 内容：");
		if (!input) return;
		try {
			const parsed = JSON.parse(input);
			const res = await fetch(`${API_BASE}/api/presets`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(parsed),
			});
			const json = await res.json();
			if (json.ok) {
				state.activeId = json.activeId || "";
				state.settings = { ...state.settings, ...(json.settings || {}) };
				state.favorites = json.favorites || [];
				syncSettings(state);
				void loadWallpapers();
				alert("外观预设导入成功！");
			}
		} catch (err) {
			alert(`导入失败：${err.message}`);
		}
	});

	drawer.querySelector("#pi-we-rescan-btn").addEventListener("click", async () => {
		currentPage = 1;
		gridEl.innerHTML = `<div class="pi-we-empty"><span>正在全盘重新扫描...</span></div>`;
		updatePagination(0, 1, 1);
		try {
			const res = await fetch(`${API_BASE}/api/rescan`);
			const json = await res.json();
			if (json.ok) {
				wallpapers = json.wallpapers || [];
				state.favorites = json.favorites || [];
				renderGrid();
			}
		} catch (err) {
			gridEl.innerHTML = `<div class="pi-we-empty"><span>扫描失败：${err.message}</span></div>`;
			updatePagination(0, 1, 1);
		}
	});

	searchInput.addEventListener("input", (e) => {
		searchKeyword = e.target.value.trim().toLowerCase();
		currentPage = 1;
		renderGrid();
	});

	tabs.forEach((tab) => {
		tab.addEventListener("click", () => {
			tabs.forEach((t) => t.classList.remove("active"));
			tab.classList.add("active");
			currentFilter = tab.getAttribute("data-tab");
			currentPage = 1;
			renderGrid();
		});
	});

	if (modeBtn) {
		modeBtn.addEventListener("click", () => {
			displayMode = displayMode === "paged" ? "all" : "paged";
			modeBtn.textContent = displayMode === "paged" ? "📑 分页模式" : "📜 全部显示";
			currentPage = 1;
			renderGrid();
			gridEl.scrollTop = 0;
		});
	}

	pagePrevBtn.addEventListener("click", () => {
		if (currentPage > 1) {
			currentPage--;
			renderGrid();
			gridEl.scrollTop = 0;
		}
	});

	pageNextBtn.addEventListener("click", () => {
		const filtered = getFilteredWallpapers();
		const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
		if (currentPage < totalPages) {
			currentPage++;
			renderGrid();
			gridEl.scrollTop = 0;
		}
	});

	function getFilteredWallpapers() {
		return wallpapers.filter((w) => {
			if (currentFilter === "fav") {
				if (!state.favorites.includes(w.id)) return false;
			} else if (currentFilter !== "all" && w.type !== currentFilter) {
				return false;
			}
			if (searchKeyword) {
				const matchTitle = w.title.toLowerCase().includes(searchKeyword);
				const matchTag = w.tags?.some((t) => t.toLowerCase().includes(searchKeyword));
				if (!matchTitle && !matchTag) return false;
			}
			return true;
		});
	}

	function updatePagination(totalCount, totalPages, curPage) {
		if (!paginationEl) return;
		if (totalCount === 0) {
			paginationEl.style.display = "none";
			return;
		}

		paginationEl.style.display = "flex";
		if (displayMode === "all") {
			if (pageStatsEl) {
				pageStatsEl.textContent = `共 ${totalCount} 张 · 已全部展示 (点击顶栏切回分页)`;
			}
			if (pagePrevBtn) pagePrevBtn.disabled = true;
			if (pageNextBtn) pageNextBtn.disabled = true;
			if (pageNumbersEl) pageNumbersEl.innerHTML = "";
			return;
		}

		if (pageStatsEl) {
			pageStatsEl.textContent = `共 ${totalCount} 张 · 第 ${curPage}/${totalPages} 页`;
		}
		if (pagePrevBtn) {
			pagePrevBtn.disabled = curPage <= 1;
		}
		if (pageNextBtn) {
			pageNextBtn.disabled = curPage >= totalPages;
		}

		if (pageNumbersEl) {
			pageNumbersEl.innerHTML = "";
			const pageList = getPageNumbers(curPage, totalPages);
			pageList.forEach((p) => {
				if (p === "...") {
					const span = document.createElement("span");
					span.className = "pi-we-page-ellipsis";
					span.textContent = "…";
					pageNumbersEl.appendChild(span);
				} else {
					const btn = document.createElement("button");
					btn.className = `pi-we-page-num ${p === curPage ? "active" : ""}`;
					btn.textContent = String(p);
					btn.addEventListener("click", () => {
						if (currentPage !== p) {
							currentPage = p;
							renderGrid();
							gridEl.scrollTop = 0;
						}
					});
					pageNumbersEl.appendChild(btn);
				}
			});
		}
	}

	function getPageNumbers(cur, total) {
		if (total <= 7) {
			return Array.from({ length: total }, (_, i) => i + 1);
		}
		const set = new Set([1, total, cur]);
		if (cur - 1 > 1) set.add(cur - 1);
		if (cur + 1 < total) set.add(cur + 1);
		if (cur <= 3) {
			set.add(2);
			set.add(3);
			set.add(4);
		}
		if (cur >= total - 2) {
			set.add(total - 1);
			set.add(total - 2);
			set.add(total - 3);
		}
		const sorted = Array.from(set).sort((a, b) => a - b);
		const result = [];
		let last = 0;
		for (const p of sorted) {
			if (last && p - last > 1) {
				result.push("...");
			}
			result.push(p);
			last = p;
		}
		return result;
	}

	async function loadWallpapers() {
		try {
			const res = await fetch(`${API_BASE}/api/wallpapers`);
			const json = await res.json();
			if (json.ok) {
				wallpapers = json.wallpapers || [];
				state.favorites = json.favorites || [];
				currentPage = 1;
				renderGrid();
			} else {
				gridEl.innerHTML = `
					<div class="pi-we-empty">
						<span>未检测到 Steam 或创意工坊壁纸</span>
						<span class="pi-we-empty-sub">请确认已安装 Steam 并订阅了 Wallpaper Engine 壁纸，或在插件设置中指定自定义路径。</span>
					</div>
				`;
				updatePagination(0, 1, 1);
			}
		} catch (err) {
			gridEl.innerHTML = `<div class="pi-we-empty"><span>加载失败：${err.message}</span></div>`;
			updatePagination(0, 1, 1);
		}
	}

	function renderGrid() {
		const filtered = getFilteredWallpapers();
		const totalCount = filtered.length;
		const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

		if (currentPage > totalPages) currentPage = totalPages;
		if (currentPage < 1) currentPage = 1;

		if (totalCount === 0) {
			gridEl.innerHTML = `
				<div class="pi-we-empty">
					<span>未找到匹配的壁纸</span>
				</div>
			`;
			updatePagination(0, 1, 1);
			return;
		}

		gridEl.innerHTML = "";
		const startIdx = (currentPage - 1) * PAGE_SIZE;
		const pageItems = displayMode === "all" ? filtered : filtered.slice(startIdx, startIdx + PAGE_SIZE);

		pageItems.forEach((w) => {
			const card = document.createElement("div");
			const isActive = w.id === state.activeId;
			const isFav = state.favorites.includes(w.id);
			card.className = `pi-we-card pi-we-card-item ${isActive ? "active" : ""}`;
			card.tabIndex = 0;

			const previewUrl = w.hasPreview ? `${API_BASE}/api/preview?id=${encodeURIComponent(w.id)}` : "";

			card.innerHTML = `
				<div class="pi-we-thumb-wrap pi-we-cover-wrap">
					${previewUrl ? `<img class="pi-we-thumb pi-we-cover-img" src="${previewUrl}" alt="${w.title}" loading="lazy" />` : ""}
					<span class="pi-we-badge ${w.type}">${w.type}</span>
					${isActive ? `<span class="pi-we-active-indicator">✓ 使用中</span>` : ""}
				</div>
				<div class="pi-we-card-info pi-we-card-meta-bar">
					<div class="pi-we-card-title" title="${w.title}">${w.title}</div>
					<div class="pi-we-card-meta">
						<span>${w.rating || "Everyone"}</span>
						<button class="pi-we-fav-btn ${isFav ? "active" : ""}" title="${isFav ? "取消收藏" : "加入收藏"}">${isFav ? "★" : "☆"}</button>
					</div>
				</div>
			`;

			// 收藏按钮点击事件（阻止卡片点击冒泡）
			const favBtn = card.querySelector(".pi-we-fav-btn");
			favBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				try {
					const res = await fetch(`${API_BASE}/api/favorite`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: w.id }),
					});
					const json = await res.json();
					if (json.ok) {
						state.favorites = json.favorites || [];
						renderGrid();
					}
				} catch {
					/* ignore */
				}
			});

			card.addEventListener("click", () => {
				state.activeId = w.id;
				void bgLayer.setWallpaper(w, state.settings);
				renderGrid();
				onStateChange();
			});

			gridEl.appendChild(card);
		});
	}

	function syncSettings(freshState) {
		if (!freshState?.settings) return;
		const s = freshState.settings;
		if (blurInput) blurInput.value = String(s.glassBlur ?? 0);
		if (blurVal) blurVal.textContent = `${s.glassBlur ?? 0}px`;
		if (opacityInput) opacityInput.value = String(s.glassOpacity ?? 40);
		if (opacityVal) opacityVal.textContent = `${s.glassOpacity ?? 40}%`;
		if (themeSelect) themeSelect.value = s.wallpaperTheme || "obsidian";
		if (fpsSelect) fpsSelect.value = String(s.fpsLimit ?? "0");
		if (qualitySelect) qualitySelect.value = s.qualityPreset || "performance";
		if (aaSelect) aaSelect.value = s.antiAliasing || "off";
		if (rotateSelect) rotateSelect.value = String(s.autoRotateMinutes ?? "0");
		if (interactiveCheck) interactiveCheck.checked = Boolean(s.interactive);
		if (audioCheck) audioCheck.checked = Boolean(s.audioReactive);
		if (lightmodeCheck) lightmodeCheck.checked = Boolean(s.lightWallpaperMode);
		if (muteCheck) muteCheck.checked = Boolean(s.muteAudio);
	}

	function destroy() {
		window.removeEventListener("keydown", onKeyDown);
		backdrop.remove();
		drawer.remove();
	}

	return { open, close, toggle, loadWallpapers, renderGrid, syncSettings, getWallpapers: () => wallpapers, destroy };
}

// ------------------------------------------------------------ 运行时主流程（同步初始化 + 异步非阻塞加载）
const state = {
	activeId: "",
	favorites: [],
	settings: {
		glassBlur: 0,
		glassOpacity: 40,
		wallpaperTheme: "obsidian",
		fpsLimit: "0",
		qualityPreset: "performance",
		antiAliasing: "off",
		interactive: false,
		muteAudio: true,
		pauseOnHidden: true,
		audioReactive: false,
		autoRotateMinutes: "0",
		lightWallpaperMode: false,
	},
};

const bgLayer = createBackgroundLayer();
const audioEngine = createAudioReactiveEngine();

let saveTimer = null;
function onStateChange() {
	if (state.settings.audioReactive) audioEngine.start();
	else audioEngine.stop();

	scheduleAutoRotate();

	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		fetch(`${API_BASE}/api/active`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				activeId: state.activeId,
				favorites: state.favorites,
				settings: state.settings,
			}),
		}).catch(() => {});
	}, 300);
}

// 轮播触发器
function triggerRotate() {
	const pool = drawer.getWallpapers();
	if (!pool.length) return;
	const candList = state.favorites.length ? pool.filter((w) => state.favorites.includes(w.id)) : pool;
	const candidates = candList.length ? candList : pool;
	if (!candidates.length) return;

	// 选取下一张（若当前在列表里则取下一个，否则随机取）
	const curIdx = candidates.findIndex((w) => w.id === state.activeId);
	const nextIdx = (curIdx + 1) % candidates.length;
	const nextItem = candidates[nextIdx];

	if (nextItem) {
		state.activeId = nextItem.id;
		void bgLayer.setWallpaper(nextItem, state.settings);
		drawer.renderGrid();
		onStateChange();
	}
}

// 自动轮播定时器调度
let autoRotateTimer = null;
function scheduleAutoRotate() {
	if (autoRotateTimer) {
		clearInterval(autoRotateTimer);
		autoRotateTimer = null;
	}
	const mins = Number(state.settings.autoRotateMinutes || 0);
	if (mins > 0) {
		autoRotateTimer = setInterval(
			() => {
				if (!document.hidden) {
					triggerRotate();
				}
			},
			mins * 60 * 1000,
		);
	}
}

// 同步创建抽屉面板（确保 UI 结构与事件监听立即就绪）
const drawer = createDrawer(bgLayer, state, onStateChange, triggerRotate);

const onVisibilityChange = () => {
	if (state.settings.pauseOnHidden) {
		if (document.hidden) {
			bgLayer.pause();
			audioEngine.stop();
		} else {
			bgLayer.resume();
			if (state.settings.audioReactive) audioEngine.start();
		}
	}
};
document.addEventListener("visibilitychange", onVisibilityChange);

// ------------------------------------------------------------ 宿主动作桥（模块顶层同步注册，锁定作用域）
const teardown = [];
function whenBridge(fn, tries = 40) {
	const bridge = globalThis.window?.__piWebUiHost;
	if (bridge && typeof bridge === "object") {
		fn(bridge);
		return;
	}
	if (tries <= 0) return;
	const timer = setTimeout(() => whenBridge(fn, tries - 1), 250);
	teardown.push(() => clearTimeout(timer));
}

// 模块求值阶段直接执行，确保 registerPluginTopbarAction 在当前 pluginScope 下执行
whenBridge((bridge) => {
	try {
		const off = bridge.onUiAction?.("wallpaper-engine:toggle", () => {
			drawer.toggle();
		});
		if (typeof off === "function") teardown.push(off);
	} catch {
		/* ignore */
	}
	// 快捷键支持：Ctrl/Cmd+Alt+W 唤起壁纸抽屉
	try {
		const off = bridge.shortcuts?.register?.("ctrl+alt+w", () => {
			drawer.toggle();
		});
		if (typeof off === "function") teardown.push(off);
	} catch {
		/* ignore */
	}
});

// 注册当前运行时（支持热重载与实例清理）
globalThis[RUNTIME_KEY] = {
	drawer,
	bgLayer,
	state,
	destroy() {
		for (const off of teardown.splice(0)) {
			try {
				off();
			} catch {
				/* ignore */
			}
		}
		if (autoRotateTimer) clearInterval(autoRotateTimer);
		audioEngine.stop();
		window.removeEventListener("pi-web-ui:theme-change", enforceThemeLock);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		bgLayer.destroy();
		drawer.destroy();
	},
};

// ------------------------------------------------------------ 异步拉取激活状态与壁纸（非阻塞后台拉取）
async function loadInitialState() {
	try {
		const res = await fetch(`${API_BASE}/api/active`);
		const json = await res.json();
		if (json.ok) {
			state.activeId = json.activeId || "";
			state.favorites = json.favorites || [];
			state.settings = { ...state.settings, ...(json.settings || {}) };
			drawer.syncSettings(state);
			if (state.settings.audioReactive) {
				audioEngine.start();
			}
			scheduleAutoRotate();
		}
	} catch {
		/* ignore */
	}

	if (state.activeId) {
		fetch(`${API_BASE}/api/wallpapers`)
			.then((r) => r.json())
			.then((json) => {
				if (json.ok) {
					const item = json.wallpapers?.find((w) => w.id === state.activeId);
					if (item) void bgLayer.setWallpaper(item, state.settings);
				}
			})
			.catch(() => {});
	}
}

void loadInitialState();
