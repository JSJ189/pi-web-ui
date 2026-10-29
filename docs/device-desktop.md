# 已授权设备的网页远程桌面

设备中心通过独立设备 origin 和既有 relay 连接本机 VNC。浏览器使用随 npm 依赖分发的 noVNC 1.7（`@novnc/novnc`），不访问 CDN。桌面图像、输入和 VNC 认证都走原始 RFB 二进制 WebSocket；relay 保持现有 16 MiB 消息分块协议，不新增任意 TCP 转发。

## 本机启用与权限

默认关闭。远程桌面页面提供组件检查、安装和明确的启用/关闭按钮。组件缺失时，安装器将固定版本的 noVNC 安装到设备数据目录的专用缓存，不修改项目依赖；不执行安装脚本，不安装操作系统 VNC 服务，也不更改系统权限或密码。启用状态原子保存在设备数据目录，修改后无需重启。也可在设备本机设置兼容环境变量并重启服务：

```text
PI_DEVICE_DESKTOP=1
PI_DEVICE_VNC_PORT=5900
PI_DEVICE_VNC_HOST=127.0.0.1
```

端口允许 1–65535，默认 5900；host 仅允许字面量 `127.0.0.1` 或 `::1`，默认 IPv4。VNC host 与端口不能从中心、页面或远端 API 改写；界面仅管理应用启用状态和浏览器组件。VNC 服务应只监听回环，并启用其自身认证。明文 RFB 只在本机回环传输；浏览器到设备中心的公网连接应使用 HTTPS/WSS。

**页面「客户端只读 / View only」只是 noVNC 的客户端输入限制，不是权限。** 有设备访问权限的人可以实现自己的 RFB 客户端。如果用户只能看画面，必须在可信 VNC 服务端配置 view-only 用户、密码或只读实例；此桥不会解析或过滤 RFB 输入，也不会宣称强制只读。即使处于客户端只读，RFB 仍须发送协议握手和画面请求。

VNC 凭据由页面按 noVNC 的 `credentialsrequired` 提示输入，调用 `sendCredentials` 后立即清空输入框；它们仅通过 RFB 认证协议发送。设备中心不将其存入账号、配置、URL 或日志。服务端账号策略和无认证模式由管理员负责配置。

## 宿主接入

`server/device-center/desktop.ts` 导出同步工厂，无需提前创建 HTTP server：

```ts
const desktop = createDeviceDesktop({ app, dataDir, authorize: tokenOk });
// 在 SPA fallback 前注册以上路由，然后创建同一个 httpServer。
// 放在现有 upgrade 分发器最前面；不要另起一个会销毁未知 socket 的监听器。
if (desktop.handleUpgrade(req, socket, head)) return;
// 继续既有 upgrade 分发……
// 服务关闭时：
desktop.close();
```

`authorize(req): boolean` 是必填的独立本机鉴权回调（父提供 `tokenOk`）。每个 HTTP 和 WS 请求同时验证 TCP 来源回环、Host 回环、如存在 Origin 则必须同 Host。不能仅依赖父应用的可选登录中间件。connector 向本机转发时必须重写 Host/Origin 为其固定 local origin 并注入本机鉴权凭据；不能把中心的 origin 原样传来。中心仍须验证设备访问授权。未知 WS 路径返回 `false` 且不碰 socket。

父协调需将以下路径加入现有 relay 的允许路由，并复用设备独立域，而不是中心设置域：

| 路径                                     | 用途                                 |
| ---------------------------------------- | ------------------------------------ |
| `GET /desktop`                           | 静态页面（关闭时也能显示配置状态）   |
| `GET /api/device-desktop/status`         | 只读配置状态，不探测或承诺桌面可用性 |
| `GET /api/device-desktop/novnc/core/*`   | noVNC ES modules                     |
| `GET /api/device-desktop/novnc/vendor/*` | noVNC 本地依赖                       |
| `WS /desktop-ws`                         | 原始二进制 RFB                       |

状态包含 `os`、`enabled`、`endpointConfigured`、`assetsAvailable`、`available`，其中 `available` 仅表示配置允许尝试连接，不能证明 VNC 服务或操作系统捕获可用。`readOnlyEnforcement: "vnc-server"` 表示强制只读需要服务端实现；`clientViewOnlyIsPermission: false` 明确客户端选项不是权限。

页面资源、状态和 WS 地址全部用 `new URL(path, document.baseURI)` 生成，无根绝对 URL。反代必须保留页面 URL 的 `/desktop` 后缀并将相同前缀下的 API/WS 路径转发至设备独立 origin。CSP 允许本地模块及页面固定内联脚本，不加载外部资源。状态和错误通过 `textContent` 呈现，无用户 HTML 插入。

## 分发和边界

运行时依赖为 `@novnc/novnc ^1.7.0`。从 `getPkgRoot()` 的 package.json 建立 `createRequire`，按 Node 模块规则定位已安装依赖，再限定 `core` 和 `vendor` 中 `.js`/`.wasm` 文件。实际文件经过 realpath 检查，拒绝目录穿越和逃离允许根的符号链接。不导出 node_modules 全目录、package.json 或宿主文件。正常 npm 安装会随运行时依赖分发 noVNC，无需把 node_modules 加入主包 `files`；页面函数随 server 编译输出。

每桥最多 4 个连接；WS 最大消息 1 MiB（也约束碎片累计），输出拆成至多 64 KiB 消息；两方向待发队列硬限 4 MiB，配合 TCP/WS pause、resume 和 drain 做背压。连接 TCP 超时 10 秒，30 秒 ping/pong 心跳，30 分钟无 RFB 数据释放连接；慢消费者超限直接关闭，断线、错误和宿主 close 都销毁两端。桥不保存桌面录像或剪贴板历史。页面提供连接/断开、VNC 凭据、客户端只读、缩放、全屏及 CtrlAltDel/Tab/Esc。

## VNC 服务配置候选

- **Windows**：使用维护中的成熟 VNC 服务端（例如 TigerVNC、TightVNC 或 RealVNC 的适用版本），按服务端文档启用回环监听、认证和所需的 view-only 用户策略。服务模式、锁屏、安全桌面和 UAC 捕获受具体产品、安装权限及 Windows 策略约束；本实现没有实机验证，不承诺支持这些场景。
- **macOS**：系统「屏幕共享」可作为 RFB 兼容候选，但账号认证方式、允许 VNC viewer 的设置和系统权限需要按当前系统版本核实。noVNC 与服务端认证类型必须兼容；不能因为状态返回 darwin 就认为可以捕获。
- **Linux X11**：可使用 TigerVNC `x0vncserver` 共享现有 X11 会话。正确配置 DISPLAY/Xauthority、回环监听、VNC 认证及服务端 view-only 策略。
- **Linux Wayland**：需要合成器支持的 VNC 后端，例如适用 wlroots 环境的 wayvnc，并确认当前后端提供的认证类型与 noVNC 兼容。Wayland 并非统一支持，GNOME/KDE/无头会话应分别验证；不可将 X11 配置照搬后宣称全支持。

## 验证

`npx vitest run tests/unit/device-center-desktop.test.ts` 使用真实回环 net server 和 WebSocket 验证 RFB 字节、认证、来源限制、配置拒绝、连接上限、超限消息和清理，并验证安装后的真实 noVNC 资源解析与目录边界。有 Chrome 时同一套测试还会在 `/nested/desktop` 反代前缀下运行 Playwright：加载真实 noVNC 模块并完成 mock RFB 3.8 握手，检查窄屏无横向溢出及只读按钮状态。Chrome 探测复用 `tests/lib/chrome.mjs`，不存在则跳过浏览器用例。设置 `PI_DEVICE_DESKTOP_SCREENSHOT=1` 可在测试中保存 `artifacts/device-center/desktop.png`，画面是模拟 RFB，并非实机桌面。模拟 RFB 不代表上述系统已有实机桌面捕获验证。
