/**
 * wallpaper-engine 客户端样式注入 —— 毛玻璃质感主题与壁纸抽屉组件样式。
 */

export function getGlassThemeCss(blur = 16, opacity = 80, interactive = false) {
	const op = (opacity / 100).toFixed(2);
	return `
:root {
	--pi-we-blur: ${blur}px;
	--pi-we-opacity: ${op};
}

/* 透出底层壁纸：将各层实底背景置为透明或磨砂半透明 */
#root, .app, .main, .messages-wrap, .chat-view, .chat-scroll, .messages {
	background: transparent !important;
}

/* 顶栏磨砂 */
.topbar {
	background: rgba(18, 22, 30, calc(var(--pi-we-opacity) * 0.82)) !important;
	backdrop-filter: blur(var(--pi-we-blur)) !important;
	-webkit-backdrop-filter: blur(var(--pi-we-blur)) !important;
}

/* 侧边栏磨砂 */
.sidebar {
	background: rgba(15, 18, 25, calc(var(--pi-we-opacity) * 0.88)) !important;
	backdrop-filter: blur(var(--pi-we-blur)) !important;
	-webkit-backdrop-filter: blur(var(--pi-we-blur)) !important;
}

/* 消息气泡磨砂 */
.msg-user {
	background: rgba(30, 42, 60, var(--pi-we-opacity)) !important;
	backdrop-filter: blur(var(--pi-we-blur)) !important;
	-webkit-backdrop-filter: blur(var(--pi-we-blur)) !important;
}

.msg-assistant {
	background: rgba(22, 26, 36, var(--pi-we-opacity)) !important;
	backdrop-filter: blur(var(--pi-we-blur)) !important;
	-webkit-backdrop-filter: blur(var(--pi-we-blur)) !important;
}

/* 输入框与卡片磨砂 */
.composer-form, .composer-wrap, .card {
	background: rgba(20, 24, 34, calc(var(--pi-we-opacity) * 0.92)) !important;
	backdrop-filter: blur(var(--pi-we-blur)) !important;
	-webkit-backdrop-filter: blur(var(--pi-we-blur)) !important;
}

/* 折叠卡片与工具调用卡头磨砂 */
.chead, .toolcall, .thinking {
	background: rgba(24, 28, 40, calc(var(--pi-we-opacity) * 0.75)) !important;
	backdrop-filter: blur(calc(var(--pi-we-blur) * 0.75)) !important;
	-webkit-backdrop-filter: blur(calc(var(--pi-we-blur) * 0.75)) !important;
}

${
	interactive
		? `
/* 交互模式开启：允许鼠标穿透透明消息背景区域 */
.messages-wrap, .chat-view, .chat-scroll, .messages {
	pointer-events: none !important;
}
.msg, .composer-wrap, .card, .topbar, .sidebar, button, a, input, textarea {
	pointer-events: auto !important;
}
`
		: ""
}
`;
}

export const DRAWER_CSS = `
/* ---------------- 全局底层壁纸容器 ---------------- */
#pi-we-bg-container {
	position: fixed;
	inset: 0;
	z-index: 0;
	overflow: hidden;
	pointer-events: none;
	user-select: none;
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
}

.pi-we-scene-mount canvas {
	width: 100% !important;
	height: 100% !important;
	display: block;
	object-fit: cover;
}

/* ---------------- 壁纸库抽屉蒙层与面板 ---------------- */
.pi-we-backdrop {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.45);
	backdrop-filter: blur(4px);
	-webkit-backdrop-filter: blur(4px);
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
	width: 460px;
	max-width: 92vw;
	background: rgba(20, 24, 34, 0.96);
	backdrop-filter: blur(24px);
	-webkit-backdrop-filter: blur(24px);
	border-left: 1px solid rgba(255, 255, 255, 0.1);
	box-shadow: -8px 0 32px rgba(0, 0, 0, 0.5);
	z-index: 9999;
	display: flex;
	flex-direction: column;
	transform: translateX(100%);
	transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
	color: #e2e8f0;
	font-family: inherit;
	box-sizing: border-box;
}

.pi-we-drawer.open {
	transform: translateX(0);
}

/* 抽屉头部 */
.pi-we-header {
	padding: 16px 20px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	flex-shrink: 0;
}

.pi-we-title {
	font-size: 16px;
	font-weight: 600;
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0;
}

.pi-we-header-actions {
	display: flex;
	align-items: center;
	gap: 6px;
}

.pi-we-icon-btn {
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.12);
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
	background: rgba(255, 255, 255, 0.14);
	color: #ffffff;
}

/* 外观调节面板 */
.pi-we-settings-bar {
	padding: 12px 20px;
	background: rgba(0, 0, 0, 0.22);
	border-bottom: 1px solid rgba(255, 255, 255, 0.06);
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
	background: rgba(0, 0, 0, 0.35);
	border: 1px solid rgba(255, 255, 255, 0.15);
	color: #e2e8f0;
	border-radius: 4px;
	padding: 3px 6px;
	font-size: 12px;
	outline: none;
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
	border-top: 1px dashed rgba(255, 255, 255, 0.08);
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
	background: rgba(0, 0, 0, 0.3);
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 6px;
	color: #ffffff;
	font-size: 13px;
	outline: none;
	box-sizing: border-box;
}

.pi-we-search-input:focus {
	border-color: #38bdf8;
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
	background: rgba(255, 255, 255, 0.1);
}

.pi-we-tab.active {
	background: rgba(56, 189, 248, 0.15);
	color: #38bdf8;
	border-color: rgba(56, 189, 248, 0.3);
	font-weight: 500;
}

/* 壁纸列表网格 */
.pi-we-body {
	flex: 1;
	overflow-y: auto;
	padding: 12px 20px 24px;
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 12px;
	overscroll-behavior: contain;
}

.pi-we-card {
	position: relative;
	background: rgba(255, 255, 255, 0.04);
	border: 1px solid rgba(255, 255, 255, 0.08);
	border-radius: 8px;
	overflow: hidden;
	cursor: pointer;
	display: flex;
	flex-direction: column;
	transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	outline: none;
}

.pi-we-card:hover {
	border-color: rgba(56, 189, 248, 0.5);
	transform: translateY(-2px);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.pi-we-card.active {
	border-color: #38bdf8;
	box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.4);
}

.pi-we-thumb-wrap {
	position: relative;
	width: 100%;
	padding-top: 56.25%; /* 16:9 */
	background: #0f172a;
	overflow: hidden;
}

.pi-we-thumb {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	transition: transform 0.3s ease;
}

.pi-we-card:hover .pi-we-thumb {
	transform: scale(1.05);
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
	background: rgba(0, 0, 0, 0.65);
	backdrop-filter: blur(4px);
}

.pi-we-badge.video {
	color: #38bdf8;
	border: 1px solid rgba(56, 189, 248, 0.3);
}

.pi-we-badge.scene {
	color: #c084fc;
	border: 1px solid rgba(192, 132, 252, 0.3);
}

.pi-we-badge.image {
	color: #fbbf24;
	border: 1px solid rgba(251, 191, 36, 0.3);
}

.pi-we-badge.web {
	color: #34d399;
	border: 1px solid rgba(52, 211, 153, 0.3);
}

.pi-we-active-indicator {
	position: absolute;
	top: 6px;
	left: 6px;
	background: #38bdf8;
	color: #0f172a;
	font-size: 10px;
	font-weight: 700;
	padding: 2px 6px;
	border-radius: 4px;
	display: flex;
	align-items: center;
	gap: 3px;
	box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}

/* 收藏星星按钮 */
.pi-we-fav-btn {
	position: absolute;
	bottom: 6px;
	right: 6px;
	background: rgba(0, 0, 0, 0.65);
	backdrop-filter: blur(4px);
	border: 1px solid rgba(255, 255, 255, 0.15);
	color: #94a3b8;
	border-radius: 4px;
	width: 24px;
	height: 24px;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 13px;
	cursor: pointer;
	transition: all 0.15s ease;
}

.pi-we-fav-btn:hover {
	color: #facc15;
	border-color: #facc15;
	transform: scale(1.1);
}

.pi-we-fav-btn.active {
	color: #facc15;
	border-color: #facc15;
	background: rgba(250, 204, 21, 0.15);
}

.pi-we-card-info {
	padding: 8px 10px;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.pi-we-card-title {
	font-size: 12.5px;
	font-weight: 500;
	color: #f1f5f9;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.pi-we-card-meta {
	font-size: 11px;
	color: #64748b;
	display: flex;
	justify-content: space-between;
}

/* 空状态 / 提示 */
.pi-we-empty {
	grid-column: span 2;
	text-align: center;
	padding: 40px 16px;
	color: #94a3b8;
	font-size: 13px;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
}

.pi-we-empty-sub {
	font-size: 11.5px;
	color: #64748b;
	max-width: 260px;
	line-height: 1.5;
}
`;
