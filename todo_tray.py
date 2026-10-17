# -*- coding: utf-8 -*-
"""
待办悬浮球 — 桌面端伴侣程序
================================
配套 todo.html 使用：
  1. 本程序启动后，在桌面右下角显示一个圆形悬浮球（阿米娅，可拖拽到任意位置）
  2. 后台监听本机 8899 端口，接收 todo.html 定时推送的 localStorage 数据
  3. 左键单击悬浮球 → 弹出小窗展示「今日任务 + 待办列表 + 进度」
  4. 右键悬浮球 → 查看待办 / 打开待办页面 / 退出
  5. 系统托盘保留小球图标作为兜底入口

打包：pyinstaller --noconfirm --onefile --windowed --icon "可爱的阿米娅-人为修改.ico" --add-data "可爱的阿米娅-人为修改.ico;." todo_tray.py
"""

import os
import sys
import json
import ctypes
import threading
import datetime
import tkinter as tk
from http.server import HTTPServer, BaseHTTPRequestHandler
from PIL import Image, ImageTk, ImageDraw

# ─────────────────────────────────────────────
# 路径与常量
# ─────────────────────────────────────────────
PORT = 8899  # 与 todo.html 中 TRAY_SYNC_URL 保持一致


def app_base():
    """程序所在目录：打包后为 exe 目录，开发时为脚本目录"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def resource_path(name):
    """定位资源文件：优先 exe 同目录，其次 PyInstaller 解包临时目录"""
    candidates = []
    if getattr(sys, 'frozen', False):
        candidates.append(os.path.join(os.path.dirname(sys.executable), name))
        candidates.append(os.path.join(getattr(sys, '_MEIPASS', ''), name))
    candidates.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), name))
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return candidates[0] if candidates else name


DATA_FILE = os.path.join(app_base(), 'todo_sync.json')
PULL_STATE_FILE = os.path.join(app_base(), 'todo_pull.json')  # 悬浮球侧外部变更（供页面拉取）
ICON_FILE = resource_path('可爱的阿米娅-人为修改.ico')
CLOUD_CONFIG_FILE = os.path.join(app_base(), 'cloud_config.json')  # 坚果云 WebDAV 配置（手动同步用）
MOBILE_FILE = os.path.join(app_base(), 'mobile.html')  # 手机版页面


# ─────────────────────────────────────────────
# DPI 感知（解决小窗文字模糊）
# ─────────────────────────────────────────────
def enable_dpi_aware():
    """启用系统 DPI 感知，避免 tkinter 文字被位图拉伸变糊"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # System DPI aware
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def apply_tk_scaling(root):
    """设置 Tk 的 DPI scaling，让控件自动按物理像素放大（解决文字模糊 + 尺寸适配）"""
    try:
        dpi = ctypes.windll.user32.GetDpiForSystem()
        root.tk.call('tk', 'scaling', dpi / 72.0)
    except Exception:
        pass


def dpi_scale():
    """DPI 缩放系数（物理像素 / 逻辑像素），如 150% 缩放返回 1.5"""
    try:
        return ctypes.windll.user32.GetDpiForSystem() / 96.0
    except Exception:
        return 1.0


# ─────────────────────────────────────────────
# 数据层
# ─────────────────────────────────────────────
data_lock = threading.Lock()
latest_data = {}
pull_state = {'ver': 0, 'payload': None}  # 悬浮球侧外部变更（页面轮询拉取）


def load_saved():
    """启动时读取已同步的 JSON"""
    global latest_data
    try:
        if os.path.exists(DATA_FILE):
            with open(DATA_FILE, encoding='utf-8') as f:
                latest_data = json.load(f)
    except Exception:
        latest_data = {}


def get_sync_seq(data):
    """读取数据中的全局同步计数器（用于双端冲突裁决）"""
    try:
        return int(data.get('__syncSeq', 0) or 0)
    except Exception:
        return 0


def next_sync_seq(data):
    """把数据中的 syncSeq 递增 1 并返回新值"""
    seq = get_sync_seq(data) + 1
    data['__syncSeq'] = seq
    return seq


def ensure_updated_at(t):
    """保证任务对象有 updatedAt（缺省按 0 处理，视为最旧）"""
    if isinstance(t, dict):
        return t.get('updatedAt') if isinstance(t.get('updatedAt'), (int, float)) else 0
    return 0


def merge_todo_lists(base_raw, incoming_raw):
    """按 updatedAt 逐任务合并两份任务列表，较新者胜；syncSeq 高者优先（调用方保证）"""
    base = _json_load(base_raw, [])
    incoming = _json_load(incoming_raw, [])
    if not isinstance(base, list):
        base = []
    if not isinstance(incoming, list):
        incoming = []
    by_id = {}
    for t in base:
        if isinstance(t, dict) and t.get('id'):
            by_id[t['id']] = dict(t)
    for t in incoming:
        if isinstance(t, dict) and t.get('id'):
            tid = t['id']
            old = by_id.get(tid)
            if old is None:
                by_id[tid] = dict(t)
            elif ensure_updated_at(t) > ensure_updated_at(old):
                by_id[tid] = dict(t)
    return list(by_id.values())


def merge_data(incoming):
    """合并外部提交（网页/手机）与本地数据，按 syncSeq + updatedAt 裁决。
    返回 (changed, 新seq)。"""
    global latest_data
    with data_lock:
        local = dict(latest_data)
        in_seq = incoming.get('__syncSeq', 0)
        local_seq = get_sync_seq(local)
        # 任务列表：逐任务 updatedAt 合并（较新者胜）
        new_todos = merge_todo_lists(local.get('my_todo_list_v2'),
                                     incoming.get('my_todo_list_v2'))
        local['my_todo_list_v2'] = json.dumps(new_todos, ensure_ascii=False)
        # 思路：按日期 ts 合并（较新者胜，不依赖 seq）
        if incoming.get('my_ideas') is not None:
            local_ideas = _json_load(local.get('my_ideas'), {})
            in_ideas = _json_load(incoming.get('my_ideas'), {})
            merged_ideas = dict(local_ideas)
            for date, rec in in_ideas.items():
                old = merged_ideas.get(date)
                if not old or (rec.get('ts', 0) or 0) > (old.get('ts', 0) or 0):
                    merged_ideas[date] = rec
            local['my_ideas'] = json.dumps(merged_ideas, ensure_ascii=False)
        # 其余 key（今日/备注/计划等）：仅当提交方 seq 严格更高时整体覆盖
        # （避免手机端旧缓存覆盖电脑端新数据；手机端也不编辑这些 key）
        if in_seq > local_seq:
            for k, v in incoming.items():
                if k in ('__syncSeq', 'my_todo_list_v2', 'my_ideas'):
                    continue
                local[k] = v
        seq = max(in_seq, local_seq)
        if in_seq > local_seq or local.get('my_todo_list_v2') != incoming.get('my_todo_list_v2'):
            seq += 1
        local['__syncSeq'] = seq
        latest_data = local
        try:
            with open(DATA_FILE, 'w', encoding='utf-8') as f:
                json.dump(local, f, ensure_ascii=False)
        except Exception:
            pass
        # 外部变更也要写进 pull_state，让电脑网页轮询拉到
        _push_pull_if_changed()
        return True, seq


def _push_pull_if_changed():
    """若任务列表相对 pull_state 有变化，更新 pull_state（供 todo.html 轮询）"""
    global pull_state
    try:
        todos_str = latest_data.get('my_todo_list_v2')
        if todos_str != pull_state.get('payload'):
            pull_state['ver'] = int(pull_state.get('ver', 0)) + 1
            pull_state['payload'] = todos_str
            save_pull_state()
    except Exception:
        pass


def merge_from_web(incoming):
    """网页版推送（无 __sync 标记的旧格式）：任务逐任务 updatedAt 合并，
    思路按日期 ts 合并（避免手机端更新被网页旧数据冲掉），其余 key 以网页为准覆盖。"""
    global latest_data
    with data_lock:
        local = dict(latest_data)
        # 任务列表：逐任务 updatedAt 合并
        new_todos = merge_todo_lists(local.get('my_todo_list_v2'),
                                     incoming.get('my_todo_list_v2'))
        local['my_todo_list_v2'] = json.dumps(new_todos, ensure_ascii=False)
        # 思路：按日期 ts 合并（较新者胜）
        if incoming.get('my_ideas') is not None:
            local_ideas = _json_load(local.get('my_ideas'), {})
            in_ideas = _json_load(incoming.get('my_ideas'), {})
            merged_ideas = dict(local_ideas)
            for date, rec in in_ideas.items():
                old = merged_ideas.get(date)
                if not old or (rec.get('ts', 0) or 0) > (old.get('ts', 0) or 0):
                    merged_ideas[date] = rec
            local['my_ideas'] = json.dumps(merged_ideas, ensure_ascii=False)
        # 其余 key：网页为准覆盖（网页是这些数据的权威编辑器）
        for k, v in incoming.items():
            if k in ('__syncSeq', 'my_todo_list_v2', 'my_ideas'):
                continue
            local[k] = v
        seq = get_sync_seq(local) + 1
        local['__syncSeq'] = seq
        latest_data = local
        try:
            with open(DATA_FILE, 'w', encoding='utf-8') as f:
                json.dump(local, f, ensure_ascii=False)
        except Exception:
            pass
        _push_pull_if_changed()
        return True, seq


def save_data(obj):
    """保留原接口：整体覆盖（页面首次推送 / 手工调用）。同时维护 syncSeq 递增"""
    global latest_data
    with data_lock:
        latest_data = dict(obj)
        seq = get_sync_seq(latest_data) + 1
        latest_data['__syncSeq'] = seq
        try:
            with open(DATA_FILE, 'w', encoding='utf-8') as f:
                json.dump(latest_data, f, ensure_ascii=False)
        except Exception:
            pass


def load_pull_state():
    global pull_state
    try:
        if os.path.exists(PULL_STATE_FILE):
            with open(PULL_STATE_FILE, encoding='utf-8') as f:
                pull_state = json.load(f)
    except Exception:
        pull_state = {'ver': 0, 'payload': None}


def save_pull_state():
    try:
        with open(PULL_STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(pull_state, f, ensure_ascii=False)
    except Exception:
        pass


def toggle_todo_done(task_id):
    """勾选/取消勾选一个任务：改 done（勾选完成时 progress=100，与网页版一致），并写入 pull 状态供页面拉取"""
    global latest_data, pull_state
    with data_lock:
        raw = latest_data.get('my_todo_list_v2')
        todos = _json_load(raw, [])
        changed = False
        for t in todos:
            if isinstance(t, dict) and t.get('id') == task_id:
                t['done'] = not t.get('done', False)
                if t['done']:
                    t['progress'] = 100
                t['updatedAt'] = int(datetime.datetime.now().timestamp() * 1000)  # 参与双端裁决
                changed = True
                break
        if changed:
            latest_data['my_todo_list_v2'] = json.dumps(todos, ensure_ascii=False)
            next_sync_seq(latest_data)  # 全局计数器 +1，作为权威版本
            try:
                with open(DATA_FILE, 'w', encoding='utf-8') as f:
                    json.dump(latest_data, f, ensure_ascii=False)
            except Exception:
                pass
            # 记录外部变更，供 todo.html 轮询拉取后写回 localStorage
            pull_state['ver'] = int(pull_state.get('ver', 0)) + 1
            pull_state['payload'] = latest_data.get('my_todo_list_v2')
            save_pull_state()
    return changed


# ─────────────────────────────────────────────
# HTTP 服务：电脑网页 + 手机版 的数据枢纽（监听 0.0.0.0，局域网可访问）
# ─────────────────────────────────────────────
class SyncHandler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode('utf-8')
            obj = json.loads(body)
            if isinstance(obj, dict) and obj.get('__mobile'):
                # 手机端提交：带 syncSeq 与全量数据 → 按冲突裁决合并
                seq = merge_data(obj.get('data', {}))
                self.send_response(200)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({'ok': True, 'seq': seq[1]}).encode('utf-8'))
            elif isinstance(obj, dict) and obj.get('__sync'):
                # 通用增量提交（手机/网页扩展格式）
                seq = merge_data(obj)
                self.send_response(200)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({'ok': True, 'seq': seq[1]}).encode('utf-8'))
            else:
                # 网页版原始推送（无标记）：走 merge_from_web，避免冲掉手机端更新
                merge_from_web(obj)
                self.send_response(200)
                self._cors()
                self.end_headers()
                self.wfile.write(b'ok')
        except Exception as e:
            self.send_response(500)
            self._cors()
            self.end_headers()
            self.wfile.write(('err: %s' % e).encode('utf-8'))

    def do_GET(self):
        try:
            path = self.path.split('?')[0]
            if path.startswith('/api/pull'):
                # todo.html 轮询悬浮球侧的外部变更（勾选等）
                with data_lock:
                    resp = json.dumps({'ver': int(pull_state.get('ver', 0)),
                                       'payload': pull_state.get('payload')}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self._cors()
                self.end_headers()
                self.wfile.write(resp)
            elif path.startswith('/api/full'):
                # 手机版拉取全量数据 + syncSeq
                with data_lock:
                    resp = json.dumps({'seq': get_sync_seq(latest_data),
                                       'data': latest_data}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self._cors()
                self.end_headers()
                self.wfile.write(resp)
            elif path.startswith('/mobile'):
                # 手机版页面
                if os.path.exists(MOBILE_FILE):
                    with open(MOBILE_FILE, encoding='utf-8') as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(content.encode('utf-8'))
                else:
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(b'mobile.html not found')
            elif path.startswith('/manifest.json'):
                # PWA manifest（添加到主屏幕配置）
                f = os.path.join(app_base(), 'manifest.json')
                if os.path.exists(f):
                    with open(f, encoding='utf-8') as fp:
                        content = fp.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/manifest+json; charset=utf-8')
                    self._cors()
                    self.end_headers()
                    self.wfile.write(content.encode('utf-8'))
                else:
                    self.send_response(404)
                    self.end_headers()
            elif path.startswith('/sw.js'):
                # Service Worker（HTTPS/localhost 下离线缓存）
                f = os.path.join(app_base(), 'sw.js')
                if os.path.exists(f):
                    with open(f, encoding='utf-8') as fp:
                        content = fp.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(content.encode('utf-8'))
                else:
                    self.send_response(404)
                    self.end_headers()
            elif path.startswith('/icons/'):
                # PWA 图标（PNG）
                name = os.path.basename(path)
                f = os.path.join(app_base(), 'icons', name)
                if os.path.exists(f):
                    with open(f, 'rb') as fp:
                        content = fp.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/png')
                    self.end_headers()
                    self.wfile.write(content)
                else:
                    self.send_response(404)
                    self.end_headers()
            elif path.startswith('/api/lanip'):
                # 查询本机局域网 IP（手机端提示用）
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({'ip': get_lan_ip()}).encode('utf-8'))
            else:
                self.send_response(404)
                self.end_headers()
        except Exception as e:
            self.send_response(500)
            self._cors()
            self.end_headers()
            self.wfile.write(('err: %s' % e).encode('utf-8'))

    def log_message(self, *args):
        pass  # 静默日志


def start_server():
    try:
        server = HTTPServer(('0.0.0.0', PORT), SyncHandler)  # 监听所有网卡，允许局域网/手机访问
    except OSError as e:
        import tkinter.messagebox as mb
        mb.showerror('待办托盘球', '端口 %d 被占用，可能已有一个托盘球在运行。\n%s' % (PORT, e))
        return None
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


# ─────────────────────────────────────────────
# 数据解析 → 展示内容
# ─────────────────────────────────────────────
def _json_load(raw, default):
    try:
        return json.loads(raw) if raw else default
    except Exception:
        return default


def build_view_text():
    """根据同步数据生成小窗展示文本"""
    with data_lock:
        data = dict(latest_data)
    if not data:
        return ('尚未收到数据\n'
                '请先打开 todo.html（同目录），\n'
                '页面会自动把数据同步到这里。')

    todos = _json_load(data.get('my_todo_list_v2'), [])
    today_map = _json_load(data.get('my_today_data'), {})
    today = datetime.date.today().isoformat()
    today_ids = today_map.get(today, [])
    if not isinstance(today_ids, list):
        today_ids = []

    by_id = {t.get('id'): t for t in todos if isinstance(t, dict) and t.get('id')}
    today_tasks = [by_id[i] for i in today_ids if i in by_id]
    today_pending = [t for t in today_tasks if not t.get('done')]
    all_pending = [t for t in todos if not t.get('done')]
    all_done = [t for t in todos if t.get('done')]

    total = len(todos)
    done_count = len(all_done)
    pct = round(sum(int(t.get('progress', 0) or 0) for t in todos) / total) if total else 0

    lines = []
    lines.append('📅 %s' % today)
    lines.append('')
    lines.append('今日任务 %d 项，未完成 %d 项' % (len(today_tasks), len(today_pending)))
    if today_pending:
        for t in today_pending[:10]:
            lines.append('  • %s' % (t.get('text') or '(无标题)'))
        if len(today_pending) > 10:
            lines.append('  … 还有 %d 项' % (len(today_pending) - 10))
    else:
        lines.append('  （今日无未完成任务 ✓）')
    lines.append('')
    lines.append('全部待办 %d 项 · 已完成 %d · 总进度 %d%%' % (total, done_count, pct))
    if all_pending:
        for t in all_pending[:15]:
            prog = int(t.get('progress', 0) or 0)
            lines.append('  [%3d%%] %s' % (prog, (t.get('text') or '(无标题)')))
        if len(all_pending) > 15:
            lines.append('  … 还有 %d 项未完成' % (len(all_pending) - 15))
    else:
        lines.append('  全部完成，太棒了 🎉')
    return '\n'.join(lines)


# ─────────────────────────────────────────────
# 局域网 IP 探测（手机访问地址用）
# ─────────────────────────────────────────────
def _is_private_ip(ip):
    parts = ip.split('.')
    if len(parts) != 4:
        return False
    try:
        a = int(parts[0]); b = int(parts[1])
    except Exception:
        return False
    if a == 10:
        return True
    if a == 192 and b == 168:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    return False


def get_lan_ip():
    """获取真实局域网 IPv4（优先 10.x / 192.168.x，跳过虚拟网卡常见段）"""
    import socket as _sk
    import subprocess as _sp
    candidates = []
    # 方法1：ipconfig 解析（最准，能区分网卡）
    try:
        out = _sp.run('ipconfig', shell=True, capture_output=True, text=True,
                      encoding='utf-8', errors='replace', timeout=20).stdout
        for line in out.splitlines():
            if 'IPv4' in line and '.' in line:
                ip = line.split(':')[-1].strip()
                if _is_private_ip(ip) and ip not in candidates:
                    candidates.append(ip)
    except Exception:
        pass
    # 方法2：UDP connect 兜底
    if not candidates:
        try:
            s = _sk.socket(_sk.AF_INET, _sk.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            ip = s.getsockname()[0]
            s.close()
            if _is_private_ip(ip):
                candidates.append(ip)
        except Exception:
            pass
    # 优先级：10.x > 192.168.x > 172.x
    for pref in ('10.', '192.168.'):
        for c in candidates:
            if c.startswith(pref):
                return c
    return candidates[0] if candidates else '127.0.0.1'


# ─────────────────────────────────────────────
# 云端同步（坚果云 WebDAV，手动触发）
# ─────────────────────────────────────────────
def load_cloud_config():
    """读取坚果云 WebDAV 配置。未配置返回 None。"""
    try:
        if os.path.exists(CLOUD_CONFIG_FILE):
            with open(CLOUD_CONFIG_FILE, encoding='utf-8') as f:
                d = json.load(f)
            if d.get('url') and d.get('user') and d.get('password'):
                return d
    except Exception:
        pass
    return None


def cloud_sync(do_upload):
    """手动云端同步：从坚果云拉取或上传 todo_sync.json。
    do_upload=True 上传，False 下载。返回 (成功, 提示文字)。"""
    import urllib.request
    cfg = load_cloud_config()
    if not cfg:
        return False, '未配置坚果云 WebDAV，请先在 cloud_config.json 填写 url/user/password'
    url = cfg['url']
    user = cfg['user']
    password = cfg['password']
    import base64
    auth = 'Basic ' + base64.b64encode(('%s:%s' % (user, password)).encode('utf-8')).decode('ascii')

    try:
        if do_upload:
            with data_lock:
                payload = json.dumps(latest_data, ensure_ascii=False).encode('utf-8')
            req = urllib.request.Request(url, data=payload, method='PUT')
            req.add_header('Authorization', auth)
            req.add_header('Content-Type', 'application/json')
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
            return True, '已上传到坚果云'
        else:
            req = urllib.request.Request(url, method='GET')
            req.add_header('Authorization', auth)
            with urllib.request.urlopen(req, timeout=30) as r:
                remote = json.loads(r.read().decode('utf-8'))
            with data_lock:
                if isinstance(remote, dict) and 'my_todo_list_v2' in remote:
                    # 按冲突裁决合并（remote 视为另一来源）
                    merge_data(remote)
                    return True, '已从坚果云拉取并合并'
                return False, '坚果云文件格式不正确'
    except Exception as e:
        return False, '云端同步失败: %s' % e


# ─────────────────────────────────────────────
# 手机版访问地址提示
# ─────────────────────────────────────────────
def show_lan_hint(root):
    """弹窗显示手机版访问地址（局域网 IP + /mobile）"""
    import tkinter.messagebox as mb
    ip = get_lan_ip()
    mb.showinfo('手机版访问', '手机连上同一 WiFi 后，浏览器打开：\n\nhttp://%s:8899/mobile\n\n（手机版可离线缓存，连不上电脑时改动会留在本地，连上后自动同步）' % ip)


# ─────────────────────────────────────────────
# tkinter 小窗
# ─────────────────────────────────────────────
def show_window(root):
    """在 tkinter 主线程中弹出小窗（由 after() 调度）
    布局：标题 → 可点击任务列表（今日+全部） → 底部进度条 → 按钮栏
    默认位置：屏幕右上角"""
    scale = dpi_scale()
    win = tk.Toplevel(root)
    win.title('待办事项')
    win.geometry('460x560')
    win.attributes('-topmost', True)
    win.configure(bg='#f5f6fa')

    # ── 默认位置：右上角（距右/上边 24 逻辑像素，避开任务栏与系统托盘）
    try:
        sw = root.winfo_screenwidth()
        sh = root.winfo_screenheight()
        x = sw - 460 - int(24 * scale)
        y = int(24 * scale)
        win.geometry('460x560+%d+%d' % (x, y))
    except Exception:
        pass

    def open_page():
        page = os.path.join(app_base(), 'todo.html')
        if os.path.exists(page):
            os.startfile(page)

    header = tk.Frame(win, bg='#5c6bc0')
    header.pack(fill='x')
    tk.Label(header, text='📋 待办事项', bg='#5c6bc0', fg='white',
             font=('Microsoft YaHei UI', 14, 'bold')).pack(pady=10)

    # ── 底部按钮栏（side='bottom' 钉底，避免被 expand 抢占成 1x1）
    btns = tk.Frame(win, bg='#f5f6fa')
    btns.pack(side='bottom', fill='x', padx=14, pady=(0, 14))
    tk.Button(btns, text='🔄 刷新', command=lambda: rerender(),
              font=('Microsoft YaHei UI', 10), bg='#e8eaf6', fg='#3949ab',
              relief='flat', padx=16, pady=6).pack(side='left')
    tk.Button(btns, text='🌐 打开待办页面', command=open_page,
              font=('Microsoft YaHei UI', 10, 'bold'), bg='#5c6bc0', fg='white',
              activebackground='#3f51b5', activeforeground='white',
              relief='flat', padx=16, pady=6).pack(side='left', padx=8)
    tk.Button(btns, text='✕ 关闭', command=win.destroy,
              font=('Microsoft YaHei UI', 10), bg='#f0f0f0', fg='#666',
              relief='flat', padx=16, pady=6).pack(side='right')

    # ── 底部进度条区（必须在正文 expand 区之前 pack，否则被挤压）
    prog_area = tk.Frame(win, bg='#f5f6fa')
    prog_area.pack(side='bottom', fill='x', padx=18, pady=(0, 10))
    prog_canvas = tk.Canvas(prog_area, height=18, bg='#f5f6fa', highlightthickness=0)
    prog_canvas.pack(fill='x')
    prog_label = tk.Label(prog_area, bg='#f5f6fa', fg='#666',
                          font=('Microsoft YaHei UI', 9), anchor='w')
    prog_label.pack(fill='x', pady=(2, 0))

    # ── 中部滚动区（任务列表，最后 pack 占中间剩余空间）
    body = tk.Frame(win, bg='#f5f6fa')
    body.pack(side='top', fill='both', expand=True, padx=14, pady=(12, 6))
    canvas = tk.Canvas(body, bg='#f5f6fa', highlightthickness=0)
    scroll = tk.Scrollbar(body, command=canvas.yview)
    list_frame = tk.Frame(canvas, bg='#f5f6fa')
    list_frame.bind('<Configure>', lambda e: canvas.configure(scrollregion=canvas.bbox('all')))
    canvas.create_window((0, 0), window=list_frame, anchor='nw')
    canvas.configure(yscrollcommand=scroll.set)
    scroll.pack(side='right', fill='y')
    canvas.pack(side='left', fill='both', expand=True)

    # ── 鼠标滚轮滚动任务列表（Canvas 默认不响应滚轮，需显式绑定并递归到所有子控件）
    def _on_wheel(e):
        try:
            if getattr(e, 'delta', 0):  # Windows
                step = -1 if e.delta > 0 else 1
                canvas.yview_scroll(step * 3, 'units')
            else:  # Linux Button-4/5
                canvas.yview_scroll(-1 if e.num == 4 else 1, 'units')
        except Exception:
            pass

    def _bind_wheel_recursive(w):
        w.bind('<MouseWheel>', _on_wheel)
        w.bind('<Button-4>', _on_wheel)
        w.bind('<Button-5>', _on_wheel)
        for c in w.winfo_children():
            _bind_wheel_recursive(c)

    _bind_wheel_recursive(canvas)

    def rerender():
        """重建任务列表 + 底部进度条"""
        # 清空列表
        for w in list_frame.winfo_children():
            w.destroy()

        with data_lock:
            data = dict(latest_data)
        if not data:
            tk.Label(list_frame, text='尚未收到数据\n请先打开 todo.html（同目录），\n页面会自动把数据同步到这里。',
                     bg='#f5f6fa', fg='#999', justify='left',
                     font=('Microsoft YaHei UI', 11)).pack(anchor='w', pady=20)
            _bind_wheel_recursive(list_frame)
            prog_canvas.delete('all')
            prog_label.configure(text='')
            return

        todos = _json_load(data.get('my_todo_list_v2'), [])
        today_map = _json_load(data.get('my_today_data'), {})
        today = datetime.date.today().isoformat()
        today_ids = today_map.get(today, [])
        if not isinstance(today_ids, list):
            today_ids = []
        by_id = {t.get('id'): t for t in todos if isinstance(t, dict) and t.get('id')}
        today_tasks = [by_id[i] for i in today_ids if i in by_id]
        today_pending = [t for t in today_tasks if not t.get('done')]
        all_done = [t for t in todos if isinstance(t, dict) and t.get('done')]
        all_pending = [t for t in todos if isinstance(t, dict) and not t.get('done')]
        total = len(todos)
        done_count = len(all_done)
        pct = round(sum(int(t.get('progress', 0) or 0) for t in todos) / total) if total else 0

        # ── 今日任务区
        sec = tk.Frame(list_frame, bg='#f5f6fa')
        sec.pack(fill='x', pady=(0, 6))
        tk.Label(sec, text='📅 今日 · %s' % today, bg='#f5f6fa', fg='#3949ab',
                 font=('Microsoft YaHei UI', 12, 'bold')).pack(anchor='w', pady=(4, 2))
        tk.Label(sec, text='今日任务 %d 项 · 未完成 %d 项' % (len(today_tasks), len(today_pending)),
                 bg='#f5f6fa', fg='#888', font=('Microsoft YaHei UI', 9)).pack(anchor='w')
        if today_tasks:
            for t in today_tasks[:12]:
                _task_row(sec, t)
        else:
            tk.Label(sec, text='  （今日暂无任务）', bg='#f5f6fa', fg='#aaa',
                     font=('Microsoft YaHei UI', 10)).pack(anchor='w', pady=2)

        # ── 分隔
        tk.Frame(list_frame, bg='#e0e0e0', height=1).pack(fill='x', pady=8)

        # ── 全部待办区
        sec2 = tk.Frame(list_frame, bg='#f5f6fa')
        sec2.pack(fill='x')
        tk.Label(sec2, text='🗂 全部待办 · %d 项' % total, bg='#f5f6fa', fg='#3949ab',
                 font=('Microsoft YaHei UI', 12, 'bold')).pack(anchor='w', pady=(4, 2))
        if all_pending:
            for t in all_pending[:15]:
                _task_row(sec2, t)
            if len(all_pending) > 15:
                tk.Label(sec2, text='  … 还有 %d 项未完成' % (len(all_pending) - 15),
                         bg='#f5f6fa', fg='#aaa', font=('Microsoft YaHei UI', 9)).pack(anchor='w', pady=2)
        elif todos:
            tk.Label(sec2, text='  ✅ 全部完成，太棒了 🎉', bg='#f5f6fa', fg='#4caf50',
                     font=('Microsoft YaHei UI', 11)).pack(anchor='w', pady=4)
        else:
            tk.Label(sec2, text='  （还没有任务）', bg='#f5f6fa', fg='#aaa',
                     font=('Microsoft YaHei UI', 10)).pack(anchor='w', pady=2)

        # ── 底部进度条
        prog_canvas.delete('all')
        w = prog_canvas.winfo_width() or 420
        h = 14
        prog_canvas.create_rectangle(0, 0, w, h, fill='#e8e8e8', outline='')
        fill_w = int(w * pct / 100)
        if fill_w > 0:
            prog_canvas.create_rectangle(0, 0, fill_w, h, fill='#4caf50', outline='')
        prog_label.configure(text='总进度 %d%% · 已完成 %d / %d 项' % (pct, done_count, total))

        # 重建后重新绑定滚轮（子控件被销毁重建，需重新绑定）
        _bind_wheel_recursive(list_frame)

    def _task_row(parent, t):
        """单个任务行：点击勾选/取消，显示完成状态与进度"""
        tid = t.get('id')
        text = t.get('text') or '(无标题)'
        done = bool(t.get('done'))
        prog = int(t.get('progress', 0) or 0)
        mark = '☑' if done else '☐'
        fg = '#bbb' if done else '#333'
        font = ('Microsoft YaHei UI', 11, 'overstrike') if done else ('Microsoft YaHei UI', 11)
        label = '%s %s' % (mark, text)
        if not done and prog > 0:
            label += '   [%d%%]' % prog
        row = tk.Button(parent, text=label, font=font, fg=fg, bg='#f5f6fa',
                        activebackground='#e8eaf6', anchor='w', relief='flat',
                        command=lambda tid=tid: _toggle(tid))
        row.pack(fill='x', pady=1)

    def _toggle(tid):
        toggle_todo_done(tid)
        rerender()

    rerender()
    win.after(5000, rerender)  # 定时刷新，跟随页面数据变化（不覆盖用户勾选后的本地视图，若页面推送会更新）


# ─────────────────────────────────────────────
# 桌面悬浮球（无边框 / 置顶 / 可拖拽 / 边缘吸附）
# ─────────────────────────────────────────────
BALL_SIZE = 64                # 悬浮球直径（逻辑像素）
BALL_POS_FILE = os.path.join(app_base(), 'todo_ball_pos.json')
SNAP_ZONE = 100               # 距屏幕左/右边缘小于该值（物理像素）时吸附


def make_ball_image(size):
    """把阿米娅图标裁剪成圆形（透明区域填充洋红，供 -transparentcolor 挖空），失败时画一个紫色圆球"""
    if os.path.exists(ICON_FILE):
        try:
            img = Image.open(ICON_FILE).convert('RGBA')
            w, h = img.size
            s = min(w, h)
            img = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
            img = img.resize((size, size), Image.LANCZOS)
        except Exception:
            img = None
    else:
        img = None

    if img is None:
        img = Image.new('RGBA', (size, size), (92, 107, 192, 255))
        d = ImageDraw.Draw(img)
        d.ellipse((0, 0, size - 1, size - 1), fill=(92, 107, 192, 255))

    # 圆形遮罩：圆形内保留原图，圆形外填洋红 #ff00ff（透明色）
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((0, 0, size - 1, size - 1), fill=255)

    # 把原图 alpha 合成到洋红底上（消除 RGBA 透明像素 → tk 会渲染成黑/白的问题）
    magenta = Image.new('RGBA', (size, size), (255, 0, 255, 255))
    magenta.paste(img, (0, 0), mask)

    # 最终结果：圆形区域=阿米娅，圆形外=纯洋红（被 transparentcolor 挖空）
    out = Image.new('RGBA', (size, size), (255, 0, 255, 255))
    out.paste(magenta, (0, 0), mask)
    return out


def load_ball_pos(scale):
    """读取记忆位置。旧文件存的是逻辑坐标，需按当前 DPI 换算成物理坐标"""
    try:
        with open(BALL_POS_FILE, encoding='utf-8') as f:
            d = json.load(f)
        x, y = int(d.get('x')), int(d.get('y'))
        if not d.get('physical'):   # 旧版本文件：逻辑坐标 → 物理坐标
            x, y = int(round(x * scale)), int(round(y * scale))
        return x, y
    except Exception:
        return None


def save_ball_pos(x, y):
    try:
        with open(BALL_POS_FILE, 'w', encoding='utf-8') as f:
            json.dump({'x': x, 'y': y, 'physical': True}, f)
    except Exception:
        pass


def create_ball(root):
    """创建悬浮球窗口，返回窗口对象"""
    apply_tk_scaling(root)
    scale = dpi_scale()
    size = int(round(BALL_SIZE * scale))   # 物理像素尺寸（150% 缩放下为 96px）
    photo = ImageTk.PhotoImage(make_ball_image(size))

    pos = load_ball_pos(scale)
    if pos:
        x, y = pos
    else:
        sw = root.winfo_screenwidth()
        sh = root.winfo_screenheight()
        x, y = sw - size - int(60 * scale), sh - size - int(110 * scale)  # 默认右下角，避开任务栏

    ball = tk.Toplevel(root)
    ball.overrideredirect(True)                     # 无边框
    ball.attributes('-topmost', True)               # 置顶
    ball.attributes('-transparentcolor', '#ff00ff')  # 洋红=透明（Windows）
    ball.geometry('%dx%d+%d+%d' % (size, size, x, y))

    lbl = tk.Label(ball, image=photo, bg='#ff00ff', cursor='hand2')
    lbl.image = photo  # 防止被垃圾回收
    lbl.pack()

    # 关键时序：overrideredirect + transparentcolor 窗口必须先 update/lift 才会绘制内容
    ball.update()
    ball.lift()
    ball.update_idletasks()

    # ── 拖拽与单击区分 ──
    drag = {'sx': 0, 'sy': 0, 'wx': 0, 'wy': 0, 'moved': False}
    MOVE_THRESHOLD = 6

    def on_press(e):
        drag['sx'] = e.x_root
        drag['sy'] = e.y_root
        drag['wx'] = ball.winfo_x()
        drag['wy'] = ball.winfo_y()
        drag['moved'] = False

    def on_move(e):
        dx = e.x_root - drag['sx']
        dy = e.y_root - drag['sy']
        if abs(dx) > MOVE_THRESHOLD or abs(dy) > MOVE_THRESHOLD:
            drag['moved'] = True
        if drag['moved']:
            ball.geometry('+%d+%d' % (drag['wx'] + dx, drag['wy'] + dy))

    def on_release(e):
        if drag['moved']:
            x, y = ball.winfo_x(), ball.winfo_y()
            # 边缘吸附：靠近屏幕左/右边缘时贴边
            sw = root.winfo_screenwidth()
            if x <= SNAP_ZONE:
                x = 0
            elif x + size >= sw - SNAP_ZONE:
                x = sw - size
            ball.geometry('+%d+%d' % (x, y))
            save_ball_pos(x, y)
        else:
            # 单击 → 弹出任务小窗
            show_window(root)

    lbl.bind('<ButtonPress-1>', on_press)
    lbl.bind('<B1-Motion>', on_move)
    lbl.bind('<ButtonRelease-1>', on_release)

    # ── 右键菜单 ──
    def open_page():
        page = os.path.join(app_base(), 'todo.html')
        if os.path.exists(page):
            os.startfile(page)

    def cloud_menu_action(direction):
        # direction: 'up' 上传 / 'down' 下载
        ok, msg = cloud_sync(direction == 'up')
        import tkinter.messagebox as mb
        mb.showinfo('云端同步', msg)

    m = tk.Menu(ball, tearoff=0)
    m.add_command(label='📋 查看待办', command=lambda: show_window(root))
    m.add_command(label='🌐 打开待办页面', command=open_page)
    m.add_command(label='📱 手机版地址', command=lambda: show_lan_hint(root))
    m.add_separator()
    m.add_command(label='☁️ 云端上传', command=lambda: cloud_menu_action('up'))
    m.add_command(label='☁️ 云端下载', command=lambda: cloud_menu_action('down'))
    m.add_separator()
    m.add_command(label='退出', command=lambda: root.after(0, root.quit))

    def on_right(e):
        try:
            m.tk_popup(e.x_root, e.y_root)
        finally:
            m.grab_release()

    lbl.bind('<Button-3>', on_right)
    return ball


# ─────────────────────────────────────────────
# 主程序
# ─────────────────────────────────────────────
def main():
    import pystray

    enable_dpi_aware()  # 必须在创建任何窗口之前启用，否则文字被位图拉伸变糊
    load_saved()
    load_pull_state()
    server = start_server()
    if server is None:
        return

    root = tk.Tk()
    root.withdraw()  # 隐藏主窗口

    # 桌面悬浮球
    create_ball(root)

    def on_show(icon, item):
        root.after(0, lambda: show_window(root))

    def on_open(icon, item):
        root.after(0, lambda: os.startfile(os.path.join(app_base(), 'todo.html')))

    def on_lan(icon, item):
        root.after(0, lambda: show_lan_hint(root))

    def on_cloud_up(icon, item):
        root.after(0, lambda: _cloud_action('up'))

    def on_cloud_down(icon, item):
        root.after(0, lambda: _cloud_action('down'))

    def _cloud_action(direction):
        ok, msg = cloud_sync(direction == 'up')
        import tkinter.messagebox as mb
        mb.showinfo('云端同步', msg)

    def on_quit(icon, item):
        icon.stop()
        root.after(0, root.quit)

    # 托盘图标（兜底入口）
    if os.path.exists(ICON_FILE):
        img = Image.open(ICON_FILE)
    else:
        img = Image.new('RGB', (64, 64), '#5c6bc0')

    menu = pystray.Menu(
        pystray.MenuItem('📋 查看待办', on_show, default=True),
        pystray.MenuItem('🌐 打开待办页面', on_open),
        pystray.MenuItem('📱 手机版地址', on_lan),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('☁️ 云端上传', on_cloud_up),
        pystray.MenuItem('☁️ 云端下载', on_cloud_down),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('退出', on_quit)
    )
    icon = pystray.Icon('todo_tray', img, '待办事项', menu)
    icon.run_detached()

    root.mainloop()
    try:
        server.shutdown()
    except Exception:
        pass


if __name__ == '__main__':
    main()
