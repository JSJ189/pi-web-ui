/**
 * Live2D 挂件组件控制器 (DOM、手势、气泡、右键菜单、设置面板与音效)
 */
import { Live2DStage, ensureLive2dEngine } from "./engine.mjs";
import { getAllModels, saveCustomModels, loadCustomModels } from "./models.mjs";
import { WIDGET_CSS } from "./styles.mjs";

const POS_STORAGE_KEY = "pi-web-ui:live2d-pos";
const CONFIG_STORAGE_KEY = "pi-web-ui:live2d-config";

/** HTML 转义：所有外部可控文本（模型名等）进 innerHTML 前必过此函数。 */
function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (c) => {
		return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
	});
}

function playChirpSound() {
	try {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return;
		const ctx = new Ctx();
		if (ctx.state === "suspended") void ctx.resume();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.setValueAtTime(880, ctx.currentTime);
		osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
		gain.gain.setValueAtTime(0.08, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start();
		osc.stop(ctx.currentTime + 0.15);
	} catch {}
}

export class Live2DWidget {
	constructor(options = {}) {
		this.clientBase = options.clientBase || "/plugins/live2d/client";
		this.t = options.t || ((k) => k);
		this.config = this._loadConfig();
		this.models = getAllModels(this.clientBase);
		this.activeModel = this.models.find((m) => m.key === this.config.modelKey) || this.models[0];

		this.stage = null;
		this.container = null;
		this.bodyWrap = null;
		this.canvas = null;
		this.bubbleEl = null;
		this.bubbleTimer = null;
		this.contextMenuEl = null;
		this.modalEl = null;
		this._hideTimer = null;
		this._onPointerMove = null;
		this._onPointerUp = null;

		// 清理旧版本遗留的最小化悬浮药丸
		document.getElementById("pi-l2d-minimized-pill")?.remove();

		this.width = Math.round(280 * (this.config.scale || 1.0));
		this.height = Math.round(340 * (this.config.scale || 1.0));
		this.visible = this.config.enabled !== false;

		this._initStyles();
		this._buildDOM();
		this._setupGestures();
		this._setupEvents();
	}

	_loadConfig() {
		try {
			const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
			if (raw) return JSON.parse(raw);
		} catch {}
		return {
			enabled: true,
			modelKey: "shizuku",
			mode: "mouse",
			scale: 1.0,
			clickThrough: false,
			reactToAgent: true,
			soundEnabled: true,
		};
	}

	_saveConfig() {
		try {
			localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));
		} catch {}
	}

	_initStyles() {
		let style = document.getElementById("pi-live2d-styles");
		if (!style) {
			style = document.createElement("style");
			style.id = "pi-live2d-styles";
			document.head.appendChild(style);
		}
		style.textContent = WIDGET_CSS;
	}

	_buildDOM() {
		// 1. 全局挂件容器
		const container = document.createElement("div");
		container.id = "pi-live2d-companion";
		if (!this.visible) {
			container.classList.add("pi-l2d-hidden");
			container.style.display = "none";
		}
		if (this.config.clickThrough) container.classList.add("pi-l2d-click-through");

		// 恢复位置
		this._applyStoredPosition(container);

		// 2. 气泡框
		const bubble = document.createElement("div");
		bubble.className = "pi-l2d-bubble";
		bubble.innerHTML = `
			<span class="pi-l2d-bubble-text">${this.t("bubble.default")}</span>
			<button class="pi-l2d-bubble-close">✕</button>
		`;
		bubble.querySelector(".pi-l2d-bubble-close").addEventListener("click", (e) => {
			e.stopPropagation();
			this.hideBubble();
		});
		this.bubbleEl = bubble;
		container.appendChild(bubble);

		// 3. 挂件主体包裹与 Canvas
		const bodyWrap = document.createElement("div");
		bodyWrap.className = "pi-l2d-body-wrap";
		this.bodyWrap = bodyWrap;

		const canvas = document.createElement("canvas");
		canvas.className = "pi-l2d-canvas";
		canvas.width = this.width;
		canvas.height = this.height;
		canvas.style.width = `${this.width}px`;
		canvas.style.height = `${this.height}px`;
		this.canvas = canvas;
		bodyWrap.appendChild(canvas);

		// 4. 悬浮快捷工具条
		const actionsBar = document.createElement("div");
		actionsBar.className = "pi-l2d-actions-bar";
		actionsBar.innerHTML = `
			<button class="pi-l2d-action-btn" data-action="exp" title="${this.t("actions.expressions")}">🎭</button>
			<button class="pi-l2d-action-btn" data-action="switch" title="${this.t("actions.switch_model")}">🔄</button>
			<button class="pi-l2d-action-btn" data-action="mode" title="${this.t("actions.mode")}">👀</button>
			<button class="pi-l2d-action-btn" data-action="ghost" title="${this.t("actions.click_through")}">👻</button>
			<button class="pi-l2d-action-btn" data-action="settings" title="${this.t("actions.settings")}">⚙️</button>
			<button class="pi-l2d-action-btn" data-action="close" title="${this.t("actions.close")}">✕</button>
		`;
		actionsBar.addEventListener("click", (e) => {
			const btn = e.target.closest(".pi-l2d-action-btn");
			if (!btn) return;
			e.stopPropagation();
			const act = btn.dataset.action;
			if (act === "exp") this._showExpressionsMenu(btn);
			else if (act === "switch") this._showModelsMenu(btn);
			else if (act === "mode") this._toggleMode();
			else if (act === "ghost") this.toggleClickThrough();
			else if (act === "settings") this.openSettings();
			else if (act === "close") this.hide();
		});
		bodyWrap.appendChild(actionsBar);

		container.appendChild(bodyWrap);
		document.body.appendChild(container);
		this.container = container;
	}

	_applyStoredPosition(el) {
		try {
			const raw = localStorage.getItem(POS_STORAGE_KEY);
			if (raw) {
				const pos = JSON.parse(raw);
				if (pos.right !== undefined) el.style.right = `${pos.right}px`;
				if (pos.bottom !== undefined) el.style.bottom = `${pos.bottom}px`;
				if (pos.left !== undefined) {
					el.style.left = `${pos.left}px`;
					el.style.right = "auto";
				}
				if (pos.top !== undefined) {
					el.style.top = `${pos.top}px`;
					el.style.bottom = "auto";
				}
				return;
			}
		} catch {}
		// 默认右下角停靠
		el.style.right = "24px";
		el.style.bottom = "24px";
	}

	_abortDragging() {
		if (this.isDragging) {
			this.isDragging = false;
			if (this._onPointerMove) window.removeEventListener("pointermove", this._onPointerMove);
			if (this._onPointerUp) window.removeEventListener("pointerup", this._onPointerUp);
			this._onPointerMove = null;
			this._onPointerUp = null;
		}
	}

	_setupGestures() {
		// 拖拽手势
		this.isDragging = false;
		let startX = 0;
		let startY = 0;
		let origLeft = 0;
		let origTop = 0;
		let moved = false;

		const onPointerDown = (e) => {
			if (!this.visible || this.config.clickThrough) return;
			if (e.button !== 0) return; // 仅左键拖拽
			if (e.target.closest(".pi-l2d-actions-bar") || e.target.closest(".pi-l2d-bubble")) return;
			// 角色外围完全透明空白区域不拦截点击与拖拽
			if (this.stage?.isPixelTransparent(e.clientX, e.clientY)) return;

			this.isDragging = true;
			moved = false;
			startX = e.clientX;
			startY = e.clientY;

			const rect = this.container.getBoundingClientRect();
			origLeft = rect.left;
			origTop = rect.top;

			// 将定位切换为 left/top 绝对控制
			this.container.style.left = `${origLeft}px`;
			this.container.style.top = `${origTop}px`;
			this.container.style.right = "auto";
			this.container.style.bottom = "auto";

			this._onPointerMove = onPointerMove;
			this._onPointerUp = onPointerUp;
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", onPointerUp);
		};

		const onPointerMove = (e) => {
			if (!this.isDragging || !this.visible) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
				moved = true;
			}
			let newLeft = origLeft + dx;
			let newTop = origTop + dy;

			// 限制在窗口可视边界内
			const maxLeft = window.innerWidth - this.width - 10;
			const maxTop = window.innerHeight - this.height - 10;
			newLeft = Math.max(10, Math.min(maxLeft, newLeft));
			newTop = Math.max(10, Math.min(maxTop, newTop));

			this.container.style.left = `${newLeft}px`;
			this.container.style.top = `${newTop}px`;
		};

		const onPointerUp = (e) => {
			if (!this.isDragging) return;
			this.isDragging = false;
			if (this._onPointerMove) window.removeEventListener("pointermove", this._onPointerMove);
			if (this._onPointerUp) window.removeEventListener("pointerup", this._onPointerUp);
			this._onPointerMove = null;
			this._onPointerUp = null;

			if (!this.visible) return;

			if (moved) {
				// 保存位置
				const rect = this.container.getBoundingClientRect();
				try {
					localStorage.setItem(
						POS_STORAGE_KEY,
						JSON.stringify({
							left: Math.round(rect.left),
							top: Math.round(rect.top),
						}),
					);
				} catch {}
			} else {
				// 单击处理
				this._handleClick(e);
			}
		};

		this.canvas.addEventListener("pointerdown", onPointerDown);

		// 滚轮缩放手势
		this.container.addEventListener(
			"wheel",
			(e) => {
				if (!this.visible || this.config.clickThrough) return;
				if (this.stage?.isPixelTransparent(e.clientX, e.clientY)) return;
				e.preventDefault();
				const delta = e.deltaY > 0 ? -0.05 : 0.05;
				let nextScale = (this.config.scale || 1.0) + delta;
				nextScale = Math.max(0.4, Math.min(2.0, Math.round(nextScale * 100) / 100));
				this.setScale(nextScale);
			},
			{ passive: false },
		);
	}

	_setupEvents() {
		// 右键菜单
		this.canvas.addEventListener("contextmenu", (e) => {
			if (!this.visible || this.config.clickThrough) return;
			if (this.stage?.isPixelTransparent(e.clientX, e.clientY)) return;
			e.preventDefault();
			e.stopPropagation();
			this._showContextMenu(e.clientX, e.clientY);
		});

		// 双击互动
		this.canvas.addEventListener("dblclick", (e) => {
			if (!this.visible || this.config.clickThrough) return;
			if (this.stage?.isPixelTransparent(e.clientX, e.clientY)) return;
			e.preventDefault();
			e.stopPropagation();
			this._handleDoubleClick();
		});

		// 全局点击关闭菜单
		window.addEventListener("click", () => {
			this._closeContextMenu();
		});
	}

	_setupStageHover() {
		if (!this.stage) return;
		this.stage.onHoverPixel = (transparent) => {
			if (!this.visible || this.config.clickThrough || this.isDragging) return;
			if (transparent === true) {
				// 鼠标悬停在角色周围的透明空白区域：完全穿透到网页下层
				if (this.canvas) this.canvas.style.pointerEvents = "none";
				if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "none";
			} else {
				// 鼠标悬停在角色身体或移出 canvas 区域：恢复正常交互
				if (this.canvas) this.canvas.style.pointerEvents = "auto";
				if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "auto";
			}
		};
	}

	toggleClickThrough(forced) {
		const next = typeof forced === "boolean" ? forced : !this.config.clickThrough;
		this.config.clickThrough = next;
		this._saveConfig();

		if (next) {
			this._abortDragging();
			this.container?.classList.add("pi-l2d-click-through");
			if (this.canvas) this.canvas.style.pointerEvents = "";
			if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "";
			this.showBubble(this.t("toast.click_through_on"), 3500);
		} else {
			this.container?.classList.remove("pi-l2d-click-through");
			if (this.canvas) this.canvas.style.pointerEvents = "auto";
			if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "auto";
			this.showBubble(this.t("toast.click_through_off"), 3000);
		}
	}

	async start() {
		try {
			await ensureLive2dEngine(this.clientBase);
			this.stage = new Live2DStage(this.canvas, {
				mode: this.config.mode || "mouse",
			});
			await this.stage.init();
			await this.stage.loadModel(this.activeModel);

			this._setupStageHover();

			if (!this.visible) {
				this.stage.stop();
			} else {
				// 初次启动弹出一句亲切的问候气泡
				setTimeout(() => {
					this.showBubble(this.t("bubble.default"), 4500);
				}, 600);
			}
		} catch (err) {
			console.error("[live2d] 初始化挂件失败:", err);
		}
	}

	async switchModel(modelKey) {
		const target = this.models.find((m) => m.key === modelKey);
		if (!target || !this.stage) return;
		const prevModel = this.activeModel;
		const prevKey = this.config.modelKey;
		this.activeModel = target;
		this.config.modelKey = modelKey;
		this._saveConfig();

		this.showBubble(`${this.t("toast.switched_model")}${target.name}`, 3000);
		if (this.config.soundEnabled) playChirpSound();
		try {
			await this.stage.loadModel(target);
		} catch (err) {
			console.error("[live2d] 模型切换失败，回退到先前模型:", err);
			this.showBubble(`加载 ${target.name} 失败，已恢复`, 3500);
			this.activeModel = prevModel;
			this.config.modelKey = prevKey;
			this._saveConfig();
			if (prevModel) {
				try {
					await this.stage.loadModel(prevModel);
				} catch {}
			}
		}
	}

	_toggleMode() {
		const nextMode = this.config.mode === "mouse" ? "idle" : "mouse";
		this.config.mode = nextMode;
		this._saveConfig();
		this.stage?.setMode(nextMode);
		const label = nextMode === "mouse" ? this.t("menu.mode.mouse") : this.t("menu.mode.idle");
		this.showBubble(`${this.t("toast.switched_mode")}${label}`, 2500);
	}

	setScale(scale) {
		this.config.scale = scale;
		this._saveConfig();
		this.width = Math.round(280 * scale);
		this.height = Math.round(340 * scale);
		this.canvas.style.width = `${this.width}px`;
		this.canvas.style.height = `${this.height}px`;
		this.stage?.resize(this.width, this.height);
	}

	_handleClick(e) {
		if (!this.stage) return;
		const area = this.stage.hitTest(e.clientX, e.clientY);

		if (this.config.soundEnabled) playChirpSound();

		if (area === "head") {
			this.stage.playMotion("flick_head") || this.stage.playMotion("Tap") || this.stage.playMotion("TapBody");
			this.stage.playExpression("happy");
			this.showBubble(this.t("bubble.poke_head"), 3500);
		} else if (area === "mouth") {
			this.stage.playExpression("surprised");
			this.showBubble(this.t("bubble.poke_mouth"), 3500);
		} else {
			this.stage.playMotion("tap_body") || this.stage.playMotion("Tap") || this.stage.playMotion("TapBody");
			this.stage.playExpression("blush") || this.stage.playExpression("happy");
			this.showBubble(this.t("bubble.poke_body"), 3500);
		}
	}

	_handleDoubleClick() {
		if (!this.stage) return;
		this.stage.playMotion("shake") || this.stage.playMotion("Tap");
		this.stage.playExpression("happy");
		const quotes = [
			this.t("bubble.random1"),
			this.t("bubble.random2"),
			this.t("bubble.random3"),
			this.t("bubble.random4"),
		];
		const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
		this.showBubble(randomQuote, 4000);
	}

	showBubble(text, duration = 4000) {
		if (!this.bubbleEl || !this.visible) return;
		const textSpan = this.bubbleEl.querySelector(".pi-l2d-bubble-text");
		if (textSpan) textSpan.textContent = text;

		this.bubbleEl.classList.add("pi-l2d-bubble-visible");

		if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
		if (duration > 0) {
			this.bubbleTimer = setTimeout(() => {
				this.hideBubble();
			}, duration);
		}
	}

	hideBubble() {
		if (this.bubbleEl) {
			this.bubbleEl.classList.remove("pi-l2d-bubble-visible");
		}
		if (this.bubbleTimer) {
			clearTimeout(this.bubbleTimer);
			this.bubbleTimer = null;
		}
	}

	show() {
		this.visible = true;
		this.config.enabled = true;
		this._saveConfig();
		if (this._hideTimer) {
			clearTimeout(this._hideTimer);
			this._hideTimer = null;
		}
		if (this.container) {
			this.container.style.display = "";
			void this.container.offsetHeight;
			this.container.classList.remove("pi-l2d-hidden");
		}
		if (this.canvas) this.canvas.style.pointerEvents = "auto";
		if (this.bodyWrap) this.bodyWrap.style.pointerEvents = "auto";
		this.stage?.start();
		this.showBubble(this.t("bubble.default"), 3000);
	}

	hide() {
		this.visible = false;
		this.config.enabled = false;
		this._saveConfig();
		this.hideBubble();
		this._closeContextMenu();
		this._abortDragging();
		if (this.modalEl) {
			this.modalEl.remove();
			this.modalEl = null;
		}
		this.stage?.stop();
		if (this.container) {
			this.container.classList.add("pi-l2d-hidden");
			if (this._hideTimer) clearTimeout(this._hideTimer);
			this._hideTimer = setTimeout(() => {
				if (!this.visible && this.container) {
					this.container.style.display = "none";
				}
			}, 260);
		}
	}

	toggle() {
		if (this.visible) this.hide();
		else this.show();
	}

	// ── 右键上下文菜单 ──────────────────────────────────────────
	_showContextMenu(clientX, clientY) {
		this._closeContextMenu();

		const menu = document.createElement("div");
		menu.className = "pi-l2d-contextmenu";

		// 模式
		menu.appendChild(this._createMenuTitle(this.t("menu.mode")));
		const isMouse = this.config.mode === "mouse";
		menu.appendChild(
			this._createMenuItem(this.t("menu.mode.mouse"), isMouse, () => {
				this.config.mode = "mouse";
				this._saveConfig();
				this.stage?.setMode("mouse");
			}),
		);
		menu.appendChild(
			this._createMenuItem(this.t("menu.mode.idle"), !isMouse, () => {
				this.config.mode = "idle";
				this._saveConfig();
				this.stage?.setMode("idle");
			}),
		);
		menu.appendChild(
			this._createMenuItem(
				this.config.clickThrough ? this.t("menu.click_through_disable") : this.t("menu.click_through_enable"),
				Boolean(this.config.clickThrough),
				() => {
					this.toggleClickThrough();
				},
			),
		);

		menu.appendChild(this._createDivider());

		// 表情
		const expressions = this.stage?.expressions || [];
		if (expressions.length > 0) {
			menu.appendChild(this._createMenuTitle(this.t("menu.expressions")));
			const previewExps = expressions.slice(0, 5);
			for (const exp of previewExps) {
				menu.appendChild(
					this._createMenuItem(`🎭 ${exp}`, false, () => {
						this.stage?.playExpression(exp);
					}),
				);
			}
			menu.appendChild(this._createDivider());
		}

		// 角色
		menu.appendChild(this._createMenuTitle(this.t("menu.models")));
		for (const m of this.models) {
			menu.appendChild(
				this._createMenuItem(m.name, m.key === this.activeModel.key, () => {
					this.switchModel(m.key);
				}),
			);
		}

		menu.appendChild(this._createDivider());

		// 恢复位置
		menu.appendChild(
			this._createMenuItem(this.t("menu.reset_pos"), false, () => {
				localStorage.removeItem(POS_STORAGE_KEY);
				this.container.style.left = "auto";
				this.container.style.top = "auto";
				this.container.style.right = "24px";
				this.container.style.bottom = "24px";
			}),
		);

		// 设置
		menu.appendChild(
			this._createMenuItem(this.t("menu.settings"), false, () => {
				this.openSettings();
			}),
		);

		// 收起
		menu.appendChild(
			this._createMenuItem(this.t("menu.hide"), false, () => {
				this.hide();
			}),
		);

		document.body.appendChild(menu);
		this.contextMenuEl = menu;

		// 调整坐标避免超出屏幕
		const menuW = 200;
		const menuH = menu.offsetHeight || 280;
		const x = Math.min(window.innerWidth - menuW - 10, clientX);
		const y = Math.min(window.innerHeight - menuH - 10, clientY);
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;

		requestAnimationFrame(() => menu.classList.add("pi-l2d-menu-visible"));
	}

	_showExpressionsMenu(anchorBtn) {
		const rect = anchorBtn.getBoundingClientRect();
		this._showContextMenu(rect.left - 200, rect.top);
	}

	_showModelsMenu(anchorBtn) {
		const rect = anchorBtn.getBoundingClientRect();
		this._showContextMenu(rect.left - 200, rect.top);
	}

	_createMenuTitle(text) {
		const el = document.createElement("div");
		el.className = "pi-l2d-menu-group-title";
		el.textContent = text;
		return el;
	}

	_createMenuItem(text, active, onClick) {
		const el = document.createElement("div");
		el.className = "pi-l2d-menu-item" + (active ? " active" : "");
		el.textContent = text;
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			this._closeContextMenu();
			onClick();
		});
		return el;
	}

	_createDivider() {
		const el = document.createElement("div");
		el.className = "pi-l2d-menu-divider";
		return el;
	}

	_closeContextMenu() {
		if (this.contextMenuEl) {
			this.contextMenuEl.remove();
			this.contextMenuEl = null;
		}
	}

	// ── 设置弹窗 ──────────────────────────────────────────────────
	openSettings() {
		if (this.modalEl) return;

		const overlay = document.createElement("div");
		overlay.className = "pi-l2d-modal-overlay";

		const card = document.createElement("div");
		card.className = "pi-l2d-modal-card";
		card.innerHTML = `
			<div class="pi-l2d-modal-head">
				<span>${this.t("settings.title")}</span>
				<button class="pi-l2d-bubble-close" id="pi-l2d-close-settings">✕</button>
			</div>
			<div class="pi-l2d-modal-body">
				<!-- 1. 已配置角色列表 -->
				<div class="pi-l2d-form-group">
					<label class="pi-l2d-form-label">${this.t("settings.models")}</label>
					<div id="pi-l2d-models-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
				</div>

				<!-- 2. 本地模型上传区 -->
				<div class="pi-l2d-form-group">
					<label class="pi-l2d-form-label">${this.t("settings.upload_title")}</label>
					<div class="pi-l2d-dropzone" id="pi-l2d-dropzone">
						<div class="pi-l2d-dropzone-icon">📦</div>
						<div class="pi-l2d-dropzone-title">${this.t("settings.upload_title")}</div>
						<div class="pi-l2d-dropzone-desc">${this.t("settings.upload_desc")}</div>
						<div class="pi-l2d-upload-actions">
							<button type="button" class="pi-l2d-btn pi-l2d-btn-primary" id="pi-l2d-btn-upload-zip">${this.t("settings.upload_zip_btn")}</button>
							<button type="button" class="pi-l2d-btn" id="pi-l2d-btn-upload-folder">${this.t("settings.upload_folder_btn")}</button>
						</div>
						<div class="pi-l2d-upload-status" id="pi-l2d-upload-status" style="display: none;"></div>
					</div>
					<input type="file" id="pi-l2d-file-zip" accept=".zip,application/zip" style="display:none;" />
					<input type="file" id="pi-l2d-file-folder" webkitdirectory directory multiple style="display:none;" />
				</div>

				<!-- 3. 外部 URL 导入 -->
				<div class="pi-l2d-form-group" style="padding: 12px; background: var(--bg, #0d0f14); border-radius: 8px; border: 1px solid var(--border, #334155);">
					<label class="pi-l2d-form-label">${this.t("settings.add_model")}</label>
					<input class="pi-l2d-input" id="pi-l2d-new-name" placeholder="${this.t("settings.model_name")}" />
					<input class="pi-l2d-input" id="pi-l2d-new-url" placeholder="${this.t("settings.model_url")}" style="margin-top:6px;" />
					<button class="pi-l2d-btn" id="pi-l2d-btn-add" style="margin-top:8px; align-self: flex-start;">${this.t("settings.add_model")}</button>
				</div>

				<!-- 4. 交互选项开关 -->
				<div class="pi-l2d-switch-row" style="padding: 10px 12px; background: var(--bg-elev2, #1e222b); border-radius: 8px;">
					<div>
						<div style="font-weight: 500;">${this.t("settings.click_through")}</div>
						<div style="font-size: 11.5px; color: var(--text-faint, #64748b); margin-top: 2px;">${this.t("settings.click_through_hint")}</div>
					</div>
					<input type="checkbox" id="pi-l2d-cfg-clickthrough" ${this.config.clickThrough ? "checked" : ""} />
				</div>

				<div class="pi-l2d-switch-row">
					<span>${this.t("settings.react_agent")}</span>
					<input type="checkbox" id="pi-l2d-cfg-react" ${this.config.reactToAgent ? "checked" : ""} />
				</div>

				<div class="pi-l2d-switch-row">
					<span>${this.t("settings.sound")}</span>
					<input type="checkbox" id="pi-l2d-cfg-sound" ${this.config.soundEnabled ? "checked" : ""} />
				</div>
			</div>
			<div class="pi-l2d-modal-foot">
				<button class="pi-l2d-btn pi-l2d-btn-primary" id="pi-l2d-save-settings">${this.t("settings.save")}</button>
			</div>
		`;

		overlay.appendChild(card);
		document.body.appendChild(overlay);
		this.modalEl = overlay;

		const renderModelsList = () => {
			const listEl = card.querySelector("#pi-l2d-models-list");
			listEl.innerHTML = "";
			for (const m of this.models) {
				const isCur = m.key === this.activeModel.key;
				const isCustom = m.isUploaded || m.key.startsWith("upload_") || m.key.startsWith("custom_");
				const row = document.createElement("div");
				row.style.cssText =
					"display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:var(--bg-elev2,#1e222b); border-radius:6px;";
				row.innerHTML = `
					<div style="font-size:13px; font-weight:${isCur ? "600" : "400"}; color:${isCur ? "var(--accent,#3b82f6)" : "inherit"}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:260px;">${escapeHtml(m.name)}</div>
					<div style="display:flex; gap:6px; align-items:center;">
						${!isCur ? `<button class="pi-l2d-btn pi-l2d-btn-apply" data-key="${escapeHtml(m.key)}" style="padding:4px 8px; font-size:12px;">${this.t("settings.apply")}</button>` : '<span style="font-size:12px; color:var(--accent,#3b82f6);">✓</span>'}
						${isCustom ? `<button class="pi-l2d-btn-del" data-key="${escapeHtml(m.key)}" title="${this.t("settings.del")}">🗑️</button>` : ""}
					</div>
				`;
				row.querySelector(".pi-l2d-btn-apply")?.addEventListener("click", () => {
					this.switchModel(m.key);
					renderModelsList();
				});
				row.querySelector(".pi-l2d-btn-del")?.addEventListener("click", async () => {
					try {
						await fetch("/plugins-api/live2d/delete-model", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ key: m.key }),
						});
					} catch {}
					const idx = this.models.findIndex((x) => x.key === m.key);
					if (idx !== -1) this.models.splice(idx, 1);
					const customs = loadCustomModels().filter((x) => x.key !== m.key);
					saveCustomModels(customs);
					if (this.activeModel.key === m.key) {
						await this.switchModel("shizuku");
					}
					renderModelsList();
				});
				listEl.appendChild(row);
			}
		};
		renderModelsList();

		// 上传状态提示处理
		const statusEl = card.querySelector("#pi-l2d-upload-status");
		const fileZipInput = card.querySelector("#pi-l2d-file-zip");
		const fileFolderInput = card.querySelector("#pi-l2d-file-folder");
		const dropzoneEl = card.querySelector("#pi-l2d-dropzone");

		// 1. 处理 ZIP 模型上传
		const handleZipFile = async (file) => {
			if (!file) return;
			statusEl.style.display = "flex";
			statusEl.className = "pi-l2d-upload-status loading";
			statusEl.textContent = `⏳ ${this.t("settings.uploading")}`;
			try {
				const modelName = encodeURIComponent(file.name.replace(/\.zip$/i, ""));
				const res = await fetch(`/plugins-api/live2d/upload-zip?name=${modelName}`, {
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body: file,
				});
				const data = await res.json();
				if (!data.ok) throw new Error(data.error || "Upload failed");

				statusEl.className = "pi-l2d-upload-status";
				statusEl.style.color = "var(--green, #22c55e)";
				statusEl.textContent = `✓ ${this.t("settings.upload_success")}`;

				const newModel = data.model;
				const customs = loadCustomModels();
				customs.push(newModel);
				saveCustomModels(customs);
				this.models.push(newModel);
				await this.switchModel(newModel.key);
				renderModelsList();
			} catch (err) {
				statusEl.className = "pi-l2d-upload-status error";
				statusEl.textContent = `✗ ${this.t("settings.upload_failed")}${err.message}`;
			}
		};

		// 2. 处理文件夹模型上传
		const handleFolderFiles = async (fileList) => {
			if (!fileList || fileList.length === 0) return;
			const files = Array.from(fileList);
			const modelKey = "upload_" + Date.now();
			const folderName = files[0].webkitRelativePath?.split("/")[0] || "CustomModel";

			statusEl.style.display = "flex";
			statusEl.className = "pi-l2d-upload-status loading";
			statusEl.textContent = `⏳ ${this.t("settings.uploading")} (0/${files.length})`;

			try {
				let uploaded = 0;
				for (const file of files) {
					const relPath = file.webkitRelativePath || file.name;
					await fetch(`/plugins-api/live2d/upload-file?key=${modelKey}&relPath=${encodeURIComponent(relPath)}`, {
						method: "POST",
						headers: { "Content-Type": "application/octet-stream" },
						body: file,
					});
					uploaded++;
					statusEl.textContent = `⏳ ${this.t("settings.uploading")} (${uploaded}/${files.length})`;
				}

				const res = await fetch("/plugins-api/live2d/finish-folder-upload", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: modelKey, name: folderName }),
				});
				const data = await res.json();
				if (!data.ok) throw new Error(data.error || "Failed to parse model");

				statusEl.className = "pi-l2d-upload-status";
				statusEl.style.color = "var(--green, #22c55e)";
				statusEl.textContent = `✓ ${this.t("settings.upload_success")}`;

				const newModel = data.model;
				const customs = loadCustomModels();
				customs.push(newModel);
				saveCustomModels(customs);
				this.models.push(newModel);
				await this.switchModel(newModel.key);
				renderModelsList();
			} catch (err) {
				statusEl.className = "pi-l2d-upload-status error";
				statusEl.textContent = `✗ ${this.t("settings.upload_failed")}${err.message}`;
			}
		};

		// 绑定按钮触发文件选择
		card.querySelector("#pi-l2d-btn-upload-zip").addEventListener("click", () => {
			fileZipInput.click();
		});
		fileZipInput.addEventListener("change", (e) => {
			const file = e.target.files?.[0];
			if (file) handleZipFile(file);
			fileZipInput.value = "";
		});

		card.querySelector("#pi-l2d-btn-upload-folder").addEventListener("click", () => {
			fileFolderInput.click();
		});
		fileFolderInput.addEventListener("change", (e) => {
			if (e.target.files) handleFolderFiles(e.target.files);
			fileFolderInput.value = "";
		});

		// 拖拽 ZIP 上传支持
		dropzoneEl.addEventListener("dragover", (e) => {
			e.preventDefault();
			dropzoneEl.classList.add("dragover");
		});
		dropzoneEl.addEventListener("dragleave", () => {
			dropzoneEl.classList.remove("dragover");
		});
		dropzoneEl.addEventListener("drop", (e) => {
			e.preventDefault();
			dropzoneEl.classList.remove("dragover");
			const file = e.dataTransfer?.files?.[0];
			if (file) {
				if (file.name.toLowerCase().endsWith(".zip")) {
					handleZipFile(file);
				} else if (e.dataTransfer.files.length > 1) {
					handleFolderFiles(e.dataTransfer.files);
				}
			}
		});

		// 3. 外部 URL 导入模型
		card.querySelector("#pi-l2d-btn-add").addEventListener("click", () => {
			const nameInput = card.querySelector("#pi-l2d-new-name");
			const urlInput = card.querySelector("#pi-l2d-new-url");
			const name = nameInput.value.trim();
			const url = urlInput.value.trim();
			if (!name || !url) return;

			const key = "custom_" + Date.now();
			const newModel = {
				key,
				name: `✨ ${name}`,
				url,
				type: url.endsWith(".model.json") ? "cubism2" : "cubism4",
				scale: 1.0,
			};
			const customs = loadCustomModels();
			customs.push(newModel);
			saveCustomModels(customs);
			this.models.push(newModel);

			nameInput.value = "";
			urlInput.value = "";
			renderModelsList();
		});

		// 4. 保存设置并关闭
		const close = () => {
			const clickThroughChecked = card.querySelector("#pi-l2d-cfg-clickthrough").checked;
			if (clickThroughChecked !== Boolean(this.config.clickThrough)) {
				this.toggleClickThrough(clickThroughChecked);
			}
			this.config.reactToAgent = card.querySelector("#pi-l2d-cfg-react").checked;
			this.config.soundEnabled = card.querySelector("#pi-l2d-cfg-sound").checked;
			this._saveConfig();
			overlay.remove();
			this.modalEl = null;
		};

		card.querySelector("#pi-l2d-close-settings").addEventListener("click", close);
		card.querySelector("#pi-l2d-save-settings").addEventListener("click", close);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close();
		});
	}

	// ── AI 情绪联动响应 ──────────────────────────────────────────
	onAgentThinking() {
		if (!this.config.reactToAgent || !this.visible) return;
		this.stage?.playExpression("f00") || this.stage?.playExpression("neutral");
		this.showBubble(this.t("bubble.thinking"), 4000);
	}

	onAgentDone() {
		if (!this.config.reactToAgent || !this.visible) return;
		this.stage?.playExpression("happy") || this.stage?.playExpression("f01");
		this.stage?.playMotion("tap_body") || this.stage?.playMotion("Tap");
		this.showBubble(this.t("bubble.done"), 3500);
	}

	onAgentError() {
		if (!this.config.reactToAgent || !this.visible) return;
		this.stage?.playExpression("sad") || this.stage?.playExpression("f03");
		this.showBubble(this.t("bubble.error"), 4000);
	}

	destroy() {
		if (this._hideTimer) {
			clearTimeout(this._hideTimer);
			this._hideTimer = null;
		}
		this._abortDragging();
		this.hideBubble();
		this._closeContextMenu();
		document.getElementById("pi-l2d-minimized-pill")?.remove();
		if (this.modalEl) {
			this.modalEl.remove();
			this.modalEl = null;
		}
		if (this.container) this.container.remove();
		if (this.stage) this.stage.destroy();
	}
}
