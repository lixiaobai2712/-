# 待办事项清单 — 项目交接文档（HANDOVER）

> 本文件是**开发者交接文档**：写给接手这个项目的人看，说明它是什么、怎么跑、怎么改、改的时候注意什么。
> 使用说明（面向日常使用者）见 `README.md`，功能变更历史见 `CHANGELOG.md`。
>
> 交接日期：2026-10-17 ｜ GitHub main 最新提交：`fbbdd94`

---

## 1. 项目是什么

一个**个人效率工具**，由三端组成，数据互通：

| 端 | 载体 | 作用 |
|---|---|---|
| 电脑网页 | `todo.html`（纯前端单文件） | 主界面：待办/日期备忘/日期规划/工作登记/明天要说的话/思路侧边栏 |
| 桌面悬浮球 | `todo_tray.exe`（Python 打包） | 桌面右下角阿米娅小球：左键弹窗看今日任务+进度、右键菜单；同时是**数据枢纽**（内置 HTTP 服务） |
| 手机版 | `mobile.html`（PWA） | 手机浏览器打开即用，可"添加到主屏幕"变 App；任务勾选/新增/删除/进度 + 思路侧边栏 |

数据流向：**电脑网页(localStorage) ↔ 悬浮球(枢纽) ↔ 手机(localStorage)**，跨端同步走两条通道（见 §7）。

## 2. 当前状态（交接时点）

- 全部功能已完成并通过端到端验证，代码已推送 GitHub main（`fbbdd94`）。
- 本机悬浮球正在运行（`todo_tray.exe`，监听 `0.0.0.0:8899`），防火墙规则 `TodoTray8899`（入站 TCP 8899）已放行。
- 测试数据已清空（用手机端删除功能删掉了全部测试任务，墓碑保留在 `my_deleted`）。

## 3. 系统架构

```
┌─────────────┐        POST /api/sync        ┌────────────────────────┐
│ 电脑网页     │ ◄──────────────────────────  │                        │
│ todo.html   │       GET /api/pull (8s轮询)  │  桌面悬浮球 todo_tray   │
│ (localStorage│ ──────────────────────────► │  · tkinter 悬浮球/弹窗  │
│  为本地权威) │                             │  · 内置 HTTP 服务        │
└─────────────┘                             │    0.0.0.0:8899        │
                                            │  · 数据枢纽 (todo_sync  │
                                            │    .json 为跨端权威)     │
                                            └───────────┬────────────┘
                                                        │ GET/POST /api/*
                                                        │ (同一 WiFi 局域网)
                                            ┌───────────▼────────────┐
                                            │  手机版 mobile.html     │
                                            │  (PWA + localStorage    │
                                            │   离线缓存)             │
                                            └────────────────────────┘
      云端兜底（方案B，手动触发）：手机「☁️ 同步」/ 悬浮球右键「云端上传/下载」
                            └─► 坚果云 WebDAV
```

**同步通道**
- **方案A（局域网直连）**：电脑与手机在同一 WiFi 时，手机 15s 轮询、电脑网页 8s 轮询，自动双向同步。手机不在同一 WiFi 时改动只留本地缓存，连上后自动补同步。
- **方案B（坚果云 WebDAV）**：不同网络时的手动兜底。手机「☁️ 同步」按钮 / 悬浮球右键「云端上传/下载」，**只手动触发，不做自动轮询**（用户拍板）。

## 4. 文件清单

| 文件 | 职责 | git 状态 |
|---|---|---|
| `todo.html`（约131KB） | 电脑网页主程序：四大模块 + 思路侧边栏 + 同步桥 | 已提交 |
| `todo_tray.py`（约40KB） | 悬浮球 + HTTP 数据枢纽 + PWA 路由 + 云端同步 | 已提交 |
| `todo_tray.exe`（约20MB） | PyInstaller 打包产物，双击运行 | 本地产物（可重新打包） |
| `mobile.html`（约30KB） | 手机版页面 + PWA 标签 + 删除/墓碑逻辑 | 已提交 |
| `manifest.json` / `sw.js` / `icons/icon-*.png` | PWA 配置与图标（192/512/180） | 已提交 |
| `cloud_config.json` | 坚果云 WebDAV 配置模板（url/user/password） | gitignore，本地填写 |
| `todo_sync.json` / `todo_pull.json` / `todo_ball_pos.json` | 运行时数据：枢纽全量 / 页面轮询增量 / 悬浮球位置 | gitignore |
| `README.md` / `CHANGELOG.md` / `PLAN_手机版与双端联动*.md` | 使用说明 / 变更历史 / 设计方案 | 已提交 |
| `可爱的阿米娅-人为修改.ico` | 悬浮球图标源文件（打包用） | 已提交 |

## 5. 数据模型

### 5.1 任务对象（`my_todo_list_v2` 数组元素）
```json
{ "id": "mvb5...", "text": "任务名", "done": false, "progress": 0,
  "favorite": false, "note": "", "approach": "", "updatedAt": 1792166769416 }
```
`updatedAt` = 毫秒时间戳，勾选/进度/新增/删除时更新，是冲突裁决的兜底依据。

### 5.2 电脑网页 localStorage keys（todo.html 内 `*_KEY` 常量）
| Key | 内容 |
|---|---|
| `my_todo_list_v2` | 待办任务列表（数组 JSON） |
| `my_deleted` | **删除墓碑** `{任务id: 删除时间戳}`（跨端传播删除） |
| `my_date_notes` | 日期备忘 |
| `my_date_plans` | 日期规划 |
| `my_today_data` / `my_today_mode` | 今日任务模式：日期→任务ID映射 / 当前视图模式 |
| `my_panel_mode` | 左侧面板备忘/规划模式 |
| `my_worklog` | 每日工作登记 |
| `my_tomorrow_msg` / `my_tomorrow_dismiss` | 明天要说的话 / 弹窗关闭状态 |
| `my_ideas` / `my_ideas_open` / `my_ideas_pos` | 思路侧边栏：`{日期: {text, ts}}` / 开合 / 手动翻页位置 |
| `my_schedule_data` / `my_schedule_edit_mode` | 课表/日程数据 / 编辑模式 |

### 5.3 手机版 localStorage keys（mobile.html）
| Key | 内容 |
|---|---|
| `mobile_todo_cache_v1` | `{seq, data:{...全量数据}}` 离线缓存，含 `my_deleted` 墓碑 |
| `mobile_ideas_v1` | 思路缓存（结构同 `my_ideas`） |
| `mobile_cloud_cfg_v1` | 坚果云配置缓存 |

### 5.4 删除墓碑 `my_deleted`（重点）
- 任意端删除任务：从本地列表移除 + 在 `my_deleted` 记 `{任务id: 当前时间戳}`。
- 各端 merge 时：合并各端墓碑映射（同 id 取较新 ts）→ 把墓碑中的 id 从任务列表**一律剔除**。
- **删除是终局操作**：即使某端还有旧缓存/旧任务数据，合并后也不会把已删任务"复活"。
- 墓碑永久保留在数据中（量小，不清理；重建同名任务会得到新 id，互不影响）。

## 6. HTTP API 契约（枢纽 `0.0.0.0:8899`）

| 方法/路径 | 说明 | 返回 |
|---|---|---|
| `GET /api/pull` | 网页 8s 轮询的增量（任务列表字符串） | `{ver, payload}` |
| `GET /api/full` | 全量数据（手机/思路/墓碑用） | `{seq, data}` |
| `GET /api/lanip` | 局域网 IP（手机自动探测电脑用） | IP 字符串 |
| `GET /mobile` | 手机版页面 | HTML |
| `GET /manifest.json` `GET /sw.js` `GET /icons/*` | PWA 资源 | 按类型 |
| `POST /api/sync` | 数据提交，**按 body 分三支**（见下） | `{ok, seq}` |

**POST /api/sync 三分支**（todo_tray.py `do_POST`）：
1. body 含 `__mobile: true` → `merge_data(body.data)`（手机端全量提交，带 `__syncSeq`）
2. body 含 `__sync: true` → `merge_data(body)`（通用增量提交）
3. 无标记（网页旧格式整包） → `merge_from_web(body)`（避免整体覆盖冲掉手机端更新）

## 7. 冲突裁决规则（用户拍板，**不可改**）

合并函数在 `todo_tray.py`：`merge_data()`（手机/增量）与 `merge_from_web()`（网页旧格式），公共部分：
- **`syncSeq` 全局单调计数器优先**（`__syncSeq` 字段，每次合并递增）；
- **任务逐条按 `updatedAt` 较新者胜**（`merge_todo_lists()`，按 id 建索引逐条裁决）；
- **思路按日期键 `ts` 较新者胜**（不依赖 seq，各端可独立写不同日期）；
- **非任务 key**（今日/工作日志/计划等）：仅当提交方 seq 严格更高时整体覆盖（手机端不编辑这些 key，避免手机旧缓存覆盖电脑新数据）；
- **删除墓碑**：合并取较新 ts，并剔除对应任务（§5.4）；
- 网页旧推送走 `merge_from_web`，任务/思路合并 + 其余 key 网页覆盖（网页是这些数据的权威编辑器）。

**跨设备时间说明**：跨设备冲突以 `syncSeq` 计数器为准；`updatedAt` 仅在同设备内判新旧兜底（用户原话："只取最新时间的同步，或内置一个计数器"——计数器已实现为 syncSeq）。

## 8. 部署与运行

### 8.1 运行（日常）
双击 `todo_tray.exe` → 桌面右下角出现阿米娅悬浮球 → 网页 `todo.html` 与手机版即刻可用。
- 手机访问：`http://<电脑IP>:8899/mobile`（电脑 IP 见悬浮球右键「📱 手机版地址」）
- 网页与悬浮球同步：`127.0.0.1:8899`（网页 8s 轮询）

### 8.2 防火墙（首次运行或换网络后）
需放行入站 TCP 8899（已建规则名 `TodoTray8899`）。重建方法（PowerShell 管理员）：
```powershell
New-NetFirewallRule -DisplayName "TodoTray8899" -Direction Inbound -Protocol TCP -LocalPort 8899 -Action Allow
```

### 8.3 重新打包（改过 todo_tray.py 后）
```bash
pyinstaller --noconfirm --onefile --windowed --icon "可爱的阿米娅-人为修改.ico" --add-data "可爱的阿米娅-人为修改.ico;." todo_tray.py
```
打包后把 `dist/todo_tray.exe` 复制回项目根目录覆盖，重新启动。

### 8.4 依赖
- Python 3.x（本机 3.13），标准库 `tkinter`/`http.server`/`ctypes`/`urllib`（云端同步用）
- 第三方：`Pillow`（图标渲染）、`pystray`（托盘兜底，函数内 import）
- 打包：`PyInstaller`（本机 6.22.3）
- 校验 JS：`node --check`

### 8.5 坚果云配置（方案B，可选）
`cloud_config.json`：
```json
{ "url": "https://dav.jianguoyun.com/dav/待办同步/", "user": "邮箱", "password": "应用授权码" }
```
注意：url 含中文路径需 URL 编码；password 是 WebDAV **应用授权码**（账户信息→安全选项→生成），不是登录密码。未配置时点同步只提示、不影响本地使用。

## 9. 验证方法（历史复用套路）

| 层 | 方法 |
|---|---|
| JS 语法 | 提取 `<script>` 内容写临时文件 → `node --check` |
| Python 语法 | `ast.parse` |
| 数据核验 | `urllib` 请求 `http://127.0.0.1:8899/api/full`，核对任务/墓碑/seq |
| 电脑网页 | 浏览器打开 `file:///D:/Desktop/个人项目/待完成目标/todo.html`，检查渲染与轮询 |
| 手机版 | 浏览器打开 `http://10.171.10.193:8899/mobile` |
| 端到端 | 三端互操作：手机勾选→网页拉到；网页删除→手机消失；手机删除→服务端剔除+网页消失（本次删除功能即按此验证） |

## 10. 已知问题 / 注意事项（接手必读）

1. **测试数据"推回"现象**：若有设备（手机/另一个浏览器）一直开着待办页面，其 15s 轮询会把该设备 localStorage 缓存推回服务端，导致电脑端删数据后"又回来了"。处理：在对应设备上关闭待办页面或清除该站点数据，然后电脑端清理；这不是 bug，是轮询同步的设计行为。
2. **PWA 离线壳限制**：Service Worker（`sw.js`）只在 HTTPS 或 localhost 生效；局域网 HTTP 下 `registerSW()` 静默跳过——不影响"添加到主屏幕"（Android/iOS 均支持），仅离线打开壳不可用。
3. **坚果云凭据未填**：`cloud_config.json` 留空可运行，填入才启用方案B（用户尚未提供授权码）。
4. **数据权威层级**：电脑网页 localStorage 是本机权威；枢纽 `todo_sync.json` 是跨端权威。清数据时：先 `taskkill /F /IM todo_tray.exe` → 改/删 `todo_sync.json` → 重启 exe（否则内存态会把旧数据写回文件）。
5. **悬浮球位置**：`todo_ball_pos.json` 记录 `{x, y, physical}`（当前第二显示器）；多显示器/分辨率变化时若球"消失"，删掉该文件重启即回到默认位置。
6. **删除终局**：`my_deleted` 墓碑不清理、不可撤销；任务重建会得到新 id。
7. **国内网络推 GitHub**：HTTPS 推送遇 `TLS unexpected EOF` 时用 `git -c http.version=HTTP/1.1 push origin main`。
8. **执行环境**：本机 Windows；开发/验证用 `C:\Users\ASUS\AppData\Local\Programs\Python\Python313\python.exe`。

## 11. 版本历史摘要（详见 CHANGELOG.md）

| 阶段 | 内容 |
|---|---|
| v1 基础 | 纯前端单文件 todo.html：待办/日期备忘/规划/工作登记/明天要说的话，localStorage 持久化 |
| v2 悬浮球 | Python 托盘球 + 8899 数据枢纽 + 网页 8s 轮询双向同步（README 有打包说明） |
| v3 悬浮球增强 | DPI 清晰度、弹窗可吸附屏幕左右侧、打开网页主窗口按钮、勾选+进度条+滚轮滚动 |
| v4 思路侧边栏 | 按日期分页/按日期写、手动翻页记忆、修改时间悬停查看（鼠标放上去才显示，像 QQ 聊天） |
| v5 手机版+双端联动 | mobile.html + 方案A局域网自动同步 + 方案B坚果云手动同步 + syncSeq/updatedAt 冲突裁决 + 离线缓存 |
| v6 PWA | 手机版添加到主屏幕变 App（manifest + 图标 + sw.js） |
| v7 删除任务 | 手机端 ✕ 删除 + **墓碑机制**多端删除同步（当前版本） |

## 12. Git 与协作

- 仓库：`https://github.com/lixiaobai2712/-.git`，分支 `main`，工作流：改 → 提交 → `git -c http.version=HTTP/1.1 push origin main`
- 提交历史即 CHANGELOG 各阶段，含设计决策（冲突规则、墓碑机制、PWA 取舍）。
