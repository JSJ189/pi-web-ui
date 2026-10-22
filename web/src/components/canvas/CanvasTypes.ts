/**
 * CanvasTypes.ts — 画布协作前端通用辅助函数与视觉配置。
 */
import type { CanvasEngineId, CanvasNodeRole, CanvasNodeStatus } from "../../types";

export interface EngineMeta {
	id: CanvasEngineId;
	name: string;
	badge: string;
	color: string;
	bgColor: string;
	desc: string;
}

export const ENGINE_METAS: Record<CanvasEngineId, EngineMeta> = {
	pi: {
		id: "pi",
		name: "Pi 原生",
		badge: "PI",
		color: "var(--accent, #a855f7)",
		bgColor: "color-mix(in srgb, var(--accent, #a855f7) 15%, transparent)",
		desc: "支持完整插件生态、工具延迟加载与全局子代理编排",
	},
	dsh: {
		id: "dsh",
		name: "DSH 极速",
		badge: "DSH",
		color: "var(--info-blue, #38bdf8)",
		bgColor: "color-mix(in srgb, var(--info-blue, #38bdf8) 15%, transparent)",
		desc: "基于 Hashline 补丁引擎，擅长极速高频代码重构与打补丁",
	},
	claude: {
		id: "claude",
		name: "Claude Code",
		badge: "CLAUDE",
		color: "var(--amber, #f97316)",
		bgColor: "color-mix(in srgb, var(--amber, #f97316) 15%, transparent)",
		desc: "Anthropic 官方基座，擅长跨模块复杂逻辑与疑难排错",
	},
	durable: {
		id: "durable",
		name: "Durable 自愈",
		badge: "DURABLE",
		color: "var(--green, #22c55e)",
		bgColor: "color-mix(in srgb, var(--green, #22c55e) 15%, transparent)",
		desc: "事务化长任务自愈引擎，专攻端到端自动化测试与自愈修复",
	},
};

export interface RoleMeta {
	role: CanvasNodeRole;
	labelZh: string;
	labelEn: string;
	icon: string;
}

export const ROLE_METAS: Record<CanvasNodeRole, RoleMeta> = {
	architect: { role: "architect", labelZh: "架构总指挥 (Lead)", labelEn: "Lead Architect", icon: "🏛️" },
	coder: { role: "coder", labelZh: "研发工程师 (Coder)", labelEn: "Software Engineer", icon: "💻" },
	reviewer: { role: "reviewer", labelZh: "代码审查员 (Reviewer)", labelEn: "Code Reviewer", icon: "🔍" },
	tester: { role: "tester", labelZh: "测试与运维 (DevOps)", labelEn: "QA & DevOps", icon: "🧪" },
	devops: { role: "devops", labelZh: "运维与发布 (Deploy)", labelEn: "Deploy & Release", icon: "🚀" },
	custom: { role: "custom", labelZh: "自定义数字员工", labelEn: "Custom Teammate", icon: "🤖" },
};

export const STATUS_COLORS: Record<CanvasNodeStatus, { text: string; bg: string; dot: string }> = {
	idle: { text: "var(--text-faint)", bg: "var(--bg-elev)", dot: "#94a3b8" },
	queued: { text: "var(--amber-text)", bg: "color-mix(in srgb, var(--amber) 12%, transparent)", dot: "var(--amber)" },
	running: {
		text: "var(--info-blue)",
		bg: "color-mix(in srgb, var(--info-blue) 12%, transparent)",
		dot: "var(--info-blue)",
	},
	waiting_approval: {
		text: "var(--amber-text)",
		bg: "color-mix(in srgb, var(--amber) 20%, transparent)",
		dot: "var(--amber)",
	},
	done: { text: "var(--green)", bg: "color-mix(in srgb, var(--green) 12%, transparent)", dot: "var(--green)" },
	error: { text: "var(--err-text)", bg: "color-mix(in srgb, var(--red) 12%, transparent)", dot: "var(--red)" },
	paused: { text: "var(--text-faint)", bg: "var(--bg-elev)", dot: "#64748b" },
};

/** 节点输入与输出端口相对于节点顶部的 Y 轴圆心位置（单位 px） */
export const PORT_Y_OFFSET = 72;
