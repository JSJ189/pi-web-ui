# browser-use · 常驻 Chrome 自动化插件

基于 [DrissionPage](https://www.drissionpage.cn) 的常驻 Chrome 自动化插件，为 AI 注册原生的 `browser_use` 工具。

## 核心特性

- **零配置常驻浏览器**：无需手动修改 Chrome 启动参数或调试端口。插件自动拉起或连接一个常驻实体 Chrome 窗口（默认端口 `9333`，使用独立沙箱 profile，绝不与用户日常 Chrome 冲突）。
- **后台任务统一管理**：浏览器运行时自动注册到 Web UI 的 **「后台任务」** 面板（显示当前端口、打开标签页数量），支持在面板中一键点击 **[停止]** 随时优雅关闭浏览器；与宿主的“自动清理遗留”及“全部关闭”完全打通。
- **闲置超时自动关闭**：长时间不使用自动退出并释放系统内存与 CPU 资源（默认 15 分钟无任何操作自动关闭；可在插件设置中自由调整为 0~180 分钟，设为 0 表示永不自动关闭）。
- **自然人机协同**：窗口在桌面上可见且在会话期间保持。用户可以在该窗口里随手打开标签页、手动扫码登录（微信/淘宝/GitHub 等），AI 随时调用 `tabs` 与 `switch` 无缝接管已打开的页面。
- **Token 极致节省**：独有的 `snapshot -i` 页面快照仅提取人类可见的交互元素（带有 `[1] [button] 登录` 等序号），彻底剥离几万行冗余 DOM 与 CSS/JS 内部实现。
- **全能交互能力**：支持点击、输入、下拉选择、复选框勾选、聚焦打字、组合键（`Enter`、`ctrl+a` 等）、平滑滚动、JS 表达式执行、整页长截图等。
- **原生反爬穿透**：继承 DrissionPage 对 Chromium 底层 CDP 的优化，具有极高的拟人化特征，不易被风控与验证码阻断。

## 安装与依赖

1. **启用插件**：在 pi-web-ui 设置 → 插件管理中开启 `browser-use`。
2. **环境要求**：系统需安装 Python 3（以及安装了 Chrome 或 Chromium）。
   - 首次使用时，插件脚本会自动在插件目录下创建 `.venv` 并通过 pip 安装 `drissionpage`（约需 20~30 秒，自动就绪）。
   - 若系统已存在带 `drissionpage` 的环境，会自动优先复用。

## 插件设置

在 pi-web-ui 设置 → 插件管理 → `browser-use` 齿轮图标中可配置：

- **闲置自动关闭（分钟）**（`idleTimeoutMinutes`）：
  - 默认值：`15` 分钟
  - 范围：`0` ~ `180` 分钟
  - 说明：当 AI 或用户在设定的时长内没有对常驻浏览器执行任何操作时，后台自动触发平稳退出以完全释放内存；设置为 `0` 表示保持常驻、永不自动关闭。

## 工具参数：`browser_use`

AI 可以直接使用原生 tool call 调用：

| 动作 `action`       | 关键参数             | 说明                                                               |
| :------------------ | :------------------- | :----------------------------------------------------------------- |
| `open`              | `url`                | 在当前标签页打开网址（自动补齐 `https://`）                        |
| `new`               | `url`                | 新建标签页并打开网址                                               |
| `tabs`              | -                    | 列出所有标签页（含序号、标题、网址及当前激活状态）                 |
| `switch`            | `target`             | 按序号（如 `"2"`）、标题或网址片段切换标签页                       |
| `close`             | `target?`            | 关闭标签页（默认当前激活页）                                       |
| `snapshot`          | `interactiveOnly?`   | 获取页面结构快照；`interactiveOnly: true` 时仅返回带序号的交互元素 |
| `click`             | `target`, `byJs?`    | 点击元素（可传快照序号 `"3"`、文本 `"Sign in"` 或 CSS 选择器）     |
| `input`             | `target`, `text`     | 清空并输入文本                                                     |
| `select`            | `target`, `option`   | 下拉框选择（按选项文本、值或序号）                                 |
| `check` / `uncheck` | `target`             | 勾选 / 取消勾选复选框或单选框                                      |
| `type`              | `text`               | 向当前获得焦点的元素直接打字                                       |
| `press`             | `key`                | 触发按键或快捷键（如 `"Enter"`、`"ctrl+a"`、`"Escape"`）           |
| `hover`             | `target`             | 鼠标悬停在指定元素上                                               |
| `scroll`            | `scroll`             | 页面滚动：`"top"`、`"bottom"`、`"up"`、`"down"` 或像素值           |
| `wait`              | `seconds`            | 等待指定秒数                                                       |
| `js` / `jsx`        | `code`               | 执行 JavaScript 代码或获取表达式值                                 |
| `screenshot`        | `path?`, `fullPage?` | 截取页面截图（支持 fullPage 长图）                                 |
| `quit`              | -                    | 关闭常驻浏览器窗口，结束当前自动化会话                             |

## 典型对话示例

- _“帮我去 GitHub 搜索热门的 DrissionPage 库”_  
  → AI 调用 `browser_use(action: "open", url: "https://github.com")`  
  → AI 调用 `browser_use(action: "snapshot", interactiveOnly: true)` 发现搜索框序号为 1  
  → AI 调用 `browser_use(action: "input", target: "1", text: "DrissionPage")` 并按回车。

- _“看下我刚才在浏览器里手动打开的那个订单页”_  
  → AI 调用 `browser_use(action: "tabs")` 获取所有标签  
  → AI 调用 `browser_use(action: "switch", target: "订单")` 切换接管  
  → AI 调用 `browser_use(action: "snapshot")` 读取并解析内容。
