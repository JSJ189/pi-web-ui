# pm2-manager · 进程管家

用 **pm2** 统一托管 AI 启动的后台任务。装了这个插件，AI 起长期服务/调试实例时不再用
`nohup`、尾部 `&`、`start /b` 把进程甩到管理面之外 —— 全部进 pm2，于是**有名字、有状态、
有日志、能单独停**，宿主顶栏「后台任务」面板与插件面板看到的是同一份列表。

> 现场问题：AI 调试时后台起一堆实例（本机实测一次遗留 12 个 `dist/server/index.js`，
> CPU 打满），既不在任何列表里也停不干净。这个插件就是治它。

## 它做了四件事

| #   | 做什么         | 怎么做的                                                                                                                                                                                                                                          |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **提示词引导** | 注册单个 action 式 `pm2` 工具，`description` / `promptSnippet` / `promptGuidelines` 三处告诉模型「长期任务一律走 pm2」，不必猜                                                                                                                    |
| 2   | **硬闸门**     | `host.onToolPre` 拦 bash 的裸后台启动：`nohup` / `disown` / `setsid` / `start /b` / `Start-Process` / 尾部 `&`，带原因拒绝并指路 `pm2` 工具；`#bg-ok` 是逃生门                                                                                    |
| 3   | **同一面板**   | 管理界面就地嵌进宿主「后台任务」面板（`ui["tasks.panel"]`），与宿主自己 diff 出来的裸进程列表共存；**不给每个应用注册 `registerBackgroundTask`** —— 那会让同一个应用在面板里列两遍                                                                |
| 4   | **内嵌面板**   | 宿主「后台任务」面板里就地嵌一块「pm2 托管的应用」（`view:false` + `ui["tasks.panel"]`）：应用表（状态/CPU/内存/重启/时长）、看日志、停止/重启/删除；pm2 缺失时一键安装。宿主自己 diff 出来的裸进程列表仍在上方 —— 同一个面板，各管一段，不重复列 |

## 给 AI 的用法（工具 `pm2`）

```
action=list                      # 列出托管的应用（含 CPU/内存/重启/时长）
action=start name=api script=server.js args=["--port","8788"] cwd=/path
action=logs  name=api lines=100  # 读输出（不用再留一个无人看管的进程）
action=stop|restart|delete name=api      # name=all 可整批
action=install                   # 一键 npm i -g pm2（未安装时）
```

约定（写在工具提示词里，模型每轮都能看到）：

- 起后台/长期任务一律 `action=start`，**不要**用 `nohup`、尾部 `&`、`start /b`；
- 起第二份同名服务前先 `action=list`，不需要的用 `action=delete` 清掉；
- 想看输出用 `action=logs`，别把进程丢在后台不闻不问。

逃生门：确实需要裸后台（例如测试里 `sleep 30 &` 等端口）时，命令里带 `#bg-ok` 即可放行；
纯等待类命令（`sleep` / `wait` / `echo`）本来就不拦。

## 跨平台

pm2 是 npm 全局包，**Windows / macOS / Linux 都能跑**，本插件在三个平台上都走同一条调用链：

1. 先按 `设置.pm2Bin` → 环境变量 `PI_WEB_PM2` → node 前缀（`dirname(process.execPath)/node_modules/pm2/bin/pm2`）
   找 pm2 的 **JS 入口**；
2. 都没命中才去问 `npm root -g`（这一步才起子进程，且只在按需路径上）；
3. 调用一律 `node <pm2 的 JS 入口> <args>` —— **不走 PATH、不碰 `.cmd` 垫片**，绕开
   Windows 上 `execFile("pm2")` 直接 EINVAL、以及服务化运行时 PATH 里没有全局 bin 目录两个坑。

平台差异只在一处：**Windows 不支持 `pm2 startup` 开机自启**（官方限制），所以本插件不碰自启。
「遗留裸实例」的跨平台扫描（netstat/ss/lsof + 进程树）由**宿主**的后台任务面板自己负责，本插件
不再重复实现一套，避免同一份信息在一个面板里列两遍。

## 设置

| key         | 默认   | 作用                                                                       |
| ----------- | ------ | -------------------------------------------------------------------------- |
| `guardMode` | `deny` | `deny` = 拦裸后台启动并指路 pm2；`off` = 不拦（仍可用工具/面板管理）       |
| `pm2Bin`    | 空     | pm2 入口绝对路径（留空自动探测）；填的是 `bin/pm2`（JS 入口），不是 `.cmd` |

## HTTP 路由（面板用）

`/plugins-api/pm2-manager/*`：`GET /status`、`POST /install`、`POST /action`。

## 权限

`ui`（`tasks.panel` 槽位）、`tools`（AI 工具 + 裸启动闸门）、`http`（面板路由）。

## 文件

- `manifest.json`：manifest（含 settings schema、`view:false` 与 `ui["tasks.panel"]` 条目）
- `index.mjs`：服务端入口 —— 上半是**纯函数区**（裸启动识别 / pm2 入口候选 / jlist 解析 / 格式化，单测直接从本文件 import），下半是 activate（探测、AI 工具、闸门、HTTP 路由）
- `client/entry.mjs`：内嵌面板（`mount(container)` → 返回 cleanup；面板关闭或插件重载时宿主调 cleanup 收摊）

> 纯函数**刻意内联**在 `index.mjs` 而不是单独成文件：宿主的 `plugins_reload` 只给
> `index.mjs` 的 import 加 `?e=<epoch>` 缓存击穿，被它静态 import 的兄弟模块会命中
> Node ESM 模块缓存 —— 改了不随 reload 生效，必须重启服务（踩过一次）。

- 单测：`tests/unit/pm2-manager.test.ts`（纯函数 + 假宿主 activate，零端口零子进程）
