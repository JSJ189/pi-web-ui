/**
 * wallpaper-engine 客户端样式注入 —— 多套专属炫酷毛玻璃主题、清晰度增强与壁纸抽屉组件样式。
 */

export const WALLPAPER_THEMES = {
	obsidian: {
		id: "wallpaper-obsidian",
		name: "🌑 黑曜冷月",
		accent: "#e2e8f0",
		accentSoft: "rgba(255, 255, 255, 0.14)",
		border: "rgba(255, 255, 255, 0.16)",
		borderSoft: "rgba(255, 255, 255, 0.08)",
		text: "#ffffff",
		textDim: "#cbd5e1",
		topbarBg: "rgba(6, 6, 8, 0.48)",
		panelBg: "rgba(8, 8, 12, 0.45)",
		cardBg: "rgba(12, 13, 18, 0.65)",
		inputboxBg: "rgba(14, 15, 22, 0.60)",
		userBg: "linear-gradient(135deg, rgba(30, 32, 40, 0.68) 0%, rgba(18, 19, 24, 0.58) 100%)",
		userBorder: "rgba(255, 255, 255, 0.30)",
		inputGlow: "rgba(255, 255, 255, 0.12)",
		inputFocusGlow: "rgba(255, 255, 255, 0.28)",
		focusBorder: "rgba(255, 255, 255, 0.65)",
		codeBg: "rgba(6, 7, 10, 0.85)",
		codeBorder: "rgba(255, 255, 255, 0.14)",
	},
};

function scaleAlpha(colorStr, factor) {
	if (!colorStr) return colorStr;
	return colorStr.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/g, (_, r, g, b, a) => {
		const newA = Math.max(0, Math.min(1, Number(a) * factor)).toFixed(3);
		return `rgba(${r}, ${g}, ${b}, ${newA})`;
	});
}

export function getGlassThemeCss(
	blur = 0,
	opacity = 40,
	interactive = false,
	themeKey = "obsidian",
	lightWallpaperMode = false,
) {
	const clampedBlur = Math.max(0, Math.min(Number(blur) || 0, 24));
	// 解除最小 40% 限制，支持 0%~100% 自由无级调节
	const opRatio = Math.max(0.0, Math.min(1.0, (Number(opacity) ?? 40) / 100));
	const op = opRatio.toFixed(2);
	const hasBlur = clampedBlur > 0;
	const pal = WALLPAPER_THEMES[themeKey] || WALLPAPER_THEMES.obsidian;

	// 动态缩放面板与输入框等底色透明度
	const topbarBg = scaleAlpha(pal.topbarBg, opRatio);
	const panelBg = scaleAlpha(pal.panelBg, opRatio);
	const cardBg = scaleAlpha(pal.cardBg, opRatio);
	const inputboxBg = scaleAlpha(pal.inputboxBg, opRatio);
	const userBg = scaleAlpha(pal.userBg, opRatio);

	// 对固定悬浮部件应用轻量 GPU 磨砂质感；当 blur <= 0 时严格输出 none，防复合风暴
	const fixedGlassFilter = hasBlur
		? `backdrop-filter: blur(${clampedBlur}px) !important; -webkit-backdrop-filter: blur(${clampedBlur}px) !important;`
		: `backdrop-filter: none !important; -webkit-backdrop-filter: none !important;`;

	const composerGlassFilter = hasBlur
		? `backdrop-filter: blur(${clampedBlur}px) !important; -webkit-backdrop-filter: blur(${clampedBlur}px) !important;`
		: `backdrop-filter: none !important; -webkit-backdrop-filter: none !important;`;

	return `
:root {
	--pi-we-blur: ${clampedBlur}px;
	--pi-we-opacity: ${op};

	/* 深度联动宿主内置壁纸透明度系统与当前选中的壁纸主题调色 */
	--wallpaper-panel-alpha: calc(var(--pi-we-opacity) * 35%);
	--topbar-bg: ${topbarBg};
	--statusbar-bg: ${topbarBg};
	--panel-bg: ${panelBg};
	--msgs-bg: transparent;
	--inputbox-bg: ${inputboxBg};
	--card-bg: ${cardBg};
	--chip-bg: rgba(255, 255, 255, ${Math.max(0, 0.08 * opRatio).toFixed(3)});

	--accent: ${pal.accent};
	--accent-soft: ${pal.accentSoft};
	--border: ${pal.border};
	--border-soft: ${pal.borderSoft};
	--text: ${pal.text};
	--text-dim: ${pal.textDim};
}

/* 1. 透出底层壁纸：将所有骨架实底背景完全置为透明 */
#root, .app, .layout, .view-pane, .main, .messages-wrap, .chat-view, .chat-scroll, .messages, .inputbar {
	background: transparent !important;
}

/* 2. 顶栏与底栏：去阴影、纯净通透，根据模糊度按需毛玻璃 */
.topbar {
	background: ${topbarBg} !important;
	border-bottom: 1px solid ${pal.border} !important;
	box-shadow: none !important;
	${fixedGlassFilter}
	z-index: 50 !important;
}

.footer-bar, .statusbar {
	background: ${topbarBg} !important;
	border-top: 1px solid ${pal.border} !important;
	box-shadow: none !important;
	${fixedGlassFilter}
	z-index: 50 !important;
}

/* 3. 左右侧边栏面板（.panel）：剔除实黑，呈现高级亚克力微透暗晶质感（去阴影） */
.panel, .drawer-left .panel, .drawer-right .panel, .lp-panel {
	background: ${panelBg} !important;
	border-color: ${pal.border} !important;
	box-shadow: none !important;
	${fixedGlassFilter}
}

.panel-header, .lp-section-header, .panel-convs, .panel-sessions, .lp-group-title, .panel-body {
	background: transparent !important;
}

.lp-conv-row:hover, .lp-conv-row.active, .ft-row:hover, .panel-item:hover {
	background: ${pal.accentSoft} !important;
}

/* 3.1 左侧分区标题（最近项目、运行对话、历史对话等）彻底提亮为清爽亮白，告别暗黑发脏 */
.lp-section-header,
.lp-section-title,
.lp-section-title-text,
.lp-section-chevron,
.lp-section-count,
.panel-section-title {
	color: #f8fafc !important;
	opacity: 0.96 !important;
	text-shadow: 0 0 1px rgba(0, 0, 0, 0.95), 0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

/* 4. 单个气泡独立圆角与轻微毛玻璃背景（内部工具与正文平整连贯无空隙） */
.messages-wrap,
.chat-scroll,
.messages {
	background: transparent !important;
}

.msg {
	background: transparent !important;
	border: none !important;
	box-shadow: none !important;
}

.msg-assistant .msg-body {
	background: rgba(12, 18, 32, 0.38) !important;
	border: 1px solid rgba(255, 255, 255, 0.05) !important;
	border-radius: 16px !important;
	box-shadow: none !important;
	backdrop-filter: blur(2px) saturate(115%) !important;
	-webkit-backdrop-filter: blur(2px) saturate(115%) !important;
	overflow: hidden !important;
}

/* 正文消息（最终文本回复）与上方工具卡、思考块左侧完全对齐留出边距，消除顶格突兀感 */
.msg-text {
	padding: 6px 12px !important;
	border-radius: 8px !important;
}

/* 4.1 全页面可见文字防眩光阴影（标题、项目名、会话名、正文字等），1像素紧致高锐度边缘，绝不晕染发糊 */
.topbar,
.topbar-title,
.bar-item-text,
.bar-item-badge,
.brand,
.brand *,
.lp-section-header,
.lp-section-title,
.lp-group-title,
.project-name,
.session-title,
.lp-conv-title,
.ft-name,
.quick-chip,
.msg-body p,
.msg-body li,
.msg-body h1,
.msg-body h2,
.msg-body h3,
.msg-body h4,
.msg-body h5,
.msg-body h6,
.msg-body strong,
.msg-body em,
.thinking-title,
.thinking-summary,
.tool-title,
button:not(.icon-btn):not(.lp-section-action),
.btn {
	${
		lightWallpaperMode
			? `text-shadow:
		-1px -1px 0 rgba(0, 0, 0, 0.92),
		 1px -1px 0 rgba(0, 0, 0, 0.92),
		-1px  1px 0 rgba(0, 0, 0, 0.92),
		 1px  1px 0 rgba(0, 0, 0, 0.92),
		 0 1px 2px rgba(0, 0, 0, 0.85) !important;`
			: `text-shadow: 0 0 1px rgba(0, 0, 0, 0.95), 0 1px 1.5px rgba(0, 0, 0, 0.85) !important;`
	}
}

/* 4.2 次要与偏黑小字全面保护（项目路径、时间戳、会话副标题、分区计数、底栏所有小指标等）：提亮并应用零扩散紧致微暗边缘，绝不隐形，绝不糊黑 */
.project-path,
.project-time,
.session-sub,
.session-meta,
.session-time,
.ft-path,
.ft-size,
.ft-date,
.msg-time,
.msg-role,
.bar-item-char,
.cwd-sub,
.lp-section-count,
.lp-count,
.statusbar,
.statusbar *,
.footer-bar,
.footer-bar *,
.ctx-val,
.ctx-max,
.status-conn-label,
.status-cache-label,
.engine-picker-name,
.engine-badge,
.text-dim,
.text-faint,
.version-text,
.template-desc,
.inputbox textarea {
	color: #e2e8f0 !important;
	opacity: 0.95 !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1px rgba(0, 0, 0, 0.85) !important;
}

.project-path,
.session-meta {
	color: #f1f5f9 !important;
	opacity: 0.92 !important;
}

.project-time,
.session-time {
	color: #e2e8f0 !important;
	opacity: 0.95 !important;
}

${
	lightWallpaperMode
		? `
/* 4.3 亮色壁纸增强偏光晶层：轻微压制高亮刺眼白光，让壁纸与白字达到最舒适对比度 */
#pi-we-bg-container::after {
	content: "" !important;
	position: absolute !important;
	inset: 0 !important;
	background: rgba(0, 0, 0, 0.14) !important;
	pointer-events: none !important;
	z-index: 1 !important;
}
`
		: ""
}

/* 5. 用户提问消息气泡：独立微晶毛玻璃气泡（带圆角） */
.msg-user {
	background: transparent !important;
	box-shadow: none !important;
}

.msg-user .msg-body {
	background: linear-gradient(135deg, rgba(30, 32, 40, 0.68) 0%, rgba(18, 19, 24, 0.58) 100%) !important;
	border: 1px solid rgba(255, 255, 255, 0.12) !important;
	border-radius: 16px !important;
	box-shadow: none !important;
	backdrop-filter: blur(2px) saturate(115%) !important;
	-webkit-backdrop-filter: blur(2px) saturate(115%) !important;
}

/* 6. 输入框外壳（.inputbox）与底部控制栏（回形针、麦克风、书本、模型/思考/权限胶囊等全适配）：轻微毛玻璃磨砂 */
.inputbox {
	background: rgba(12, 14, 20, 0.48) !important;
	border: 1px solid rgba(255, 255, 255, 0.22) !important;
	border-radius: 20px !important;
	box-shadow: none !important;
	backdrop-filter: blur(10px) saturate(130%) !important;
	-webkit-backdrop-filter: blur(10px) saturate(130%) !important;
	transition: border-color 0.2s ease;
}

.inputbox:focus-within {
	border-color: ${pal.focusBorder} !important;
	box-shadow: none !important;
}

.inputbox textarea {
	background: transparent !important;
	color: #f8fafc !important;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
}

/* 6.1 输入框底部工具条：胶囊文字（高、完全权限、全功能等）彻底提亮为纯白，防眩光锁边 */
.composer-tools,
.composer-tools-left,
.composer-tools-center,
.composer-tools-right {
	color: #f8fafc !important;
}

.composer-tools .chip {
	background: rgba(14, 20, 36, 0.45) !important;
	border: 1px solid rgba(56, 189, 248, 0.28) !important;
	color: #f8fafc !important;
	box-shadow: none !important;
	transition: background 0.15s ease, border-color 0.15s ease;
}

.composer-tools .chip:hover {
	background: rgba(14, 20, 36, 0.65) !important;
	border-color: ${pal.accent} !important;
}

.composer-tools .chip > span,
.composer-tools .chip > span.chip-model,
.composer-tools .chip > span.chip-sub,
.composer-tools .chip-sub {
	color: #f8fafc !important;
	opacity: 0.98 !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

.composer-tools .chip > svg,
.composer-tools .dd-caret svg,
.composer-tools .dd-caret,
.inputbox .composer-tools-left button svg,
.inputbox .btn.composer-plugin-action svg,
.inputbox .composer-tools-left .btn svg {
	color: #f8fafc !important;
	stroke: #f8fafc !important;
	filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.95)) drop-shadow(0 1px 1.2px rgba(0, 0, 0, 0.85)) !important;
}

.inputbox .composer-tools-left button,
.inputbox .btn.composer-plugin-action,
.inputbox .composer-tools-left .btn {
	filter: none !important;
}

/* 胶囊按钮（模型、思考、权限、预设等下拉）恒定保持 8px 圆角矩形，悬停绝不变形为扁平椭圆 */
.composer-tools .chip,
.composer-tools .chip:hover,
.composer-tools .dropdown > button,
.composer-tools .dropdown > button:hover,
.dropdown > button.chip,
.dropdown > button.chip:hover {
	border-radius: 8px !important;
}

/* 仅针对左侧附件等纯图标小按钮悬停时轻微高光，绝不改变任何下拉胶囊圆角 */
.inputbox .btn.composer-plugin-action:not(.chip):hover,
.inputbox .composer-tools-left > button:not(.chip):not(.dropdown):hover {
	color: ${pal.accent} !important;
	background: rgba(255, 255, 255, 0.12) !important;
	border-radius: 6px !important;
}

/* 发送按钮（冷白银辉高光圆钮 + 深黑箭头，高对比度清晰锋利，绝不白底隐形） */
.inputbox .btn.send {
	background: #f8fafc !important;
	border-color: #ffffff !important;
	color: #050507 !important;
	box-shadow: 0 2px 12px rgba(255, 255, 255, 0.35) !important;
}
.inputbox .btn.send svg {
	stroke: #050507 !important;
	color: #050507 !important;
	filter: none !important;
}
.inputbox .btn.send:hover:not(:disabled) {
	background: #ffffff !important;
	border-color: #ffffff !important;
	color: #000000 !important;
	box-shadow: 0 0 16px rgba(255, 255, 255, 0.55) !important;
	transform: translateY(-1px);
}
.inputbox .btn.send:disabled {
	opacity: 0.35 !important;
	box-shadow: none !important;
	cursor: default !important;
}
.inputbox .btn.send:disabled svg {
	stroke: #050507 !important;
	color: #050507 !important;
	filter: none !important;
}

/* 运行中插队/排队分裂胶囊按钮（银白双段胶囊，黑箭黑单，分界清晰） */
.inputbox .split-send {
	background: #f8fafc !important;
	border-color: #ffffff !important;
	box-shadow: 0 2px 12px rgba(255, 255, 255, 0.35) !important;
}
.inputbox .split-send button {
	color: #050507 !important;
}
.inputbox .split-send button svg {
	stroke: #050507 !important;
	color: #050507 !important;
	filter: none !important;
}
.inputbox .split-send .split-queue {
	background: rgba(0, 0, 0, 0.08) !important;
}
.inputbox .split-send button + button {
	border-left: 1px solid rgba(0, 0, 0, 0.18) !important;
}
.inputbox .split-send:hover {
	background: #ffffff !important;
	border-color: #ffffff !important;
	box-shadow: 0 0 16px rgba(255, 255, 255, 0.55) !important;
}
.inputbox .split-send button:hover:not(:disabled) {
	background: rgba(0, 0, 0, 0.12) !important;
}

/* 7. 卡片、代码块与工具调用：方案 B（纯净无界微透流 · 连成一体无空隙） */
.card {
	background: rgba(255, 255, 255, 0.04) !important;
	border: none !important;
	border-radius: 10px !important;
	box-shadow: none !important;
}

/* 工具调用（.toolcall）、思考块（.thinking）彻底消除外边距，连成一体，杜绝百叶窗斑马线切碎背景 */
.toolcall,
.thinking {
	background: transparent !important;
	border: none !important;
	border-radius: 0 !important;
	margin: 0 !important;
	box-shadow: none !important;
	backdrop-filter: none !important;
	-webkit-backdrop-filter: none !important;
}

/* 折叠条（.chead）：紧凑平整悬浮，完全不设边框与独立外边距，内边距与 .msg-text 对齐 */
.chead {
	background: transparent !important;
	border: none !important;
	border-radius: 0 !important;
	padding: 6px 12px !important;
	margin: 0 !important;
	position: relative !important;
	box-shadow: none !important;
	backdrop-filter: none !important;
	-webkit-backdrop-filter: none !important;
	transition: background 0.15s ease !important;
}

.chead:hover {
	background: rgba(255, 255, 255, 0.06) !important;
}

/* 条目之间仅以 1px 极微弱细线无缝分割，消除任何漏景空隙 */
.toolcall + .toolcall .chead,
.thinking + .toolcall .chead,
.toolcall + .thinking .chead {
	border-top: 1px solid rgba(255, 255, 255, 0.04) !important;
}

/* 工具组首项与末项圆角封闭，整组浑然一体 */
.msg-body > .toolcall:first-child .chead,
.msg-body > .thinking:first-child .chead {
	border-top-left-radius: 8px !important;
	border-top-right-radius: 8px !important;
}
.msg-body > .toolcall:last-child .chead,
.msg-body > .thinking:last-child .chead {
	border-bottom-left-radius: 8px !important;
	border-bottom-right-radius: 8px !important;
}

.toolcall .chead::before,
.thinking .chead::before {
	display: none !important;
}

pre, code {
	text-shadow: none !important;
}

pre {
	background: ${pal.codeBg} !important;
	border: 1px solid rgba(255, 255, 255, 0.08) !important;
	border-radius: 10px !important;
	box-shadow: none !important;
}

/* 7.1 工具调用与思考文字：彻底提亮为高对比纯白，注入1像素紧致微暗边缘 */
.toolcall-name,
.chead-title.toolcall-name,
.toolcall-path,
.toolcall-cmd,
.toolcall-agent,
.toolcall-status,
.toolcall-output-label,
.thinking-label,
.thinking-live-label,
.thinking-preview-prefix,
.thinking-preview-track,
.thinking-preview-live,
.thinking-wait,
.thinking-body p,
.thinking-body li,
.thinking-body span,
.thinking-body strong,
.thinking-body em {
	color: #f8fafc !important;
	opacity: 0.98 !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

.toolcall-path,
.toolcall-cmd {
	color: #e2e8f0 !important;
}

/* 8. 快捷短语芯片：轻微毛玻璃磨砂晶体胶囊 */
.quick-chip {
	background: rgba(14, 16, 24, 0.45) !important;
	border: 1px solid rgba(255, 255, 255, 0.16) !important;
	border-radius: 14px !important;
	backdrop-filter: blur(8px) saturate(130%) !important;
	-webkit-backdrop-filter: blur(8px) saturate(130%) !important;
	box-shadow: none !important;
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important;
}

.quick-chip:hover {
	background: rgba(255, 255, 255, 0.16) !important;
	border-color: rgba(255, 255, 255, 0.4) !important;
}

/* 9. 确保所有全局弹窗、下拉菜单、浮层与抽屉在毛玻璃壁纸下永不被消息或背景遮挡（MARKERS等浮窗透亮适配） */
.dd-portal-wrapper,
.dd-menu,
.ctx-menu,
.pm-panel,
.pi-we-drawer,
.pi-we-backdrop,
.modal-backdrop,
.modal-overlay,
[data-pi-floating-panel],
.floating-panel {
	z-index: 99999 !important;
}

[data-pi-floating-panel],
.floating-panel {
	background: rgba(10, 15, 26, 0.82) !important;
	border: 1px solid rgba(56, 189, 248, 0.28) !important;
	box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55) !important;
	color: #f8fafc !important;
}

[data-pi-floating-panel] *,
.floating-panel * {
	color: #f8fafc !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1.2px rgba(0, 0, 0, 0.85) !important;
}

/* 9.1 右下角状态栏指标（GitHub、CPU/内存68%·32%、工作区路径等）全量高对比提亮与矢量锁边 */
.statusbar-right,
.statusbar-right *,
.statusbar .bar-item-host-metrics,
.statusbar .bar-item-host-metrics *,
.statusbar .status-host-metrics,
.statusbar .status-host-metrics *,
.statusbar .bar-item-cwd,
.statusbar .bar-item-cwd *,
.statusbar .status-cwd,
.statusbar .status-cwd * {
	color: #f8fafc !important;
	opacity: 0.98 !important;
	text-shadow:
		0 0 1px rgba(0, 0, 0, 0.95),
		0 1px 1.5px rgba(0, 0, 0, 0.85) !important;
}

.statusbar-right .bar-item-icon svg,
.statusbar .bar-item-host-metrics svg,
.statusbar .status-host-metrics svg,
.statusbar .bar-item-cwd svg,
.statusbar .status-cwd svg {
	color: #f8fafc !important;
	stroke: #f8fafc !important;
	filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.95)) drop-shadow(0 1px 1.2px rgba(0, 0, 0, 0.85)) !important;
}

/* 10. 顶部按钮与所有图标：所有按钮统一度量衡，阴影唯一精准挂载在矢量笔画上，严禁父子容器双重叠加产生浓黑光晕 */
span.bar-item-icon,
span.plugin-icon-svg,
.side-dock-btn,
.chead-copy,
.chead-toggle,
.msg-actions button,
.panel-header .icon-btn,
.panel-collapse-btn,
.panel-rail,
.lp-section-action,
.pi-we-icon-btn,
.topbar .icon-btn,
.icon-btn,
.project-icon {
	background: transparent !important;
	border: none !important;
	box-shadow: none !important;
	filter: none !important;
	text-shadow: none !important;
	color: #f8fafc !important;
	transition: filter 0.15s ease, transform 0.15s ease, color 0.15s ease;
}

/* 全界面所有图标矢量元素（SVG / Glyph / 胶囊图标）：统一定义唯一、精致、锐利的微黑锁边，绝不晕染；
   注意：仅对叶子节点 SVG 或字符 Glyph 施加滤镜，绝对禁止在包含 SVG 的 span 容器上挂滤镜防嵌套双重阴影 */
svg.bar-item-icon,
.bar-item-glyph,
.bar-item-icon svg,
.bar-item-icon.plugin-icon-svg svg,
.lp-section-action svg,
.panel-collapse-btn svg,
.panel-rail svg,
.side-dock-btn svg,
.project-icon svg,
.chead-copy svg,
.chead-copy > svg,
.chead-toggle svg,
.chead-toggle > svg,
.chead-icon svg,
.toolcall-icon svg,
.thinking-icon svg,
.toolcall-status svg,
.toolcall-open svg {
	color: #f8fafc !important;
	stroke: #f8fafc !important;
	filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.95)) drop-shadow(0 1px 1.2px rgba(0, 0, 0, 0.85)) !important;
	transition: filter 0.15s ease, color 0.15s ease;
}

/* 悬停微高光微反馈：统一只对图标自身应用光晕，容器 span 保持无滤镜 */
.bar-item:hover span.bar-item-icon,
.bar-item:hover span.plugin-icon-svg {
	filter: none !important;
}

.bar-item:hover svg.bar-item-icon,
.bar-item:hover .bar-item-icon svg,
.bar-item:hover .bar-item-glyph,
.side-dock-btn:hover svg,
.chead-copy:hover svg,
.chead-toggle:hover svg,
.msg-actions button:hover svg,
.lp-section-action:hover svg,
.panel-collapse-btn:hover svg,
.panel-rail:hover svg,
.icon-btn:hover svg,
.toolcall-open:hover svg {
	color: ${pal.accent} !important;
	stroke: ${pal.accent} !important;
	filter: drop-shadow(0 0 2px ${pal.accent}) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.9)) !important;
}

.side-dock-btn:hover,
.chead-copy:hover,
.chead-toggle:hover,
.msg-actions button:hover,
.lp-section-action:hover,
.panel-collapse-btn:hover,
.panel-rail:hover,
.icon-btn:hover,
.toolcall-open:hover {
	transform: scale(1.08);
}

/* 顶栏所有按钮（含沙盒、临时对话等）默认彻底裸幽灵化，绝不残留突兀的高亮黄色圆环或生硬外边框 */
.topbar .bar-item:not(:hover),
.topbar .chip:not(:hover),
.topbar .sandbox-chip:not(:hover),
.topbar .ephemeral-chat-btn:not(:hover) {
	background: transparent !important;
	border-color: transparent !important;
	box-shadow: none !important;
}

${
	interactive
		? `
/* 交互模式开启：允许鼠标穿透透明消息背景区域 */
.messages-wrap, .chat-view, .chat-scroll, .messages {
	pointer-events: none !important;
}
.msg, .msg-body, .inputbar, .inputbox, .card, .topbar, .panel, .footer-bar, button, a, input, textarea, [role="button"] {
	pointer-events: auto !important;
}
`
		: ""
}
`;
}

export const DRAWER_CSS = `
/* ---------------- 全局底层壁纸容器（独立硬件加速层与严格包含） ---------------- */
#pi-we-bg-container {
	position: fixed;
	inset: 0;
	z-index: 0;
	overflow: hidden;
	pointer-events: none;
	user-select: none;
	transform: translate3d(0, 0, 0);
	will-change: transform;
	contain: strict;
	backface-visibility: hidden;
}

#pi-we-bg-container.interactive {
	pointer-events: auto;
}

.pi-we-bg-media {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	object-position: center;
	border: none;
	transform: translateZ(0);
	transition: opacity 0.4s ease;
}

iframe.pi-we-bg-media {
	border: none;
	width: 100%;
	height: 100%;
	background: transparent;
	pointer-events: inherit;
}

.pi-we-scene-mount {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	overflow: hidden;
	pointer-events: inherit;
	transform: translateZ(0);
}

.pi-we-scene-mount canvas {
	width: 100% !important;
	height: 100% !important;
	display: block;
	object-fit: cover;
	transform: translateZ(0);
}

/* ---------------- 壁纸库抽屉蒙层与面板 ---------------- */
.pi-we-backdrop {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.55);
	backdrop-filter: blur(6px);
	-webkit-backdrop-filter: blur(6px);
	z-index: 9998;
	opacity: 0;
	pointer-events: none;
	transition: opacity 0.25s ease;
}

.pi-we-backdrop.open {
	opacity: 1;
	pointer-events: auto;
}

.pi-we-drawer {
	position: fixed;
	top: 0;
	right: 0;
	bottom: 0;
	height: 100vh;
	max-height: 100vh;
	width: 480px;
	max-width: 92vw;
	background: rgba(14, 20, 34, 0.96);
	border-left: 1px solid rgba(56, 189, 248, 0.25);
	box-shadow: -10px 0 40px rgba(0, 0, 0, 0.65);
	z-index: 9999;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	transform: translate3d(100%, 0, 0);
	will-change: transform;
	transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
	color: #e2e8f0;
	font-family: inherit;
	box-sizing: border-box;
}

.pi-we-drawer.open {
	transform: translate3d(0, 0, 0);
}

/* 抽屉头部 */
.pi-we-header {
	padding: 16px 20px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	border-bottom: 1px solid rgba(56, 189, 248, 0.16);
	flex-shrink: 0;
	background: rgba(11, 16, 28, 0.5);
}

.pi-we-title {
	font-size: 16px;
	font-weight: 600;
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0;
	color: #f8fafc;
	text-shadow: 0 0 12px rgba(56, 189, 248, 0.45);
}

.pi-we-header-actions {
	display: flex;
	align-items: center;
	gap: 6px;
}

.pi-we-icon-btn {
	background: rgba(56, 189, 248, 0.08);
	border: 1px solid rgba(56, 189, 248, 0.22);
	color: #cbd5e1;
	border-radius: 6px;
	padding: 5px 9px;
	font-size: 12.5px;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	transition: all 0.15s ease;
}

.pi-we-icon-btn:hover {
	background: rgba(56, 189, 248, 0.22);
	border-color: rgba(56, 189, 248, 0.45);
	color: #ffffff;
}

.pi-we-theme-badge {
	font-size: 11px;
	padding: 2px 7px;
	border-radius: 999px;
	background: rgba(56, 189, 248, 0.16);
	border: 1px solid rgba(56, 189, 248, 0.35);
	color: #38bdf8;
	font-weight: 500;
}

/* 外观调节面板 */
.pi-we-settings-bar {
	padding: 12px 20px;
	background: rgba(8, 12, 22, 0.45);
	border-bottom: 1px solid rgba(56, 189, 248, 0.12);
	display: flex;
	flex-direction: column;
	gap: 10px;
	font-size: 12px;
}

.pi-we-slider-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.pi-we-slider-label {
	color: #94a3b8;
	width: 90px;
	flex-shrink: 0;
}

.pi-we-slider-row input[type="range"] {
	flex: 1;
	accent-color: #38bdf8;
	cursor: pointer;
}

.pi-we-slider-val {
	width: 44px;
	text-align: right;
	color: #e2e8f0;
	font-family: monospace;
}

.pi-we-select {
	background: rgba(8, 12, 22, 0.7);
	border: 1px solid rgba(56, 189, 248, 0.25);
	color: #e2e8f0;
	border-radius: 6px;
	padding: 4px 8px;
	font-size: 12px;
	outline: none;
	cursor: pointer;
}

.pi-we-select:focus {
	border-color: #38bdf8;
}

.pi-we-checkbox-row {
	display: flex;
	align-items: center;
	gap: 6px;
	color: #cbd5e1;
	cursor: pointer;
}

/* 预设导出与导入条 */
.pi-we-preset-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding-top: 4px;
	border-top: 1px dashed rgba(56, 189, 248, 0.16);
}

/* 搜索与分类 */
.pi-we-filter-bar {
	padding: 12px 20px 8px;
	display: flex;
	flex-direction: column;
	gap: 10px;
	flex-shrink: 0;
}

.pi-we-search-input {
	width: 100%;
	padding: 8px 12px;
	background: rgba(8, 12, 22, 0.5);
	border: 1px solid rgba(56, 189, 248, 0.22);
	border-radius: 6px;
	color: #ffffff;
	font-size: 13px;
	outline: none;
	box-sizing: border-box;
}

.pi-we-search-input:focus {
	border-color: #38bdf8;
	box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);
}

.pi-we-tabs {
	display: flex;
	gap: 6px;
	overflow-x: auto;
}

.pi-we-tab {
	padding: 4px 10px;
	border-radius: 4px;
	font-size: 12px;
	background: rgba(255, 255, 255, 0.05);
	border: 1px solid transparent;
	color: #94a3b8;
	cursor: pointer;
	white-space: nowrap;
	transition: all 0.15s ease;
}

.pi-we-tab:hover {
	color: #e2e8f0;
	background: rgba(56, 189, 248, 0.12);
}

.pi-we-tab.active {
	background: rgba(56, 189, 248, 0.2);
	color: #38bdf8;
	border-color: rgba(56, 189, 248, 0.4);
	font-weight: 500;
}

/* 显示模式切换按钮（分页浏览 vs 全部展示） */
.pi-we-mode-btn {
	margin-left: auto;
	padding: 4px 10px;
	border-radius: 4px;
	font-size: 11.5px;
	background: rgba(56, 189, 248, 0.12);
	border: 1px solid rgba(56, 189, 248, 0.35);
	color: #38bdf8;
	cursor: pointer;
	white-space: nowrap;
	transition: all 0.15s ease;
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

.pi-we-mode-btn:hover {
	background: rgba(56, 189, 248, 0.25);
	border-color: #38bdf8;
	color: #ffffff;
}

/* 壁纸列表网格（声明 min-height: 0 锁定 flex 伸缩，确保底部分页栏永远不被挤出可视区） */
.pi-we-body {
	flex: 1 1 0% !important;
	min-height: 0 !important;
	overflow-y: auto !important;
	padding: 12px 18px 24px !important;
	display: grid !important;
	grid-template-columns: repeat(2, 1fr) !important;
	gap: 14px !important;
	align-items: start !important;
	overscroll-behavior: contain !important;
	box-sizing: border-box !important;
}

.pi-we-card,
.pi-we-card-item {
	position: relative !important;
	background: rgba(14, 21, 37, 0.85) !important;
	border: 1px solid rgba(56, 189, 248, 0.2) !important;
	border-radius: 8px !important;
	overflow: hidden !important;
	cursor: pointer !important;
	display: flex !important;
	flex-direction: column !important;
	min-width: 0 !important;
	width: 100% !important;
	box-sizing: border-box !important;
	margin: 0 !important;
	transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s ease, box-shadow 0.2s ease !important;
	outline: none !important;
}

.pi-we-card:hover,
.pi-we-card-item:hover {
	border-color: rgba(56, 189, 248, 0.6) !important;
	transform: translateY(-2px) !important;
	box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 12px rgba(56, 189, 248, 0.25) !important;
}

.pi-we-card.active,
.pi-we-card-item.active {
	border-color: #38bdf8 !important;
	box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.85) !important;
}

/* 封面容器：宽度 100%，高度完全由封面图片的真实比例撑开，绝不拉伸、绝不裁剪、绝不塌陷 */
.pi-we-thumb-wrap,
.pi-we-cover-wrap {
	position: relative !important;
	width: 100% !important;
	background: #060913 !important;
	overflow: hidden !important;
	display: block !important;
	line-height: 0 !important;
	min-height: 80px !important;
	box-sizing: border-box !important;
}

/* 核心封面主体：display: block + position: static + width: 100% + height: auto，比例与原图 1:1 绝对一致 */
.pi-we-thumb,
.pi-we-cover-img {
	display: block !important;
	position: static !important;
	width: 100% !important;
	height: auto !important;
	max-height: 240px !important;
	object-fit: contain !important;
	transition: transform 0.25s ease !important;
	box-sizing: border-box !important;
}

.pi-we-card:hover .pi-we-thumb,
.pi-we-card-item:hover .pi-we-cover-img {
	transform: scale(1.03) !important;
}

.pi-we-badge {
	position: absolute;
	top: 6px;
	right: 6px;
	padding: 2px 6px;
	border-radius: 4px;
	font-size: 10px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	background: rgba(0, 0, 0, 0.75);
	backdrop-filter: blur(4px);
	z-index: 2;
}

.pi-we-badge.video {
	color: #38bdf8;
	border: 1px solid rgba(56, 189, 248, 0.4);
}

.pi-we-badge.scene {
	color: #c084fc;
	border: 1px solid rgba(192, 132, 252, 0.4);
}

.pi-we-badge.image {
	color: #fbbf24;
	border: 1px solid rgba(251, 191, 36, 0.4);
}

.pi-we-badge.web {
	color: #34d399;
	border: 1px solid rgba(52, 211, 153, 0.4);
}

.pi-we-active-indicator {
	position: absolute;
	top: 6px;
	left: 6px;
	background: #38bdf8;
	color: #020617;
	font-size: 10px;
	font-weight: 700;
	padding: 2px 6px;
	border-radius: 4px;
	box-shadow: 0 0 10px rgba(56, 189, 248, 0.6);
	z-index: 2;
}

/* 卡片信息区：有明确的背景和分界，确保卡片层次分明，绝不与相邻卡片重叠 */
.pi-we-card-info,
.pi-we-card-meta-bar {
	padding: 8px 10px !important;
	background: rgba(10, 15, 26, 0.96) !important;
	border-top: 1px solid rgba(56, 189, 248, 0.15) !important;
	display: flex !important;
	flex-direction: column !important;
	gap: 4px !important;
	min-width: 0 !important;
	flex-shrink: 0 !important;
	box-sizing: border-box !important;
}

.pi-we-card-title {
	font-size: 12px !important;
	font-weight: 500 !important;
	color: #f8fafc !important;
	overflow: hidden !important;
	text-overflow: ellipsis !important;
	white-space: nowrap !important;
	line-height: 1.4 !important;
}

.pi-we-card-meta {
	display: flex !important;
	align-items: center !important;
	justify-content: space-between !important;
	gap: 6px !important;
	font-size: 11px !important;
	color: #94a3b8 !important;
}

.pi-we-fav-btn {
	background: transparent;
	border: none;
	font-size: 15px;
	color: #64748b;
	cursor: pointer;
	padding: 2px;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: color 0.15s ease, transform 0.15s ease;
}

.pi-we-fav-btn:hover {
	transform: scale(1.2);
}

.pi-we-fav-btn.active {
	color: #f59e0b;
	text-shadow: 0 0 8px rgba(245, 158, 11, 0.5);
}

/* 空状态与无壁纸选项 */
.pi-we-empty {
	grid-column: span 2;
	padding: 32px 16px;
	text-align: center;
	color: #94a3b8;
	font-size: 13px;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
}

.pi-we-card-none {
	grid-column: span 2;
	padding: 12px;
	background: rgba(255, 255, 255, 0.03);
	border: 1px dashed rgba(56, 189, 248, 0.25);
	border-radius: 8px;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	font-size: 13px;
	color: #94a3b8;
	cursor: pointer;
	transition: all 0.2s ease;
}

.pi-we-card-none:hover {
	border-color: rgba(56, 189, 248, 0.6);
	color: #38bdf8;
	background: rgba(56, 189, 248, 0.08);
}

/* 壁纸列表分页栏（吸底常驻，保证无论内容多少均 100% 始终可见） */
.pi-we-pagination {
	flex-shrink: 0 !important;
	position: sticky !important;
	bottom: 0 !important;
	z-index: 99 !important;
	padding: 10px 16px !important;
	background: rgba(8, 12, 22, 0.98) !important;
	border-top: 1px solid rgba(56, 189, 248, 0.3) !important;
	box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.6) !important;
	backdrop-filter: blur(12px) !important;
	display: flex !important;
	align-items: center !important;
	justify-content: space-between !important;
	gap: 8px !important;
	user-select: none !important;
	box-sizing: border-box !important;
	min-height: 48px !important;
}

.pi-we-page-info {
	font-size: 11.5px;
	color: #94a3b8;
	white-space: nowrap;
}

.pi-we-page-nav {
	display: flex;
	align-items: center;
	gap: 4px;
}

.pi-we-page-btn {
	padding: 4px 8px;
	font-size: 11.5px;
	color: #e2e8f0;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(56, 189, 248, 0.2);
	border-radius: 5px;
	cursor: pointer;
	transition: all 0.15s ease;
	white-space: nowrap;
}

.pi-we-page-btn:hover:not(:disabled) {
	background: rgba(56, 189, 248, 0.2);
	border-color: #38bdf8;
	color: #38bdf8;
}

.pi-we-page-btn:disabled {
	opacity: 0.35;
	cursor: not-allowed;
	border-color: rgba(255, 255, 255, 0.08);
}

.pi-we-page-numbers {
	display: flex;
	align-items: center;
	gap: 3px;
}

.pi-we-page-num {
	min-width: 24px;
	height: 24px;
	padding: 0 4px;
	font-size: 11.5px;
	font-family: inherit;
	color: #94a3b8;
	background: transparent;
	border: 1px solid transparent;
	border-radius: 4px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	transition: all 0.15s ease;
}

.pi-we-page-num:hover:not(.active) {
	color: #f1f5f9;
	background: rgba(255, 255, 255, 0.08);
}

.pi-we-page-num.active {
	color: #020617;
	background: #38bdf8;
	border-color: #38bdf8;
	font-weight: 700;
	box-shadow: 0 0 8px rgba(56, 189, 248, 0.45);
}

.pi-we-page-ellipsis {
	padding: 0 2px;
	color: #64748b;
	font-size: 12px;
}
`;
