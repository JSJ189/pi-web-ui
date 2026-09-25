/**
 * sol-savings 客户端 —— 无独立视图（manifest view:false），接底栏动作。
 */

const ACTION_DETAILS = "sol-savings:details";

function hostApi() {
	try {
		return window.__piWebUiHost ?? null;
	} catch {
		return null;
	}
}

/** 应用根（含 nginx 子路径前缀），由本 bundle URL 推导。 */
function appRoot() {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		return `${u.origin}${i >= 0 ? u.pathname.slice(0, i) : ""}`;
	} catch {
		return "";
	}
}

function apiBase() {
	const root = appRoot();
	return `${root}/plugins-api/sol-savings`;
}

async function fetchStatus() {
	try {
		const res = await fetch(`${apiBase()}/status`);
		if (res.ok) return await res.json();
	} catch {
		/* ignore */
	}
	return null;
}

async function postAction(action, data = {}) {
	try {
		const res = await fetch(`${apiBase()}/action`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, ...data }),
		});
		if (res.ok) return await res.json();
	} catch (err) {
		return { ok: false, error: err?.message || String(err) };
	}
	return { ok: false, error: "HTTP 接口请求未响应或返回错误状态" };
}

function showModal(content, statusInfo) {
	const old = document.getElementById("sol-savings-modal");
	if (old) old.remove();

	const overlay = document.createElement("div");
	overlay.id = "sol-savings-modal";
	overlay.style.cssText = `
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.7);
		backdrop-filter: blur(3px);
		z-index: 99999;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 20px;
	`;

	const dialog = document.createElement("div");
	dialog.style.cssText = `
		background: var(--bg-elev, #1e1e24);
		border: 1px solid var(--border, #333);
		border-radius: 10px;
		width: 100%;
		max-width: 520px;
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
		color: var(--text, #eee);
		font-family: inherit;
		overflow: hidden;
		animation: sol-pop 0.15s ease-out;
	`;

	const header = document.createElement("div");
	header.style.cssText = `
		padding: 14px 18px;
		border-bottom: 1px solid var(--border, #333);
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-weight: 600;
		font-size: 15px;
	`;
	header.innerHTML = `<span>⚡ SoL-Pi 状态与配置管理</span><button type="button" style="background:none;border:none;color:var(--text-dim,#888);cursor:pointer;font-size:18px;padding:2px 6px;">✕</button>`;

	const body = document.createElement("div");
	body.style.cssText = `
		padding: 18px;
		font-size: 13px;
		line-height: 1.6;
		max-height: 70vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 14px;
	`;

	// 1. 会话实时节省统计区
	const statsBox = document.createElement("div");
	statsBox.style.cssText = `
		background: var(--bg-elev2, rgba(255,255,255,0.03));
		border: 1px solid var(--border, #333);
		border-radius: 6px;
		padding: 12px 14px;
		white-space: pre-wrap;
		word-break: break-word;
	`;
	statsBox.textContent = content;
	body.appendChild(statsBox);

	// 2. SoL-Pi 扩展与配置状态区
	const isInstalled = statusInfo?.installed ?? false;
	const hasConfig = statusInfo?.hasConfig ?? false;
	const config = statusInfo?.config;

	// 已安装且已配置时默认折叠详情，避免占用弹窗主要空间；未安装或未配置时展开提示用户操作
	const detailsContainer = document.createElement("details");
	detailsContainer.style.cssText = `
		border: 1px solid var(--border, #333);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.2);
		overflow: hidden;
	`;
	if (!isInstalled || !hasConfig) {
		detailsContainer.open = true;
	}

	const summary = document.createElement("summary");
	summary.style.cssText = `
		padding: 10px 14px;
		font-weight: 600;
		font-size: 13px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		cursor: pointer;
		user-select: none;
		list-style: none;
	`;
	// 针对不同浏览器的 summary 箭头样式隐藏
	summary.innerHTML = `
		<div style="display: flex; align-items: center; gap: 8px;">
			<span>⚙️ SoL-Pi 运行与配置</span>
			<span style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: ${
				isInstalled ? "var(--green, #10b981)" : "var(--amber, #f59e0b)"
			}; color: #000; font-weight: bold;">
				${isInstalled ? "扩展已安装" : "未安装扩展"}
			</span>
		</div>
		<span style="font-size: 11px; color: var(--text-dim, #888); font-weight: normal;">▶ 展开/收起</span>
	`;

	const configBox = document.createElement("div");
	configBox.style.cssText = `
		padding: 0 14px 14px 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		border-top: 1px solid rgba(255, 255, 255, 0.05);
		margin-top: 4px;
		padding-top: 10px;
	`;

	configBox.innerHTML = `
		<div style="font-size: 12px; color: var(--text-dim, #aaa);">
			${
				!isInstalled
					? "• 未检测到 SoL-Pi 扩展包 (NVlabs/SoL-Pi)。"
					: hasConfig
					? `• 配置文件生效中: <code>${statusInfo.configPath}</code>`
					: "• 扩展已安装，但尚未配置 <code>sol-pi.json</code>，特性未激活。"
			}
		</div>
	`;

	// 快捷操作按钮容器
	const btnRow = document.createElement("div");
	btnRow.style.cssText = `display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px;`;

	if (!isInstalled) {
		const installBtn = document.createElement("button");
		installBtn.textContent = "📦 一键安装 SoL-Pi 扩展";
		installBtn.style.cssText = `
			padding: 6px 14px;
			border-radius: 4px;
			border: 1px solid var(--accent, #3b82f6);
			background: var(--accent, #3b82f6);
			color: #fff;
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
		`;
		installBtn.onclick = async () => {
			installBtn.disabled = true;
			installBtn.textContent = "⏳ 正在安装...";
			const res = await postAction("install");
			if (res.ok) {
				alert("✅ SoL-Pi 扩展安装成功！已同时自动写入推荐开启配置。");
				close();
			} else {
				alert("❌ 安装失败: " + (res.error || "未知错误"));
				installBtn.disabled = false;
				installBtn.textContent = "📦 一键安装 SoL-Pi 扩展";
			}
		};
		btnRow.appendChild(installBtn);
	}

	if (!hasConfig) {
		const enableBtn = document.createElement("button");
		enableBtn.textContent = "🚀 一键生成推荐配置 (启用节省与规划)";
		enableBtn.style.cssText = `
			padding: 6px 14px;
			border-radius: 4px;
			border: 1px solid var(--accent, #3b82f6);
			background: ${isInstalled ? "var(--accent, #3b82f6)" : "transparent"};
			color: #fff;
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
		`;
		enableBtn.onclick = async () => {
			enableBtn.disabled = true;
			enableBtn.textContent = "⏳ 配置写入中...";
			const res = await postAction("write_config");
			if (res.ok) {
				alert("✅ 已成功写入 sol-pi.json (开启了 observationPack 与 onlineContextCompact)！\n提示：重启或新开会话即可生效。");
				close();
			} else {
				alert("❌ 写入配置失败: " + (res.error || "未知错误"));
				enableBtn.disabled = false;
				enableBtn.textContent = "🚀 一键生成推荐配置 (启用节省与规划)";
			}
		};
		btnRow.appendChild(enableBtn);
	} else {
		// 已有配置，显示开关概况与状态
		const obs = config?.observationPack ? "✅ 大输出打包开启" : "⚪ 大输出打包关闭";
		const plan = config?.onlineContextCompact ? "✅ 在线规划压缩开启" : "⚪ 在线规划压缩关闭";
		const infoText = document.createElement("div");
		infoText.style.cssText = "font-size: 12px; color: var(--text-dim, #999);";
		infoText.textContent = `${obs} · ${plan}`;
		configBox.appendChild(infoText);
	}

	configBox.appendChild(btnRow);
	detailsContainer.appendChild(summary);
	detailsContainer.appendChild(configBox);
	body.appendChild(detailsContainer);

	const footer = document.createElement("div");
	footer.style.cssText = `
		padding: 12px 18px;
		border-top: 1px solid var(--border, #333);
		display: flex;
		justify-content: flex-end;
		background: var(--bg-elev2, rgba(255,255,255,0.03));
	`;
	const closeBtn = document.createElement("button");
	closeBtn.textContent = "关闭";
	closeBtn.style.cssText = `
		padding: 6px 16px;
		border-radius: 4px;
		border: 1px solid var(--border, #444);
		background: transparent;
		color: var(--text, #eee);
		cursor: pointer;
		font-size: 12px;
	`;

	const close = () => overlay.remove();
	closeBtn.onclick = close;
	header.querySelector("button").onclick = close;
	overlay.onclick = (e) => {
		if (e.target === overlay) close();
	};

	footer.appendChild(closeBtn);
	dialog.appendChild(header);
	dialog.appendChild(body);
	dialog.appendChild(footer);
	overlay.appendChild(dialog);
	document.body.appendChild(overlay);
}

function register() {
	try {
		const api = hostApi();
		api?.onUiAction?.(ACTION_DETAILS, async () => {
			const btn =
				document.querySelector('[data-pi-slot="bottombar"] button.status-action[title*="SoL-Pi"]') ||
				document.querySelector('button.status-action[title*="SoL-Pi"]');
			const tip = btn?.getAttribute("title") || "";
			let content = "⚡ SoL-Pi：当前会话暂未产生大输出打包或上下文规划数据。";
			if (tip) {
				const lines = tip.split("\n").filter((l) => !l.includes("点击查看"));
				if (lines.length > 0) content = lines.join("\n");
			}

			// 获取扩展与配置实时状态
			const statusInfo = await fetchStatus();
			showModal(content, statusInfo);
		});
	} catch {
		/* ignore */
	}
}

register();

export default {
	mount() {
		register();
		return () => {};
	},
};
