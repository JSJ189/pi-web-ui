# pi-web-ui

[English](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md) | [简体中文](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.zh-CN.md) | **繁體中文** · 🌐 [**官方網站**](https://xing-shuyin.github.io/pi-web-ui-site/) · 📖 [**詳細文件中心**](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)

[![npm 版本](https://img.shields.io/npm/v/pi-web-ui?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-web-ui)
[![Node.js](https://img.shields.io/node/v/pi-web-ui?logo=node.js&logoColor=white)](https://nodejs.org/)
[![許可證](https://img.shields.io/github/license/xing-shuyin/pi-web-ui)](LICENSE)

> 你只需要開啟瀏覽器，就能完成所有工作。
>
> 聊天、寫程式碼、改檔案、用終端機、管 Git —— 都在一個瀏覽器分頁裡，不用開 IDE，不用來回切換。

AI 程式設計代理（pi / DSH）的瀏覽器工作台，宗旨只有一句話：**開啟瀏覽器，什麼都能做**。代理在伺服器端執行，
事件經 WebSocket 串流推送到瀏覽器。支援思考區塊與工具呼叫、附件與圖片問答、內建終端機、
模型管理，以及設定面板（自訂系統提示詞、技能/外掛開關、設定預設集並一鍵套用）等功能。
需要 Node.js ≥ 22.19 及設定好的 pi 環境。

## 作者的其他專案

> **正在使用 DSH 建置工具？**
>
> [**dsh-ui-tools**](https://github.com/xing-shuyin/dsh-ui-tools) 是作者的配套專案，
> 用於在 DSH 生態中建置和擴充套件 UI 工具。

QQ 群組 1126050727

## 功能特性

**對話**

- WebSocket 串流聊天 —— pi SDK 在伺服器端行程內執行，事件以快照（60ms 節流）推送，瀏覽器按快照渲染。
- 思考區塊、工具呼叫卡片、bash 輸出，即時顯示狀態（執行中 → 已結束 · 等模型 · 耗時）。
- **補充（steer）** —— 回覆串流中可排隊傳送跟進訊息，目前回合工具結算後立即注入（對應 pi CLI 的 Enter 打斷語意）。
- **斜槓命令** —— 輸入 `/` 彈出命令選擇器（內建 / 擴充套件 / 範本 / 技能）；內建 `/new /name /model /compact /cwd /thinking /resume /reload`，另有 `/help`（命令清單）、`/copy`（複製上一條回覆）與 `/pi-web-ui:quit`（離開服務）。`/new` 可帶首條提示（`/new 修復失敗的測試`），會作為新對話的第一條訊息發出去。
- **每專案多對話併發** —— 每個對話獨立 agent runtime，切走後仍在背景執行；「執行的對話」清單顯示串流進度，可隨時切回。
- **編輯重問** —— 把任意歷史問題 fork 成新分支重新提問，原對話不受影響。
- 超過 30 條的訊息自動摺疊為摘要行（惰性渲染，點選展開）。
- 問題導航 —— 右側浮動導航條 + 每個問題頂部的序號標籤，一鍵跳轉。
- **提示詞範本** —— 空對話狀態展示一鍵範本庫（儲存庫初始化、程式碼審查、研究、合併衝突……）；點卡片即填入輸入框，也可把目前草稿存成自己的範本。
- **模型錯誤自動重試** —— 按對話可設定重試次數（預設 6，`0` = 失敗即停）；次數用完則失敗輪次標紅，紅色錯誤旁有一鍵「重試」按鈕。
- **排隊可控** —— 排隊/插隊的氣泡可以 ✕ 移除，也可以 ↩ **撤回**：文字落回輸入框（輸入框非空時另起一行附加，絕不覆蓋正在打的字）。
- **訊息內建資訊** —— 每條訊息頭部顯示角色、產出它的模型和本地 `HH:MM` 時間，每段文字都有複製按鈕。附件渲染為獨立可摺疊卡片（模式徽章 `lines`/`ref`/`bridged` + 複製按鈕 + 視覺橋「已轉寫」說明），技能呼叫渲染為技能卡（展開可見完整 `SKILL.md`），你輸入的參數單獨成氣泡。
- **壓縮看得見** —— 上下文壓縮顯示為一張卡片（「已壓縮 N tokens」），完成時自動展開並跳轉；壓縮進行中的橫幅會即時計數（「正在壓縮 · 12s」）並標明觸發原因（手動 / 閾值 / 溢位）。

**專案與工作階段**

- **切換專案** —— 工作區根目錄（agent 讀寫的位置、終端機啟動位置）隨時可切，不用重新啟動：
  - **右下角狀態列的路徑** —— 點 `📁 <路徑>` 開啟目錄選擇器：`Tab` 補全、`↑` 回上級、`💻` 跳到「電腦」根以便換磁碟機代號、點資料夾進入後按「選擇」，或直接「選擇目前目錄」；「＋ 新增資料夾」可當場建目錄，`Esc` 或點選別處關閉。
  - **右側檔案樹** —— 在任意資料夾上點右鍵 →「以專案開啟」（同一選單裡還有「上傳檔案到此資料夾」）。
  - **左欄「最近專案」**，或輸入框裡 `/cwd <路徑>`（只輸 `/cwd` 顯示目前目錄）。
  - 啟動預設工作目錄來自 `--cwd <dir>` / `PI_WEB_CWD`。
- **對話並行** —— 每個對話獨立 agent runtime，切走後仍在背景串流；每專案最多同時 8 個（子代理不計入）。
- **「執行的對話」清單** —— 按專案分組（目前專案置頂），子代理縮排掛在父對話下，帶子代理 / 錯誤（懸停看原因）/ 串流徽標；✎ 行內改名；✕ 可選「僅關已結束的子代理」或「強行全關」（執行中會二次確認）；右鍵某行只作用於該對話的子代理子樹。
- **歷史工作階段** —— 讀的是 `<agentDir>/sessions/--<cwd>--/`，也就是 pi CLI/TUI 寫的同一份轉錄：瀏覽器和終端機裡的 `pi` 共用每個專案的一份清單。支援 ✎ 行內重新命名（寫入的 `session_info` 與 pi 的 `/name` 同機制）與兩步確認刪除。
- **最近專案** —— 本瀏覽器的記錄 ∪ 所有有轉錄的目錄，去掉你刪過的（墓碑）和不存在的路徑，按最近使用排序（顯示 20 條，最多存 30）。
- **回到現場** —— 重連會恢復上次用的工作目錄（並提示落在哪），標籤標題可顯示目前專案名，每個專案記住自己的「模型 + 該供應商目前金鑰」用於**新增**對話（已有內容的對話不被覆蓋）。
- 上次關服時仍在回答的對話，會在下次連線時一次性提示「上次執行被打斷」，而不是歷史裡憑空少一段。

**搜尋與導航**

- **全域搜尋（Ctrl/Cmd+K）** —— 一個輸入框搜三處：對話轉錄全文（含助手輸出，最多 50 條、每條帶跳轉錨點）、最近專案、工作區檔名（受限遍歷：50 條結果 / 2 萬條目 / 4 秒 / 深度 24，觸頂時會明確提示而不是卡住）。`↑`/`↓` + `Enter` 開啟、`Esc` 關閉；點對話＝恢復並跳到命中訊息，點專案＝切工作區並重搜，點檔案＝開啟預覽。
- **工作階段內搜尋（Ctrl/Cmd+F）** —— 搜目前對話**實際渲染出來的文字**（大小寫不敏感，走 CSS Custom Highlight API 高亮），`Enter` 下一個、`Shift+Enter` 上一個、`Esc` 關閉。被摺疊的舊訊息用訊息資料建索引，所以長工作階段仍可搜——只有你跳到的那一條才會展開。
- **長工作階段體驗** —— 超過 30 條的訊息摺疊成摘要行（含思考/工具/bash/圖片計數與 90 字預覽）；問題導航條列出問過的每個問題；上滾後浮出「回到底部」；只有貼底時才自動跟隨輸出（你主動上滾就不會被拽回）；遠離視口的訊息取代為等高佔位。

**子代理與範本**

- **第一方子代理** —— 背景派發獨立對話，並行進行研究 / 實作 / 審查（統一的 `subagent` 工具，透過 `action="spawn"` 派發）；支援 `action="wait_all"` 批次等待（阻塞上限為 60 秒且不低於 5 秒，受看門狗 × 0.8 約束，逾時回傳未完成清單，引導後續等待）；與普通對話一樣在左欄管理：即時檢視輸出、補充（steer）、中止、移出。記憶體中的工作階段——不會出現在歷史 / resume 清單，可巢狀派發。
- **子代理範本** —— 設定面板「子代理範本」裡設定可重複使用的預設集：角色系統提示詞（附加或整體取代）+ 技能/擴充套件白名單 + 可選模型 + 可選思考強度。AI 用 `subagent(action="templates")` 查詢清單、`subagent(action="spawn", template="…")` 選用，也可以不傳範本按主工作階段預設設定執行。模型與思考強度都留空 = 跟隨主對話目前設定（與「跟隨主對話」的模型回退邏輯相同）；範本指定了就固定用那個組合（模型不支援的思考等級會自動收斂）。停用的範本保留在面板可隨時重新啟用，但對 AI 工具不可見（查不到、不能選）。範本全域共享（`<dataDir>/subagent-templates.json`，所有瀏覽器用戶端一致）。首次使用時會建立 13 個內建範本 —— 前 6 個（review / implement / research / scout / audit / delegate）改編自 pi-subagents 社群專案，另 7 個（oracle / librarian / explore / metis / momus / multimodal-looker / sisyphus-junior）移植自 oh-my-pi 內建 agent —— 面板標「預設」徽標，可像普通範本一樣修改或刪除。

**檔案、圖片與附件**

- 一律只給路徑引用：`reference`（僅路徑）/ `lines`（選中行範圍，引用上帶行號），**檔案內容永不注入 prompt**——模型用自己的 read 工具按需讀（舊版 `inline` 全文注入已移除，舊用戶端/舊草稿發來的 `inline` 按 `reference` 處理）。
- 貼上 / 拖曳 / 上傳圖片 —— 瀏覽器端自動縮放，模型支援識圖時作為圖片內容傳送（不支援時提示警告）。
- **視覺橋** —— 目前模型不支援識圖時，把圖片交給自動發現的視覺模型轉寫成文字證據（按批次快取，可在設定裡指定模型/開關）。
- 免工作區路徑附加任意檔案 —— 存入全域上傳目錄，以絕對路徑引用（內容不注入）。
- 檔案預覽 —— 行號、點選/拖曳/Shift 選區（可新增到對話為 lines 附件）、GBK 回退解碼、二進位十六進位檢視、媒體 HTTP 預覽（支援 Range）、下載按鈕。
- 即時檔案樹 —— 伺服器端對目前列出目錄 fs.watch，改動即靜默重列；超大目錄顯示截斷提示。
- **能瀏覽到工作區之外** —— 檔案樹可以越過工作區根到 💻「此電腦」層，列出所有磁碟機代號（POSIX 下是 `/`）；麵包屑可直接跳到任意層級，`..` 回上級；目錄被刪/改名/無權限時降級為空清單 + 提示，而不是錯誤頁。
- **行內操作** —— 懸停檔案：下載 / 引用附件（🔗）/ 複製名稱 / 複製路徑；懸停資料夾：引用附件、複製名稱、複製路徑（純 HTTP 環境下剪貼簿不可用時自動走後備實作）。
- **從檔案樹上傳** —— 右鍵**資料夾行** →「上傳檔案到此資料夾」（同一選單裡還有「以專案開啟」）；右鍵檔案行或面板空白 →「上傳檔案到目前目錄」（你正在瀏覽的那一層）。把系統檔案拖到資料夾行上就上傳到那一個資料夾（該行高亮），拖到面板則上傳到目前目錄；拖入的是**資料夾**會明確提示不支援，而不是靜默沒反應。單檔案上限 100MB，空檔案會被拒絕，檔名只取 basename 並取代 Windows 非法字元（限 200 字），目標目錄不存在會自動建立，上傳完成後清單會重新整理——哪怕你當時正瀏覽別的地方。
- **清單狀態的邊界** —— Windows/macOS 用工作區根的遞迴監聽，**任何**子目錄的改動都會重新整理（400ms 防抖）；不支援監聽的網路盤迴退為 10 秒輪詢（每個工作區只提示一次）；POSIX 隱藏建置噪聲（`node_modules`、`.git`、`dist`、`.venv` ……）且最多 500 條，Windows 只隱藏依賴/VCS/資料目錄且最多 2000 條，兩者被截斷時都會明說。
- **預覽也是編輯器** —— 文字檔案可直接改並用 Ctrl/Cmd+S 儲存（限 2MB、未改動時儲存置灰、帶未儲存改動關閉會先確認）；Markdown 可切渲染/原文；HTML 在沙盒 iframe 裡渲染，走目錄對映 URL 讓相對 CSS/圖片正常載入（「啟用腳本」是逐檔案開關，且永不開同源）；圖片/影片走 HTTP Range 串流；二進位給十六進位檢視；文字支援行號、點選/拖曳/Shift 選區（作為 `lines` 附件新增）、50–200% 縮放、自動換行開關與全螢幕。
- **下載不跟安全瀏覽打架** —— 先取位元組再用瀏覽器的儲存框存檔（不支援時回退 blob 連結，超 200MB 走原生下載），Windows 非法檔名自動改寫，取消儲存框不算錯誤。

**終端機與 Git**

- 內建終端機（xterm.js + node-pty），每用戶端獨立 PTY 管理；Windows 優先 Git Bash，回退到隨包下載的 busybox，再回退 `cmd`。同時最多 16 個線上終端機（agent 自己開的不計入），每個標籤切換時保留自己的 8000 行回溯；標籤可行內重新命名、可關閉（真殺行程），結束碼會寫進回溯。
- **常用命令清單** —— 終端機側欄上半是目前專案的 `.pi/commands.json` 清單（`name` + `command` + `cwd`，`${pwd}` 展開為工作區）：點一行即執行（同名標籤重複使用並重新啟動，類 VSCode task），可增刪改，也能從磁碟重讀檔案。
- **AI bash 分組** —— agent 透過終端機接管開啟的終端機收進可摺疊的「AI bash」分組，不會淹沒你自己的標籤。
- **終端機接管 bash**（設定 → 工具，預設關）—— 開啟後 agent 的 `bash` 工具在可見的常駐終端機裡跑，而不是隱藏行程，因此 `cd`/venv/ssh 等 shell 狀態能跨呼叫保留；靜默閾值（預設 15 秒，`0` = 一直等）決定何時把安靜的命令轉背景，`head`/`tail` 控制模型要讀的行數。
- **執行狀態偵測** —— agent 用過的終端機在對話仍串流時長時間沒輸出，伺服器端會把尾部輸出作為 steer 推給 AI（「去讀/回答/關掉它」），而不是乾等。
- **原始碼管理（Git）面板** —— 經隱藏查詢終端機展示 status / branch / diff / 歷史 / 未追蹤檔案，另有逐檔案暫存（＋）與取消暫存（－）、提交框（Enter 提交、相容輸入法）與「全部提交」（`git add -A && git commit`）、本地/遠端追蹤分支分組的切換器（選遠端分支會在本地建追蹤分支）、分離 HEAD 與 `↑領先 ↓落後` 徽標。「提交樹」頁載入 `git log --graph` 並可看每個提交的完整 diff。寫操作（提交 / 切分支 / 推送 / 拉取）都在可見終端機裡跑並自動切到終端機檢視；儲存庫真實 git 目錄變動時（含 worktree）以及 30 秒輪詢後備都會自動重新整理，因此在瀏覽器之外提交也能自己出現在面板裡。

**模型與設定**

- 模型管理 —— UI 裡編輯 models.json、按 provider 設定 API key（金鑰/headers 永不下發瀏覽器）。
  - **模型選擇器** —— 可按名稱/provider/id 搜尋，多個供應商時左側有供應商欄；你常用的模型自動置頂並標「用過 N 次」，另帶推理/視覺徽標；開啟時滾到目前模型，底欄固定「重新整理模型 / 管理模型」。
  - **一個供應商多把金鑰** —— 內建供應商可存多個命名金鑰（`<agentDir>/provider-keys.json`）：加第二把不會丟掉第一把，可按名啟用/刪除（刪掉目前活躍的會自動啟用下一把）。選擇器按金鑰分組列出，點某把金鑰下的模型即切過去；瀏覽器只拿到金鑰暱稱。
  - **自訂供應商** —— 可增刪改（API 型別、`baseUrl`、金鑰、可選鑑權頭）並逐模型設定上下文視窗/最大輸出/文字或圖片/推理；**抓取模型**在**伺服器端**探測 `/models`（所以區域網/迴環位址不受 CORS 限制）合併結果，已儲存的供應商也能重新探測。手改過的 `models.json` 用「重新載入 models.json」拉進來（允許註釋，與 SDK 一致）。
- 思考強度（thinking level）按模型切換 —— 共七檔，模型不支援的等級置灰，而不是靜默換到別的檔。
- 首次設定引導 —— 沒裝 pi CLI 時可直接一鍵安裝（失敗有詳情、可重試/跳過），然後選供應商 + 填金鑰就能開用。
- 設定面板：
  - **系統提示詞** —— 11 個來源（soul / tools / guidelines / pi 文件 / append / persona / terminal / markers / context / skills / cwd）拼成的 `{{token}}` 組合範本，點 token 晶片即可附加；每個來源可單獨覆蓋（`auto` 徽標、「以預設為底改寫」、單獨還原預設，環境類來源保持唯讀）；另有兩個檢視器分別展示**實際生效的完整提示詞**與**真正發給模型的工具 schema**。
  - **輸入歷史與快捷短語** —— 歷史有上限（1–500 條，可選單條字數上限，兩步確認清空），用 `↑`/`↓` 在游標位於草稿首/末**視覺行**時翻（自動折行的行也算）；輸入框上方的快捷短語可逐條編輯/上下移/刪除/還原預設。
  - **技能** —— 逐個啟停，另有「全文」晶片把整個 `SKILL.md` 注入提示詞（單檔案 8KB、總量 32KB）。
  - **擴充套件** —— 逐個啟停，`npm:` 裝的可在可見終端機裡一鍵解除安裝（`pi remove npm:<包名>`）。
  - **介面外掛 / 目標審查 / 視覺橋 / 子代理範本** 各有自己的頁，見 [介面外掛](#介面外掛)。
  - **預設集** —— 把目前組合（提示詞範本/模式/覆蓋、技能與擴充套件開關、工具開關、終端機接管、重試次數、審查提示詞、技能全文名單）存成命名預設，隨時套用或刪除；有意**不**包含（問卷、目標模式、顯示偏好、視覺橋、預設子代理模型、快捷短語），套用預設後它們保持原值。
  - **預設集匯入 / 匯出 / 分享** —— 預設集可匯出為 JSON（`pi-web-ui-preset` v1）：匯出到剪貼簿或 `.json` 檔案、貼上/選檔案/**按網址**匯入（先預覽：名稱、說明、將寫入的欄位、被忽略的未知欄位、是否覆蓋同名，確認後才寫入磁碟，可順帶立即套用），或者一鍵發到社群共享儲存庫 [pi-web-ui-presets](https://github.com/xing-shuyin/pi-web-ui-presets)（有 `gh` 命令或 GitHub 權杖就直接提交 Issue，兩者都沒有則開啟**已預填內容**的建 Issue 頁面，點一下 Submit 即可；儲存庫機器人驗證後自動收錄）。「瀏覽分享」頁籤拉儲存庫目錄、搜尋、一鍵匯入別人的預設。匯入的 JSON 在伺服器端過白名單淨化（只認 19 個已知欄位，未知欄位忽略、型別不符丟棄），網址匯入只允許公網 http(s)（內網/迴環位址攔下），單一檔案 ≤512KB。詳見 [docs/preset-sharing.md](docs/preset-sharing.md)。
  - **生效時機** —— 工具開關、重試次數、顯示偏好、標記與技能全文名單即時生效；提示詞範本/覆蓋與技能擴充套件開關需重新載入工作階段，回答中改的會延後到「本回覆結束後生效」（有提示）。
  - **顯示偏好** —— 思考區塊預設展開或摺疊、工具卡預設展開、寬螢幕聊天列（寬螢幕下取消 860px 上限）、標籤標題顯示專案名、聊天桌布（位址或上傳，帶壓暗/模糊滑桿）。
- 主題切換 —— 頂欄選擇主題；主題是純 `:root` 調色盤覆蓋（佈局唯一在 styles.css）。如何新增自訂主題或向儲存庫貢獻主題，見 [主題](#主題)。

**代理工具與行內標記**

- **工具開關** —— 設定 →「工具」把所有可選工具逐個列出：統一的 `subagent` 工具（預設開）、以及另外 15 個工具 —— `edit_soft`、`browser_page`、`eval` 與 `lsp` 預設關，`delegate_task` / `ask_user_question` / `todo_list` / `conversation_read` / `present_files` / `skill` / `schedule` / `claim_files` / `plan_update` / `patch` / `compact_context` 預設開。開關即時生效、不重新啟動，工具只是被停用仍保留註冊以便隨時開回；核心工具 `bash` 與 SDK 內建的 `read` / `write` / `edit` 走設定頁「核心工具」獨立區域管理。
- **行內標記** —— 狀態改變不需要工具往返，AI 直接把標記寫進回覆：任務清單用 `[[todo:new:<主題>]]` / `[[todo:set:<id>,in_progress]]` / `[[todo:remove:<id>]]` / `[[todo:dep:<id>,blocks=<id>]]`，不打斷的提醒用 `[[notify:<級別>:<內容>]]`，改對話標題用 `[[conv:rename:<標題>]]`。氣泡定稿即執行，標記寫錯會以瀏覽器提示回顯；任務清單同時以常駐 widget 顯示在右欄檔案樹下方（`N/M done` + ✓/◐/○），跟隨目前對話，且因為存在該對話自己的工作階段分支裡，重新整理後仍在。設定 →「工具」另有總開關與逐標記開關（這兩項全域共享）。
- **`edit_soft`** —— 更寬鬆的 `edit`（預設關）：縮排/空白導致內建工具失敗時用它，先精確子串、再按去空白逐行核心比對，`newText` 原樣寫入並保留檔案換行符/BOM，結果帶 diff 與 unified patch。
- **`delegate_task`** —— 強制六段派單（TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT）並在伺服器端校驗：範本不可用、任務少於 20 字或任一段為空都會被打回，並把可用範本清單回給模型。卡片按六段結構化展示，跑完後可一鍵跳到對應子代理對話。
- **`ask_user_question`** —— pi 引擎本身沒有問卷工具，這是 pi-web-ui 加的：模型可以問結構化問題（單選/多選 + 富文字選項預覽 + 自由文字），以對話方塊彈出；回答作為工具結果回給模型，取消則以工具錯誤返回，等你回答的時間不受工具看門狗限制，未答的問卷重新整理/重連後會恢復。
- **MCP 伺服器管理與公開市集** —— 設定 →「MCP 伺服器」提供完整的圖形化管理，支援 Pi 全域（`~/.pi/agent/mcp.json`）與目前專案級（`.pi/mcp.json`）雙作用域設定。可在介面中快捷新增、編輯、刪除、啟停伺服器，檢視即時執行狀態與暴露的工具清單；接入 Smithery 開放註冊中心（`api.smithery.ai`）千餘款公共伺服器即時搜尋與 GitHub 官方儲存庫，並支援自訂源，一鍵新增至全域或目前專案。底層設定熱載入，儲存或手改檔案即刻生效無需重新啟動。
- **技能市集與公開儲存庫同步** —— 設定 →「技能」提供已安裝技能管理與公開技能市集，遵循官方 Agent Skills 規範；支援直連 GitHub 官方 Agent Skills 庫（`anthropics/skills`）或任意自訂 GitHub 儲存庫（`owner/repo`），線上檢索技能、即時拉取並預覽 `SKILL.md` 指令正文，一鍵安裝至全域使用者目錄（`~/.pi/agent/skills`）或目前專案（`.pi/skills`），熱生效無需重新啟動服務。
- **擴充套件 UI 橋** —— pi 擴充套件可以驅動瀏覽器：`setWidget` 在檔案樹下方渲染即時面板（點標題居中放大），`setStatus` 在底欄顯示狀態文字，`notify` 彈通知，`select`/`confirm`/`input` 在輸入框上方彈出非模態請求面板（選項走 Markdown 渲染，`Esc` 當作取消）；widget 文字裡的 ANSI 色碼會被剝掉，不會把擴充套件底欄變成轉義序列噪聲。
- **外掛能力** —— 外掛可註冊 `/命令`（選擇器標 plugin 來源、伺服器端執行不耗 token）、註冊帶停止按鈕的背景任務、宣告設定表單、訂閱執行/工具/對話事件，並在前端經 `window.__piWebUiHost` 切檢視、新增對話。詳見 [介面外掛](#介面外掛)。

**聲音與通知**

- **聲音提醒** —— 總開關 + 四個事件各自開關（提問 / 完成 / 開始 / 錯誤），每個都帶試聽按鈕，另有音量滑桿（0–100%）。
- **桌面 / 系統通知** —— 預設關；開啟時在點選處申請瀏覽器權限，被拒則自動關回（並記住）。通知經 Service Worker 發出，所以裝成 PWA 後背景也能收到，覆蓋「完成 / 提問 / 錯誤」，點通知會把應用程式視窗拉到前景。你明顯正在看頁面時不會打擾——包括 Windows 上瀏覽器仍聲稱有焦點/可見但視窗已最小化的情況（改用原生視窗矩形判定）。

**PWA 與離線**

- **可安裝** —— 帶 web app manifest（獨立視窗、192/512/1024 + maskable 圖示、`./` 相對路徑所以子路徑部署也能裝），Chrome/Edge 的「安裝應用程式」或手機「新增到主螢幕」即可得到獨立視窗與圖示。
- **離線應用程式殼** —— Service Worker 對導航請求走網路優先 + 快取外殼後備（後端宕機/重新啟動時頁面仍能開啟），雜湊靜態資源快取優先，而 `/ws`、`/api`、`/themes`、`/plugins` 永不快取；新 worker 會立即接管已開啟的頁面。
- **該提醒時才提醒** —— 頁面載入的建置與伺服器端 wire 協定不一致時（比如剛更新完）會固定顯示重新整理提示條；標籤標題可顯示目前專案資料夾。

**語言與語言包**

- 頂欄語言選單按母語名列出所有語言，「取得更多語言」開啟的管理器列出 11 個可下載語言包的版本與下載/移除按鈕（另有重新整理）；語言包存放於 `<dataDir>/locales/`，也能手動放入以進行完全離線安裝。
- 首次存取沒有存過選擇時，按瀏覽器語言 → 執行個體預設（`PI_WEB_LOCALE`）→ 英文的順序決定；一旦你選過就一直跟著。
- 伺服器端的工具回覆、提示詞段落與提醒會依語言選擇中文或英文；目前繁體中文介面使用的伺服器文案仍是簡體中文。

**目標（Goal）模式**

- GoalBar 目標欄 —— 可設定目標、需求釐清用模型（介面標示「調研模型」，供「AI 提煉」向導使用）、執行模型、最大輪數與鎖定開關。
- 目標釐清精靈（「AI 提煉」）會透過逐題問卷收斂原始需求；完成後會自動將結果設為目標並開始執行。
- **委託執行與審查（pi 引擎）** —— 伺服器端會建立一個會保留轉錄的常駐執行對話處理工作，由目前對話擔任審查者。每輪完成後，伺服器會提供執行者自述、計畫摘要及最近的工具／命令證據，由審查者判定是否通過或要求執行對話修改；輪次、熔斷與停止皆由伺服器端管理。

**DeepSeek Harness（DSH）引擎**

- **引擎可切換** —— `PI_WEB_ENGINE=pi|dsh`（預設 `pi`）。pi 引擎在行程內跑 pi SDK；**DSH 引擎**把官方 [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/dsh)（DeepSeek Harness）執行時作為子行程重新啟動。`/api/health` 返回 `engine`；底欄顯示 DSH 徽標。
- **同一套 wire 協定** —— DSH 引擎實作與 pi 相同的 WebSocket 協定，目標/審查、SCM、背景任務、設定、外掛、終端機、message_delta 與快照全部一致。
- **原生目標機制** —— DSH 自己的目標狀態機 + round-driver 自動續輪；完成/受阻由模型自判定（無獨立審查工作階段）。目標精靈經模型 `ask_user_question` 驅動。
- **真圖片塊** —— 圖片作為真正的 image 內容發給支援視覺的 DeepSeek 模型（如 `deepseek-v4-flash-vision-exp`）；純文字模型走文字轉寫橋。
- **提問對話方塊** —— 模型 `ask_user_question` 彈出瀏覽器對話方塊（單選/多選 + 自由文字），支援排隊與倒計時。
- **工具 & MCP 橋** —— 外掛 AI 工具與外部 MCP 伺服器（`mcp.json`）都橋進 DSH 執行時，DSH 模型可直接呼叫（伺服器端執行）。
- **技能啟停** —— 設定面板暴露 DSH 技能目錄；停用即執行時過濾該技能，模型不可見。
- **DSH 使用者修補檔** —— 在 `<dataDir>/dsh-patches/` 放 `.yml` Cordis 修補檔擴充套件執行時，設定面板一鍵重掃生效；設定 →「外掛」會列出修補檔（大小/時間）與解析後的目錄路徑，壞檔案跳過並把錯誤打到執行時的 stderr。

**DSH 與 pi 引擎的差異**（切換前值得知道）：

- 思考強度固定 `high`，改檔會回答「DeepSeek V4 只支援高思考強度」。
- 底欄的 token/成本/上下文按 DeepSeek 官方每百萬定價與 100 萬視窗計算。
- 開啟歷史工作階段是唯讀回放：一發訊息就會開**新分支**並把舊對話作為上下文注入（執行時不允許原地續聊）；編輯重問同理。
- **停止**會殺掉執行時行程樹，所以所有進行中的 DSH 對話都會停（有提示），半成品目標會先清除；不支援只中止 bash 工具。
- 工作階段存在 `<dataDir>/dsh-sessions/`（與 pi 引擎的轉錄隔離），超過 `PI_WEB_DSH_SESSION_RETENTION_DAYS`（90）天自動清理；每專案最多同時 8 個對話；執行時崩潰按 1s/3s/9s 退避重新啟動，60 秒內最多 2 次，超限就停下並提示你去查 API key 與 DSH 依賴。
- 工具跑在 `workspace-write` 沙盒裡、核准為 never——你的「停止」按鈕就是控制閥。問卷是逐題精靈（帶選項預覽與倒計時）。
- pi 專屬能力（工作階段重新命名、`/compact`、`/reload`、擴充套件熱重新載入、子代理範本、自訂供應商/多金鑰、供應商模型探測、裝 pi CLI、視覺橋、逐工具開關）都會給明確提示並被隱藏入口，而不是靜默失敗。

**背景任務**

- 背景任務面板 —— 在 bash 前後對比監聽埠，偵測 agent 啟動的服務並列出埠 / pid / 名稱 / 命令列（點命令列可展開全文）；可單獨停止或全部關閉，頂欄按鈕帶即時數量徽標。
- 清單屬於**瀏覽器用戶端**而非對話：切專案、切對話、重連都不丟，伺服器端每 30 秒重新整理一次並剔除已離開的行程。偵測會排除已知桌面軟體，以及父鏈回溯到 `explorer` 而不是服務行程的行程（所以你自己開的瀏覽器不會被當成「AI 啟動的服務」）。
- 外掛註冊的任務帶 🧩 標記與即時狀態文字，走外掛自己的停止回撥（比如郵件輪詢任務）。
- 工具看門狗 —— 單個工具呼叫超過 20 分鐘自動中斷工作階段（逾時在設定「工具」頁可改，0 = 停用；`PI_WEB_TOOL_TIMEOUT_MS` 只提供預設值；工具自己宣告更長逾時，如 bash `timeout`，則自動順延）。問卷豁免。
- **只停止 bash 命令** —— 中止執行中的 bash 工具而不打斷對話。
- **失聯警告** —— 串流執行完全沒事件超過 3 分鐘（`PI_WEB_STALL_NOTIFY_MS`，`0` = 關）會指名對話地提醒一句，但不自動中止。

**安全與維運**

- 預設只綁 loopback；區域網 / 容器需明確 `PI_WEB_HOST=0.0.0.0`。
- **口令鑑權** —— `PI_WEB_TOKEN` 可經 `Authorization: Bearer …`、`X-PI-Token: …`、`?token=…` 或 `pi_web_token` cookie 任一通過；`?token=` 連結一次登入、從位址列抹除並把口令寫入 cookie，每次授權請求都會重新整理它，失效 cookie 在 401 時立即過期——所以改完口令後一次正確的 `?token=` 進入就永久恢復。`/api/health` 保持開放給探針。
- WebSocket Origin/Host 同權威校驗 —— 跨源頁面直接拒絕（403），`Origin: null`（`file://` 頁面）一律拒絕，設了口令時憑據不對會在升級前就被 401；反代情境用 `PI_WEB_ALLOW_ORIGINS` 白名單。
- **Host 白名單** —— `PI_WEB_ALLOW_HOSTS=host1,host2` 在始終生效的同權威校驗之上再加一層嚴格主機名白名單。
- **執行個體收窄** —— `PI_WEB_TABS=chat,terminal,git` 只開放這些分頁，未列出的分頁在**伺服器端**也會被拒絕（對應訊息返回說明），`chat` 永不可關。`PI_WEB_MANAGED=1` 宣告執行個體由外部部署管理：自更新、裝 pi CLI、外掛市集安裝都會被伺服器端拒絕並給出原因，前端也隱藏這些入口（版本按鈕變成純標籤）。
- **檔案邊界** —— 工作區相對路徑的讀寫一律做 `..` 逃逸校驗（工作區外的路徑只能經明確絕對路徑/機器瀏覽到達）；`/api/file` 行內只允許圖片/影片/HTML，二進位不可能被 `<img>` 帶走——其他型別必須走 `?download=1`（附件下載）。HTML 預覽路由一律以 sandbox 下發。
- 本地控制 socket 提供 `server status|quiesce|unquiesce`（排空模式：拒絕新 prompt/編輯重問/工作階段恢復，DSH 下還會拒絕新用戶端連線，存量跑完）。
- 憑據不下發瀏覽器 —— provider headers（可能含 Authorization）永不傳送到前端，供應商 API key 只以暱稱形式到達瀏覽器。
- 13 種介面語言（中英內建 + 11 個可下載語言包：德/西/法/意/日/韓/葡/俄/繁中/港繁/臺繁），語言包可在頂欄選單裡裝/卸（見上方「語言與語言包」）。
- **保留期** —— `uploads/` 裡超過 `PI_WEB_UPLOAD_RETENTION_DAYS`（14 天，`0` = 不清理）的上傳檔案會在啟動時與之後每 6 小時清理一次；`attachments/` 不受此保留期影響。DSH 工作階段有自己 90 天的清理。
- **維運看門狗**（工具逾時、模型失聯、終端機閒置狀態）都可調，見 [環境變數調整](#環境變數調整)。

**部署與更新**

- 前景執行 / 全域 npm 安裝 / Docker（見 [Docker](#docker)）/ macOS launchd / Linux systemd / Windows 登入自啟（HKCU `Run` 鍵 + 無控制台啟動器 + 崩潰看門狗）/ 桌面快捷方式（`server shortcut`）。
- `server install --print` 只輸出將要寫入的 launchd plist / systemd unit / Windows 啟動器就離開，可在真正安裝前先審閱。
- **更新面板** —— 版本按鈕在有新版本時顯示黃點，另有「N 個更新」徽標；「檢查全部更新」會比對本體、全域安裝的 pi 核心與 `<agentDir>/npm/package.json` 裡宣告的直接依賴，每行都能單獨更新，另有「全部更新」與「重新檢查」；命令在可見終端機裡跑（pi 擴充套件走 `pi update npm:<名字>`，這是唯一能更新 pi 真正載入的那份的命令；其餘走 `npm i -g <名字>@latest`）。剛釋出不足 30 分鐘會提醒 npm 快取後設資料可能還沒同步。被 launchd/systemd/Windows 看門狗託管的執行個體多一個「重新啟動服務」按鈕；前景執行的執行個體沒有，因為沒有東西會把它拉回來。
- **命令列更新外掛** —— `pi-web-ui plugins --check-updates` 逐個對比外掛記錄的提交與遠端 HEAD 並給出確切更新命令；每次 `install --force` 都會把舊版本快照到 `<dataDir>/plugin-backups/`（只留最近 3 份，複製失敗自動回溯），所以 `pi-web-ui plugins --rollback <id>` 可以退回上一版。
- pi CLI 裡還有 `/webui`（來自隨包的 `extensions/webui.ts`）：`/webui` 從 8787 起挑第一個空閒埠啟動服務，`--port 9000`、`--cwd <路徑>`、`--no-browser`、`status`、`stop` 分別控制它；每個 pi 工作階段一個子行程，工作階段關閉時回收，不留孤兒行程。

## 快捷鍵

| 按鍵                        | 作用                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter`                     | 傳送。觸屏裝置上 `Enter` 改為換行，`Ctrl/Cmd+Enter` 才傳送（Windows 觸屏筆記本當作桌面）。                                             |
| `Shift+Enter`               | 輸入框內換行。                                                                                                                         |
| `↑` / `↓`                   | 游標在首/末**視覺行**時翻全域輸入歷史（跨對話持久化；自動折行的行也算，一段長草稿按 `↑` 是逐行上移游標而不是切歷史）；`Esc` 回到草稿。 |
| `Ctrl/Cmd+K`                | 全域搜尋（對話 / 專案 / 工作區檔名）。                                                                                                 |
| `Ctrl/Cmd+F`                | 搜目前對話 —— `Enter` 下一個命中，`Shift+Enter` 上一個，`Esc` 關閉。                                                                   |
| `/`                         | 開啟斜槓命令選擇器（`↑`/`↓` 選擇、`Tab` 或 `Enter` 補全、`Esc` 關閉；輸入空格則自動關閉）。                                            |
| `Ctrl/Cmd+S`                | 預覽裡編輯檔案時儲存。                                                                                                                 |
| `Ctrl/Cmd+A`                | 預覽裡全選行（游標不在文字框時）。                                                                                                     |
| `Ctrl/Cmd+Enter`            | 提交「編輯重問」編輯器。                                                                                                               |
| `Ctrl/Cmd+C` / `Ctrl/Cmd+V` | 終端機裡：有選中則複製（無選中時 `^C` 仍發給 shell）/ 原生貼上。                                                                       |
| `Esc`                       | 關閉預覽、對話方塊、命令選擇器、問卷或擴充套件請求面板（預覽有未儲存改動時會先問）。                                                   |
| 拖放                        | 視窗任意位置拖入檔案 = 附件到對話；拖到檔案樹 = 上傳到那一個目錄；不支援拖資料夾（展開後選檔案）。                                     |

## 介面截圖

![對話 + 提示詞範本](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/chat-prompts.jpeg)

_對話 + 提示詞範本_

![執行軌跡時間線](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/trajectory.jpeg)

_執行軌跡時間線（run-trace 外掛）_

![設定面板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/settings.jpeg)

_設定面板_

![內建終端機](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/terminal.jpeg)

_內建終端機_

![Git 原始碼管理面板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/git.jpeg)

_Git 原始碼管理面板_

## 安裝

```bash
npm i -g pi-web-ui            # 全域安裝（推薦）
npx pi-web-ui                 # 或免安裝直接跑（拉取最新版，啟動在 :8787）
npm i -g .                    # 或安裝本地 checkout
```

**npm ≥ 12？** npm 12+ 預設阻止依賴安裝腳本（會看到 `npm warn install-scripts … blocked` 警告）。
node-pty 是原生模組，需要允許其腳本（其餘兩個包只是 no-op/純提示，一併允許可消除警告）：

```bash
npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
```

### 🐧 Linux：安裝前的編譯依賴

內建終端機依賴的 `node-pty` 只發布 macOS / Windows 的預編譯產物，Linux 上
`npm install` 一律回退到 `node-gyp` 原始碼編譯。請在安裝 pi-web-ui **之前**裝好 C/C++ 工具鏈：

```bash
# Debian / Ubuntu
sudo apt-get install -y build-essential python3
# Fedora / RHEL
sudo dnf install -y python3 make gcc-c++
# Arch
sudo pacman -S --needed base-devel python
```

缺少時會整體安裝失敗：

```
npm error path .../node_modules/node-pty
npm error command sh -c node scripts/prebuild.js || node-gyp rebuild
npm error > Rebuilding because directory .../node_modules/node-pty/prebuilds/linux-x64 does not exist
npm error make: g++: No such file or directory
```

Android / Termux 是特殊情況，見 [Termux（Android）](#termuxandroid)。

### 🖥️ 桌面版（Electron）

偏好獨立視窗，而不是瀏覽器分頁？GitHub Releases 提供 Windows 安裝程式、macOS `.dmg` 與 Linux `.AppImage`：

**[⬇ 下載最新桌面版](https://github.com/xing-shuyin/pi-web-ui/releases/latest)**

桌面版會啟動同一套本機伺服器，再以獨立視窗連線；它使用隨機的 loopback 埠與獨立 WebUI 資料目錄（`<userData>/data`），不會和網頁版搶用 `8787`，兩者可以同時開啟。不過兩者預設共用 `~/.pi/agent`（pi 設定、認證與對話記錄），請勿同時操作同一個對話；如需完全隔離，請為桌面版另設 `PI_CODING_AGENT_DIR`。詳細設定見 [`desktop/README.md`](desktop/README.md)。

各平台的簽章與安全提示可能隨發行版本而異；若系統阻擋安裝，請先查看該版本的 Release 說明與桌面版文件。自行建置可執行 `npm run desktop:dist`，產物位於 `release/`。

### Termux（Android）

pi-web-ui 可以透過 [Termux](https://termux.dev) 在 Android 上執行，但原生依賴
`node-pty` 需要編譯工具鏈，而且 Android 有幾個值得注意的坑：

1. **先安裝編譯工具鏈** —— `node-pty` 需要 Python 和 C 工具鏈：

   ```bash
   pkg install python clang make binutils
   ```

2. **給 node-pty 建置指定一個佔位 NDK 路徑**。在 Android 上，gyp 會報
   `Undefined variable android_ndk_path`，除非該變數有定義：

   ```bash
   GYP_DEFINES="android_ndk_path=' '" npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
   ```

3. **如果安裝後 `pi-web-ui` 無法執行**（Android 上 exec 位和/或 shebang 可能
   被破壞）：恢復它：

   ```bash
   chmod +x "$(command -v pi-web-ui)"
   sed -i 's/\r$//' "$(command -v pi-web-ui)"
   ```

4. **背景執行時加上 `--no-browser`**（沒有桌面瀏覽器可以自動開啟）：

   ```bash
   setsid nohup pi-web-ui --no-browser --cwd /path/to/workspace >~/pi-web.log 2>&1 &
   ```

   `setsid` 把伺服器從啟動它的 shell 的行程組中脫離，關閉 Termux 工作階段也不會
   帶走伺服器 —— 單靠 `nohup` 在父行程組被殺時是不夠的。

啟動時的 `[control] socket error: EACCES …/.pi-web/pi-web-ui.sock` 警告在
Android 上無害：`pi-web-ui server stop/restart` 無法透過 control socket 工作，
但 Web UI 本身不受影響。

## 啟動

**前景啟動**

```bash
pi-web-ui                                           # 前景，http://localhost:8787
```

**啟動參數 & 環境變數** —— 每個設定既能用命令列的 `--flag` 傳，也能用環境變數設（flag 優先）。
二者任選一種即可：

| 參數                 | 環境變數              | 預設          | 作用                                                  |
| -------------------- | --------------------- | ------------- | ----------------------------------------------------- |
| `--port <n>`         | `PI_WEB_PORT`         | `8787`        | HTTP 埠                                               |
| `--cwd <dir>`        | `PI_WEB_CWD`          | 目前目錄      | 工作區根（讀/寫/終端機）                              |
| `--data-dir <dir>`   | `PI_WEB_DATA_DIR`     | `~/.pi-web`   | 資料目錄（介面狀態/外掛/上傳/附件/主題/語言包）       |
| `--engine <pi\|dsh>` | `PI_WEB_ENGINE`       | `pi`          | 代理引擎；`--engine dsh` = DeepSeek Harness           |
| `--host <addr>`      | `PI_WEB_HOST`         | `127.0.0.1`   | 監聽位址（`0.0.0.0` 供區域網/Docker）                 |
| `--agent-dir <dir>`  | `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi 設定目錄（auth.json、models.json、工作階段、技能） |
| `--no-browser`       | —                     | 關            | 啟動但不自動開啟瀏覽器                                |
| _僅環境變數_         | `PI_WEB_TOKEN`        | 空            | 可選共享鑑權口令                                      |
| _僅環境變數_         | `PI_WEB_DSH_*`        | —             | dsh 執行時、修補檔與除錯設定                          |

兩者等價 —— 任選其一：

```bash
pi-web-ui --engine dsh --port 9000 --cwd /path/to/project
PI_WEB_ENGINE=dsh PI_WEB_PORT=9000 PI_WEB_CWD=/path/to/project pi-web-ui
```

若用 dsh 引擎，需先安裝執行時（`npm i -g @deepseek-ai/dsh@0.1.1-rc.2`）並準備 DeepSeek API key
（讀 `~/.pi/agent/auth.json`，在供應商/API key 面板設定）。

## 停止

- **前景**：在執行它的終端機裡按 `Ctrl+C`。
- **作為服務**：`pi-web-ui server stop`。**Linux 和 Windows** 上會保留開機自啟（下次登入/開機會回來，直到 `server uninstall`）；**macOS** 上 `stop` 會解除安裝 launchd 代理，因此不再登入自啟——用 `pi-web-ui server start` 恢復。

## 更新

```bash
npm i -g pi-web-ui@latest     # 升級到最新發布版本
pi-web-ui server restart      # 重新啟動服務使新版本生效（前景執行則手動重新啟動）
```

## 解除安裝

```bash
npm uninstall -g pi-web-ui
```

解除安裝**不會**刪除你的聊天記錄：歷史面板裡的轉錄存在 `<agentDir>/sessions/`（預設 `~/.pi/agent/sessions/`，按專案分子目錄），其餘狀態（介面設定、最近專案、外掛、上傳、附件儲存區、主題、語言包）存在 `<dataDir>`（預設 `~/.pi-web/`）。兩者都能跨解除安裝/升級/重灌保留，之後重跑 `pi-web-ui server install` 會重新讀到。`PI_WEB_UPLOAD_RETENTION_DAYS` 只清理 `<dataDir>/uploads/`，不會清理 `<dataDir>/attachments/`；若要清除所有資料，請先備份需要保留的內容，再分別手動清除 `<dataDir>` 與 `<agentDir>/sessions/`；若也要移除 pi 的認證和模型設定，再刪除整個 `<agentDir>`。

## 作為系統服務（開機自啟）

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project   # 安裝 + 啟動
pi-web-ui server status                     # 執行中？開機自啟？
pi-web-ui server restart                    # 重新啟動（應用程式設定/版本變更）
pi-web-ui server stop                       # 停止（開機自啟保留）
pi-web-ui server start                      # 再次啟動
pi-web-ui server uninstall                  # 徹底移除服務
pi-web-ui server shortcut                   # 桌面一鍵啟動圖示
pi-web-ui server quiesce                    # 排空：拒絕新的對話/訊息，存量執行繼續跑完
pi-web-ui server unquiesce                  # 解除排空，恢復接收新工作
```

`server status` 還會經本地控制 socket 顯示即時狀態（版本、PID、排空狀態、
瀏覽器連線數、執行中對話數）——`quiesce`/`unquiesce` 也走同一個 socket。

- **macOS** → launchd 代理（無需 sudo），日誌 `/tmp/pi-web-ui.log` / `.err`
- **Linux** → systemd unit（`systemctl enable --now`），日誌 `journalctl -u pi-web-ui -f`
- **Windows** → 登入自啟 Run 鍵（HKCU，無需管理員）+ wscript 無視窗啟動器 + 10 秒崩潰看門狗（PID 寫在 `%APPDATA%\pi-web-ui\`）

選項：`--port`（預設 8787）、`--cwd`（工作目錄）、`--data-dir`（資料目錄）、
`--engine <pi|dsh>`、`--host`、`--agent-dir`、`--name`（自訂服務名）、
`--print`（只輸出將產生的設定，不安裝）。重複執行 `server install`
並傳入新選項即可重新產生設定並重新啟動服務 —— 這就是修改已裝服務埠/工作目錄/引擎的方式。
`--engine` / `--host` / `--agent-dir` 會自動烘焙進服務；僅環境變數的（`PI_WEB_TOKEN`、
`PI_WEB_DSH_*`）需手動寫進服務設定。見上方「啟動參數 & 環境變數」表。

```bash
pi-web-ui server install --engine dsh --port 9000 --cwd /path/to/project
```

## Docker

容器映像檔會建置前後端、保留 `node-pty` 需要的編譯工具鏈、預裝 DSH 執行時（所以 `PI_WEB_ENGINE=dsh` 無需額外步驟）、以非 root 的 `node` 使用者執行，並宣告 `/app/.pi-web` 為資料卷：

```bash
docker compose up -d          # 然後開啟 http://localhost:8787
```

`docker-compose.yml` 已設好容器必需的 `PI_WEB_HOST=0.0.0.0`（埠對映的前提），並用命名卷 `pi-web-data` 持久化資料目錄。檔案裡註釋掉的塊覆蓋常見容器調整 —— 切 DSH 引擎、掛 `dsh-patches` 目錄、把專案掛為 `PI_WEB_CWD`、把 `~/.pi/agent` 唯讀掛為 `PI_CODING_AGENT_DIR`（讓容器能看到你的 API key 與模型設定）：

```yaml
services:
  pi-web-ui:
    build: .
    ports: ["8787:8787"]
    environment:
      PI_WEB_HOST: 0.0.0.0
      # PI_WEB_ENGINE: dsh
    volumes:
      - pi-web-data:/app/.pi-web
      # - ./my-project:/workspace:ro
      # - ~/.pi/agent:/root/.pi/agent:ro
volumes:
  pi-web-data:
```

## 介面外掛

外掛是可選的介面元件（頂欄多出一個 tab，背後是外掛自己的檢視，可帶伺服器端入口和 AI 工具）。
它們安裝在**資料目錄的 plugins 資料夾**（`<dataDir>/plugins/<id>/`，預設
`~/.pi-web/plugins/`）—— 一個外掛就是一個目錄：`manifest.json` + 可選伺服器端入口
（`index.mjs`）+ 可選檢視入口（`client/entry.mjs`）。目錄不存在 = 沒有外掛，介面上不會有任何痕跡。

### 外掛目錄

以下外掛隨本儲存庫釋出（`plugins/<id>/`），可直接從 GitHub 安裝：

| 外掛                                                                                                      | 功能                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📬 [網頁郵箱 webmail](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail)                 | IMAP 收件箱瀏覽/搜尋/閱讀/標記/刪除 + SMTP 發信、新郵件通知，可選「允許 AI 管理郵箱」（六個 `mail_*` AI 工具）。首次啟用自動補裝 npm 依賴。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 🗄️ [資料庫 db-client](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client)               | 資料庫工作台：MySQL / PostgreSQL / SQLite / SQL Server / MongoDB / Redis 連線管理 + 庫表樹 —— 表結構、分頁排序、SQL 編輯器、行編輯。驅動首次使用自動安裝。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 📝 [編輯器 + SSH vscode-editor](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor) | 類 VSCode 工作台：多根檔案樹（本地 + SSH 主機）、CodeMirror 多標籤編輯器、Remote-SSH 遠端檔案瀏覽/編輯、可拖曳多終端機面板（xterm.js）、SFTP 同步與下載到電腦。自動安裝 `ssh2`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ☁️ [sftp](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/sftp)                                | 專案級 SFTP 同步：設定存專案自己的 `.pi/sftp.json`（多環境 profile）+ `.pi/sftp.local.json`（本機覆蓋，兩層深合併，自動加進 .gitignore）。先算差異再傳（待上傳 / 待下載 / 一致 / 單邊 / 衝突），`sftp_sync` 預設 dry-run，不明確傳 `dryRun:false` 就不動檔案。刪除永不真刪：檔案進帶時間戳的 `.sftp-trash/<批次>/`，垃圾桶被內部護欄永久排除。併發串流傳輸、`.sftp-tmp-*` + rename 原子寫入磁碟、傳後大小校驗。憑據只寫引用（`${secret:名}` 走宿主加密儲存 / `${env:VAR}` / `${file:路徑}`），寫法不合法的引用直接錯誤而不是靜默成空密碼。另有 `mappings` 子樹對映、mtime 容差與僅比大小的降級、遠端檔名防穿越、symlink 跳過、**一個** action 式 `sftp` 工具（而非十幾個）與需手動開啟的 `exec` 動作，外加面板裡的手動上傳/下載（遠端樹每行 ⬇、工具欄「上傳本地對應目錄」，永不動刪除策略）、連線/差異/遠端檔案樹檢視 tab、底欄狀態徽標，以及一鍵匯入現成的 `.vscode/sftp.json`（明文口令轉入加密儲存）。 |
| 📊 [圖表 mermaid](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/mermaid)                     | 把對話裡的 ` ```mermaid ` 圍欄渲染成 SVG 圖表（fenced-code 渲染外掛，本地引擎離線優先）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 🧭 [執行軌跡 run-trace](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/run-trace)             | 執行軌跡：任務 → 思考 → 工具 → 檔案改動 → 結果的時間線聚合檢視，支援回放與節點詳情。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 📖 [閱讀 legado-web](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/legado-web)               | Legado 閱讀（文字源）：基於相容安卓書源的搜書 / 發現 / 詳情 / 目錄 / 正文閱讀，支援書源匯入、偵測與刪廢源，並提供四個修源 AI 工具（`legado_rules`、`legado_book_sources`、`legado_source_probe`、`legado_run_rule`）與「🤖 AI 修復源」按鈕（帶失敗現場直接開新對話）。書源/書架/進度存在 `<dataDir>/legado-web/`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 💬 [微信通道 wechat-ilink](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/wechat-ilink)       | 微信掃碼登入（與騰訊 openclaw-weixin 同源的 ilink 協定）：出站長輪詢收訊息，在微信裡直接指揮 agent，無需公網 IP。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 🎤 [語音輸入 voice-input](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/voice-input)         | 輸入框旁的麥克風按鈕：瀏覽器語音識別直接聽寫進輸入框；不支援/識別失敗時自動降級為伺服器端轉寫（遠端介面，或一鍵安裝的本地 Whisper，免費不出網）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 🌐 [即時預覽 live-preview](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/live-preview)       | Live Server 式預覽：`/liveserver` 看 HTML（含相對資源與自動重新整理）、`/md` 看 Markdown 渲染；真服務只綁回環位址，經宿主通用代理對外只露同源字首。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 🖼 [圖片處理 image-toolkit](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/image-toolkit)      | 圖片處理工作台：壓縮（按目標體積二分逼近）、裁剪、縮放、旋轉/翻轉、格式轉換（PNG/JPEG/WebP/AVIF）、批次匯出 ZIP、浮水印、濾鏡調色、圖片資訊與 EXIF，可直接讀寫工作區圖片；另給 AI 配了 4 個工具。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 📓 [筆記 notes](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/notes)                         | 隨手記：筆記 + 待辦 + 日程提醒三合一。頂欄按鈕開啟可自由拖曳的全域浮窗（位置/尺寸記憶，設定也在浮窗裡，無獨立檢視頁）；提醒走伺服器端定時（重新啟動不丟、錯過補送），另有 5 個 AI 工具與 `/note` `/todo` `/remind` 快速捕獲。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

`plugins/demo-mailbox` 作為最小外掛範本保留在儲存庫裡（伺服器端入口 + 用戶端檢視 + 雙向訊息協定），兼作測試夾具——想自己寫外掛從這裡入手。

也可以直接在介面裡裝：**設定 → 介面外掛 → 外掛市集**列出可維護外掛（同一套，隨包在 `plugins/catalog.json`）並提供**安裝 / 更新 / 解除安裝**（更新保留 `config.json`），還能用「新增外掛」把任何第三方外掛（填 `owner/repo` 或 `owner/repo/子目錄`）加進清單——你加的條目存在 `<dataDir>/plugin-catalog.json`。外掛作者想讓外掛進內建清單，往 `plugins/catalog.json` 提一行 PR 即可。

安裝範例（網頁郵箱）：

```bash
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail
```

每個外掛在儲存庫裡的目錄都帶獨立 `README.md`，含完整功能清單、設定說明與注意事項。

### 社群外掛

外掛目錄並不限於本儲存庫：條目的 `source` 可以指向任意 GitHub 儲存庫（`owner/repo`、monorepo 裡的 `owner/repo/子目錄`，
兩者都可帶 `#ref`），所以在別處開發、釋出、維護的外掛同樣能進市集清單，安裝 / 更新 / 回溯與上面的外掛完全一致——
同樣落在 `<dataDir>/plugins/<id>/`，更新時保留 `config.json`。

裝的時候程式碼是從那個儲存庫拉的，本儲存庫不做內建複製：社群條目只是一條指標，許可證、issue 與釋出節奏都歸外掛作者。
想要固定版本，在 `source` 裡帶上 `#ref`。

| 外掛                                                                     | 功能                                                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🌿 [多儲存庫 Git multi-git](https://github.com/EinErste/pi-web-multigit) | 多儲存庫 Git 總覽：專案目錄下每個儲存庫的變更、差異、歷史、分支、貯藏、跨倉搜尋、時間線與單檔案回溯，另有工作區分支聚合、Fetch/Pull（僅快進）與可選的內建終端機；其餘唯讀。 |

想被收錄，只需在 `plugins/catalog.json` 新增一筆項目，再提交 PR。不提 PR 也可以在市集裡自行登記（存在
`<dataDir>/plugin-catalog.json`），或用 `pi-web-ui install --catalog <url>` 把市集指向你自託管的目錄檔案。

### 安裝

從 GitHub 安裝（支援以下任意源寫法）：

```bash
pi-web-ui install owner/repo                                  # 簡寫
pi-web-ui install https://github.com/owner/repo               # 完整 URL（.git 可省）
pi-web-ui install https://github.com/o/r/tree/dev/sub/dir     # 指定分支 + 儲存庫內子目錄
pi-web-ui install owner/repo#v1.2                             # 指定分支/tag（#字尾對以上任意寫法都適用）
pi-web-ui install /path/to/plugin-dir                         # 本地目錄直接安裝（開發除錯用）
```

常用選項：

- `--name <id>` —— 自訂外掛 id / 目錄名（預設取儲存庫名或子目錄名；僅限字母數字-`-`/`_`）。
- `--force` —— 目標目錄已存在時覆蓋安裝。外掛本地的 `config.json`（憑據等）在升級時會原樣保留。
- `--data-dir <dir>` —— 覆蓋資料目錄（預設 `~/.pi-web`）。

CLI 會淺克隆儲存庫（無 git 時回退 tarball 下載），定位其中的 `manifest.json`
（包括儲存庫內子目錄裡的），然後把外掛複製到 `<dataDir>/plugins/<id>/`。

**沒裝 git？沒有網路？** 直接把外掛目錄手動複製到 `~/.pi-web/plugins/` 也行——效果完全一樣。

### 更新

對同一來源重新執行 `install` 並加 `--force` 即覆蓋更新：

```bash
# 例：把網頁郵箱外掛更新到儲存庫裡的最新版
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail --force
```

- 升級時會自動保留外掛目錄裡的 `config.json`（帳號憑據等）。
- 存放在外掛目錄**其他位置**的本地資料不在保留範圍內（如 db-client 的
  `db-connections.json`、vscode-editor 的 `ssh-hosts.json`）——強制重灌前請先備份。
- 更新後重新整理瀏覽器即可生效，無需重新啟動服務。
- 想知道哪些外掛過時了：`pi-web-ui plugins --check-updates` 逐個對比記錄的提交與遠端 HEAD；退回上一版用 `pi-web-ui plugins --rollback <id>`（每次 `--force` 升級前都會自動備份舊目錄，只留最近 3 份）。

### 生效方式

服務執行中只需**重新整理瀏覽器**——新外掛在 attach 時即被載入，無需重新啟動；服務未執行則下次啟動生效。
每個外掛會在頂欄出現一個 tab（🧩 或外掛內建圖示）。

### 列出 / 停用 / 解除安裝

```bash
pi-web-ui plugins             # 列出已裝外掛（id / 名稱 / 版本 / 描述）
pi-web-ui uninstall <id>      # 解除安裝外掛
```

- 想臨時隱藏某個外掛而不解除安裝：設定面板（⚙）→「介面外掛」開關即可——按用戶端持久化、純 UI
  隱藏，無需重新啟動，隨時可重新開啟。
- `uninstall` 會刪除外掛目錄；重新整理瀏覽器後 tab 即消失。寫在外掛目錄內的設定檔案也會一併刪除——
  如需保留請先備份 `<dataDir>/plugins/<id>/config.json`。

## 瀏覽器擴充套件

### 🎯 網頁元素拾取（page-picker）

在**開發中的網頁**上點選元素，把它整理成 AI 能直接動手的上下文，一鍵注入 pi-web-ui 的對話輸入框
（`Alt+Shift+P` 或點擴充套件圖示 → hover 高亮 → 點選拾取 → `Shift`+點選多選 → 寫備註 → 「新增到對話」）。

它不是 pi-web-ui 的伺服器端外掛，而是一個**瀏覽器擴充套件**（所以不走 `pi-web-ui install`）：

**下載裝**（不需要 Node）：[`page-picker-extension.zip`](https://github.com/xing-shuyin/pi-web-ui/releases/latest/download/page-picker-extension.zip) →
解壓縮 → `chrome://extensions` 開啟「開發者模式」→「載入已解壓縮的擴充套件程式」→ 選解壓縮出的目錄 →
點擴充套件的「擴充套件程式選項」填 pi-web-ui 位址（遠端位址先點「授權該位址」）。

詳細說明（互動、採集了什麼、遠端部署、已知限制）見
[`plugins/page-picker/README.md`](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/page-picker)。

採集的不是截圖，而是**能讓 AI 一次改對**的東西：React fiber 裡的元件原始碼位置（`Card.tsx:18:5` +
呼叫鏈）、Vue SFC 檔案、命中的 CSS 規則**原始檔與行號**（Vite dev 下精確反推）、
只保留「與預設值不同」的計算樣式子集、短且唯一的定位串、HTML 骨架與摺疊文字；
可選元素截圖會走對話附件。

## 主題

每個主題是**一份純 `:root` 調色盤覆蓋** —— 只寫 CSS 變數的宣告檔案（變數全集見 `web/src/styles.css` 的 `:root`：`--bg/--accent/--term-*` 基礎色，加 `--tooltip-bg/--code-bg/--notice-*` 等派生色）。佈局只存在於打包的 `web/src/styles.css` 裡，選主題只是覆蓋變數，因此任何主題都能在所有版本上工作，改佈局也不需要碰主題檔案。內建主題由 `node make-light-theme.mjs` 產生。

內建主題隨 npm 套件分發（`themes/`）。選擇器把命名調色盤（`nord`、`tokyo-night`、`catppuccin`、`one-dark`、`solarized-light`、`geist`、`ayu-light` 等）歸在「現代經典」下，內建預設歸在「原始預設」下：`white` / `mist` / `paper` / `sakura`（淺色）、`cyberpunk` / `dazzle` / `dark-teal`（深色）、`md-preview`，以及桌布友好的 `translucent` / `transparent`（可配對話桌布）。主題選擇器在頂欄（🌞 圖示），目前選擇按瀏覽器存在 `localStorage`。

### 使用主題

在頂欄直接選擇即可 —— 內建主題和使用者主題合併顯示在同一個選單裡；同名 id 時使用者主題優先。

### 本地新增主題（無需 GitHub）

把任意 CSS 檔案丟進**資料目錄的 themes 資料夾**就會自動出現在主題選單裡 —— 不用重新啟動、不用重新建置：

1. 找到資料目錄（預設 `~/.pi-web`，可用 `PI_WEB_DATA_DIR` 覆蓋）。
2. 建立 `<dataDir>/themes/` 並放入你的樣式表，例如 `~/.pi-web/themes/my-theme.css`。
3. 重新整理頁面，在頂欄選擇它。**檔名（去掉 `.css`）** 就是選單裡顯示的主題 id。

```
~/.pi-web/
└── themes/
    └── my-theme.css          # 選單裡顯示為 "my-theme"
```

最容易的寫法：複製一個內建調色盤（如原始碼儲存庫裡的 `themes/white.css`），改 `:root` 顏色即可 —— 想覆蓋哪些變數就列哪些，沒列的會落到 `styles.css` 的深色預設值。注意：

- **終端機跟隨主題** —— 在你的 `:root` 裡設定 `--term-*` 變數（終端機 ANSI 配色 + `--term-bg`），xterm 畫布和它的內邊距容器都會自動適配（預設值見 `styles.css`）。
- 程式碼高亮色（打包內建 `highlight.js` 的 `github-dark.css`）在淺色主題下必須覆蓋，否則程式碼會看不清 —— 參照 `themes/white.css` 末尾的 `.hljs` 覆蓋寫法（深色主題可跳過）。
- 主題 id 必須比對 `^[A-Za-z0-9_-]+$`（不能有點和斜槓 —— 伺服器端有路徑穿越防護）。

### 向儲存庫貢獻主題（GitHub）

想讓你的主題隨包分發給所有人？在 [github.com/xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) 開一個 Pull Request：

1. Fork 並 clone 儲存庫。
2. 建立 `themes/<id>.css` —— 一份純 `:root` 調色盤。以 `themes/white.css`（淺色）或 `themes/cyberpunk.css`（深色）為範本。
3. 本地驗證：執行 `npm run dev`，用頂欄主題選擇器確認你的主題能被列出、渲染正確（對話卡片、程式碼塊、工具呼叫卡片、Git/終端機面板）。
4. 如果你改了 `styles.css` 的變數清單，用 `node make-light-theme.mjs` 重新產生全部內建主題。
5. 提交（`git add themes/<id>.css`）並開 PR。`themes/` 已在 npm 包 `files` 白名單裡，合併釋出後 `npm i -g pi-web-ui` 即可把你的主題帶給所有人。

合併主題的規則：必須是單一 CSS 檔案、設定 `--term-*` 變數保證終端機可讀、淺色主題覆蓋 `.hljs` 語法高亮色以保證程式碼可讀。

## 環境變數調整

以下全部可選——預設值就是開發時一直在用的設定。完整參考：[`docs/env-vars.md`](docs/env-vars.md)。

| 變數                                         | 預設               | 作用                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_WEB_TOOL_TIMEOUT_MS`                     | `1200000`（20 分） | 單工具呼叫看門狗；逾時自動中止（`ask_user_question` 豁免）。只做預設值，設定面板「工具」頁優先。                                                                                                                                                                     |
| `PI_WEB_STALL_NOTIFY_MS`                     | `180000`（3 分）   | 串流執行完全沒事件時給警告（不中止）；`0` = 關。                                                                                                                                                                                                                     |
| `PI_WEB_TERMINAL_IDLE_MS`                    | `15000`            | AI 開過的終端機靜默這麼久就催它去看一眼；`0` = 關。                                                                                                                                                                                                                  |
| `PI_WEB_TERMINAL_IDLE_LINES`                 | `10`               | 該催命訊息回送的終端機尾部行數（1–500）。                                                                                                                                                                                                                            |
| `PI_WEB_VISION_TIMEOUT_MS`                   | `90000`            | 視覺橋整批轉寫的逾時。                                                                                                                                                                                                                                               |
| `PI_WEB_UPLOAD_RETENTION_DAYS`               | `14`               | `<dataDir>/uploads/` 保留天數；不影響 `<dataDir>/attachments/`；`0` = 不清理 uploads。                                                                                                                                                                               |
| `PI_WEB_SHELL`                               | 自動               | 僅 Windows：node-pty 用哪個 shell（自動順序：`PI_WEB_SHELL` → `$SHELL` → Git Bash → 隨包 busybox → `%COMSPEC%` → PowerShell）。                                                                                                                                      |
| `PI_WEB_TABS`                                | 全部分頁           | 逗號分隔的分頁白名單（`chat,terminal,git,search,tasks,settings,plugins`）；未列入的在伺服器端也被拒絕，`chat` 不可關。                                                                                                                                               |
| `PI_WEB_MANAGED`                             | 關                 | `1`/`true` 宣告執行個體由外部部署管理：自更新、裝 pi CLI、裝外掛都被拒絕並說明原因，前端也隱藏入口。                                                                                                                                                                 |
| `PI_WEB_ALLOW_HOSTS`                         | 空                 | 嚴格的主機名白名單（疊加在始終生效的同權威校驗之上）。                                                                                                                                                                                                               |
| `PI_WEB_LOCALE`                              | 空                 | 首訪回退語言（明確選擇與瀏覽器語言優先順序更高）。                                                                                                                                                                                                                   |
| `PI_WEB_LOCALE_BASE_URL`                     | GitHub raw         | 語言包下載根 —— 指向鏡像站即可做離線/內網安裝。                                                                                                                                                                                                                      |
| `PI_WEB_PKG_ROOT`                            | 自動               | 明確指定包根目錄（非標準安裝位置時用）。                                                                                                                                                                                                                             |
| `PI_CODING_AGENT_SESSION_DIR`                | 空                 | 讓 pi 把轉錄扁平寫入該目錄（而非 `<agentDir>/sessions/--<cwd>--/`，會改變歷史清單讀到的內容）。                                                                                                                                                                      |
| `PI_WEB_SDK`                                 | `global`           | 預設沿機器的祖先目錄鏈尋找較新的 pi SDK；有多份時取版本最高者，沒有較新版本則使用內建副本。設為 `bundled` 可強制使用內建版本。                                                                                                                                       |
| `PI_WEB_ALLOW_ORIGINS`                       | 空                 | WebSocket Origin 校驗的額外白名單（逗號分隔；dev 代理 / 反向代理用）。                                                                                                                                                                                               |
| `PI_WEB_GIT_EXTENSION_CHECK`                 | `1`（預設開）      | 設 `0`/`false`/`no`/`off` 關閉「全部元件更新」裡的 git 行（走 `git ls-remote`），大型單體儲存庫情境可用。                                                                                                                                                            |
| `PI_WEB_PLUGIN_CATALOG_URL`                  | 官方清單 URL       | 開機外掛市集清單來源：預設指向官方社群清單 `https://xing-shuyin.github.io/pi-web-ui-plugins/catalog.json`（僅下載目錄資訊並寫入可安裝清單，**不自動安裝外掛**）。設為空串或 `off`/`0`/`false`/`no` 可關閉；設 `PI_WEB_PLUGIN_CATALOG_INSTALL=1` 時順手自動全部安裝。 |
| `PI_WEB_LAUNCHED_BY` / `PI_WEB_SERVICE_NAME` | 空                 | 由 `pi-web-ui server install` 寫進服務單元/啟動腳本（`service` / `--name`）：伺服器端據此知道執行個體由平臺服務託管，更新面板才會出現「重新啟動服務」按鈕。                                                                                                          |
| `PI_WEB_DSH_*`                               | —                  | DSH 執行時旋鈕：`PI_WEB_DSH_RUNTIME`、`PI_WEB_DSH_DATA_DIR`、`PI_WEB_DSH_PATCH_DIR`、`PI_WEB_DSH_QUESTION_TIMEOUT_MS`、`PI_WEB_DSH_TOOL_TIMEOUT_MS`、`PI_WEB_DSH_SESSION_RETENTION_DAYS`、`PI_WEB_DSH_DEBUG`。                                                       |

## 安全

- **預設只綁 loopback** —— 伺服器只監聽 `127.0.0.1`，不暴露到網路；需要區域網存取或
  Docker 埠對映時明確設定 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已內建）。
- **WebSocket Origin 校驗** —— 瀏覽器頁面連 `/ws` 時其 Origin 的 hostname **和埠**
  必須與請求 Host 一致，跨源頁面直接 403；無 Origin 的非瀏覽器用戶端不受影響。
  反向代理情境可用 `PI_WEB_ALLOW_ORIGINS=http://你的域名:端口` 允許。
- **Quiesce 排空** —— `server quiesce` 後拒絕新的 prompt/編輯重問/工作階段恢復，存量執行
  跑完為止（升級/備份前用）；`server unquiesce` 恢復。
- **憑據不下發瀏覽器** —— provider 的 `headers`（可能含 Authorization / API key）
  永不發給瀏覽器；模型管理 UI 編輯其他欄位，伺服器端自動保留 headers。

## 隱私

pi-web-ui 在你自己的機器上執行，沒有遙測、分析追蹤或 pi-web-ui 自有帳號。資料預設儲存在本機：pi 設定、認證與對話轉錄位於 `~/.pi/agent/`；網頁版的介面設定、最近專案、外掛、上傳與附件儲存區、主題及語言包位於 `~/.pi-web/`。其中 `<dataDir>/attachments/` 存放對話中的圖片與二進位附件，不受 `PI_WEB_UPLOAD_RETENTION_DAYS` 的清理範圍影響。桌面版的 WebUI 資料目錄位於 Electron 使用者資料目錄下的 `data/`，但預設仍與網頁版共用 `~/.pi/agent/`。HTTP 伺服器預設只監聽 loopback。

**與模型互動時，提示詞與模型所需的內容會送到你設定的模型供應商。**一般文字檔案附件起初只會以路徑提供；模型呼叫 `read` 讀取後，檔案內容才會進入模型脈絡。圖片會包含在模型訊息中；若啟用視覺橋，還會送到你選定的視覺模型供應商進行轉寫。

| 情況                                            | 連線目的地                                                       | 傳送的資料                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 傳送訊息或 agent 呼叫模型                       | 你設定的模型供應商                                               | 提示詞、對話脈絡，以及依上方流程讀取或處理的檔案／圖片內容                  |
| 列出模型時檢查官方目錄（快取有效期 4 小時）     | `pi.dev`                                                         | 僅模型目錄請求，不含對話內容                                                |
| 啟動時同步外掛市集目錄                          | 預設 `xing-shuyin.github.io`                                     | 下載可安裝項目清單，不會自動安裝；可設 `PI_WEB_PLUGIN_CATALOG_URL=off` 停用 |
| 安裝或更新外掛、主題、語言包                    | `github.com` / `raw.githubusercontent.com`                       | 僅下載請求                                                                  |
| 非託管網頁版連線時自動檢查 Web UI／npm 套件更新 | 預設 `registry.npmjs.org`，或 `<agentDir>/npm/.npmrc` 指定的來源 | 套件名稱與版本查詢；私有來源的認證依設定傳送                                |
| 非託管網頁版連線時檢查 pi 擴充套件與介面外掛    | 各套件或外掛設定的來源（常見為 Git 遠端）                        | 查詢遠端版本／提交資訊，不含對話內容                                        |
| 桌面版啟動時檢查應用程式更新                    | GitHub Releases                                                  | 只下載更新中繼資料，不會自動下載更新                                        |
| 手動安裝或更新 npm 套件                         | `registry.npmjs.org` 或設定的 npm 來源                           | 套件資訊與套件檔案                                                          |
| Windows 找不到 Git Bash 或 `PATH` 上的 bash 時  | `frippery.org`                                                   | 下載一次 `busybox64u.exe` 到 `~/.pi-web/bin/bash.exe`，之後可離線重用       |

使用 MCP 公開市集搜尋、第三方外掛或語音輸入等選用功能時，可能另行連線至 Smithery、外掛作者指定的服務或其他第三方；資料內容依你選用的服務與設定而定。

反向代理、選用的 `PI_WEB_TOKEN` 口令與 Docker 埠對映都由你自行設定，詳見[安全](#安全)。

## 反向代理（nginx）

pi-web-ui 預設只綁 loopback，同機 nginx 反代是官方支援的遠端存取方式（無需
`PI_WEB_HOST=0.0.0.0`）：

```nginx
# pi-web-ui 在 127.0.0.1:8787，對外暴露為 https://your-host/pi/
server {
    listen 443 ssl;
    server_name your-host;
    # ssl_certificate ... / ssl_certificate_key ...

    # 子路徑 WebSocket：移除 /pi 字首後轉送至應用程式的 /ws。
    location /pi/ws {
        proxy_pass http://127.0.0.1:8787/ws;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 應用程式入口（剝掉 /pi/ 字首）
    location /pi/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        # 必須用 $http_host（保留埠）—— 伺服器端的 Origin 校驗比較完整權威
        # （hostname + 埠），$host 會丟掉埠導致 403
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket —— 必須原樣轉發 Host，否則升級被 403（頁面能開，
    # 但對話/終端機一直重連）
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 建置產物的絕對路徑資源/API（根路徑，不帶 /pi/）
    location /assets/  { proxy_pass http://127.0.0.1:8787; }
    location = /favicon.svg           { proxy_pass http://127.0.0.1:8787; }
    location = /api/file   { proxy_pass http://127.0.0.1:8787; }
    location = /api/health { proxy_pass http://127.0.0.1:8787; }
}
```

要點：

- **`Host` 必須用 `$http_host`**（保留埠），`/pi/`、`/pi/ws` 和 `/ws` 都要 —— Origin 校驗比較
  hostname **和**埠。`proxy_set_header Host $host` 或不設定（預設上游位址
  `127.0.0.1:8787`）都會 403。
- **同源自動通過**：只要瀏覽器 Origin 與轉發後的 Host 一致（普通反代天然如此），
  就無需 `PI_WEB_ALLOW_ORIGINS`；僅當瀏覽器 Origin 與後端看到的 Host 不同
  （如 TLS 終止代理改了埠）才需要設定。
- **不要開 `proxy_protocol`**（除非確實要真實用戶端 IP）：它會讓 nginx 拒絕所有
  不帶 PROXY 頭的連線，區域網直連和 frp 以外的用戶端全掛。用 frp 時同樣去掉
  `transport.proxyProtocolVersion`（除非 nginx 也 listen proxy_protocol）。
- **區域網免代理存取**：直接設 `PI_WEB_HOST=0.0.0.0`（加防火牆規則），
  或把上面的 server 塊放到 80/443 埠。

帶 frp 內網穿透的完整可執行範例：`deploy/nginx-subpath.conf`。

## 參與貢獻

pi-web-ui 是一個小型開源專案 —— **你的貢獻就是它成長的力量**。程式碼、外掛、主題、文件、翻譯、想法，統統歡迎；每一個合併的 PR 都會隨下一次 `npm publish` 送達所有使用者。❤️

| 貢獻方式               | 如何開始                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🧩 **寫外掛**          | 打造你自己的介面 tab + AI 工具。以 `plugins/demo-mailbox` 為最小範本（它兼作測試夾具），本地開發後既可開 PR 收錄進[外掛目錄](#外掛目錄)，也可獨立釋出並照樣收錄（見[社群外掛](#社群外掛)）。                    |
| 🎨 **貢獻主題**        | 以 `themes/white.css`（淺色）或 `themes/cyberpunk.css`（深色）為純調色盤範本，調整 `:root` 配色 + `--term-*` + `.hljs`，用 `npm run dev` 驗證後開 PR —— 完整步驟見[向儲存庫貢獻主題](#向儲存庫貢獻主題github)。 |
| 💻 **修 bug / 加功能** | 在 [Issues](https://github.com/xing-shuyin/pi-web-ui/issues) 裡挑一個，或提出新想法。Fork → 分支 → PR。程式碼約定見 `AGENTS.md`（Tab 縮排、i18n 雙語 key、協定改動只動 `server/protocol.ts`）。                 |
| 📖 **文件與翻譯**      | 完善 README、補外掛文件、改錯別字，或幫忙把介面/文件翻譯成更多語言。                                                                                                                                            |
| 💡 **想法與回饋**      | 在 [Issues](https://github.com/xing-shuyin/pi-web-ui/issues) 或 [Discussions](https://github.com/xing-shuyin/pi-web-ui/discussions) 裡發文 —— 功能建議、bug 報告、介面最佳化點子、部署經驗分享都歡迎。          |

**開 PR 前**，快速自檢能讓維護者更省心：

- `npm run check:protocol` + `npm test` —— 協定同步與單元測試。
- `npm run typecheck` —— 無型別錯誤。
- `npm run build` —— 前後端都能編譯。
- 涉及協定改動：`server/index.ts` 與 `web/src/use-chat.ts` 兩端 dispatch 都要加分支（詳見 `AGENTS.md`「協定單源」）。

> 喜歡 pi-web-ui？給儲存庫點個 ⭐，幫助更多人發現它。如果你在上面做了很酷的東西（外掛、主題、部署方案），記得告訴我們 —— 我們樂於展示社群作品。

## 授權條款

MIT
