# AGENTS.md — pi-web-ui 项目指南

> 给 AI 编码助手（pi / Claude Code / Cursor 等）看的高层指南，细节按主题在 `docs/`。
> 修改后在 pi 里跑 `/reload`。精简前全文备份：`AGENTS.md.bak`。

## 1. 项目是什么

pi-web-ui 是 pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：
浏览器对话、文件树、附件、内置终端（xterm.js + node-pty）、模型管理、声音提醒、中英文切换。
一条命令可跑，可 Docker / systemd / launchd / Windows 计划任务部署。
另有 **Electron 桌面壳**（`desktop/`，随机空闲口起同一 server，网页版零改动；见 `desktop/README.md`）。

- 仓库：`git@github.com:xing-shuyin/pi-web-ui.git`；npm 包 `pi-web-ui`
- Node **>= 22.19.0**；版本 `package.json` 与 `package-lock.json` 两处同步

## 2. 技术栈

| 层     | 技术                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 后端   | Node + Express（静态 + `/api/health`）+ `ws`（`/ws`）                  |
| 前端   | React 19 + Vite 8 + react-markdown + highlight.js + xterm.js           |
| 智能体 | `@earendil-works/pi-coding-agent` SDK（进程内，读 `~/.pi/agent` 配置） |
| 终端   | node-pty（服务端 PTY）+ `@xterm/xterm`（经 terminal bridge 转发）      |
| 样式   | 单文件 `web/src/styles.css`（CSS 变量主题，默认深色）                  |

## 3. 目录结构

完整注释版目录树见 `docs/directory-reference.md`（扁平速览）。

顶层：`server/` 后端（ESM，编译到 `dist/server/`）· `web/` 前端（编译到 `web/dist/`，gitignore 但进 npm 包）·
`bin/pi-web-ui.mjs`（CLI）· `desktop/`（Electron 壳）· `deploy/`（launchd/systemd/Windows 任务示例）·
`themes/`（完整样式表主题）· `plugins/`（官方插件，各自 README；`catalog.json` = 市场内置列表，加插件在此加一条 + PR；`page-picker/extension` 是浏览器扩展不是插件）·
`extensions/webui.ts`（pi 扩展 `/webui`）· `dev/`（本地辅助，不进包）· `docs/`（见 §4 表）· `tests/`（见下）。

server 关键文件（★=单源/入口，必读；其余按名读源码，不在此逐条注释）：
`protocol.ts`★（wire 协议唯一事实源）· `index.ts`（express + `/ws` 分发 + 心跳 + `pending` 重放队列）·
`agent-service.ts`（ClientSession/多对话并发/工具注册 customTools）· `serialize.ts`（SDK→UiMessage，`details` ≤64KB 下发）·
`tool-manager.ts`★（`AGENT_TOOL_CATALOG`，工具开关唯一事实源）· `tool-approval.ts` + `approval-rules.ts`（审批门禁 + 规则库）·
`client-state.ts`（`client-state.json` 持久化：locale/workspaceRoots/softCap…）· `composer-drafts.ts`（草稿中心）·
`plugins.ts`（`UI_SLOT_ALIASES`/`UI_SLOTS` 别名+枚举）· `plugin-catalog.ts`/`plugin-catalog-sync.ts`/`plugin-installer.ts`（市场目录同步+后台安装）·
`plugin-grants.ts`（目录授权）· `plugin-project.ts`（host.project.create）·
`subagents.ts` + `subagent-templates.ts`（第一方子代理+模板库）·
`attachments.ts`（只发路径引用，不注入内容）· `files-service.ts` + `text-sniff.ts`（`decodeText`/`countLines`）·
`vision-bridge.ts`（纯文本模型看图转写）· `present-files-tool.ts`（只读探测+摘录预算）·
`terminals.ts`（PTY 管理；`terminalBash` 开关分流）· `scm.ts`（只读 git，execFile 直跑）·
`model-admin.ts`（models.json+多密钥）· `patch-remote-catalog.ts`（模型目录整表替换补丁）·
`soft-cap.ts`（压缩软上限纯函数）· `i18n.ts`（服务端语言：`resolveServerLang`/`pick`/`bilingual`/`getServerBlock`）·
`control-socket.ts`（本地 status/quiesce）· `launch-origin.ts`（托管探测）· `webui-context.ts`（扩展 UI 桥）·
`settings-service.ts`/`goal-service.ts`/`slash-commands.ts`/`themes.ts`/`uploads.ts`/`bg-servers.ts`/`queue-utils.ts`/`process-utils.ts`/`tool-info.ts`/`conversation-read-tool.ts`/`compact-context-tool.ts`/`edit-soft-tool.ts`/`read-tool.ts`/`ensure-bash.ts`/`patch-node-pty.ts`。
`server/dsh/`：`preset-clones.ts`（file: 克隆）+ `runtime/{launcher,goal-rpc,custom-prompt}.mjs` + `dsh-usage.ts`（统计映射）。

web/src 关键（★=先读这三个）：`use-chat.ts`★（WS+reducer+终端 bridge）· `app-globals.ts`★（模块级 store + `appSend`；快照数据禁入）·
`types.ts`（`export type * from "../../server/protocol"` shim，由 `scripts/check-protocol-sync.mjs` 守护）·
`ui-slots.ts`★（宿主 UI 扩展点：四层合并+22 slot）· `slot-toolbar.tsx`（各组件 `*HostNodes`+`renderMergedToolbar`）·
`base-url.ts`（`appUrl()`，见 §9）· `i18n.tsx`（文案只许字符串字面量，见 §9）· `styles.css`（全部样式）·
`notify.ts`（`isCollapsedWindow`/`shouldSuppressNotify`）· `composer-bridge.ts` + `composer-draft.ts`（`advanceComposerSession`/`focusComposer`）·
`topbar-fit.ts`（实测宽度溢出）· `use-floating-panel.ts`（浮层统一 Hook）· `pending-question.ts`（问卷恢复）·
`present-items.ts`/`present-settings.ts`/`file-preview-bridge.ts`（present_files 卡片）· `tool-info-state.ts`/`tool-schema.ts`· `plugin-host.ts`（宿主 API 时序）。
components 按文件名自解释，只记特殊机制：`ContextMenu`/`ToolInfoDialog`（portal 到 body + fixed，同因 overflow 裁剪）·
`TopBar`/`FooterBar`（单一扁平流，slot 顺序直排+`hostNodes`）· `SlotTabs`/`PluginPage`（切走即 cleanup 不挂载）·其余读源码。

tests：`run-smoke.mjs`（零 token 冒烟聚合，ALL 列表）· `unit/`（vitest 纯函数单测）· `*-test.mjs`（手写 Playwright/WS；**需 Chrome 的不入 smoke**，手动跑，缺 Chrome 自动 SKIP）· `scratch/`（一次性，gitignore）。
CI：`ci.yml`（协议同步→typecheck→build→vitest→冒烟）· `release-notes.yml` · `desktop-release.yml`。

## 4. 核心架构（每主题一句话）

`docs/` 索引（找详细文档先看这里，均为 `docs/<名>.md`）：**architecture-core** 快照驱动/协议单源/安全边界/主题/多对话并发 · **architecture-attachments** 附件/图片/视觉桥/上传预览下载 · **architecture-terminal** 终端 PTY/SCM/活力检测/bash 接管 · **architecture-plugins** 插件形态/协议/宿主扩展点/MCP 桥/多根工作区 · **architecture-system-prompt** 系统提示词组装链路与 override 钩子 · **dsh-engine** DSH 预设/问卷/底栏统计/工具桥 · **development** 开发工作流/CI/编码约定/测试规范 · **release** 发布流程 · **deployment** 部署 · **env-vars** 环境变量全表 · **antigravity-proxy** 反代接入 · **directory-reference** 完整注释版目录树

| 主题 | 文档 | 一句话 |
| ---- | ---- | ------ |
| 快照驱动 | `docs/architecture-core.md` | 服务端唯一事实源，60ms 节流；`snapshot_delta` 增量 + `message_delta` 实时通道；`send()` 背压超阈丢 snapshot（幂等，250ms 重试）；`get_state`/`flushSnapshot` 立即推一次 |
| 协议单源 | 同上 | 只改 `server/protocol.ts`，两端 switch 各加分支；`web/src/types.ts` 是 shim |
| 全局运行态 | 同上 | 整树共享放 `app-globals.ts`（`useAppField` 单字段订阅，组件不收 `send` prop 用 `appSend`）；快照流数据禁入 store |
| 安全边界 | 同上 | 默认 loopback；WS Origin/Host 校验；quiesce 准入；provider headers 不下发浏览器 |
| 主题 | 同上 | styles.css 是共享基线；主题=完整样式表可覆盖一切；终端跟随主题 |
| 多对话并发 | 同上 | 每对话独立 runtime，上限 8/项目（子代理不计）；运行列表口径 listed ∪ 有内容的当前对话；clientId 存 sessionStorage，每标签页独立 |
| 附件/预览 | `docs/architecture-attachments.md` | 只给路径引用（`reference`/`lines`，内容不注入）；预览 512KB 上限+嗅探+GBK 回退；媒体走 HTTP Range；下载绕 Safe Browsing |
| 终端/SCM | `docs/architecture-terminal.md` | 每 Conversation 一个 TerminalManager；`terminalBash` 开关分流（`persist` 决定一次性/ai-bash 持久）；SCM 只读走 execFile，写操作走可见终端 |
| 工具开关/read 目录 | `docs/architecture-core.md` | `AGENT_TOOL_CATALOG` 唯一事实源；`read` 覆盖目录走 ls 口径（`readDirEnabled` 是行为开关，不入目录；仅 pi 引擎） |
| 审批 | `server/tool-approval.ts` | 规则库 `<dataDir>/approval-rules.json`（ask/deny/allow）；三档放行：全局关→本对话全部允许→允许同类；记忆只在内存，随过户搬 |
| 问卷/草稿进快照 | `docs/architecture-core.md` | `UiState.pendingQuestion`（刷新恢复）+ `UiState.draft`（只跟全量快照，`draft_update` 自带 sessionId） |
| 临时对话 | `server/agent-service.ts` | `new_chat {ephemeral:true}`→内存不落盘；`UiState.isEphemeral` 恒存在于 light state；`persist_conversation` 一键转正（id 不变） |
| 插件/UI 扩展点 | `docs/architecture-plugins.md` | `<dataDir>/plugins/<id>/`；manifest `ui` 与 `host.ui.register()` 同一套别名+枚举；合并「宿主<插件<arrange<用户偏好」；插件不碰 DOM；`PLUGIN_API_VERSION=2` |
| 多根工作区 | 同上 | `set_workspace_roots` 按项目 cwd 存（上限 8）；**额外根=工作区内**，插件读免授权；AI 只在主 cwd 干活 |
| 子代理模板 | `server/subagent-templates.ts` | 全局共享；append/replace + 白名单 + 可选模型/强度（空=跟随）；停用对 AI 不可见 |
| DSH | `docs/dsh-engine.md` | 四预设 file: 克隆 mount；问卷/技能钩子挂 agent scope（host 收不到 scoped 事件）；底栏统计吃直播帧+usage（`dsh-usage.ts`） |
| 压缩软上限 | `server/soft-cap.ts` | C→`reserveTokens=W−C` live 注入；关/非法回填 16384；pi 引擎独有 |
| 看门狗 | `docs/architecture-core.md` | 20 分钟 abort 会话（不碰后台服务）；`ask_user_question` 豁免 |
| present_files | `server/present-files-tool.ts` | 只读探测+摘录预算走 `details`；前端无 details 也能渲染（参数解析+合并）；远端本地打开报不支持 |
| browser_page/对话引用 | `docs/architecture-core.md` | 闸门在扩展侧；对话引用只发 `<conversation-ref>` aside，模型经 `conversation_read` 按需取 |

## 5. 开发工作流

> 详见 `docs/development.md`

```bash
npm run dev          # node --watch 后端(:8788) + vite 前端(:5173)
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run format       # prettier（提交前必跑；只检查用 format:check）
npm run lint         # oxlint（提交前必跑；自动修用 lint:fix）
npm run build        # build:web + build:server
npm start            # 跑 dist/server/index.js（生产）
npm test             # vitest
npm run test:smoke   # 零 token 冒烟
```

约定：缩进 Tab；样式全在 `styles.css`；协议消息只改 `protocol.ts`（§4）；服务端 URL 一律 `appUrl()` 包一层（§9）。
i18n：前端 `useT()`，核心 `zh`/`en`（新 key 两处都加，`tests/unit/locales.test.ts` 锁对齐；语言包 `locales/*.json` 缺 key 回落英文）；
服务端 `pick(lang,zh,en,key?)`（key 全局唯一 `<模块>.<slug>`；多行 `getServerBlock`；tool 定义 `bilingual(en,zh)`）；notice 推 UI 用 `text`+`textEn` 双字段。
测试：端口 ≥8900 隔离；data-dir `mkdtempSync` 隔离；精确清理自己进程；**禁 `pkill -f`**。
Playwright：Chrome 路径走 `tests/lib/chrome.mjs`（`PI_WEB_CHROME` 可覆盖）；仓库根用 `fileURLToPath(new URL("..", import.meta.url))`（Windows 下 `URL.pathname` 会 ENOENT）；win32 清理走 `tests/lib/port-utils.mjs` 的 `freePort`。

## 6. 发布流程

> 详见 `docs/release.md`

```bash
npm run typecheck && npm run build
npm run changelog:i18n   # 文案有增减必跑
git add -A && git commit -m "feat(xxx): 描述"   # 不带 Co-authored-by
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z   # tag 带 v，与 npm 版本一致；Action 自动建 Release+桌面包
npm publish
```

版本须高于 registry；升级后 `pi-web-ui server restart`；发布前检查示例文件不泄密；Release 说明预览：`node scripts/release-notes.mjs X.Y.Z --base v<上版>`。

## 7. 环境变量

> 完整列表见 `docs/env-vars.md`

| 变量 | 默认 | 作用 |
| ---- | ---- | ---- |
| `PI_WEB_PORT` | `8787` | HTTP 端口 |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址（默认 loopback） |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区 |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 数据目录 |
| `PI_WEB_SDK` | `global` | #321 起默认跟随：机器上有**更新**的 pi 副本（祖先链，如全局 pi CLI）就用它（多份取最高），没有或更旧回落自带副本；`bundled`/off/0/false/no = 强制自带（可复现，报 bug 用）。升级全局 pi 后**重启服务**即生效；更新面板会亮「运行中 vs 机器上」差距并提供「安装全局引擎」入口 |
| `PI_WEB_TOKEN` | 空 | 共享口令鉴权 |
| `PI_WEB_PLUGIN_CATALOG_URL` | 官方清单 | 市场目录来源；空/`off`/`0`/`false`/`no` 关闭；`PI_WEB_PLUGIN_CATALOG_INSTALL=1` 才开机自动安装 |
| `PI_WEB_TOOL_TIMEOUT_MS` | 20 分钟 | 看门狗超时（`ask_user_question` 豁免） |

## 8. 部署

> 详见 `docs/deployment.md`

- 前台：`pi-web-ui --port 9000 --cwd /path`
- 自启：`pi-web-ui server install`（macOS→launchd / Linux→systemd / Windows→登录 Run 键，免管理员）
- Docker：`docker compose up -d`

## 9. 常见坑（现行有效禁令清单）

- **服务活着时禁 `npm run build` / `npm install`**：build 会清空 `web/dist` 致黑屏（中招后给黑页标签 Unregister SW 再重载）；install 会新旧 SDK 混装（`The requested module ./text.js does not provide an export…`，看 `/api/health` 的 piVersion 与 piSdkCopies 是否一致）。姿势：先停服务再操作再启动。
- **`details` ≤64KB 超限整丢**：`serialize.ts` 下发+随会话持久；新工具别塞大块内容（自封顶，见 `present-files-tool.ts` 摘录预算）；前端渲染不许依赖 details（参数解析+可选合并，见 `present-items.ts`）。
- **新增可开关工具动三处**：`tool-manager.ts` 的 `AGENT_TOOL_CATALOG`（唯一事实源；工具名字符串只在此定义，模块 import+re-export）＋ `agent-service.ts` 的 customTools 注册（DSH 无注册面除外）＋ `tests/unit/tool-registration.test.ts` 的 FACTORY_TOOLS。两道 CI 守卫：注册→目录、目录→设置行（`OTHER_AGENT_TOOLS` 循环渲染，不手写行；`todo_list` 固定 markers 分区；bash/read 永不入目录）。
- **服务端 URL 必须 `appUrl()` 包一层**（`/ws`、`/api/*`、`/plugins/*`、`/themes/*`），否则 nginx 子路径部署 404；排查先看请求带没带应用根前缀。
- **elsewhere/过户**：`take_over_conversation` 搬 runtime 本体（单 writer）；`ask_user_question`/`browser_page` 在调用瞬间按 runtime 身份解析持有方（`bridgeTarget`+`findConversationHome`，锚点是 `created.session` 对象不是 conv id）；跨页作答 `question_answer` 带 `owner`；「另一处」行左键两段确认；elsewhere 只列 live 会话。回归：`takeover-test`/`idle-takeover-test`/`remote-answer-test`/`elsewhere-lifecycle-test`。
- **远期 cron 别交给 `host.schedule`**：Node 超 2^31-1ms 的 setTimeout 截断成 1ms → 死循环；远期用 `armDelay` 分片（≤6h）+ `nextCronFire` 回 null（「不再触发」）；notes 式需求挂一条 `* * * * *` 巡检、自带 `nextDue` 落库。回归：`plugin-cron-overflow-test.mjs`。
- **工作区禁家目录根**：`server install` 默认 `~/pi-web-ui`；`$HOME` 的同步扫描会被坏挂载挂起致事件循环假死。`ready` 只代表传输通，不代表会话就绪——测试判活按插件真实内容，不拿 `ready` 当信号；`attach` 链用户路径禁同步 `statSync`。
- **文本解码/行号**：预览·附件统一 `decodeText`（UTF-8→GBK→latin1）；`countLines` 不算尾随换行，前端 `split("\n")` 后 pop 末尾空串。
- **Windows 最小化通知**：`hasFocus`/`visibilityState` 在最小化时照常撒谎，只看窗口矩形（`isCollapsedWindow`，`notify.ts`）；Windows 吞通知还要求近 2 分钟有页面交互；**通知禁带 `tag`**（同 tag 静默替换，`renotify` 救不回）。排查：`NotifyToggle.tsx` 的 `SHOW_NOTIFY_TEST_PANEL` 改 true。
- **模型目录=官方整表替换**：`patch-remote-catalog.ts` 启动幂等改写 SDK（无旧残留、无"新增 N 个"）；`npm install`/SDK 升级后重启自动重打，结构变化自动跳过。验证：`tests/scratch/verify-patch.mjs`。
- **token cookie**：`pi_web_token` 存 `encodeURIComponent` 后的值，**读时先 `decodeCookieToken` 再比**（`server/auth-cookie.ts`）；改口令后一次正确的 `?token=` 即永久恢复（有效请求刷新 cookie，401+失效 cookie 自动 Expire）。回归：`token-auth-test.mjs`。
- **CSS 变量先定义后引用**：未定义的 `var(--x)` 整条声明失效；守卫 `tests/unit/css-tokens.test.ts`（CI 必跑），新增豁免写理由。
- **UI 扩展点三规则**：① slot 两端同口径（manifest `ui` 与 `host.ui.register()` 同一别名+枚举；前端不认识静默丢弃）；② 新可隐藏/可排序入口必须在渲染组件接 slot（`hostNodes`+顺序驱动，无数据时退化全画；顶栏单一扁平流，禁按种类分组容器；溢出与隐藏走同一「⋯」菜单、实测宽度决定，`topbar-fit.ts`）；③ 往下展开的菜单 portal 到 body + fixed（z-index 救不了 overflow 裁剪），关闭走 ref；浮层统一 `useFloatingPanel`，**禁在 scroll 里关**（只重算锚点；mousedown/Escape 才关）。回归：`ui-layout-ui-test`（真 Chrome）。
- **新对话三连**：经 `focusComposer()` 自动聚焦输入框（触屏豁免）；非 chat 视图先切回 chat；待发附件 chips 随会话清空（`advanceComposerSession`，判据 `UiState.sessionId`；空 sessionId 瞬时态不清）。单测：`composer-draft.test.ts`。
- **DSH 三规则**：shipped 预设用 `preset-clones.ts` 的 file: 克隆（`file:` 指文件不是目录；roster 以 clone 为唯一 system 根，关 `includeShippedRoot`）；问卷 answerer 与技能过滤钩子挂每次会话 `setup()` 的 agent scope；底栏统计吃直播帧（wrapper `{global:true}` 转 `assistant.stream`）+ `assistant/message.usage`，纯映射 `dsh-usage.ts`。回归：`preset-clones.test.ts`、`dsh-smoke-test.mjs` §2.5、`dsh-stats-test.mjs`。
- **`i18n.tsx` value 只许字符串字面量**（`+` 续行可）：`scripts/i18n-diff.mjs` 手写解析器只认这个；改完文案跑 `npm run changelog:i18n` 验证。

---

_结构/流程变更时同步更新本文件及相关 `docs/`。修改后运行 `/reload` 生效。_
