# QQ 机器人与工作台 (QQBot Plugin)

> QQ 机器人插件，基于腾讯官方开放平台 QQBot WebSocket 出站长连接，支持双向会话对话（零公网 IP / 免反代）、结构感知 Markdown 智能分块、白名单安全准入与频道/群聊消息推送。零外部第三方包依赖（Node 内建 fetch + node:crypto + 全局 WebSocket）。

## 功能特性

- 🤖 **QQBot 官方 WebSocket 出站长连接双工对话**：基于腾讯官方开放平台 QQBot Gateway 协议，客户端主动发起长连接，**零公网 IP、免域名备案、免反向代理、免开放入站端口**，在局域网或个人电脑即可即开即用！
- 📦 **结构感知 Markdown 分块**：针对 QQ 消息长度限制，采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮不破损。
- ⚡ **斜杠快捷指令**：支持 `/help`、`/clear` 或 `/new`（清空上下文开启全新对话）、`/status`（查看机器人在线指标）。
- 🛡️ **安全白名单控制**：支持设置允许对话的 QQ OpenID / 用户 ID 白名单，未授权人员友好拦截，防止 Bot 被陌生人滥用。
- 💬 **被动消息引用与多端支持**：支持 QQ 频道子频道（@机器人）、QQ 群聊（@机器人）以及单聊好友消息，自动关联 `msg_id` 被动回复。
- 🛠️ **AI 工具**：向 AI 助手注册 `qq` 工具，AI 可自主向 QQ 频道推送消息与通知。
- 🖼️ **富媒体双向（图片/语音/视频/文件）**：
  - **收**：QQ 发来的附件（事件里的 `attachments`，腾讯 CDN、有实效）下载后落到工作区
    `.pi-qq-media/`，正文给绝对路径，agent 用 `read` 直接看；语音优先用 `voice_wav_url`
    并带上官方 ASR 文本。单件上限 25MB，超限/下载失败降级为占位文字（绝不吞消息）；
    设置里可开关「接收图片/文件落地」。
  - **发**：`qq` 工具新增 `image` / `file`（本地路径或 http(s) URL）与 `user_openid` /
    `group_openid` 目标。链路 = `POST /v2/{users|groups}/{openid}/files`
    （本地文件 ≤ 5MB 走 base64 `file_data`，更大自动走 `upload_prepare` → 分片 PUT →
    `upload_part_finish` → 合并拿 `file_info`）→ `msg_type=7` + `media.file_info`。
    超过软限制（图片 20MB / 视频 30MB / 语音 20MB）由 QQ 侧降级为文件卡片。
  - **频道限制**：QQ 频道子频道只接受**公网 http(s) URL** 的 `image` 字段，本地文件没有
    上传通道 —— 要么先用单聊/群聊发，要么给公网链接（工作台会直接报错提示）。

## 配置指南

1. 打开 [QQ 开放平台](https://q.qq.com/) 并注册/登录开发者账号；
2. 进入「机器人」管理后台，创建机器人应用；
3. 获取机器人的 **AppID** 与 **ClientSecret**；
4. 在机器人设置中配置好机器人名称、头像以及权限列表；
5. 在 pi-web-ui 的 QQ 面板点击「⚙️ 配置凭证」，填入 AppID 与 ClientSecret，勾选「启用 QQ 机器人双向会话对话服务」即可！
