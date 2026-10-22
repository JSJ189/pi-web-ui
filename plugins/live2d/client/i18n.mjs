/**
 * Live2D 看板娘双语国际化
 */

const DICT = {
	zh: {
		"topbar.toggle": "显示/隐藏看板娘 (Alt+L)",
		"bubble.default": "你好呀！今天想写点什么代码呢？",
		"bubble.thinking": "正在认真思考中...",
		"bubble.done": "回答完成啦！",
		"bubble.error": "呜，好像遇到了一点小麻烦...",
		"bubble.poke_head": "哇！摸摸头~ (´▽`ʃ♡ƪ)",
		"bubble.poke_body": "别戳啦，好痒呀~ >///<",
		"bubble.poke_mouth": "想吃草莓蛋糕了！🍰",
		"bubble.random1": "今天也是充满干劲的一天！✨",
		"bubble.random2": "累了就喝口水，休息一下眼睛吧~ 🍵",
		"bubble.random3": "代码写得真棒，继续加油！🚀",
		"bubble.random4": "有什么难题都可以交给我和 AI 智能体哦！💡",
		"menu.mode": "交互模式",
		"menu.mode.mouse": "👀 鼠标视线跟随",
		"menu.mode.idle": "💤 自然呼吸待机",
		"menu.click_through_enable": "👻 开启点击穿透",
		"menu.click_through_disable": "🔓 取消点击穿透",
		"menu.expressions": "表情选择",
		"menu.motions": "动作交互",
		"menu.models": "角色切换",
		"menu.reset_pos": "📍 恢复默认位置",
		"menu.settings": "⚙️ 看板娘设置",
		"menu.hide": "✕ 暂时收起挂件",
		"settings.title": "Live2D 看板娘设置",
		"settings.models": "已配置模型",
		"settings.upload_title": "📦 上传本地模型",
		"settings.upload_desc": "支持直接拖入/选择 .zip 模型压缩包，或直接选择解压后的本地模型文件夹。",
		"settings.upload_zip_btn": "📁 上传 ZIP 压缩包",
		"settings.upload_folder_btn": "📂 上传模型文件夹",
		"settings.uploading": "正在上传与解压解析模型...",
		"settings.upload_success": "模型上传成功！",
		"settings.upload_failed": "上传失败：",
		"settings.add_model": "+ 外部 URL 导入",
		"settings.model_name": "显示名称",
		"settings.model_url": "模型配置地址 (.model3.json 或 .model.json)",
		"settings.scale": "挂件缩放比例",
		"settings.click_through": "完全点击穿透 (Ghost 幽灵模式)",
		"settings.click_through_hint":
			"默认人物透明区域已自动穿透；开启此项后人物身体也完全不拦截鼠标，丝毫不挡页面点击与操作。",
		"settings.react_agent": "跟随 AI 思考与回答情绪联动",
		"settings.sound": "交互轻提示音",
		"settings.save": "保存设置",
		"settings.cancel": "取消",
		"settings.del": "删除",
		"settings.apply": "立即切换",
		"actions.expressions": "表情",
		"actions.switch_model": "换装",
		"actions.mode": "模式",
		"actions.click_through": "穿透",
		"actions.settings": "设置",
		"actions.close": "收起",
		"toast.switched_model": "已切换看板娘为：",
		"toast.switched_mode": "已切换模式为：",
		"toast.click_through_on": "已开启点击穿透，点击顶栏图标或按 Alt+L 可随时退出",
		"toast.click_through_off": "已恢复正常交互模式",
	},
	en: {
		"topbar.toggle": "Toggle Live2D Companion (Alt+L)",
		"bubble.default": "Hello! What are we coding today?",
		"bubble.thinking": "Thinking carefully...",
		"bubble.done": "Done! Hope it helps!",
		"bubble.error": "Oops, something went wrong...",
		"bubble.poke_head": "Headpat! (´▽`ʃ♡ƪ)",
		"bubble.poke_body": "Hey, that tickles! >///<",
		"bubble.poke_mouth": "Craving some strawberry cake! 🍰",
		"bubble.random1": "Let's make today productive! ✨",
		"bubble.random2": "Remember to hydrate and rest your eyes~ 🍵",
		"bubble.random3": "Great code! Keep up the momentum! 🚀",
		"bubble.random4": "Feel free to ask the AI agent anytime! 💡",
		"menu.mode": "Interaction Mode",
		"menu.mode.mouse": "👀 Look at Mouse",
		"menu.mode.idle": "💤 Natural Breathing",
		"menu.click_through_enable": "👻 Enable Click-Through",
		"menu.click_through_disable": "🔓 Disable Click-Through",
		"menu.expressions": "Expressions",
		"menu.motions": "Motions",
		"menu.models": "Models",
		"menu.reset_pos": "📍 Reset Position",
		"menu.settings": "⚙️ Settings",
		"menu.hide": "✕ Minimize Companion",
		"settings.title": "Live2D Companion Settings",
		"settings.models": "Configured Models",
		"settings.upload_title": "📦 Upload Local Model",
		"settings.upload_desc": "Upload a .zip package or select an extracted model directory directly from your device.",
		"settings.upload_zip_btn": "📁 Upload ZIP Archive",
		"settings.upload_folder_btn": "📂 Upload Model Folder",
		"settings.uploading": "Uploading and extracting model...",
		"settings.upload_success": "Model uploaded successfully!",
		"settings.upload_failed": "Upload failed: ",
		"settings.add_model": "+ Import from URL",
		"settings.model_name": "Display Name",
		"settings.model_url": "Model URL (.model3.json or .model.json)",
		"settings.scale": "Widget Scale",
		"settings.click_through": "Full Click-Through (Ghost Mode)",
		"settings.click_through_hint":
			"Transparent areas pass clicks by default. Enabling this makes the whole companion click-through so it never obstructs clicks.",
		"settings.react_agent": "React to AI Thinking & Replies",
		"settings.sound": "Sound Effects",
		"settings.save": "Save Settings",
		"settings.cancel": "Cancel",
		"settings.del": "Delete",
		"settings.apply": "Switch",
		"actions.expressions": "Emote",
		"actions.switch_model": "Costume",
		"actions.mode": "Mode",
		"actions.click_through": "Ghost",
		"actions.settings": "Config",
		"actions.close": "Hide",
		"toast.switched_model": "Switched companion to: ",
		"toast.switched_mode": "Switched mode to: ",
		"toast.click_through_on": "Click-through enabled. Click topbar icon or press Alt+L to exit",
		"toast.click_through_off": "Normal interaction restored",
	},
};

export function detectLang() {
	try {
		const docLang = document.documentElement.lang;
		if (docLang && docLang.toLowerCase().startsWith("zh")) return "zh";
		const navLang = navigator.language;
		if (navLang && navLang.toLowerCase().startsWith("zh")) return "zh";
	} catch {}
	return "en";
}

export function makeT(lang = "zh") {
	const current = DICT[lang] || DICT.zh;
	const fallback = DICT.en;
	return (key, params) => {
		let text = current[key] || fallback[key] || key;
		if (params && typeof params === "object") {
			for (const [k, v] of Object.entries(params)) {
				text = text.replace(new RegExp(`{${k}}`, "g"), String(v));
			}
		}
		return text;
	};
}
