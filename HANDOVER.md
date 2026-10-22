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

- v10（Gitee 数据 + Netlify 页面 + Android PWA）代码已完成，**尚未提交 git**；上一次提交为 `08b8644`。
- 本机悬浮球正在运行（`0.0.0.0:8899`），防火墙规则 `TodoTray8899`（入站 TCP 8899）已放行。
- Gitee 自动同步、设置窗、开机自启、PWA 静态路由均已实现；mock Gitee 测试通过。
- **仍需用户手动完成**：建 Gitee 私有仓库、生成令牌、把 `docs/` 拖到 Netlify、在电脑设置窗和手机弹窗各填一次令牌。令牌不要进入聊天/仓库。
- 小窗现为无边框圆角卡片，每 3s 自动刷新；`TODO_TRAY_NATIVE_CHROME=1` 可回退系统标题栏。

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
                                                        │ HTTPS + Token
                                                        │ 自动 120s ±10% / 手动
                                            ┌───────────▼────────────┐
                                            │  Gitee 私有仓库         │
                                            │  owner/repo:sync.json   │
                                            └───────────▲────────────┘
                                                        │ HTTPS + Token
                                                        │ 自动 120s / 手动
                                            ┌───────────┴────────────┐
                                            │ 手机 PWA（Netlify）     │
                                            │ Android 主屏幕独立窗口  │
                                            │ localStorage 离线缓存   │
                                            └────────────────────────┘
```

**同步通道**
- **主通道（Gitee）**：电脑悬浮球与手机 PWA 各自通过 HTTPS 读写 Gitee 私有仓库的同一个 `sync.json`。手机不再依赖电脑在线，也不受校园网 AP 隔离影响。
- **电脑网页**：仍只与 `127.0.0.1:8899` 通信（8s 轮询），由悬浮球负责与 Gitee 合并。
- **局域网备用**：`http://<电脑IP>:8899/mobile` 仍可用，返回同一份 `docs/mobile.html`，页面同样走 Gitee。
- HTTP 服务使用 `ThreadingHTTPServer`（`daemon_threads=True`）；Gitee 同步在后台线程执行，不阻塞 Tk 主线程。
- 悬浮球弹出的小窗是自绘无边框圆角卡片（`MiniWindow`），每 3s 自动刷新且全局单例。

## 4. 文件清单

| 文件 | 职责 | git 状态 |
|---|---|---|
| `todo.html`（约137KB） | 电脑网页主程序：四大模块 + 思路侧边栏 + 同步桥 | 已提交 |
| `todo_tray.py`（约75KB） | 悬浮球/小窗 + HTTP 数据枢纽 + PWA 路由 + Gitee 同步/设置/自启 | 已提交 |
| `todo_tray.exe`（约20MB） | PyInstaller 打包产物，双击运行 | 本地产物（可重新打包） |
| `docs/mobile.html`（约55KB） | 手机版页面 + Gitee 同步 + 删除/墓碑逻辑 | 待提交（新目录） |
| `docs/manifest.json` / `docs/sw.js` / `docs/icons/*` | PWA 配置、离线壳与图标（192/512/180） | 待提交（新目录） |
| `docs/_headers` / `docs/_redirects` | Netlify：noindex/CSP/不缓存 SW，根路径 302 | 待提交 |
| `cloud_config.json` | Gitee 配置（repo/token 等，由设置窗写入） | gitignore，本地填写 |
| `cloud_config.example.json` | Gitee 配置字段示例（无真实令牌） | 待提交 |
| `todo_sync.json` / `todo_pull.json` / `todo_ball_pos.json` | 运行时数据：枢纽全量 / 页面轮询增量 / 悬浮球位置 | gitignore |
| `todo_reminders.json` | 悬浮球「到点提醒」已提醒记录 `{日期\|HH:MM\|计划id: true}`（exe 同目录，gitignore，删除后自动重建） | gitignore |
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
| `my_ideas_mode` / `my_ideas_pen_color` | 思路视图模式（`read`/`edit`/`pen`）/ 上次选中的画笔颜色（`r`/`y`/`g`，空=未选） |
| `my_schedule_data` / `my_schedule_edit_mode` | 课表/日程数据 / 编辑模式 |

### 5.3.1 思路正文内联语法（v11，**重要：改了这套语法就要同步改三端**）
思路正文里用两种内联标记，**不新增存储字段**（`my_ideas` 仍是 `{日期:{text,ts}}`），因此同步格式与合并规则完全不变：

| 语法 | 含义 | 正则 |
|---|---|---|
| `[r] 文字` / `[y] 文字` / `[g] 文字` | 行首标记：红/黄/绿轻重缓急 | `/^[ \t]*\[([rygRYG])\][ \t]*/` |
| `[[显示文字\|详细说明]]` | 悬停说明（省略 `\|说明` 则说明=显示文字） | `/\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]/g` |

渲染规则：**相邻同色的行合并成一整块**（`idea-block`），颜色小球只画在块首；标记语法本身不出现在渲染结果里。三端各自的实现位置：
- 电脑 `todo.html`：`ideaParseLine` / `ideaSetLineColor` / `ideaRenderText` / `ideasRenderPreview`，模式切换 `ideasApplyMode`，涂抹 `ideaPenHit` / `ideaPenCommit`
- 手机 `docs/mobile.html`：`mIdeaParseLine` / `mIdeaSetLineColor` / `mIdeaRenderText` / `mIdeasRenderPreview`，点按上色 `mIdeaPaintLine`

> ⚠️ 已知坑：标记模式下编辑框被隐藏、永远拿不到焦点，所以 `isIdeasEditing()` 必须把「正在涂抹」和「停留在标记模式」也算作编辑中，否则网页 8s 轮询会刷新思路、把正在涂的笔画清掉。切走标记模式时要先存档再重载，避免漏掉期间合并进来的其它端改动。

### 5.3 手机版 localStorage keys（mobile.html）
| Key | 内容 |
|---|---|
| `mobile_todo_cache_v1` | `{seq, remoteSeq, data:{...全量数据}}` 离线缓存，含 `my_deleted` 墓碑 |
| `mobile_ideas_v1` | 思路缓存（结构同 `my_ideas`） |
| `mobile_ideas_pos` | 记住手动选中的思路日期（打开抽屉时恢复，不再每次跳回今天） |
| `mobile_ideas_mode` / `mobile_ideas_pen_color` | 手机思路模式 / 上次选中的画笔颜色（同电脑端语义） |
| `mobile_gitee_cfg_v1` | Gitee 配置：`{repo, branch, path, token, interval, apiBase, authMode}` |
| `mobile_sync_state_v1` | 同步状态：`{lastAt, lastError, nextAllowedAt, rateStep, lastSyncedSeq}` |

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
| `GET /api/lanip` | 局域网 IP（手机自动探测电脑用） | `{"ip": "10.x.x.x"}` |
| `GET /mobile` | 手机版页面 | HTML |
| `GET /manifest.json` `GET /sw.js` `GET /icons/*` | PWA 资源 | 按类型 |
| `POST /api/sync` | 数据提交，**按 body 分三支**（见下） | `{ok, seq}` |

**POST /api/sync 三分支**（todo_tray.py `do_POST`）：
1. body 含 `__mobile: true` → 把信封顶层的 `__syncSeq` 注入 `body.data` 后 `merge_data(data)`（手机端全量提交）
2. body 含 `__sync: true` → 支持 `{__sync, __syncSeq, data:{...}}` 信封或扁平 body，`merge_data(...)`
3. 无标记（网页旧格式整包） → `merge_from_web(body)`（避免整体覆盖冲掉手机端更新）

`__syncSeq` 只在「提交方 seq 更高」或「任务/墓碑/思路确有结构变化」时递增；完全相同的重复提交不会让计数器上涨（防止空闲轮询当心跳）。

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
- 手机主入口：Netlify 网址（悬浮球右键「📱 手机版网址」可查看；设置窗里填写）
- 局域网备用：`http://<电脑IP>:8899/mobile`
- 网页与悬浮球同步：`127.0.0.1:8899`（网页 8s 轮询）
- Gitee 自动同步：悬浮球启动 10s 后开始，默认每 120s ±10%；设置窗可改 60–3600s

### 8.2 防火墙（首次运行或换网络后）
局域网备用访问需要放行入站 TCP 8899（已建规则名 `TodoTray8899`）。重建方法（PowerShell 管理员）：
```powershell
New-NetFirewallRule -DisplayName "TodoTray8899" -Direction Inbound -Protocol TCP -LocalPort 8899 -Action Allow
```
Gitee 主通道是出站 HTTPS，不需要放行入站。

### 8.3 重新打包（改过 todo_tray.py 或 docs/ 后）
```bash
pyinstaller --noconfirm --onefile --windowed --icon "可爱的阿米娅-人为修改.ico" --add-data "可爱的阿米娅-人为修改.ico;." --add-data "docs;docs" todo_tray.py
```
`todo_tray.spec` 的 `datas` 也要包含 `('docs', 'docs')`。打包后把 `dist/todo_tray.exe` 复制回项目根目录覆盖，重新启动。

### 8.4 依赖
- Python 3.x（本机 3.13/3.14），标准库 `tkinter`/`http.server`/`ctypes`/`urllib`/`winreg`
- 第三方：`Pillow`（图标渲染）、`pystray`（托盘兜底，函数内 import）
- 打包：`PyInstaller`（本机 6.22.3）
- 校验 JS：`node --check`

### 8.5 Gitee 配置（`cloud_config.json`）

正常使用由「Gitee 同步设置」窗口写入，字段示例见 `cloud_config.example.json`：

```json
{
  "provider": "gitee",
  "repo": "owner/todo-data",
  "branch": "master",
  "path": "sync.json",
  "token": "********",
  "interval": 120,
  "enabled": true,
  "api_base": "https://gitee.com/api/v5",
  "auth_mode": "bearer",
  "web_url": "https://xxx.netlify.app"
}
```

- `branch` 留空时，保存并测试会读取仓库 `default_branch` 自动补全。
- `auth_mode`：先 Bearer；遇 401/预检失败自动回退 `?access_token=` 并写回 `query`。
- `TODO_TRAY_CONFIG` 环境变量可把配置指向临时文件（mock 测试用）。
- Gitee Contents API：GET 读文件（返回 base64 + sha）；POST 创建；PUT 带 sha 更新；冲突 400/409/422 重拉重试 3 次；429/403 限流退避 60s→120s→300s→600s→1200s→3600s（±20%）。
- **陷阱**：Gitee 对不存在的文件路径返回 `200 + []`（不是 404）。两端都必须把「200 且响应是数组」当作文件不存在，否则首次上传会误判为“内容损坏”而永远不创建文件。路径若真是目录，数组非空，应提示改用文件路径。
- 电脑合并云端时**只取** `my_todo_list_v2` / `my_deleted` / `my_ideas` + `__syncSeq`，绝不把手机的非任务旧快照写回电脑。
- 两端都用语义指纹（任务按 id、忽略顺序/seq/updatedAt）比较，内容相同不写 Gitee，防止回环提交。

### 8.6 Netlify / PWA 部署
1. 把 `docs/` 整个目录拖到 [Netlify Drop](https://app.netlify.com/drop)。
2. `docs/_redirects` 把 `/` 302 到 `/mobile.html`；`docs/_headers` 设置 noindex、CSP、`sw.js`/`manifest.json` 不缓存。
3. 站点建议固定名字后再安装 App；以后更新在同一站点 Deploys 页重新拖 `docs/`。
4. 手机 Chrome「安装应用」；Service Worker 只缓存同源 GET，Gitee 请求与写操作不缓存。

## 9. 验证方法（历史复用套路）

| 层 | 方法 |
|---|---|
| JS 语法 | 提取 `<script>` 内容写临时文件 → `node --check` |
| Python 语法 | `ast.parse` |
| 数据核验 | `urllib` 请求 `http://127.0.0.1:8899/api/full`，核对任务/墓碑/seq |
| 电脑网页 | 浏览器打开 `file:///D:/Desktop/个人项目/待完成目标/todo.html`，检查渲染与轮询 |
| 手机版 | 浏览器打开 Netlify 网址，或局域网 `http://<电脑IP>:8899/mobile` |
| Gitee 客户端 | mock Gitee API（GET/POST/PUT、sha 冲突、401 回退、429、中文/emoji）跑 `gitee_sync_once` |
| 静态路由 | 另起 `ThreadingHTTPServer`（非 8899）请求 `/mobile`、`/manifest.json`、`/sw.js`、`/icons/*`，核对 200 + no-cache |
| 端到端 | 电脑/手机互操作：新增/勾选/删除/思路；墓碑不复活；非任务 key 不被手机覆盖；空闲两轮后 Gitee 不再产生提交 |

### 9.1 v11 新增的自动化测试（`tests/`，用捆绑 Node 跑）
```bash
node tests/ideas_mark_test.js    # 语法解析/涂抹/擦除/相邻并块 纯逻辑（29 项）
node tests/syntax_check.js       # 抽取两个 HTML 的内联脚本做 vm.Script 语法检查
node tests/e2e_browser.js        # 电脑网页 Edge headless + CDP 真实鼠标涂抹/换色/悬停/手感/单击不误涂/拖拽内容完整/防文本选择误删（93 项，出截图）
node tests/e2e_mobile.js         # 手机版点按上色/点链接看说明/摘要去语法（28 项，出截图）
node tests/sync_format_test.js   # 同步格式回归：沙箱导入 todo_tray.py，走真实合并函数做往返断言（13 项）
```
> ⚠️ **铁律**：E2E 必须跑在**隔离副本**上（脚本已自动生成 `tests/out/sandbox*/` 并把同步地址改成不可达端口）。曾因直接对真实 `todo.html` 跑浏览器测试、而悬浮球正在运行，导致测试文本被 8s 轮询合并进真实 `my_ideas` 并自动推上了 Gitee（污染提交 `b79f9d2ea0`/seq=171，已用 `tests/restore_cloud.js` 以 seq=172 回退）。**动测试前先停掉 `todo_tray`**；同理，**不要往正在运行且开着云同步的真实悬浮球 POST 测试数据**。2026-10-21 再次发生同类事故（v12.3 手感排查时在真实页面用 bu 拖动，前 5 行染上 `[r]` 并推上云端）：恢复链路为 停悬浮球 → 本地 `todo_sync.json` 去 `[r]` 并把该记录 `ts` 置为当前（较新者胜）→ 同步修复浏览器 localStorage 并刷新 → 重启悬浮球 → 等自动同步把干净版覆盖云端 → Gitee API 回读确认 `seq` 与首行。此后凡涉及涂抹的实测一律只用隔离副本。
> `sync_format_test.js` 的做法：把 `todo_tray.py` 复制到 `tests/out/sandbox-tray/`，其 `DATA_FILE` 等路径随 `__file__` 落在沙箱内，再 `import` 并直接调用 `merge_from_web` / `merge_data` / `_normalize_cloud_payload` / `_owned_fingerprint`，既走真实代码又不碰真实数据。
> 维护用脚本（仅在事故时使用）：`clean_pollution.js`（删本地测试污染键）、`restore_cloud.js`（云端回退，含回读校验）、`diff_cloud.js`（本地与云端逐 key 对比）。

## 10. 已知问题 / 注意事项（接手必读）

1. **旧设备缓存 "推回"**：任务按 `updatedAt` 逐条合并、删除走墓碑，删除/编辑不会被旧快照覆盖；电脑从 Gitee 合并时只接受手机的三个 key，非任务 key（今日映射、计划、工作日志）始终由电脑保留。排查数据异常时，先让各端页面刷新一次，仍不对再检查 `my_deleted`。
2. **PWA 离线壳限制**：Service Worker（`sw.js`）只在 HTTPS 或 localhost 生效；Netlify 是 HTTPS，正常可用。局域网 HTTP 下 `registerSW()` 静默跳过——不影响"添加到主屏幕"，仅离线打开壳不可用。
3. **Gitee 令牌未填 / 未验证真实仓库**：设置窗「保存并测试」通过即表示令牌与仓库可用。若 Gitee 认证额度或浏览器 CORS 与预期不符，错误会显示在状态卡；同步失败只影响云端，本地功能不受影响。
4. **Token 安全**：只存 `cloud_config.json`（gitignore）和手机 localStorage；不要发聊天、不要提交、不要写进 `docs/`。泄露后在 Gitee 个人令牌页撤销即可。
5. **Netlify 站点改名/重建**：origin 变化会导致手机 localStorage 为空（可从 Gitee 拉回）。建议固定站点名，更新页面走同一站点 Deploys。
6. **数据权威层级**：电脑网页 localStorage 是本机权威；枢纽 `todo_sync.json` 是跨端权威；Gitee 是跨网络权威。清数据时：先 `taskkill /F /IM todo_tray.exe` → 改/删 `todo_sync.json` → 重启 exe（否则内存态会把旧数据写回文件）。
7. **悬浮球位置**：`todo_ball_pos.json` 记录 `{x, y, physical}`（当前第二显示器）；多显示器/分辨率变化时若球"消失"，删掉该文件重启即回到默认位置。
8. **删除终局**：`my_deleted` 墓碑不清理、不可撤销；任务重建会得到新 id。
9. **小窗渲染**：无边框/透明色依赖 Windows；非 Windows、`TODO_TRAY_NATIVE_CHROME=1` 或属性设置失败时自动回退系统标题栏。滚动/勾选/刷新/Esc/拖拽均可用，关闭时会取消 3s 定时器。
10. **开机自启**：写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `TodoTray`；frozen 写 exe 路径，开发态写 `pythonw.exe + todo_tray.py`。路径变化后重新勾选即可更新。
11. **国内网络推 GitHub**：HTTPS 推送遇 `TLS unexpected EOF` 时用 `git -c http.version=HTTP/1.1 push origin main`。
12. **执行环境**：本机 Windows；开发/验证用 `C:\Users\ASUS\AppData\Local\Programs\Python\Python313\python.exe`。
13. **到点提醒（电脑悬浮球）**：只提醒 `type=='point'`、日期=今天、未完成、且当前时间在到点后 20 分钟窗口（`REMINDER_WINDOW_MIN=20`）内的计划；检查间隔 20s（`REMINDER_POLL_SEC`）；已提醒写入 `todo_reminders.json` 防重复（删掉文件即可对同条目重新提醒）；提醒**只读** `latest_data['my_date_plans']`，不修改计划数据，也不参与三端同步。手机版同语义：30s 轮询 + `visibilitychange` 补查 + `mobile_reminded_v1` 持久化。
14. **打包 exe 必须用 Python313**（含 `pystray`）：`C:\Users\ASUS\AppData\Local\Programs\Python\Python313\python.exe -m PyInstaller --noconfirm --clean todo_tray.spec`。`C:\Python314\python.exe` 缺 `pystray`，用它打包出的 exe 启动即静默退出（8899 不监听、无任何窗口），特征：`build\todo_tray\warn-todo_tray.txt` 出现 `missing module named pystray`。

## 11. 版本历史摘要（详见 CHANGELOG.md）

| 阶段 | 内容 |
|---|---|
| v1 基础 | 纯前端单文件 todo.html：待办/日期备忘/规划/工作登记/明天要说的话，localStorage 持久化 |
| v2 悬浮球 | Python 托盘球 + 8899 数据枢纽 + 网页 8s 轮询双向同步（README 有打包说明） |
| v3 悬浮球增强 | DPI 清晰度、弹窗可吸附屏幕左右侧、打开网页主窗口按钮、勾选+进度条+滚轮滚动 |
| v4 思路侧边栏 | 按日期分页/按日期写、手动翻页记忆、修改时间悬停查看（鼠标放上去才显示，像 QQ 聊天） |
| v5 手机版+双端联动 | mobile.html + 方案A局域网自动同步 + 方案B坚果云手动同步 + syncSeq/updatedAt 冲突裁决 + 离线缓存 |
| v6 PWA | 手机版添加到主屏幕变 App（manifest + 图标 + sw.js） |
| v7 删除任务 | 手机端 ✕ 删除 + **墓碑机制**多端删除同步 |
| v8 同步回查+小窗重做 | 修复全量合并/墓碑/云端死锁/seq 心跳等 10+ 问题；小窗改为无边框圆角卡片，单例 + 3s 刷新 |
| v9 思路侧栏重做 | 电脑/手机统一为“左编辑 + 右侧日期列表（日期 + 最后修改时间）”，手动点击切换，不再按天翻页/弹日历，编辑不新增日期 |
| v10 Gitee + Netlify PWA | 校园网隔离/坚果云 CORS → 改用 Gitee 私有仓库做数据、Netlify 托管手机页；自动 120s 同步、语义指纹防回环、限流退避、401 回退、开机自启；移除手机端局域网轮询与坚果云 |
| v11 思路标记 + 悬停说明 | 思路正文内联语法 `[r]/[y]/[g]` 与 `[[文字\|说明]]`；阅读/编辑/涂抹三模式、荧光笔涂抹（手机点按）、相邻同色行自动并块且小球只在块首、悬停/点按看说明；不新增存储字段，三端同步格式不变 |
| v12/v12.1 思路交互重做 | 蜡笔选色 + 阅读/编辑同屏 + 双击链接编辑；再合并为单区域所见即所得（contenteditable） |
| v12.2 到点提醒 + 蜡笔修复 | 修复蜡笔选色面板被 `overflow:hidden` 裁剪；电脑悬浮球/手机 App 对日期规划「时间点」到点弹窗（20 分钟窗口、已提醒持久化、不依赖浏览器打开） |
| v12.3 蜡笔手感 | ①拖动中实时预览上色（`.pen-live-r/y/g`，松手才写真源）；②`mousemove` 挂 `document`，命中三级兜底（closest → elementFromPoint → y 几何），拖出编辑区再拖回不断涂、编辑区外不乱涂；③commit 重排保持 `scrollTop`；④拖出窗口 `mouseleave` 兜底提交。涂抹实机测试必须在 `tests/out/sandbox/` 隔离副本（端口 8899→19999）上进行 |
| v12.3.1 单击不误涂 | 点击/拖拽位移阈值（8px）：单击只涂按下那一行，边界手抖不再连带下一行；`penJustCommitted` 挡掉重排后 click 的二次命中。手机端点按单行不受影响 |
| v12.4 涂抹不丢内容 | 根因：点蜡笔只弹面板不进涂抹态 → 拖动变文本选择 → 误删两行。修复：点蜡笔即进涂抹态（用上次色）+ 涂抹态 `user-select:none` + mousedown/dragstart/keydown 三重 preventDefault，内容不可选中、不可被删。E2E 93 项含拖拽内容完整与防误删断言 |

## 12. Git 与协作

- 仓库：`https://github.com/lixiaobai2712/-.git`，分支 `main`，工作流：改 → 提交 → `git -c http.version=HTTP/1.1 push origin main`
- 提交历史即 CHANGELOG 各阶段，含设计决策（冲突规则、墓碑机制、PWA 取舍）。
