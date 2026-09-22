# tasks-plugin-ui.md — 插件 UI 扩展点框架（issue #146 完整版）交接单

> 给「新对话的 AI」看的续作说明。**动手前先读完整份 + `AGENTS.md`**。
> 注：仓库里的 `tasks.md` 是另一份任务书（issue #91 服务端多语言），本文件是**插件 UI 扩展点**的交接单，互不覆盖。
> 本轮的立场：宿主做成**通用扩展点框架**（新增挂载点 = 宿主加常量 + 一处渲染，插件侧契约不变），
> 而不是继续往 #146 里塞字段。

---

## 0. 一句话现状

**T1（右栏/会话右键的 slot 接入）、T2（`settings.pages` 进设置面板）、T3（多根工作区 + 会话 API）、
T4 的 1/2/3/4/5（单测、`PLUGIN_API_VERSION` 升 2、文档、CHANGELOG、i18n）都已落地并已随
**v0.92.0 发布**。§1–§3 是当时的落地记录（数字已按当前代码校正），§4 是**当前真正剩下的待办**。

当前实测（2026-09-20，仓库 v0.92.0；工作区可能另有并行会话的未提交改动）：

```
npx vitest run     186 文件 / 2289 用例（2284 过 · 1 跳过 · 4 失败）
                      ⚠️ 那 4 个失败属**另一会话的在途工作**（`web/src/ui-slots.ts` 新加的
                         `host:tool-info` 条目的 `labelKey` 还没进 zh 文案表，连带 21→22 的期望），
                         不在本文件范围；以实跑为准
                      ⚠️ tests/unit/plugin-project.test.ts 的 gitTimeoutMs 用例在机器有负载时会偶发
                         挂到 30s（根因见 §4.2），空闲时连过
冒烟 run-smoke     ALL = 62 项；Windows 上 terminal-smoke-test / restart-handoff-test 属已知环境性失败
真 Chrome E2E       ✅ 全绿（实测）：plugin-settings-page-test(12) / plugin-settings-select-ui-test(11) /
                       plugin-topbar-ui-test(10) / context-menu-ui-test(44) / ui-layout-ui-test(47)
                     ✅ workspace-roots-test（协议，已在 run-smoke）
```

**E2E 数字只认实测**：`docs/architecture-plugins.md` 的回归表里已按实测校正；
`grep -c 'check(' tests/<name>.mjs` 只能当上界（循环/条件里的 check 不一定都执行）。

---

## 1. 已完成（别重做）

### 1.1 契约（`server/protocol.ts`）
- `UiSlotId`：**22 个挂载点** —— `topbar.primary` / `topbar.overflow` / `bottombar` /
  `composer.leading` / `composer.actions` / `message.actions` / `rightpanel.tabs` /
  `contextmenu.topbar|message|session|file|toolcall` / `settings.pages` / `leftpanel.sessions` /
  `chat.header` / `chat.empty` / `file.preview.toolbar` / `terminal.toolbar` / `scm.toolbar` /
  `goalbar.actions` / `notice.actions` / `modal.dialog`
- `UiContribution`（`kind`: view/action/badge/menu/page/organizer/divider/toggle/input/progress/select；`children`（一层）/
  `when` / `badge` / `group` / `order` / `align` / `hidden` / `action` / `view` / `checked` / `value` / `progress` / `options`）
- `UiArrangeOp`（插件整理**任何**条目，含 `host:*` 内置）/ `UiPluginUi`（`{items, arrange}`）
- `UiLayoutPrefs`（用户偏好：`hidden` / `shown` / `order` / `groups` / `labels`）
- **`set_workspace_roots`（本轮落地）** + `UiState.workspaceRoots?`
- 授权：`plugin_path_request` / `plugin_path_response` / `plugin_path_revoke` / `plugin_grants`

### 1.2 服务端
- `server/plugins.ts`：manifest `"ui"` 解析（`parseUiItem`/`parseUiContributions`/`parseUiArrange`、
  `UI_SLOTS`、`UI_SLOT_ALIASES` 自然简写）、**权限门控**（严格模式 = 声明了 permissions **或** `apiVersion>=2`）、
  `host.ui.register/update/remove/arrange/list`、跨目录 `host.fs.requestAccess/authorizedDirs/listPath/
  readPath/readTextPath/writePath/removePath`、`host.project.create`、
  `notifyWorkspaceRoots()` / `isInsideWorkspace()`（额外工作区根也算「工作区内」）、
  **`PLUGIN_API_VERSION = 2`**、`onGrantsChanged` 钩子（授权落表即重推 `plugin_grants`）
- `server/client-state.ts`：`normalizeWorkspaceRoots` / `MAX_WORKSPACE_ROOTS = 8` /
  按项目（cwd）持久化 `workspaceRoots`（`getWorkspaceRoots` / `saveWorkspaceRoots`）
- `server/agent-service.ts`：`ClientSession.setWorkspaceRoots()` + `workspaceRoots` getter、
  快照 `workspaceRoots`、`onCwdChanged(abs, roots)` 钩子带上根；
  `server/dsh/dsh-agent-service.ts` 同样实现（DSH 无插件宿主，多根只让文件树受益）
- `server/index.ts`：分发 `set_workspace_roots`；`onClientCwdChanged` → `notifyCwd` + `notifyWorkspaceRoots`；
  `plugin_path_request` 广播与答复、attach 推 `plugin_grants`、`plugin_job*` / `plugin_catalog_sync` /
  `set_settings.uiLayout`
- `server/plugin-grants.ts`（授权表）、`plugin-project.ts`（项目组装）、`plugin-installer.ts`（#152）、
  `plugin-catalog-sync.ts`（#148）

### 1.3 前端
- `web/src/ui-slots.ts`：`BUILTIN_UI_ITEMS`（**109** 条，覆盖 **12 个 slot**；其中 `browser`/`sound`/`language`/`theme`/`update`/`github` 六个**默认 `hidden:true`**，落在「⋯」溢出菜单里）+ `buildUiSlots`
  （**四级优先级：宿主默认 → 插件贡献 → 插件 arrange → 用户偏好（最高）**）+ `splitOverflow` /
  `restoreUiItem` / `restoreAllUi`；条目带 `arrangedBy` / `userOverrides` / `movedFrom`
- `web/src/context-menu-state.ts` + `components/ContextMenu.tsx`（App 里唯一的全局右键菜单）
- `components/PluginPage.tsx`（`settings.pages` 宿主容器）+ `components/SlotTabs.tsx`（slot tab 容器）
- **已接入的挂载点（12 个有内置条目，其余为纯插件位）**：`topbar.primary` / `topbar.overflow`（含**隐藏的内置入口在「⋯」里真的可点**，
  见 §2.6）/ `bottombar` / `composer.actions` / `message.actions` / `contextmenu.message` /
  `contextmenu.topbar` / `rightpanel.tabs`（含根选择器）/ `contextmenu.file` / `contextmenu.session` /
  `contextmenu.toolcall`（工具卡工具名右键，宿主内置「显示工具详细信息」，见 §1.1 之外的 ToolInfoDialog）/
  `settings.pages` / `file.preview.toolbar` / `terminal.toolbar` / `scm.toolbar` / `goalbar.actions` / `leftpanel.sessions`
- 设置面板：**「界面布局」页**（按 slot 列条目、来源、隐藏/显示、↑↓、单条恢复、全部恢复）+ **「已授权目录」段**
  + **插件自定义页**（侧边栏一项一页，`PluginPage` 渲染）
- `web/src/app-globals.ts`：`workspaceRoots`（与 `cwd` 同源，快照镜像；`sameArray` 比较防白重渲染）
- `web/src/plugin-host.ts`：宿主 API 版本 **11**（v2 引入 `sessions.list/open`、`openSession` 多根；后续陆续加了
  `openModal`/`closeModal`、`shortcuts`、`searchProviders`、`composerProviders`、`loadPluginBundle` 等）
- 样式：`styles.css` 的 `.ctx-menu*` / `.slot-tabs*` / `.plugin-page*` / `.root-picker*` /
  `.status-action` / `.composer-plugin-action` / `.set-ui-slot*` / `.set-plugin-page`

### 1.4 测试
- 单测（当时新增的）：`plugin-ui-manifest`、`workspace-roots`、`plugin-host`（多根 + 会话 API 用例）
  —— **当前总数**：183 文件 / 2258 用例（2026-09-20 实测，见 §0）
- 协议：**`tests/workspace-roots-test.mjs`**（多根落快照 / 归一化 / 按项目持久化 / 插件免授权读根）、
  **`tests/plugin-grants-test.mjs`**（授权接线：request → 浏览器确认 → 落表 → 插件读得到 → 撤销 → 再问一遍）、
  `tests/plugin-jobs-test.mjs`
- 浏览器（真 Chrome，**不入 run-smoke**）：`plugin-settings-page-test.mjs`(12 过)、
  `plugin-settings-select-ui-test.mjs`(11 过)、`plugin-topbar-ui-test.mjs`(10 个 check)、
  `context-menu-ui-test.mjs`(44 个 check)、`ui-layout-ui-test.mjs`(46 个 check：布局页 ↔ 界面一致性)
  —— 后三个当前**未全绿**，原因见 §4.1

---

## 2. 本轮的关键决策（以后别推翻，除非有更好理由）

### 2.1 多根工作区存**服务端**（不是 localStorage）
按项目（cwd）存在 `client-state.json`，经快照 `workspaceRoots` 下发。理由：插件宿主也要知道
（`isInsideWorkspace` 据此豁免授权），多标签页/多设备一致，重启不丢。**AI 仍只在主 cwd 里干活**
（pi SDK 单 cwd 模型）；多根只影响「哪些路径算工作区内」+ 右栏文件树的根。
前端表现 = 右栏 crumbs 里的根选择器（`.root-picker`）+ 两个加根入口（文件树右键「添加为工作区根」、底栏 cwd 选择器头部「＋ 添加为工作区根」）。

### 2.2 文件树只**切换根**，不做合并视图
一个根一个根地浏览（`list_files` 本来就吃任意绝对路径）。合并多根树 = 多份并发列表 + 虚拟层级，
收益不明、复杂度高，明确不做。

### 2.3 内置「文件」tab 也**可以**被隐藏
`RightPanel` 尊重 `host:right-files` 的 `hidden`（用户偏好 / 插件 arrange）。否则布局页那个勾选框
就是摆设，「设置里看到的 == 界面上看到的」这条 #146 核心不变量当场破产。全藏光时右栏为空 —— 那是
用户/插件的明确意愿，布局页「恢复」一键可退。

### 2.4 `host.ui.register` 与 manifest **同一套解析**
运行时注册也走 `UI_SLOT_ALIASES` + `UI_SLOTS` 校验（以前不映射别名、不校枚举 → 插件写
`slot: "topbar"` 会得到一个前端不认识的 slot，表现成「注册了但界面上没有」，最难排）。
`parseUiArrange` 的 `slot` 仍只收完整枚举名（既有契约，别顺手改）。

### 2.5 `PLUGIN_API_VERSION` 1 → 2 的含义
新能力（`ui` 族、跨目录 fs、`project`、多根）算 v2 契约。升到 2 后：`apiVersion: 2` 的插件**必须**
声明 `permissions`（否则默认拒绝 + `console.error`），manifest 侧的 `ui` 门控也与 `can()` 同口径了
（`scan()` 里原来只看 permissions，不看 apiVersion —— 已修）。仓库里的官方插件都没写 `apiVersion`，
不受影响（仍是旧全权模式：放行 + 每次激活警告一次）。

### 2.6 隐藏的内置顶栏入口在「⋯」溢出菜单里**必须真的可点**
`App` 的 `onUiAction` 只分发**插件**动作；`host:*` 的实现留在拥有它的组件里（T1 的教训）。
所以 `TopBar` 自己有一份 `dispatchHostOverflow`（history / files / new-chat / search / tasks / settings →
本地处理器），溢出菜单先问它、再回落 `onUiAction`。**新增可隐藏的宿主入口时记得在这里补一条**，
否则用户会得到一个点了没反应的按钮。顺带修掉了溢出菜单把宿主图标词表名（`folder`）当文字显示的问题。

### 2.7 授权落表即重推
`host.fs.requestAccess` 成功后经 `PluginManager.onGrantsChanged` → `index.ts` 的 `pushPluginGrants()`，
设置面板「已授权目录」即时可见（以前只在 attach / 撤销时推，「点了允许但列表里没出现」）。

---

## 3. 内置条目现在**真的**听布局页（本轮补齐，别退回）

初版只有部分渲染层消费 slot（其它写死在组件 JSX 里 → 布局页的勾选框是摆设，见 git 历史里的
`ui-slots.ts` 注释「位置登记，由渲染层决定画不画」）。**本轮把宿主内置条目也接进了 slot 渲染**：

| 位置 | 渲染层 | 隐藏 | ↑↓ 调序 |
|---|---|---|---|
| 顶栏视图三连 / 右上固定开关（历史·文件·新对话） | `hostOn()` 门禁 | ✅（隐藏的从「⋯」菜单点回来） | 结构固定 |
| 顶栏「桌面工具组」（搜索/浏览器/任务/设置/声音/语言/主题/版本/GitHub） | `TopBar.tsx` 的 `hostNodes` 节点工厂，按 `uiPrimary` 顺序画 | ✅ 进「⋯」菜单（**菜单型整块组件搬过去**：`OVERFLOW_AS_NODE_IDS`） | ✅ 真的换位置 |
| 底栏 | `FooterBar.tsx` 的 `hostNodes` + `bottombarItems` 顺序 | ✅ | ✅ 真的换位置 |
| 消息 hover 工具条 | `Message.tsx` 跳 `hidden` | ✅（全隐藏 ⇒ 整条容器不画） | ✅（按数组顺序拼） |
| 右栏 tab | `RightPanel.tsx` 按 `uiRightPanelTabs` 顺序 | ✅（含内置「文件」tab） | ✅ |
| 四处 `contextmenu.*` | `LeftPanel` / `RightPanel` 跳 `hidden` | ✅（一条不剩就不弹空菜单） | ✅（数组顺序即菜单顺序） |

**新增/改渲染层时必须在渲染组件里接上**（§2.6 那条纪律的另一半）：

1. 新增一个可隐藏/可排序的宿主入口 → 在拥有它的组件里加一份 **id → 节点/处理器** 映射
   （`hostNodes` 或 `dispatchHostOverflow` 那种），并确保 `uiPrimary`/`bottombarItems` **没传**时
   回退成「按内置默认顺序全画」（拿不到 slot 数据就把整条顶栏/底栏清空是最糟的降级）。
2. 顶栏的**容器划分**（品牌区 / 视图条 / 桌面组 / 右上固定开关）是结构性的：↑↓ 只在桌面组与底栏
   真的换位置，跨容器调序不可表达；窄屏 `.topbar-more` 折叠面板完全不参与 slot（它不是同一批入口）。
3. 右栏插件 tab / 插件页会随选中项卸载（`SlotTabs` 的取舍：让插件 cleanup 生效，代价是 tab 内部
   状态不保）。要保状态就把状态提到上层组件 —— 别改成 `display:none` 全留。

回归网：`tests/ui-layout-ui-test.mjs`（真 Chrome，43 checks：插件 arrange 藏宿主条目 / 插件条目与宿主同排 /
右栏 tab 顺序 / 勾掉与 ↑↓ 真的生效 / 隐藏的菜单型条目在溢出菜单里还能用 / 消息工具条整条不画）。

## 4. 还剩什么（2026-09-20 重新盘点）

> 发版收口（版本号 / CHANGELOG / #146 回帖 / 发布）**已于 v0.92.0 完成**，不再是待办。
> 下面全是本次文档审计期间**实测发现**的、有证据的遗留项。

### 4.1 三个真 Chrome E2E 的测试假设过期 —— **已全部修好并实测全绿**

| 测试 | 原失败原因 | 修法 | 实测 |
|---|---|---|---|
| `plugin-topbar-ui-test` | ① 用 `button[title*="设置"]` 找设置入口（顶栏刻意不用原生 `title`，用 `data-tip`）② `.plugin-topbar-item` 被「⋯」按钮复用，默认视口下插件条目落进溢出菜单 ③ 卸载按钮在「界面插件」→「**插件列表**」子页签里（默认是「插件市场」） | 改选择器 + 宽视口 + 按 `.set-subtab` 切子页签（并在切前断言「源码构建」） | **10/10** |
| `ui-layout-ui-test` | 4 条假设「声音/主题」默认在主栏；实际这六个内置条目 `hidden: true`，默认在「⋯」里（取消勾选实际是**显示**） | 先用布局页勾选框把两者**显示出来**，再走原有的调序/隐藏/溢出断言 | **47/47** |
| `context-menu-ui-test` | ① 文件行菜单断言「上传文件到当前目录」，但 `RightPanel.tsx` 对 `host:file-upload` **文件行刻意隐藏**（`isFile ||`）—— 经确认这是**产品回归**，已去掉 `isFile` 判断 ② 溢出菜单里菜单型条目包在 `.plugin-topbar-menu-keep`（无 `role=menuitem`） | 恢复文件行上传（产品改动）+ 放宽菜单项选择器 | **44/44** |
| `plugin-settings-page-test` | 布局页已拆成独立页签（`{ id: "layout" }`），测试还在点「界面插件」 | 改点「界面布局」页签 | **12/12** |
| `ui-layout-ui-test`（另一条） | 「消息工具条有 4 个可隐藏条目」——实际 5（编辑重问 + 复制四件套） | 期望值 4→5 | — |
| `dsh-ui-test` | 同上第一条（`button.chip[title="设置"]`） | 改按 `data-tip` 匹配（未重跑，需 DSH 运行时） | 未验 |

### 4.2 `plugin-project.test.ts` 的 `gitTimeoutMs` 用例在负载下偶发挂死（真缺陷）

- **根因**：`server/plugin-project.ts` 的 `runGit` **只在 `child.on("close")` 里 settle**（唯一出口）；
  超时路径调 `killPidTree`，而它在 win32 是 fire-and-forget（`server/process-utils.ts` 的
  `void import(...).then(spawn taskkill)` + `unref`，不等杀灭结果）。负载高时竞态窗口变宽 → `close` 迟到
  → Promise 不 settle → 挂到用例的 30s 上限。
- **证据**：空闲连过 3 次；4 个 Chrome E2E 抢机器时连续失败 2 次；独立循环复现过 1 次挂死。
- **修复方案**（未动代码）：① `runGit` 加 `settled` 标志 + 杀灭后「宽限计时器」强制
  `settle({timedOut:true, code:-1})` 并 `destroy()` 两条 stdio 管道；② `killPidTree` 返回 Promise；
  ③ win32 上 taskkill 后再补一发 `child.kill()`；④ 确定性恢复后收紧 30s 上限。

### 4.3 `plugins/voice-input` 缺 `"tools"` 能力族 → 它的 AI 工具永不注册（**已修**）

`plugins/voice-input/manifest.json` 的 `permissions` 原是 `["ui","http","fs:read"]`，但它调用了
`host.registerAgentTool({ name: "transcribe_audio" })`；宿主对注册点是**硬门控**
（`server/plugins.ts` 的 `if (!can("tools")) return () => {}`），严格模式下未声明 `tools` 即拒
→ 工具实际永远不会注册（只打一条「缺少能力声明」的运行时诊断）。其余所有注册 AI 工具的插件
（db-client / image-toolkit / legado-web / live-preview / notes / vscode-editor / webmail / wechat-ilink）
**都**声明了 `"tools"`。`tests/unit/voice-input.test.ts` 用 `createMockHost`，拦不住这类门控。
**已修**：manifest 加 `"tools"`，并给单测补上 `expect(manifest.permissions).toContain("tools")` 断言
（以前没断言，所以缺声明时测试是绿的）。

### 4.4 可选增强（都不是必须）

- 右栏多根的合并视图（现在只支持切换根）；
- 设置面板里直接管理「额外工作区根」（现在只能从文件树右键加减）；
- `kind="organizer"` 目前只在协议词表与 `UI_KINDS` 里存在，各渲染层无专门处理；
- ~~插件条目/内置条目的冲突检测与教学式错误~~ → **已做**（§10 的 P0-1）；
- 服务端 `parseUiItem` 的丢弃点仍只产 diagnostics（不下发到 UI）——前端合并层的
  诊断（§10 P0-1）已经覆盖「注册了但界面上没有」的主诉；服务端那批留给「插件作者
  看设置面板」时再看（现成字段 `UiPluginInfo.diagnostics` 已经在）。

---

## 4.5 本轮 DSH 对照升级（2026-09-22，见 §10）

**做完了「如果只做三件事」里的两件 + 一件**，都在分支 `feat/plugin-system-dsh-upgrade`：

| 条目 | 状态 | 主要落点 |
|---|---|---|
| §10.1【P0-1】失败不许静默（布局诊断 + per-entry ErrorBoundary） | ✅ | `web/src/ui-slots.ts`（`diagnostics[]`）、`components/SlotErrorBoundary.tsx`、`SettingsModal` 布局页横幅、`App.tsx` console.warn |
| §10.2【P0-2】统一的可逆副作用（effect 栈） | ✅ | `server/plugins.ts`（`PluginEffectStack` + `host.effect`） |
| §10.3【P0-3】安装前先读 spec（引导式安装） | ✅ | `server/plugin-install-spec.ts`、`plugin-installer.ts#inspectInstallSpec`、协议 `plugin_install_inspect*`、设置面板市场页 |
| §10.4【P1-4】slot 语义化（cardinality + chain） | ⬜ 未做 | — |
| §10.5【P1-5】拦截扩展点（类型化 Decision） | ⬜ 未做（依赖 10.2 已就位） | — |
| §10.6【P1-6】manifest schema 校验失败即拒 | ⬜ 未做 | — |
| §10.7–10.9【P2】注册面目录 / 依赖声明 / 层式组合 | ⬜ 未做 | — |

---

## 5. 硬约束与坑（必读）

### 5.1 工具坑
- **不要用 `edit_soft`**：它对多行块（尤其含 `}` 结尾）会匹配错位，实测弄坏过 `protocol.ts`、
  `use-chat.ts`、`ChatInput.tsx`。用**精确 `edit`** 或（更稳）**写临时 node/python 脚本做字符串/行级替换**。
- 写临时脚本时：**每次替换后就 `writeFileSync`**（或最后统一写但先确认无中途抛错），失败路径也要清干净
  （临时脚本命名 `.pi-tmp-*` / 放 `tests/scratch/`，用完立刻 `rm`，`git status` 里别留 `??`）。

### 5.2 工作区
- 工作区有**大量未提交改动**（含别人的 #145/#147 修复）。**不要 `git checkout --` 整目录**，
  也不要 `git stash`；需回滚单个文件时先 `git diff <file>` 确认那文件里没有别人的改动。
- 服务端改动后要 **`pi-web-ui server restart`**（或重启 dev server）才生效；前端要 `npm run build`。

### 5.3 接入新挂载点时的纪律
1. **内置条目的实现留在组件内**，`host:*` 由该组件按 id 显式分派（App 只分发插件动作）
2. `hidden === true` 的条目：有"溢出"概念的地方（顶栏）**移到溢出菜单**（且必须真的可点），
   没有的地方（底栏/右键）**直接跳过** —— 用户永远能在设置面板「界面布局」里改回来
3. 条目顺序**严格按传入数组**（宿主已排好序，组件不要再排一次）
4. 无条目时**不要渲染空容器**
5. 组件里不要 import `styles.css`；新类名把 CSS 片段加进 `styles.css` 的「插件 UI 扩展点」分区

### 5.4 测试规范
- 单测：`tests/unit/*.test.ts`（vitest）；E2E：`tests/*-test.mjs`（自起 server，端口 ≥8900，
  临时 data-dir，结束精确清理自己进程，**禁用 `pkill -f`**）
- 需要 Chrome 的浏览器 E2E 放在 `tests/`，**不入 `run-smoke.mjs`**（CI 不一定有 Chrome），
  文件头写清「缺 Chrome 自动 SKIP」
- 加了新的零 token 协议脚本 → 记得加进 `tests/run-smoke.mjs` 的 `ALL` 列表
- **浏览器 E2E 的两个实测坑**（写新脚本时直接抄现有脚本的 `tap` / `settle` 助手）：
  1. `locator.click()` 在顶栏上偶发不达（悬停时子节点位移，事件没冒泡到按钮）→ 用
     「按坐标派发真实鼠标事件」（`tap()`）；右键菜单要用 `page.mouse.click(x, y, {button:"right"})`
  2. 服务端刚 `build` 过时页面会**自愈重载一次**（PR #144），会把刚打开的弹窗清掉 →
     操作前先 `settle()`（连续 2.5s 没有导航）或对「打开弹窗」这类动作带重试
  3. 别用 `title*="文件"` 找右栏开关 —— 全局搜索的提示文案里也有「文件」，会点开搜索弹窗
     盖住整页（要精确匹配 `title="文件列表"`）

### 5.5 i18n
- 前端 key：`web/src/i18n.tsx` 的 `zh` + `en`，**同时**补 `locales/*.json` 的 8 个语言包
  （顺序与 zh 一致、值先用英文），否则 `tests/unit/locales.test.ts` 红
- 服务端文案：`pick(lang, zh, en, "key", vars)` / `getServerBlock`；`bilingual()` 用于 tool 定义

---

## 6. 验证命令（每次收口都跑）

```bash
npm run typecheck        # 五套 tsc（server/web/tests/desktop/extension）
npm run format && npm run format:check
npm run lint             # 基线 = 3 warnings（model-admin / mermaid / marker-service）
npx vitest run           # 期望 183 文件 / 2258 用例全绿（plugin-project 的 gitTimeoutMs 在负载下偶发挂死，见 §4.2）
npm run build
# 真 Chrome（本地跑；CI 里自动 SKIP）
node tests/plugin-topbar-ui-test.mjs
node tests/plugin-settings-page-test.mjs
node tests/context-menu-ui-test.mjs
node tests/ui-layout-ui-test.mjs
node tests/panel-layout-test.mjs
# 零 token 协议冒烟（本地 / CI 同款）
node tests/run-smoke.mjs workspace-roots-test plugin-grants-test settings-test \
  plugin-test plugin-jobs-test plugin-settings-test left-panel-delete-test
```

---

## 7. 关键文件地图

| 层 | 文件 | 作用 |
|---|---|---|
| 契约 | `server/protocol.ts` | `UiSlotId` / `UiContribution` / `UiArrangeOp` / `UiPluginUi` / `UiLayoutPrefs` / `workspaceRoots` / 授权消息 |
| 服务端 | `server/plugins.ts` | manifest `ui` 解析 + 权限门控 + `host.ui.*` / `host.fs.*`（含跨目录）/ `host.project` + `notifyWorkspaceRoots` |
| 服务端 | `server/plugin-grants.ts` | 目录授权表 |
| 服务端 | `server/plugin-project.ts` | 项目组装（clone/写文件，越界拒绝） |
| 服务端 | `server/plugin-installer.ts` | 插件后台作业（#152） |
| 服务端 | `server/client-state.ts` | `normalizeWorkspaceRoots` + 按项目存根 |
| 服务端 | `server/agent-service.ts` | `ClientSession.setWorkspaceRoots` / 快照 / `onCwdChanged(abs, roots)` |
| 服务端 | `server/index.ts` | 分发：`plugin_job*` / `plugin_path_*` / `set_settings.uiLayout` / `set_workspace_roots` / attach 推 `plugin_grants` |
| 前端 | `web/src/ui-slots.ts` | 内置条目 + 四级优先级合并（**排序/可见性的唯一事实源**） |
| 前端 | `web/src/context-menu-state.ts` + `components/ContextMenu.tsx` | 通用右键菜单 |
| 前端 | `web/src/components/PluginPage.tsx` + `SlotTabs.tsx` | 插件页宿主 / slot tab 容器 |
| 前端 | `web/src/plugin-host.ts` | `window.__piWebUiHost`（API 版本 **11**） |
| 接入点 | `TopBar.tsx`（含 `dispatchHostOverflow`）/ `FooterBar.tsx` / `ChatInput.tsx` / `Message.tsx` / `MessageList.tsx` / `RightPanel.tsx`（含根选择器）/ `LeftPanel.tsx` / `App.tsx` | 已接入的挂载点与 props 传递 |
| 面板 | `web/src/components/SettingsModal.tsx` | 「界面布局」页 + 「已授权目录」段 + 插件自定义页 |

---

## 8. 契约速查

### 8.1 插件怎么声明（manifest.json）
```jsonc
{
  "permissions": ["ui", "fs"],   // apiVersion: 2 时**必须**声明（严格模式按族门控）
  "ui": {
    "topbar": [{ "id": "inbox", "label": "收件箱", "labelEn": "Inbox", "icon": "📬",
                 "kind": "action", "action": "webmail:open-inbox", "group": "mail", "order": 10 }],
    "composer": [{ "id": "pick", "label": "拾取元素", "kind": "action", "action": "webmail:pick" }],
    "rightpanel": [{ "id": "mail", "label": "邮件", "kind": "view" }],
    "settings": [{ "id": "conf", "label": "邮箱设置", "kind": "page" }],
    "contextmenu.file": [{ "id": "mail", "label": "发送到邮箱", "kind": "action", "action": "webmail:send" }],
    "arrange": [{ "id": "host:tasks", "hide": true }, { "id": "host:ctx", "order": 5 }]
  }
}
```
（`topbar` / `topbar.more` / `composer` / `message` / `rightpanel` / `settings` 是别名，全名也可用。）

### 8.2 插件怎么接管动作（client bundle）
```js
window.__piWebUiHost?.onUiAction?.("webmail:open-inbox", (itemId) => { /* ... */ });
window.__piWebUiHost?.onTopbarAction?.("webmail:open-inbox", fn);   // 旧名，等价
```

### 8.3 合并优先级
```
宿主默认(BUILTIN_UI_ITEMS) → 插件 items → 插件 arrange(按插件顺序, 只改已存在条目) → 用户偏好(最高)
用户偏好：hidden / shown(覆盖插件 hide 与默认 hidden) / order / groups / labels
```

### 8.4 会话 / 多根 API（宿主桥 v2 引入，当前宿主 API 版本 11）
```js
await __piWebUiHost.openSession({ cwd, folders: [extra1, extra2], prompt, newChat });  // 多根 = cwd + 额外根
__piWebUiHost.sessions.list();          // 运行中的对话 + 当前项目历史会话
await __piWebUiHost.sessions.open(id);  // 跨项目会先切 cwd（走目录授权）
```

---

## 9. 【调研】DSH 插件系统对照 → 可借鉴清单（2026-09-20）

> 来源：`E:\deepseek-harness`（DeepSeek Harness，简称 DSH）插件系统调研。
> 本节是**待排期的提案**，不是已完成项，也没有动任何现有代码。
> 每条给「概念 / pi-web-ui 现状 / 为什么 / 验收 / 成本 / 落地位置」。
>
> **先给结论**：pi-web-ui 有两点**比 DSH 更强，别动**——
> ① 权限体系（目录授权父子覆盖 + 能力动态授权 + DOM 授权 + 全部可撤销可审计；DSH 的 guard 源码自述
> 「这是 API 纪律，**不是安全边界**」）；
> ② 四级优先级里**用户偏好永远最后说话** + `arrange` 改别人的条目留痕 `arrangedBy`/`movedFrom`
> （DSH 只有 priority 数字遮蔽，插件把宿主入口藏了用户没有「恢复」这个动作）。
> 真正缺的是两件事：**「声明 ↔ 生效」之间的闭环**，与**插件参与 agent 行为的能力**。

### 9.0 DSH 的四层结构（照抄前先看懂这个）

| 层 | 机制 | 解决什么 |
|---|---|---|
| 地基：cordis | 插件=实现 Service 的对象；`ctx.<key>` 服务注册表；`inject` 声明依赖；5 种事件分派（emit/waterfall/parallel/serial/bail）；一切注册皆为可逆 effect | 加载顺序由**依赖**决定而非文件顺序；插件不 import 实现，只认能力名 |
| 来源①：持久 bundle | npm 包 + `dsh.bundle.patch`，profile 层式组合（按 id 覆盖 config / insert / `disabled` 保留条目）；`plugin_manager` 工具 + 侧栏 Plugins 页 | 环境差异变成**可叠加、可局部覆盖的声明层** |
| 来源②：运行期动态插件 | Plugin（稳定）/ Package（**不可变版本**）/ Run（一次激活）三层身份；host 半 + client 半；审批闸门；教学式 guard | 让程序/模型在运行期写插件，而不破坏「审批过的东西不变」 |
| UI：slots | `SlotMap` 接口声明合并；4 种 cardinality（single/list/**keyed**/**chain**）；scope；priority；inject 工厂/store/hooks/locale 五份 share；**组件永远拿不到 ctx** | 跨包 UI 组合不必互相 import，错在编译期或激活期爆 |

另有一层**拦截扩展点**（工具五阶段流水线 + 类型化 Decision），见 9.5。

> ⚠️ 一处容易搞错的地方：DSH 早期「模型自己写插件」的工具（`cordis_define/run/stop/undefine`）**已退役**
> （e2e 里有断言要求这五个名字不再出现），模型面只剩 `cordis_inspect_list` / `cordis_inspect_query`
> 两个**只读**工具（`packages/extensions/tool-cordis/src/index.ts:28,47`），持久化路径改走 `plugin_manager`。
> 所以「AI 写插件」在 DSH 那边也还不是主路径——**别把它当成我们落后的证据**。

### 9.1 【P0-1】失败不许静默：教学式错误 + per-entry 隔离 + 归因

- **概念**：DSH 把注册面每个拒绝点都做成**教学式错误**（`guard.ts:229` `harness.defineTool X must declare a valid type: …`；
  未声明就用 `ctx.service` → 「declare it: `inject:['x']` on your plugin」）；slot 注册未声明槽、keyed 缺 key、
  同 priority 同格，**运行时再查一遍并抛错**；每个 entry 独立 ErrorBoundary，崩溃 **abdicate** 给下一个 survivor，
  全灭渲染崩溃面；失败还能回读给模型自修。
- **现状**：`web/src/ui-slots.ts` 的 `buildUiSlots` 对未知 slot **静默丢弃**、坏字段静默跳过；
  全仓 `grep ErrorBoundary` **0 命中**；`components/PluginView.tsx:27` 的 mount 失败只 `console.error`；
  服务端 `server/plugins.ts` 的 `parseUiItem` 同样宽容丢弃。
- **为什么**：`AGENTS.md` 反复出现的坑就是这么来的——「注册了但界面上没有，最难排」
  「加新入口忘了接 slot = 一个点了没反应的勾选框」「slot 别名只改一边」。这不是新问题，是**反复复发的旧问题**，
  而且与本文件 §5.3 的「接入纪律」是一体两面：纪律靠人记，闭环靠代码。
- **验收**：
  1. `buildUiSlots` 多返回 `diagnostics[]`（未识别 slot / 重复 id / 未知 kind / 非法 when），
     设置面板「界面布局」页顶部显示一条，同时 `console.warn` 带 pluginId；
  2. slot 渲染处包 ErrorBoundary（**每条目独立**），崩溃只丢该条并置灰，不炸整片；
  3. 服务端 `parseUiItem` 的丢弃点也产出诊断，随 `plugins` 清单下发，插件作者在设置面板就能看到。
- **成本**：中低。
- **落地位置**：`web/src/ui-slots.ts`、各渲染层（`TopBar`/`FooterBar`/`Message`/`RightPanel`/`ChatInput`）、
  `web/src/components/SettingsModal.tsx`（布局页）、`server/plugins.ts`、`server/protocol.ts`（清单带 diagnostics）。

### 9.2 【P0-2】统一的可逆副作用（effect 栈）

- **概念**：cordis 里一切注册都是 effect，fiber 卸载时**逆序回卷**；`ctx.effect()` 保证没有孤儿。
- **现状**：每个注册**都**返回了注销函数（dispose 风格已经很统一，这点很好），但**插件实例级没有 effect 栈**——
  `plugins_reload` = 反激活全部 → 重扫（`server/plugins.ts`），清理全靠各插件自觉。
  泄漏高发区：`host.schedule` / `host.route` / `onToolEvent` / `onRunEvent` / `host.fs` 的 watcher / 定时器。
- **为什么**：热重载后事件双触发、定时器叠加、路由重复注册、watcher 堆积。同类事故已有先例
  （`host.schedule` 的 setTimeout 24.8 天溢出死循环，见 `AGENTS.md` 常见坑）。
- **验收**：`PluginHost` 内部维护 per-plugin `effects: Array<() => void>`；宿主每个订阅/注册 API
  **在内部 push disposer**（理想情况下**不需要改任何插件**）；`deactivate` 逆序全跑，跑不干净的记 name 并 warn；
  加单测断言「activate → deactivate 后 effect 栈空」。
- **成本**：中。
- **落地位置**：`server/plugins.ts`（PluginHost 的注册面）、`server/plugin-schedule.ts`。

### 9.3 【P0-3】安装前先读 spec（引导式安装）

- **概念**：DSH 安装对话框**先 inspect 再安装**：`parseInstallSpec` 分类（注册表名 / 绝对路径 / git / tarball）
  → `pnpm view` 或读 `package.json` → 回**七种 problem 之一**（`invalid-spec`/`already-installed`/`not-found`/
  `not-a-package`/`not-a-bundle`/`network`/`unknown`），每种渲染成输入框下的一句话 → 失败/取消**恢复文件** →
  装完默认 disabled，**完成画面才让用户启用**。
- **现状**：`server/plugin-catalog.ts` 的 `source` 只做宽松校验（文档明说**不拉网络、不碰 manifest**）；
  `server/plugin-installer.ts` 直接把 source 交给 CLI；失败输出按行回传面板（这部分已经做得不错）。
  结果是打错字 / 已装过 / 不是插件包，全靠用户读 pnpm 输出。
- **为什么**：**成本最低、用户当天可感知**的一条；且与既有的「后台作业 + 按行回传」天然衔接。
- **验收**：安装前 inspect——非 git/npm 形状、目标已存在（`<dataDir>/plugins/<id>`）、
  远端无 `manifest.json`、repo 不可达，各自一句话且 spec 可改；失败/取消不留半装目录。
- **成本**：低。
- **落地位置**：`server/plugin-installer.ts`（inspect 前置）、`server/plugin-catalog.ts`、
  `web/src/components/SettingsModal.tsx`（插件市场页）。

### 9.4 【P1-4】slot 语义化：cardinality + 冲突检测 + chain 选举

- **概念**：`single`（独占，同 priority 再注册**抛错**）/ `list`（按 id 加法）/ `keyed`（owner 按 key 派发）/
  **`chain`**（每项给纯函数 `select(owner)`，按 priority 升序**首个非 null 胜出**并把结果作为 `matched` 注入，
  全 null 落 owner 的常驻 `fallback`，`overlay:true` 保留 fallback 树位，`select` 抛错降级为弃权）。
- **现状**：只有「list + `order` + `hidden` + 四级优先级」，同 order 稳定排序**静默兜底**——
  既没有取代机制，也没有冲突检测。`kind` 有 11 种（比 DSH 丰富），但缺的是**位置语义**。
- **真实用例**：DSH 用 chain 做「待审批 → 审批面板接管输入框 / 待答问卷 → 问卷接管 / 都不在 → 常驻 composer」。
  pi-web-ui 的问卷是**全局弹窗**（`components/DshQuestionDialog.tsx`），不是接管输入框——
  插件想「在特定状态下接管某个位置」目前只能靠硬编码互斥判断。
- **建议分两步**：① 加 per-slot 的 `single|list` 语义 + 同格冲突检测（**低风险，先做**）；
  ② chain（选举 + 常驻 fallback + overlay 保位，**中高风险**，想清楚再动）。
- **成本**：① 低；② 中高。
- **落地位置**：`web/src/ui-slots.ts`（纯函数 + 单测）、各渲染层、`server/protocol.ts`（`UiContribution`）。

### 9.5 【P1-5】拦截扩展点（类型化 Decision）

- **概念**：插件在工具执行流水线上按阶段拿到**不同权力**——`tools/pre-execute`（allow/**deny**/ask）→
  guards → `tools/execute`（环绕：超时/重试/指标）→ `tools/post-execute`（**变换内容 / 附加 `additionalContexts`**）
  → `tools/result`（只观测）。身份不可变、参数在执行前封存；终结 guard **只能拒绝**，观测者**只能观测**。
- **现状**：`host.onToolEvent` **只观测**（phase `start|end`）——插件能看，不能拦、不能改。
- **为什么**：这是插件从「加个面板」升级到「参与 agent 行为」的分水岭：危险命令拦截、输出脱敏、
  自动补上下文，都能由插件做而不必改宿主。
- **⚠️ 约束（必须诚实）**：工具执行在 pi SDK 内部。pi-web-ui 已经覆盖了 `bash` 与 `read`（说明有插手面），
  但**未必五阶段都能做**。建议只做 **pre + post 两阶段、且只覆盖已接管的工具**，
  先把 decision 类型定清楚（`{allow}` / `{deny, reason}` / `{ask}`；`{content?, additionalContext?}`），
  而不是照搬五阶段。
- **成本**：高。**前置依赖 9.1 / 9.2**——没有隔离与 disposer 体系，加进来的决策面会以同样的方式静默失效。
- **落地位置**：`server/agent-service.ts`（工具执行路径）、`server/tool-manager.ts`、`server/protocol.ts`。

### 9.6 【P1-6】manifest 也是配置：schema 校验失败即拒

- **概念**：DSH 插件导出 Config schema，加载前校验并补默认值，失败 → fiber **FAILED** + 精确错误路径，
  **绝不带着不完整配置启动**。
- **现状**：声明式 settings schema 已经有了（含 `secret` / `optionsFrom`，**比 DSH 更贴用户**），
  但 **manifest 本体是自由形态**——只有 `apiVersion` / `engines` 做了校验。
- **为什么**：坏 manifest 不该变成运行时 `undefined`；与 9.1 同源（把静默丢弃换成明确拒绝）。
  注意与既有语义对齐：「严格模式 = 声明了 `permissions` **或** `apiVersion>=2`」（见 §2.5）。
- **成本**：中低。
- **落地位置**：`server/plugins.ts`（manifest 解析）、`tests/unit/plugin-ui-manifest.test.ts`。

### 9.7 【P2-7】机器可读的「注册面目录」（为 AI 写插件铺路）

- **概念**：DSH 用**词法扫描**（`scripts/gen-client-catalog.ts`）生成 `CLIENT_SLOT_API`——每个 slot 的
  `key/kind/scope/registerOptions/ownerProps/`**`occupants`**/`replaceRisk`/**`example`**/source，
  供只读 inspect 工具给模型查：**能力发现与执行分离**，先查真实 API 再写码，而不是凭记忆猜出满屏幻觉 API。
- **现状**：`plugin-sdk/index.d.ts` 手写静态类型 + `README.md`；没有机器可查的运行时目录。
- **建议**：把 `UI_SLOTS`（+别名）/ `AGENT_TOOL_CATALOG` / 宿主方法表 + **当前占用者** + 例子生成为 JSON
  （随 `plugins` 清单下发或一个只读 HTTP 端点），插件作者与将来的 AI 都能查。
- **前置**：先想清楚**要不要做「AI 写插件」**。注意 pi-web-ui 现在方向相反——
  `host.registerAgentTool` 是**插件给 AI 加工具**。所以这条是**铺路**，不是当下收益。
- **成本**：中。

### 9.8 【P2-8】插件依赖声明（inject 的轻量版）

- **概念**：DSH 的 `inject` 未满足 → 插件停在 **PENDING**（不激活）；提供方卸载/热替换 → 消费方一并卸载，
  服务恢复后重新加载。**决定启动时机的是依赖，不是文件顺序。**
- **现状**：`peerPlugins` 只警告不断活；宿主 API 是单体 facade，没有「谁提供能力」的概念。
- **轻量落地**：`manifest.requires: { families?, hostApi?, plugins? }` → 激活前校验，不满足**就不激活** +
  教学式错误（`apiVersion` 已经做了这半个）。
- **成本**：低。

### 9.9 【P2-9】层式组合（官方默认 + 用户局部覆盖）

- **概念**：DSH 的 profile / bundle / patch——按 id 覆盖 config、insert 新条目、`disabled` 保留条目只停挂载。
- **现状**：有 `disabledPlugins`（用户级）、预设、插件自己的 `storage.json`；缺的是
  **「官方默认值可被用户局部覆盖」的声明层**——现在想改一个官方默认值只能 fork。
- **成本**：中。

### 9.10 【P2-10】生态兼容：hooks 桥（可选）

DSH 直接跑现有 Claude Code / Codex 的 `hooks.json`（可阻断 prompt 与工具调用）。pi-web-ui 无对应物。
价值是让用户带既有 hooks 配置进来，但 pi-web-ui 的插件不是「生命周期钩子」形态，
**且依赖 9.5 先落地**，否则没有 decision 面可映射。**成本高，排在最后。**

### 9.11 明确不适用 / 别抄

| DSH 机制 | 为什么不抄 |
|---|---|
| 运行期动态插件三层身份 + 不可变 Package + 审批粒度可升级 | pi-web-ui 没有「运行期生成插件」场景；`plugin-updater` 已有备份/回滚。**若将来真做 AI 写插件，这套是完全正确的模板**（连同教学 guard + 只读 inspect + runId 级 stale 拒绝 + 那句诚实的「这是 API 纪律，不是安全边界」） |
| 客户端半用 seed 词表共享 React | pi-web-ui 是**刻意**不让插件共享 React（插件用原生 DOM、任意技术栈）。两条不同的路，别改 |
| per-package 失败隔离 + `rev` 失效 | `epoch` + `?e=` 已等价 |
| `!!js`（YAML 里跑 JS 表达式求值 config/disabled） | 不在 pi-web-ui 的威胁模型内，别抄 |

### 9.12 如果只做三件事

1. **9.3 安装前 inspect**（成本最低，用户当天可感知）
2. **9.1 失败可诊断**（把「静默丢弃」换成教学式错误 + per-entry ErrorBoundary；直接消灭 §5.3 那类反复复发的坑）
3. **9.2 统一 effect 栈**（为将来所有插件能力兜底）

做完这三条，9.4 / 9.5 才有安全的地基——否则新加的能力会以同样的方式「点了没反应」。

### 9.13 DSH 侧关键文件索引（复核用）

| 主题 | 路径 |
|---|---|
| cordis 地基 | `docs/cordis-primer.md`、`docs/cordis-api/*.md`、`docs/cordis-tutorial/01..07` |
| 生成态 cordis 面 | `docs/subsystems/extensions.md`（`dynamicCordisRunner` / `cordisInspect`） |
| slots 声明/生命周期/cardinality | `docs/subsystems/slots.md`、`packages/client/ui-slots/src/index.ts` |
| 教学式错误 + 审批 + stale 拒绝 | `packages/extensions/cordis-host-runner/src/guard.ts`、`.../src/index.ts:278,348,741` |
| 模型面只读 inspect 工具 | `packages/extensions/tool-cordis/src/index.ts:28,47` |
| 引导式安装 | `packages/boot/plugin-manager/README.md`、`.agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.zh.md` |
| 拦截 Decision 五阶段 | `.agents/notes/implemented/feature/2026-06-30-interception-extension-points.zh.md` |
| 客户端半加载模型 | `.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md` |
| 注册面目录生成器 | `scripts/gen-client-catalog.ts` |

---

## 10. 【已落地】DSH 对照升级 —— 只做三件事（2026-09-22）

> 分支 `feat/plugin-system-dsh-upgrade`。§9.12 说「如果只做三件事」= 9.3 / 9.1 / 9.2；
> 本次**三条全做**（顺序按 §9.12 的建议：先检查闭环、再地基、最后安装引导 ——
> 实际提交顺序是 P0-2 → P0-3 → P0-1，互不依赖）。每条都带单测；跑过的门见文末。
> 三件事做完，§10.4 / §10.5 才有安全的地基（改它们时不用先补隔离与 disposer）。

### 10.1【P0-2 ✅】统一的可逆副作用（effect 栈）

- **新增 `PluginEffectStack`**（`server/plugins.ts`，导出供单测）：`add(label, dispose)` /
  `remove`（幂等单条撤销）/ `release()`（逆序回卷，返回失败标签）/ `size` / `labels()`；
  cleanup 抛错只记一条诊断（`pushRuntimeDiag`），**不阻断**其它清理。
- **宿主每个注册面都改走它**：`registerAgentTool` / `registerCommand` / `route` /
  `registerProxy` / `fs.watch` / `schedule` / `registerBackgroundTask` / `ui.register` /
  `events.on` / `onStats` / `onStreaming` / `onAttach` / `onCwdChange`…（返回给插件的
  注销函数 = 栈里那一项，语义不变）。
- **新 API `host.effect(label, dispose)`**：插件自建的副作用（自建 interval / 监听器 /
  WebSocket）也挂进同一个栈。SDK 的 `index.d.ts` + `createMockHost` 已同步（mock 只记
  调用 + 返回可撤）。
- **删掉** `LoadedPlugin` 的一堆 `*Unsubscribers` 数组（`agentTool/command/watch/schedule/
  bus/stats/streaming`）——它们的作用被一个 `effects` 栈取代；`releaseEntry` 只剩兜底
  （清按 pluginId 索引的代理前缀）。
- **激活失败也回卷**：`activate()` 抛错时先把这一轮已登记的 side effect 逆序撤掉（半途
  注册的工具/路由/定时器不能留给一个已经坏掉的插件），再落错误占位行。
- **验收（单测 `tests/unit/plugin-effects-install-spec.test.ts`）**：逆序回卷顺序、单条撤销
  幂等、cleanup 抛错隔离与归因、`release` 幂等；真实 `PluginManager` 激活一个插件后反激活，
  断言工具/命令/路由（404）/总线订阅/自建 effect 全部回收，`effects.size` 归零。

### 10.2【P0-3 ✅】安装前先读 spec（引导式安装）

- **新增 `server/plugin-install-spec.ts`**（纯函数、不联网、不写盘）：
  `parseInstallSpec` 把来源分成 **npm / github / url / path / invalid**（GitHub 的
  `owner/repo[/sub][#ref]` 与网页 URL 都归 github，能抽 owner/repo/ref/subpath）；
  `inspectLocalInstallSpec` 做本地判定（形状 + 已装 `<dataDir>/plugins/<id>`）；
  `manifestCandidateUrls` 拼 raw.githubusercontent 候选；`suggestPluginId` 死心塌地与
  CLI 同规则（manifest.id > 子目录末段 > 仓库名）。
- **`plugin-installer.ts#inspectInstallSpec`**：本地检查后，本地路径源直接读它的
  manifest.json；GitHub 源用一次 `fetch`（6s 超时，可注入替身）探远端 manifest，
  归到**七种 problem**：`invalid-spec` / `already-installed` / `not-found` /
  `not-a-package` / `not-a-bundle` / `network` / `unknown`。**`network` 不阻塞安装**
  （探测失败只是没核实，不该挡住能装的）。
- **协议**：`plugin_install_inspect`（客户端上行，带 requestId/explicitId/force）→
  `plugin_install_inspect_result`（kind/suggestedId/installed/problem/detail/manifest）。
- **界面**：市场「添加插件」输入框下面一句话（**防抖 500ms 自动查**，来源或 id 变了重查）：
  已装 / 形状错 / 远端不是插件各给一条本地化提示；探到的 manifest 顺带展示（name /
  version / description）让用户确认装的是什么。
- **i18n**：4 个前端 key（zh + en + 8 语言包）：`pluginInspectAlreadyInstalled` /
  `pluginInspectInvalid` / `pluginInspectNotPlugin` / `pluginInspectNetwork`。

### 10.3【P0-1 ✅】失败不许静默（布局诊断 + per-entry 隔离）

- **`buildUiSlots` 新增可选 `diagnostics?: UiDiagnostic[]`**（不传 = 行为与原来**逐字一致**，
  纯函数契约不变）：未知 slot / 未知 kind / 宿主不认识的 when / arrange 目标不存在 /
  同一插件重复声明同 id / 插件被禁用或激活失败，各产出一条带 `pluginId` + `entryId` +
  `slot` 归因的记录。
- **布局页顶部横幅**：可折叠（有 error 级默认展开），逐条列出 `pluginId` `entryId` 与原因
  + 一句「改好插件后重扫」。`App.tsx` 同时 `console.warn` 一条（两处都不吞）。
- **`SlotErrorBoundary`**（新组件）：`slot-toolbar` 的每个条目独立包一层 —— 插件条目（尤其
  自定义 view）渲染抛错时**只丢那一条**并就地置灰（点它 console.error 出细节 + 组件栈），
  不再一个坏条目炸掉整条顶栏/底栏/右栏；key 用条目稳定 id，换条目即重置错误态。
- **验收**：`tests/unit/ui-slots.test.ts` 新增 6 个 diagnostics 用例；
  `tests/ui-layout-ui-test.mjs` 新增 2 个检查（横幅出现 + 点名插件与目标 id）。

### 10.4 尚未做的（按 §9 优先级）

- 【P1-4】slot cardinality（single/list）+ 同格冲突检测（**低风险，建议下一轮先做**）；
  chain 选举（中高风险，想清楚再动）。
- 【P1-5】拦截扩展点（工具 pre/post 两阶段 Decision）—— 前置 P0-2 已就位，可以开工；
  约束不变：先只覆盖 `bash` / `read` 这类**已接管**的工具，别照搬 DSH 五阶段。
- 【P1-6】manifest schema 校验失败即拒。
- 【P2-7/8/9】注册面目录 / 依赖声明 / 层式组合。

### 10.5 本轮验证（实测）

```
npm run typecheck   ✅ 五套 tsc 全过
npm run lint        ✅ 基线 17 warnings（无新增；新增的 warning 已顺手修掉）
npx vitest run      ✅ 217 文件 / 2483 过 · 1 跳过（含本轮新增 18+6 用例）
npm run build       ✅
node tests/plugin-jobs-test.mjs    14 checks（含 inspect 相关的协议层未破坏）
node tests/plugin-test.mjs / plugin-command / plugin-http / plugin-proxy / plugin-cwd /
     plugin-settings / plugin-update / plugin-grants / workspace-roots /
     plugin-catalog-cli  ✅
node tests/plugin-bgtask-test.mjs   ✅（effect 栈接管后台任务后仍随反激活移除）
node tests/ui-layout-ui-test.mjs    48 checks（46 原有 + 2 新增；「Esc 后溢出菜单收起」
                                    在 HEAD 上就失败，属既有问题，非本轮引入）
```

**测试端口冲突提醒**：`run-smoke.mjs` 并行跑多个 `*-test.mjs` 时会撞端口（`plugin-jobs-test` /
`plugin-cwd-test` 在并行批次里偶发假红）——单跑都过。要并行请给 `freePort` 加锁或串行。
