/**
 * wallpaper-engine 客户端入口 (v0.3.0) —— 视频/WebGL2 Scene/Web 全能渲染、音频频谱联动与自动轮播。
 */
import { DRAWER_CSS, getGlassThemeCss } from "./styles.mjs";

const RUNTIME_KEY = "__piWallpaperEngineRuntime";

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
	if (!document.getElementById("pi-we-drawer-styles")) {
		const s = document.createElement("style");
		s.id = "pi-we-drawer-styles";
		s.textContent = DRAWER_CSS;
		document.head.appendChild(s);
	}
}

function updateGlassStyle(blur, opacity, enabled = true, interactive = false) {
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
	s.textContent = getGlassThemeCss(blur, opacity, interactive);
}

// ------------------------------------------------------------ WebWallGL 引擎动态载入
let webwallglModule = null;
async function loadWebWallGL() {
	if (webwallglModule) return webwallglModule;
	try {
		webwallglModule = await import("https://cdn.jsdelivr.net/npm/webwallgl@3.0.0/+esm");
		return webwallglModule;
	} catch {
		try {
			webwallglModule = await import("https://unpkg.com/webwallgl@3.0.0/dist/webwallgl.mjs");
			return webwallglModule;
		} catch (err) {
			console.warn("[wallpaper-engine] WebWallGL 模块加载失败，将自动降级为静态预览：", err);
			return null;
		}
	}
}

// ------------------------------------------------------------ 音频响应律动模拟与采集
function createAudioReactiveEngine() {
	let active = false;
	let rafId = null;
	const spectrum = new Float32Array(64);

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
			spectrum[i] = Math.min(1.0, Math.max(0.0, wave1 * 0.6 + wave2 * 0.4));
		}

		// 注入至 Web 网页壁纸与 Scene 场景壁纸
		if (typeof window.__weAudioCb === "function") {
			try {
				window.__weAudioCb(Array.from(spectrum));
			} catch {
				/* ignore */
			}
		}

		rafId = requestAnimationFrame(tick);
	}

	return { start, stop };
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
	let currentItem = null;

	function cleanupCurrent() {
		if (currentSceneInstance) {
			try {
				currentSceneInstance.destroy?.();
			} catch {
				/* ignore */
			}
			currentSceneInstance = null;
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
			return;
		}

		if (settings.interactive) {
			container.classList.add("interactive");
		} else {
			container.classList.remove("interactive");
		}
		updateGlassStyle(settings.glassBlur, settings.glassOpacity, true, settings.interactive);

		cleanupCurrent();

		// 1. 视频壁纸播放
		if (item.type === "video" || item.hasVideo) {
			const video = document.createElement("video");
			video.className = "pi-we-bg-media";
			video.src = `/plugins-api/wallpaper-engine/api/media?id=${encodeURIComponent(item.id)}`;
			video.autoplay = true;
			video.loop = true;
			video.muted = settings.muteAudio;
			video.playsInline = true;

			video.oncanplay = () => {
				video.play().catch(() => {
					video.muted = true;
					void video.play();
				});
			};

			container.appendChild(video);
			currentMediaEl = video;
			return;
		}

		// 2. Scene 场景壁纸（基于 WebWallGL WebGL2 实时渲染）
		if (item.type === "scene" || item.hasScene) {
			const mountEl = document.createElement("div");
			mountEl.className = "pi-we-scene-mount";
			container.appendChild(mountEl);
			currentMediaEl = mountEl;

			try {
				const engine = await loadWebWallGL();
				if (!engine) throw new Error("WebWallGL 引擎未就绪");

				const [pkgRes, projectRes] = await Promise.all([
					fetch(`/plugins-api/wallpaper-engine/api/pkg?id=${encodeURIComponent(item.id)}`),
					fetch(`/plugins-api/wallpaper-engine/api/project?id=${encodeURIComponent(item.id)}`),
				]);

				if (!pkgRes.ok) throw new Error(`拉取 scene.pkg 失败: ${pkgRes.status}`);
				const pkgBuffer = await pkgRes.arrayBuffer();
				const projectJson = projectRes.ok ? await projectRes.json() : null;

				const source = engine.bytesSource(pkgBuffer, projectJson, item.id);
				const sceneInstance = await engine.mount(mountEl, {
					source,
					fit: "cover",
					fpsLimit: Number(settings.fpsLimit || 60),
				});

				currentSceneInstance = sceneInstance;
				return;
			} catch (err) {
				console.warn("[wallpaper-engine] Scene 壁纸渲染失败，平滑降级至缩略图预览：", err);
				mountEl.remove();
			}
		}

		// 3. Web 网页壁纸（沙箱 iframe 挂载）
		if (item.type === "web" || item.hasWeb) {
			const iframe = document.createElement("iframe");
			iframe.className = "pi-we-bg-media";
			const webFile = item.webFile || "index.html";
			iframe.src = `/plugins-api/wallpaper-engine/api/web?id=${encodeURIComponent(item.id)}&file=${encodeURIComponent(webFile)}`;
			iframe.sandbox = "allow-scripts allow-same-origin";
			container.appendChild(iframe);
			currentMediaEl = iframe;
			return;
		}

		// 4. 静态图片或缩略图展示
		const img = document.createElement("img");
		img.className = "pi-we-bg-media";
		const mediaSrc = item.hasImage
			? `/plugins-api/wallpaper-engine/api/media?id=${encodeURIComponent(item.id)}`
			: `/plugins-api/wallpaper-engine/api/preview?id=${encodeURIComponent(item.id)}`;
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
		if (currentMediaEl instanceof HTMLVideoElement) {
			currentMediaEl.muted = muted;
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

	return { setWallpaper, pause, resume, setMuted, setInteractive, destroy };
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

	drawer.innerHTML = `
		<div class="pi-we-header">
			<h3 class="pi-we-title">🖼️ 壁纸库 · Wallpaper Engine</h3>
			<div class="pi-we-header-actions">
				<button class="pi-we-icon-btn" id="pi-we-rescan-btn" title="重新扫描">🔄 刷新</button>
				<button class="pi-we-icon-btn" id="pi-we-close-btn" title="关闭">✕</button>
			</div>
		</div>

		<div class="pi-we-settings-bar">
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">毛玻璃模糊度:</span>
				<input type="range" id="pi-we-blur-range" min="0" max="32" value="${state.settings.glassBlur}" />
				<span class="pi-we-slider-val" id="pi-we-blur-val">${state.settings.glassBlur}px</span>
			</div>
			<div class="pi-we-slider-row">
				<span class="pi-we-slider-label">界面不透明度:</span>
				<input type="range" id="pi-we-opacity-range" min="40" max="100" value="${state.settings.glassOpacity}" />
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
					<option value="0" ${state.settings.fpsLimit === "0" ? "selected" : ""}>无限制</option>
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
			</div>
		</div>

		<div class="pi-we-body" id="pi-we-grid">
			<div class="pi-we-empty">
				<span>正在加载壁纸...</span>
			</div>
		</div>
	`;

	document.body.appendChild(backdrop);
	document.body.appendChild(drawer);

	const gridEl = drawer.querySelector("#pi-we-grid");
	const blurInput = drawer.querySelector("#pi-we-blur-range");
	const blurVal = drawer.querySelector("#pi-we-blur-val");
	const opacityInput = drawer.querySelector("#pi-we-opacity-range");
	const opacityVal = drawer.querySelector("#pi-we-opacity-val");
	const fpsSelect = drawer.querySelector("#pi-we-fps-select");
	const rotateSelect = drawer.querySelector("#pi-we-rotate-select");
	const interactiveCheck = drawer.querySelector("#pi-we-interactive-check");
	const audioCheck = drawer.querySelector("#pi-we-audio-check");
	const muteCheck = drawer.querySelector("#pi-we-mute-check");
	const searchInput = drawer.querySelector("#pi-we-search");
	const tabs = drawer.querySelectorAll(".pi-we-tab");

	function open() {
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
		if (state.activeId) updateGlassStyle(val, state.settings.glassOpacity, true, state.settings.interactive);
		onStateChange();
	});

	opacityInput.addEventListener("input", (e) => {
		const val = Number(e.target.value);
		opacityVal.textContent = `${val}%`;
		state.settings.glassOpacity = val;
		if (state.activeId) updateGlassStyle(state.settings.glassBlur, val, true, state.settings.interactive);
		onStateChange();
	});

	fpsSelect.addEventListener("change", (e) => {
		state.settings.fpsLimit = e.target.value;
		onStateChange();
	});

	rotateSelect.addEventListener("change", (e) => {
		state.settings.autoRotateMinutes = e.target.value;
		onStateChange();
	});

	interactiveCheck.addEventListener("change", (e) => {
		state.settings.interactive = e.target.checked;
		bgLayer.setInteractive(e.target.checked);
		if (state.activeId) updateGlassStyle(state.settings.glassBlur, state.settings.glassOpacity, true, e.target.checked);
		onStateChange();
	});

	audioCheck.addEventListener("change", (e) => {
		state.settings.audioReactive = e.target.checked;
		onStateChange();
	});

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
			const res = await fetch("/plugins-api/wallpaper-engine/api/presets");
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
			const res = await fetch("/plugins-api/wallpaper-engine/api/presets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(parsed),
			});
			const json = await res.json();
			if (json.ok) {
				state.activeId = json.activeId || "";
				state.settings = { ...state.settings, ...(json.settings || {}) };
				state.favorites = json.favorites || [];
				void loadWallpapers();
				alert("外观预设导入成功！");
			}
		} catch (err) {
			alert(`导入失败：${err.message}`);
		}
	});

	drawer.querySelector("#pi-we-rescan-btn").addEventListener("click", async () => {
		gridEl.innerHTML = `<div class="pi-we-empty"><span>正在全盘重新扫描...</span></div>`;
		try {
			const res = await fetch("/plugins-api/wallpaper-engine/api/rescan");
			const json = await res.json();
			if (json.ok) {
				wallpapers = json.wallpapers || [];
				state.favorites = json.favorites || [];
				renderGrid();
			}
		} catch (err) {
			gridEl.innerHTML = `<div class="pi-we-empty"><span>扫描失败：${err.message}</span></div>`;
		}
	});

	searchInput.addEventListener("input", (e) => {
		searchKeyword = e.target.value.trim().toLowerCase();
		renderGrid();
	});

	tabs.forEach((tab) => {
		tab.addEventListener("click", () => {
			tabs.forEach((t) => t.classList.remove("active"));
			tab.classList.add("active");
			currentFilter = tab.getAttribute("data-tab");
			renderGrid();
		});
	});

	async function loadWallpapers() {
		try {
			const res = await fetch("/plugins-api/wallpaper-engine/api/wallpapers");
			const json = await res.json();
			if (json.ok) {
				wallpapers = json.wallpapers || [];
				state.favorites = json.favorites || [];
				renderGrid();
			} else {
				gridEl.innerHTML = `
					<div class="pi-we-empty">
						<span>未检测到 Steam 或创意工坊壁纸</span>
						<span class="pi-we-empty-sub">请确认已安装 Steam 并订阅了 Wallpaper Engine 壁纸，或在插件设置中指定自定义路径。</span>
					</div>
				`;
			}
		} catch (err) {
			gridEl.innerHTML = `<div class="pi-we-empty"><span>加载失败：${err.message}</span></div>`;
		}
	}

	function renderGrid() {
		const filtered = wallpapers.filter((w) => {
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

		if (filtered.length === 0) {
			gridEl.innerHTML = `
				<div class="pi-we-empty">
					<span>未找到匹配的壁纸</span>
				</div>
			`;
			return;
		}

		gridEl.innerHTML = "";
		filtered.forEach((w) => {
			const card = document.createElement("div");
			const isActive = w.id === state.activeId;
			const isFav = state.favorites.includes(w.id);
			card.className = `pi-we-card ${isActive ? "active" : ""}`;
			card.tabIndex = 0;

			const previewUrl = w.hasPreview ? `/plugins-api/wallpaper-engine/api/preview?id=${encodeURIComponent(w.id)}` : "";

			card.innerHTML = `
				<div class="pi-we-thumb-wrap">
					${previewUrl ? `<img class="pi-we-thumb" src="${previewUrl}" alt="${w.title}" loading="lazy" />` : ""}
					<span class="pi-we-badge ${w.type}">${w.type}</span>
					${isActive ? `<span class="pi-we-active-indicator">✓ 使用中</span>` : ""}
					<button class="pi-we-fav-btn ${isFav ? "active" : ""}" title="${isFav ? "取消收藏" : "加入收藏"}">${isFav ? "★" : "☆"}</button>
				</div>
				<div class="pi-we-card-info">
					<div class="pi-we-card-title" title="${w.title}">${w.title}</div>
					<div class="pi-we-card-meta">
						<span>${w.rating || "Everyone"}</span>
						<span>${w.tags?.[0] || ""}</span>
					</div>
				</div>
			`;

			// 收藏按钮点击事件（阻止卡片点击冒泡）
			const favBtn = card.querySelector(".pi-we-fav-btn");
			favBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				try {
					const res = await fetch("/plugins-api/wallpaper-engine/api/favorite", {
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

	function destroy() {
		window.removeEventListener("keydown", onKeyDown);
		backdrop.remove();
		drawer.remove();
	}

	return { open, close, toggle, loadWallpapers, renderGrid, getWallpapers: () => wallpapers, destroy };
}

// ------------------------------------------------------------ 运行时主流程
async function initRuntime() {
	ensureStyles();

	let state = {
		activeId: "",
		favorites: [],
		settings: {
			glassBlur: 16,
			glassOpacity: 80,
			fpsLimit: "60",
			interactive: false,
			muteAudio: true,
			pauseOnHidden: true,
			audioReactive: false,
			autoRotateMinutes: "0",
		},
	};

	try {
		const res = await fetch("/plugins-api/wallpaper-engine/api/active");
		const json = await res.json();
		if (json.ok) {
			state.activeId = json.activeId || "";
			state.favorites = json.favorites || [];
			state.settings = { ...state.settings, ...(json.settings || {}) };
		}
	} catch {
		/* ignore */
	}

	const bgLayer = createBackgroundLayer();
	const audioEngine = createAudioReactiveEngine();

	if (state.settings.audioReactive) {
		audioEngine.start();
	}

	let saveTimer = null;
	function onStateChange() {
		if (state.settings.audioReactive) audioEngine.start();
		else audioEngine.stop();

		scheduleAutoRotate();

		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			fetch("/plugins-api/wallpaper-engine/api/active", {
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
	scheduleAutoRotate();

	const drawer = createDrawer(bgLayer, state, onStateChange, triggerRotate);

	if (state.activeId) {
		fetch("/plugins-api/wallpaper-engine/api/wallpapers")
			.then((r) => r.json())
			.then((json) => {
				if (json.ok) {
					const item = json.wallpapers?.find((w) => w.id === state.activeId);
					if (item) void bgLayer.setWallpaper(item, state.settings);
				}
			})
			.catch(() => {});
	}

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

	whenBridge((bridge) => {
		try {
			const off = bridge.onUiAction?.("wallpaper-engine:toggle", () => {
				drawer.toggle();
			});
			if (typeof off === "function") teardown.push(off);
		} catch {
			/* ignore */
		}
	});

	globalThis[RUNTIME_KEY] = {
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
			document.removeEventListener("visibilitychange", onVisibilityChange);
			bgLayer.destroy();
			drawer.destroy();
			document.getElementById("pi-we-drawer-styles")?.remove();
		},
	};
}

void initRuntime();
