import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ApprovalRulesStore,
	DEFAULT_APPROVAL_RULES,
	evaluateApprovalRules,
	extractRuleFieldValue,
	globToRegex,
	matchApprovalRule,
	normalizeApprovalRule,
	type ApprovalRule,
} from "../../server/approval-rules.js";

describe("审批规则引擎纯函数与匹配逻辑 (Approval Rules Engine)", () => {
	const cwd = "/workspace/project";

	describe("globToRegex 通配符转换", () => {
		it("单星号 * 匹配单路径段", () => {
			const re = globToRegex("*.txt");
			expect(re.test("file.txt")).toBe(true);
			expect(re.test("a/file.txt")).toBe(false);
		});

		it("双星号 ** 跨目录匹配", () => {
			const re = globToRegex("**/*.secret");
			expect(re.test("top.secret")).toBe(true);
			expect(re.test("sub/folder/file.secret")).toBe(true);
			expect(re.test("sub/folder/file.txt")).toBe(false);
		});

		it("正反斜杠统一归一化", () => {
			const re = globToRegex("src/**/*.ts");
			expect(re.test("src/components/A.ts")).toBe(true);
			expect(re.test("src\\components\\A.ts".replace(/\\/g, "/"))).toBe(true);
		});
	});

	describe("extractRuleFieldValue 参数提取", () => {
		it("提取 command", () => {
			expect(extractRuleFieldValue("command", "bash", { command: "rm -rf /" })).toBe("rm -rf /");
			expect(extractRuleFieldValue("command", "bash", {})).toBe("");
		});

		it("提取 path", () => {
			expect(extractRuleFieldValue("path", "write", { path: "src/index.ts" })).toBe("src/index.ts");
		});

		it("提取 params 完整 JSON", () => {
			const json = extractRuleFieldValue("params", "custom", { a: 1, b: "test" });
			expect(json).toContain('"a":1');
			expect(json).toContain('"b":"test"');
		});
	});

	describe("matchApprovalRule 单规则匹配", () => {
		const ruleBashDeny: ApprovalRule = {
			id: "custom.docker-rm",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "regex",
			value: "\\bdocker\\s+(rm|rmi)\\b",
			action: "deny",
			label: "禁止删除 Docker 容器与镜像",
		};

		it("正则匹配命令", () => {
			expect(matchApprovalRule(ruleBashDeny, "bash", { command: "docker rm -f c1" }, cwd)).toBe(true);
			expect(matchApprovalRule(ruleBashDeny, "bash", { command: "docker ps" }, cwd)).toBe(false);
		});

		it("工具不匹配时直接返回 false", () => {
			expect(matchApprovalRule(ruleBashDeny, "write", { command: "docker rm -f c1" }, cwd)).toBe(false);
		});

		it("停用规则不匹配", () => {
			const disabledRule = { ...ruleBashDeny, enabled: false };
			expect(matchApprovalRule(disabledRule, "bash", { command: "docker rm -f c1" }, cwd)).toBe(false);
		});

		it("前缀匹配与包含匹配", () => {
			const rulePrefix: ApprovalRule = {
				id: "custom.prod-path",
				enabled: true,
				tools: ["write", "edit"],
				field: "path",
				match: "prefix",
				value: "production/",
				action: "deny",
				label: "禁止修改生产配置",
			};
			expect(matchApprovalRule(rulePrefix, "write", { path: "production/config.json" }, cwd)).toBe(true);
			expect(matchApprovalRule(rulePrefix, "write", { path: "src/production/config.json" }, cwd)).toBe(false);

			const ruleContains: ApprovalRule = {
				id: "custom.token",
				enabled: true,
				tools: ["*"],
				field: "params",
				match: "contains",
				value: "PRIVATE_KEY",
				action: "deny",
				label: "禁止传递私钥",
			};
			expect(matchApprovalRule(ruleContains, "custom_tool", { token: "MY_PRIVATE_KEY_HERE" }, cwd)).toBe(true);
			expect(matchApprovalRule(ruleContains, "custom_tool", { token: "PUBLIC_KEY" }, cwd)).toBe(false);
		});

		it("工作区外越界写入匹配 (outside_workspace)", () => {
			const ruleWs: ApprovalRule = {
				id: "builtin.file.outside-workspace",
				enabled: true,
				tools: ["write", "edit"],
				field: "path",
				match: "outside_workspace",
				value: "",
				action: "ask",
				label: "工作区外写入",
			};
			expect(matchApprovalRule(ruleWs, "write", { path: "../../external.txt" }, cwd)).toBe(true);
			expect(matchApprovalRule(ruleWs, "write", { path: "src/index.ts" }, cwd)).toBe(false);
		});
	});

	describe("evaluateApprovalRules 多规则决策流", () => {
		it("白名单优先放行 (allow) 胜过后续 ask 规则", () => {
			const rules: ApprovalRule[] = [
				{
					id: "custom.allow-temp",
					enabled: true,
					tools: ["bash"],
					field: "command",
					match: "contains",
					value: "rm -rf /tmp/my-build",
					action: "allow",
					label: "允许清理指定临时目录",
				},
				...DEFAULT_APPROVAL_RULES,
			];

			// 命中了前面的 allow 规则，不再触发默认的 rm -rf 拦截
			const resAllowed = evaluateApprovalRules(rules, "bash", { command: "rm -rf /tmp/my-build" }, cwd);
			expect(resAllowed.action).toBe("allow");

			// 其他危险 rm -rf 依然被后续内置规则拦截为 ask
			const resAsk = evaluateApprovalRules(rules, "bash", { command: "rm -rf /" }, cwd);
			expect(resAsk.action).toBe("ask");
			expect(resAsk.category?.id).toBe("bash.rm-rf");
		});

		it("直接拒绝 (deny) 规则生效", () => {
			const rules: ApprovalRule[] = [
				{
					id: "custom.deny-drop",
					enabled: true,
					tools: ["bash"],
					field: "command",
					match: "contains",
					value: "DROP DATABASE",
					action: "deny",
					label: "严禁删库",
					reason: "已检测到删库指令，被系统规则硬性阻断",
				},
			];

			const res = evaluateApprovalRules(rules, "bash", { command: "mysql -e 'DROP DATABASE prod;'" }, cwd);
			expect(res.action).toBe("deny");
			expect(res.reason).toContain("硬性阻断");
		});

		it("无匹配规则返回 none", () => {
			const res = evaluateApprovalRules([], "bash", { command: "echo hello" }, cwd);
			expect(res.action).toBe("none");
		});
	});

	describe("normalizeApprovalRule 数据校验", () => {
		it("过滤非法与空字段", () => {
			expect(normalizeApprovalRule(null)).toBeNull();
			expect(normalizeApprovalRule({})).toBeNull();
			expect(normalizeApprovalRule({ id: "", label: "test" })).toBeNull();
			expect(normalizeApprovalRule({ id: "valid", label: "" })).toBeNull();
		});

		it("捕获坏正则", () => {
			const badRegex = {
				id: "bad",
				label: "坏正则",
				tools: ["bash"],
				field: "command",
				match: "regex",
				value: "[unclosed",
				action: "ask",
			};
			expect(normalizeApprovalRule(badRegex)).toBeNull();
		});

		it("补齐并归一化缺省字段", () => {
			const good = normalizeApprovalRule({
				id: "ok",
				label: "合法规则",
				value: "echo",
			});
			expect(good).not.toBeNull();
			expect(good?.enabled).toBe(true);
			expect(good?.tools).toEqual(["*"]);
			expect(good?.action).toBe("ask");
			expect(good?.field).toBe("command");
			expect(good?.match).toBe("regex");
		});
	});
});

describe("ApprovalRulesStore 持久化库与播种机制", () => {
	let tmpDir: string;
	let storePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rules-store-test-"));
		storePath = join(tmpDir, "approval-rules.json");
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("初次加载自动播种全部内置默认规则", () => {
		const store = new ApprovalRulesStore(storePath);
		const list = store.list();
		expect(list.length).toBe(DEFAULT_APPROVAL_RULES.length);
		const rmRf = list.find((r) => r.id === "builtin.bash.rm-rf");
		expect(rmRf).toBeDefined();
		expect(rmRf?.builtin).toBe(true);
	});

	it("添加、编辑与删除自定义规则", () => {
		const store = new ApprovalRulesStore(storePath);
		const err = store.upsert({
			id: "custom.test-rule",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "danger-cmd",
			action: "deny",
			label: "测试自定义规则",
		});
		expect(err).toBeNull();

		let list = store.list();
		expect(list.find((r) => r.id === "custom.test-rule")).toBeDefined();

		// 编辑
		store.upsert({
			id: "custom.test-rule",
			enabled: false,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "danger-cmd-2",
			action: "allow",
			label: "测试修改",
		});
		list = store.list();
		const updated = list.find((r) => r.id === "custom.test-rule");
		expect(updated?.enabled).toBe(false);
		expect(updated?.value).toBe("danger-cmd-2");

		// 删除
		const removed = store.remove("custom.test-rule");
		expect(removed).toBe(true);
		list = store.list();
		expect(list.find((r) => r.id === "custom.test-rule")).toBeUndefined();
	});

	it("禁止直接删除内置规则（只允许禁用），支持恢复默认", () => {
		const store = new ApprovalRulesStore(storePath);
		const rmSuccess = store.remove("builtin.bash.rm-rf");
		expect(rmSuccess).toBe(false);

		// 修改内置规则
		store.upsert({
			...DEFAULT_APPROVAL_RULES[0],
			action: "allow",
			label: "已魔改",
		});
		let item = store.list().find((r) => r.id === "builtin.bash.rm-rf");
		expect(item?.action).toBe("allow");

		// 恢复默认
		const resetOk = store.resetBuiltin("builtin.bash.rm-rf");
		expect(resetOk).toBe(true);
		item = store.list().find((r) => r.id === "builtin.bash.rm-rf");
		expect(item?.action).toBe("ask");
		expect(item?.label).toBe("递归/强制删除 (rm -rf)");
	});

	it("saveAll 批量重排", () => {
		const store = new ApprovalRulesStore(storePath);
		const list = store.list();
		const reversed = [...list].reverse();
		const err = store.saveAll(reversed);
		expect(err).toBeNull();
		const current = store.list();
		expect(current[0].id).toBe(reversed[0].id);
	});
});
