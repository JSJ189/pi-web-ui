# pi-web-ui

[English](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md) · **简体中文** · [繁體中文](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.zh-TW.md)

[![npm 版本](https://img.shields.io/npm/v/pi-web-ui?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-web-ui)
[![Node.js](https://img.shields.io/node/v/pi-web-ui?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

pi-web-ui 是面向 AI 编码智能体的 Web 工作台，将对话、文件、终端与 Git 放在同一个界面。它基于 [pi coding agent](https://github.com/badlogic/pi-mono)，支持在浏览器中使用，也提供 Electron 桌面版与 Windows 便携版。

**[官方网站](https://xing-shuyin.github.io/pi-web-ui-site/)** · **[文档中心](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)** · [下载发行版](https://github.com/xing-shuyin/pi-web-ui/releases/latest) · [更新日志](CHANGELOG.md)

## 快速开始

npm、npx 和源码安装需要 **Node.js ≥ 22.19.0** 与 npm。Windows 请先安装 [Git for Windows](https://git-scm.com/downloads/win)，保留 Git Bash；Linux 请准备 Python 3、make 和 C++ 编译工具链。

```bash
npm install -g pi-web-ui@latest
cd /path/to/your-project
pi-web-ui
```

默认打开浏览器，地址为 `http://127.0.0.1:8787`。在工作台设置中配置模型提供商、凭据与模型，再开始对话。安装完成不代表模型已经可用。

不安装全局命令也可在项目目录运行：

```bash
npx pi-web-ui@latest
```

若 npm 12+ 阻止依赖安装脚本，按需使用以下命令；旧版 npm 使用上面的普通命令：

```bash
npm install -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
# npx 对应写法：
npx --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
```

`node-pty` 需要安装脚本支持终端功能，请勿用 `--ignore-scripts` 跳过。原生模块构建失败时，参阅[安装指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation)补齐平台工具链。

## 选择安装方式

| 方式             | 适用场景                   | 入口与说明                                                                                                        |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| npm 全局安装     | 经常使用 CLI、管理后台服务 | `npm install -g pi-web-ui@latest`                                                                                 |
| npx              | 快速试用、按需启动         | `npx pi-web-ui@latest`；仍会使用 npm 缓存与应用数据目录                                                           |
| Electron 桌面版  | 独立桌面窗口               | [Releases](https://github.com/xing-shuyin/pi-web-ui/releases/latest)：按系统与架构选安装包；启动应用无需另装 Node |
| Windows 便携版   | 解压后使用、携带配置       | 同一 Releases 页选择 portable zip；解压后运行 `启动Pi.bat` / `PiPortable.bat`，配置与工作区放在便携目录中         |
| Docker 源码构建  | 容器部署                   | 使用仓库的 `docker-compose.yml`，见下方步骤                                                                       |
| 源码运行         | 开发或自行构建             | `npm ci` → `npm run build` → `npm start`                                                                          |
| Android / Termux | 手机本地运行               | 按[安装指南的 Termux 一节](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#termux-install)准备原生构建环境 |

桌面安装包、便携包的具体平台与架构以该次 Release 附件为准。桌面应用中的插件安装和外部命令仍可能需要 Node/npm、Git 等工具；便携版也可能使用系统网络、缓存或外部工具。

## 前台运行与后台服务

前台默认使用当前目录作为工作区；按 `Ctrl+C` 停止。服务器上可禁用自动打开浏览器：

```bash
pi-web-ui --cwd "/path/to/project" --port 9000 --no-browser
```

确认项目、模型和终端可用后，再安装后台服务。**`server install` 会安装并立即启动服务**；`server start` 用于启动已经安装但停止的服务。

```bash
pi-web-ui server install --cwd "/path/to/project" --data-dir "/path/to/pi-data"
pi-web-ui server status
```

日常管理已安装的服务：

```bash
pi-web-ui server start    # 仅在已安装且停止时使用
pi-web-ui server status
pi-web-ui server restart
pi-web-ui server stop
```

不再需要后台服务时，另行执行：

```bash
pi-web-ui server uninstall
```

卸载服务不会卸载 npm 包，也不会自动清理用户数据。

macOS 使用用户 launchd，Linux 使用 systemd，Windows 使用当前用户登录自启 Run 键。Windows 的实现不等同于系统级 Windows Service；Linux 安装所需权限取决于系统配置。

- 服务默认工作区为 **`~/pi-web-ui`**；前台默认当前目录。
- CLI 服务数据默认放在 **`~/.pi-web`**，以运行账户的家目录为准。
- pi Agent 配置默认放在 **`~/.pi/agent`**，与工作区、服务数据目录不同。
- 建议显式固定工作区与数据目录；服务环境未必继承交互终端中的凭据和环境变量。
- `server install --print` 可预览配置；使用 `--name my-pi` 安装多实例时，后续管理命令带相同名称。

更多部署与排错说明见[启动参数、服务与 /setup](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#cli-and-env)。

## 常用参数与 /setup

| 参数                   | 用途与默认值                                             |
| ---------------------- | -------------------------------------------------------- |
| `--cwd <dir>`          | 项目工作区；包含空格的路径请加引号                       |
| `--port <n>`           | HTTP / WebSocket 端口，默认 `8787`                       |
| `--host <addr>`        | 监听地址，默认 `127.0.0.1`；`0.0.0.0` 监听所有 IPv4 网卡 |
| `--data-dir <dir>`     | 服务数据目录，默认 `~/.pi-web`                           |
| `--agent-dir <dir>`    | pi Agent 配置目录，默认 `~/.pi/agent`                    |
| `--engine <pi\|dsh>`   | 执行引擎，默认 `pi`；DSH 需满足其运行与模型配置要求      |
| `--no-browser`         | 前台启动时不自动打开浏览器                               |
| `--help` / `--version` | 查看当前安装版本支持的参数或版本号                       |

常用环境变量对应 `PI_WEB_CWD`、`PI_WEB_PORT`、`PI_WEB_HOST`、`PI_WEB_DATA_DIR`、`PI_CODING_AGENT_DIR` 与 `PI_WEB_ENGINE`。`PI_WEB_SDK=bundled` 可固定使用随包 SDK；没有 `--sdk` 参数。

### 本机配置入口

启动后，在运行服务的机器上打开 **`http://127.0.0.1:8787/setup`**，端口按实际配置替换。`/setup` 是浏览器路径，用来配置访问口令与网络；模型 API Key、登录与模型选择在工作台设置中完成。

`/setup` 仅接受回环连接和本机 Host，局域网 IP、公开域名及带代理转发头的请求会被拒绝。远程服务器可通过 SSH 本地转发访问：

```bash
ssh -N -L 18787:127.0.0.1:8787 user@your-server
# 保持连接，在本机浏览器打开 http://127.0.0.1:18787/setup
```

1. 核对页面显示的配置文件路径，确认实例正确。
2. 设置访问口令、监听地址、端口及按需使用的 Host / Origin 白名单。
3. 点击“保存配置”，确认保存成功；随机生成或复制链接本身不会保存。
4. **口令保存后立即热更新；网络配置保存后需重启**对应进程或服务。

留空口令并保存会关闭口令认证。该页面位于口令认证前，本机用户可在忘记口令时重设。带口令的入口链接应按凭据保管。

配置保存在 `<dataDir>/server-config.json`。支持映射的配置按 **命令行参数 → 环境变量 → 配置文件 → 默认值** 取值；CLI 不自动读取任意 `.env` 文件。工作区与引擎仍由启动参数或环境配置。

例如启动命令仍带 `--port 9000`，重启后就会覆盖 `/setup` 保存的端口。口令虽能在当前实例热更新，重启时也需检查 访问口令环境变量 是否覆盖保存值。

跨设备访问前配置口令、网络访问范围与按需使用的 HTTPS。Host 白名单检查请求主机名，并非客户端 IP 白名单；不能当作额外的访问隔离保证。Docker 的端口映射也不等同于容器内回环连接，通常通过 Compose 配置网络与口令。

## 使用仓库 Compose 构建 Docker

```bash
git clone https://github.com/xing-shuyin/pi-web-ui.git
cd pi-web-ui
# 先编辑 docker-compose.yml，替换默认访问口令并按需配置挂载
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 pi-web-ui
```

Compose 使用 `build: .` 从本地源码构建，`pi-web-ui:latest` 是本地镜像标签。首次启动前，将 访问口令环境变量 的示例值 `change-me` 换成自己的口令。

- 服务映射端口为 `8787:8787`，容器监听 `0.0.0.0`；通过宿主机地址访问。
- 命名卷 `pi-web-data` 挂载到 **`/app/.pi-web`**，保存服务数据。
- 操作宿主机项目时，添加绑定挂载，例如 `/host/project:/workspace`，并设置 `PI_WEB_CWD: /workspace`。
- 如需复用 pi 配置，可按 Compose 注释挂载 Agent 目录，并设置 `PI_CODING_AGENT_DIR`；模型凭据另行准备。

更新源码后再次执行 `docker compose up -d --build`。`docker compose down` 保留命名卷；加 `--volumes` 会删除卷内数据。升级前备份数据，项目文件也应放在持久挂载中。

更多步骤见 [Docker 源码安装](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#docker-source-install)。

## 更新与移除

```bash
npm install -g pi-web-ui@latest
pi-web-ui server restart  # 已安装服务时执行；前台进程自行重启
```

桌面与便携版请依对应包的更新方式操作，保留实际数据目录。移除前备份需要的对话、设置与凭据；npm 用户先卸载服务，再执行 `npm uninstall -g pi-web-ui`。移除包不会删除另行保存的用户数据。

## 可以做什么

- **对话与任务**：流式回复、Markdown、图片与附件、提示词模板、历史检索，以及多对话和子代理协作。
- **项目工作台**：文件浏览与编辑、预览、内置 PTY 终端、Git 状态和差异查看，在对话旁完成日常项目操作。
- **执行控制**：工具审批、计划模式、目标模式与审查委派，按任务选择执行方式；实际权限取决于运行账户、工具与部署环境。
- **模型与扩展**：管理提供商和模型，使用 pi / DSH 引擎及各自支持的能力；通过插件、MCP、技能和 UI 扩展点定制工作台。
- **界面与部署**：多语言、主题、移动端布局、浏览器与桌面入口，以及后台服务部署。

各引擎的会话格式、工具和配置能力存在差异，切换前请参阅[文档中心](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)。界面中的审批与执行控制应结合实际系统权限使用。

## 界面预览

以下为仓库现有截图；具体界面随版本与主题变化。

| 对话与提示词                              | 设置面板                          |
| ----------------------------------------- | --------------------------------- |
| ![对话与提示词](assets/chat-prompts.jpeg) | ![设置面板](assets/settings.jpeg) |

| 内置终端                          | Git 工作区                     |
| --------------------------------- | ------------------------------ |
| ![内置终端](assets/terminal.jpeg) | ![Git 工作区](assets/git.jpeg) |

## 文档与插件

- [完整安装指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation) · [启动与服务](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#cli-and-env)
- [远程 SSH 项目](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#remote-ssh-projects) · [计划、目标与审查流程](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#modes-guide)
- [MCP 与浏览器工具](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#mcp-and-browser) · [插件 SDK](plugin-sdk/README.md)
- [社区插件目录](https://github.com/xing-shuyin/pi-web-ui-plugins) · [环境变量](docs/env-vars.md) · [部署指南](docs/deployment.md)

可在工作台浏览插件，或用 `pi-web-ui install owner/repo` 安装、`pi-web-ui plugins` 查看；权限与外部服务需求依插件而异。

## 开发与贡献

```bash
git clone https://github.com/xing-shuyin/pi-web-ui.git
cd pi-web-ui
npm ci
npm run dev
```

开发时访问 `http://localhost:5173`（Vite），后端默认端口为 `8788`。构建后运行：

```bash
npm run build
npm start
```

源码运行默认端口为 `8787`，`npm start` 不自动打开浏览器。开发规范、测试与架构入口见 [AGENTS.md](AGENTS.md) 和[开发指南](docs/development.md)；桌面开发见 [desktop/README.md](desktop/README.md)。

欢迎通过 [Issues](https://github.com/xing-shuyin/pi-web-ui/issues) 报告问题或提出需求，通过 Pull Request 提交改进。报告问题时请附版本、系统、安装方式、复现步骤与脱敏日志。

## 社区与联系

- QQ 交流群：`1126050727`
- [GitHub Discussions](https://github.com/xing-shuyin/pi-web-ui/discussions)：交流用法与想法
- [GitHub Issues](https://github.com/xing-shuyin/pi-web-ui/issues)：问题反馈与需求建议
- [dsh-ui-tools](https://github.com/xing-shuyin/dsh-ui-tools)：作者相关项目，DSH 生态 UI 工具集

## 许可证

本项目采用 [MIT License](LICENSE)。
