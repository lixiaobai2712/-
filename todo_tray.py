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

打包：pyinstaller --noconfirm --onefile --windowed --icon "可爱的阿米娅-人为修改.ico" --add-data "可爱的阿米娅-人为修改.ico;." --add-data "docs;docs" todo_tray.py
"""

import os
import sys
import json
import math
import time
import random
import ctypes
import base64
import threading
import datetime
import urllib.parse
import urllib.request
import urllib.error
import tkinter as tk
import tkinter.font as tkfont
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from PIL import Image, ImageTk, ImageDraw

try:
    import winreg
except Exception:  # 非 Windows 环境
    winreg = None

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
# Gitee 云同步配置（本地填写，gitignore；测试时可用环境变量指向临时文件）
CLOUD_CONFIG_FILE = (os.environ.get('TODO_TRAY_CONFIG') or
                     os.path.join(app_base(), 'cloud_config.json'))
# 手机 PWA 静态资源（唯一源目录 docs/，同时用于 Netlify 部署与本地 8899 服务）
DOCS_DIR = resource_path('docs')
MOBILE_FILE = resource_path(os.path.join('docs', 'mobile.html'))
MANIFEST_FILE = resource_path(os.path.join('docs', 'manifest.json'))
SW_FILE = resource_path(os.path.join('docs', 'sw.js'))
ICONS_DIR = resource_path(os.path.join('docs', 'icons'))


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


def _canon(v):
    """把 JSON 字符串/对象转成稳定的规范形式，仅用于比较（不用于存储）"""
    try:
        obj = json.loads(v) if isinstance(v, str) else v
        return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'))
    except Exception:
        return repr(v)


def _json_equal(a, b):
    """结构相等判断，避免 Python json.dumps 与 JS JSON.stringify 分隔符差异导致误判"""
    return _canon(a) == _canon(b)


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


def merge_data(incoming, notify=True):
    """合并外部提交（网页/手机）与本地数据，按 syncSeq + updatedAt 裁决。
    返回 (changed, 新seq)。notify=False 用于 Gitee 合并自身，避免同步回环唤醒。"""
    global latest_data
    with data_lock:
        local = dict(latest_data)
        try:
            in_seq = int(incoming.get('__syncSeq', 0) or 0)
        except (TypeError, ValueError):
            in_seq = 0
        local_seq = get_sync_seq(local)
        before_todos = _json_load(local.get('my_todo_list_v2'), [])
        before_deleted = _json_load(local.get('my_deleted'), {})
        before_ideas = _json_load(local.get('my_ideas'), {})
        # 任务列表：逐任务 updatedAt 合并（较新者胜）
        new_todos = merge_todo_lists(local.get('my_todo_list_v2'),
                                     incoming.get('my_todo_list_v2'))
        # 删除墓碑：合并 {id: 删除ts} 取较新，并从任务列表剔除（删除终局，不复活）
        del_map = _merge_deleted(local.get('my_deleted'), incoming.get('my_deleted'))
        new_todos = _apply_deleted(new_todos, del_map)
        local['my_deleted'] = json.dumps(del_map, ensure_ascii=False) if del_map else '{}'
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
                if k in ('__syncSeq', 'my_todo_list_v2', 'my_ideas', 'my_deleted'):
                    continue
                local[k] = v
        # 只有真实变化（结构比较）才递增计数器，避免空闲轮询把 seq 当心跳
        # 注意：my_ideas 只在本次提交真的带了该字段时才比较，
        # 否则本地缺键（None）与默认值 {} 会被误判为“有变化”
        changed = (not _json_equal(local.get('my_todo_list_v2'), before_todos) or
                   not _json_equal(local.get('my_deleted'), before_deleted) or
                   (incoming.get('my_ideas') is not None and
                    not _json_equal(local.get('my_ideas'), before_ideas)))
        seq = max(in_seq, local_seq)
        if in_seq > local_seq or changed:
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
        if notify:
            mark_local_dirty()
        return True, seq


def _push_pull_if_changed():
    """若任务列表相对 pull_state 有变化，更新 pull_state（供 todo.html 轮询）"""
    global pull_state
    try:
        todos_str = latest_data.get('my_todo_list_v2')
        if not _json_equal(todos_str, pull_state.get('payload')):
            pull_state['ver'] = int(pull_state.get('ver', 0)) + 1
            pull_state['payload'] = todos_str
            save_pull_state()
    except Exception:
        pass


def merge_from_web(incoming, notify=True):
    """网页版推送（无 __sync 标记的旧格式）：任务逐任务 updatedAt 合并，
    思路按日期 ts 合并（避免手机端更新被网页旧数据冲掉），其余 key 以网页为准覆盖。"""
    global latest_data
    with data_lock:
        local = dict(latest_data)
        # 任务列表：逐任务 updatedAt 合并
        new_todos = merge_todo_lists(local.get('my_todo_list_v2'),
                                     incoming.get('my_todo_list_v2'))
        # 删除墓碑：合并 + 剔除
        del_map = _merge_deleted(local.get('my_deleted'), incoming.get('my_deleted'))
        new_todos = _apply_deleted(new_todos, del_map)
        local['my_deleted'] = json.dumps(del_map, ensure_ascii=False)
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
            if k in ('__syncSeq', 'my_todo_list_v2', 'my_ideas', 'my_deleted'):
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
        if notify:
            mark_local_dirty()
        return True, seq


def _merge_deleted(local_raw, in_raw):
    """合并删除墓碑 {任务id: 删除时间戳}，取较新 ts"""
    local_del = _json_load(local_raw, {})
    in_del = _json_load(in_raw, {})
    merged = dict(local_del)
    for k, v in in_del.items():
        if k not in merged or (v or 0) > (merged.get(k) or 0):
            merged[k] = v
    return merged


def _apply_deleted(todos, del_map):
    """从任务列表剔除已删除的任务 id"""
    if not del_map:
        return todos
    return [t for t in todos if not (isinstance(t, dict) and t.get('id') in del_map)]


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
    if changed:
        mark_local_dirty()
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
                # 手机端提交：信封里的 __syncSeq 要注入 data，否则 seq 裁决永远不生效
                data = obj.get('data')
                data = dict(data) if isinstance(data, dict) else {}
                try:
                    data['__syncSeq'] = int(obj.get('__syncSeq', 0) or 0)
                except (TypeError, ValueError):
                    data['__syncSeq'] = 0
                _, new_seq = merge_data(data)
                self.send_response(200)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({'ok': True, 'seq': new_seq}).encode('utf-8'))
            elif isinstance(obj, dict) and obj.get('__sync'):
                # 通用增量提交（手机/网页扩展格式，兼容 {data:{...}} 包裹）
                if isinstance(obj.get('data'), dict):
                    payload = dict(obj['data'])
                    try:
                        payload['__syncSeq'] = int(obj.get('__syncSeq', 0) or 0)
                    except (TypeError, ValueError):
                        payload['__syncSeq'] = 0
                else:
                    payload = dict(obj)
                _, new_seq = merge_data(payload)
                self.send_response(200)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({'ok': True, 'seq': new_seq}).encode('utf-8'))
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
            elif path in ('/mobile', '/mobile.html'):
                # 手机版页面（docs/ 同时用于 Netlify 部署）
                if os.path.exists(MOBILE_FILE):
                    with open(MOBILE_FILE, encoding='utf-8') as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.send_header('Cache-Control', 'no-cache')
                    self.end_headers()
                    self.wfile.write(content.encode('utf-8'))
                else:
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(b'mobile.html not found')
            elif path.startswith('/manifest.json'):
                # PWA manifest（添加到主屏幕配置）
                if os.path.exists(MANIFEST_FILE):
                    with open(MANIFEST_FILE, encoding='utf-8') as fp:
                        content = fp.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/manifest+json; charset=utf-8')
                    self.send_header('Cache-Control', 'no-cache')
                    self._cors()
                    self.end_headers()
                    self.wfile.write(content.encode('utf-8'))
                else:
                    self.send_response(404)
                    self.end_headers()
            elif path.startswith('/sw.js'):
                # Service Worker（HTTPS/localhost 下离线缓存）
                if os.path.exists(SW_FILE):
                    with open(SW_FILE, encoding='utf-8') as fp:
                        content = fp.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                    self.send_header('Cache-Control', 'no-cache')
                    self.end_headers()
                    self.wfile.write(content.encode('utf-8'))
                else:
                    self.send_response(404)
                    self.end_headers()
            elif path.startswith('/icons/'):
                # PWA 图标（PNG）
                name = os.path.basename(path)
                f = os.path.join(ICONS_DIR, name)
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
        # 多线程：避免某个慢客户端阻塞电脑网页与手机端的同步
        server = ThreadingHTTPServer(('0.0.0.0', PORT), SyncHandler)
        server.daemon_threads = True
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
    """容错解析：允许传入已解析的 list/dict"""
    if isinstance(raw, (list, dict)):
        return raw
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
# 云端同步（Gitee 私有仓库 Contents API）
# ─────────────────────────────────────────────
GITEE_API_BASE = 'https://gitee.com/api/v5'


class GiteeError(Exception):
    """Gitee 同步错误，kind 用于 UI 分类：config/auth/permission/rate/notfound/conflict/parse/network/server/busy"""
    def __init__(self, kind, message, status=0, retry_after=None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status
        self.retry_after = retry_after


def load_cloud_config():
    """读取 Gitee 配置。未配置 / 旧坚果云配置返回 None。"""
    try:
        if os.path.exists(CLOUD_CONFIG_FILE):
            with open(CLOUD_CONFIG_FILE, encoding='utf-8') as f:
                d = json.load(f)
            if not isinstance(d, dict):
                return None
            if (d.get('provider', 'gitee') == 'gitee' and
                    d.get('repo') and d.get('token')):
                d.setdefault('branch', '')
                d.setdefault('path', 'sync.json')
                d.setdefault('enabled', True)
                d.setdefault('api_base', GITEE_API_BASE)
                d.setdefault('auth_mode', 'bearer')
                d.setdefault('web_url', '')
                try:
                    d['interval'] = max(60, int(d.get('interval', 120) or 120))
                except (TypeError, ValueError):
                    d['interval'] = 120
                d['path'] = str(d['path']).lstrip('/') or 'sync.json'
                return d
    except Exception:
        pass
    return None


def save_cloud_config(cfg):
    """原子写配置（临时文件 + os.replace）。"""
    try:
        tmp = CLOUD_CONFIG_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CLOUD_CONFIG_FILE)
        return True
    except Exception:
        return False


def clear_cloud_token():
    cfg = load_cloud_config()
    if cfg:
        cfg['token'] = ''
        save_cloud_config(cfg)


# ── Gitee HTTP 客户端 ──
def _repo_parts(cfg):
    repo = str(cfg.get('repo', '')).strip()
    parts = repo.split('/', 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise GiteeError('config', '仓库格式应为 owner/repo')
    return (urllib.parse.quote(parts[0], safe=''),
            urllib.parse.quote(parts[1], safe=''))


def _contents_path(cfg):
    owner, name = _repo_parts(cfg)
    path = str(cfg.get('path', 'sync.json')).lstrip('/')
    return '/repos/%s/%s/contents/%s' % (
        owner, name, urllib.parse.quote(path, safe='/'))


def _gitee_request(cfg, method, api_path, query=None, body=None, auth_mode='bearer'):
    token = cfg.get('token', '')
    base = str(cfg.get('api_base') or GITEE_API_BASE).rstrip('/')
    url = base + api_path
    q = dict(query or {})
    headers = {'Accept': 'application/json', 'User-Agent': 'todo-tray/1.0'}
    if auth_mode == 'query':
        q['access_token'] = token
    else:
        headers['Authorization'] = 'Bearer ' + token
    data = None
    if body is not None:
        b = dict(body)
        if auth_mode == 'query':
            b['access_token'] = token
        data = json.dumps(b, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    if q:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode(q)
    try:
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        try:
            text = e.read().decode('utf-8', 'replace')
        except Exception:
            text = ''
        return e.code, text
    except Exception as e:
        # 绝不把 token / 带 token 的 URL 拼进异常信息
        detail = str(getattr(e, 'reason', e))
        if token and token in detail:
            detail = detail.replace(token, '***')
        raise GiteeError('network', '网络不可用：%s' % detail)


def _gitee_call(cfg, method, api_path, query=None, body=None):
    """Bearer 优先；401 或预检失败时回退到 ?access_token= 并记住。"""
    mode = cfg.get('auth_mode', 'bearer')
    try:
        status, text = _gitee_request(cfg, method, api_path, query, body, mode)
    except GiteeError:
        if mode == 'bearer':
            status, text = _gitee_request(cfg, method, api_path, query, body, 'query')
            if status != 401:
                cfg['auth_mode'] = 'query'
                save_cloud_config(cfg)
            return status, text
        raise
    if status == 401 and mode != 'query':
        status, text = _gitee_request(cfg, method, api_path, query, body, 'query')
        if status != 401:
            cfg['auth_mode'] = 'query'
            save_cloud_config(cfg)
    return status, text


def _gitee_error(status, text):
    msg = ''
    try:
        obj = json.loads(text or '{}')
        msg = obj.get('message') or obj.get('error') or ''
    except Exception:
        msg = (text or '')[:200]
    if not msg:
        msg = 'HTTP %d' % status
    kind = 'server'
    if status == 401:
        kind = 'auth'
    elif status == 403:
        kind = 'rate' if any(w in msg.lower() for w in ('rate', 'limit', 'too many')) \
            or any(w in msg for w in ('频繁', '超过')) else 'permission'
    elif status == 404:
        kind = 'notfound'
    elif status == 429:
        kind = 'rate'
    elif status in (400, 409, 422) and (
            'sha' in msg.lower() or 'conflict' in msg.lower() or '冲突' in msg):
        kind = 'conflict'
    return GiteeError(kind, msg, status)


def gitee_repo_info(cfg):
    owner, name = _repo_parts(cfg)
    status, text = _gitee_call(cfg, 'GET', '/repos/%s/%s' % (owner, name))
    if status != 200:
        raise _gitee_error(status, text)
    try:
        return json.loads(text)
    except Exception:
        raise GiteeError('parse', 'Gitee 仓库信息解析失败')


def gitee_get_file(cfg):
    """返回 (obj, sha, branch)。文件不存在返回 (None, None, branch)。"""
    query = {'ref': cfg['branch']} if cfg.get('branch') else None
    status, text = _gitee_call(cfg, 'GET', _contents_path(cfg), query=query)
    if status == 404:
        return None, None, cfg.get('branch', '')
    if status != 200:
        raise _gitee_error(status, text)
    try:
        j = json.loads(text)
        if isinstance(j, list):
            # Gitee 对不存在的路径会返回 200 + []（而不是 404），按文件不存在处理
            if j:
                raise GiteeError('config', '云端路径是一个目录，请在设置里换成文件路径（如 sync.json）')
            return None, None, cfg.get('branch', '')
        content = j.get('content')
        if not content:
            raise ValueError('empty content')
        raw = base64.b64decode(''.join(content.split())).decode('utf-8')
        return json.loads(raw), j.get('sha'), j.get('branch') or cfg.get('branch', '')
    except GiteeError:
        raise
    except Exception:
        raise GiteeError('parse', '云端文件内容无法解析（可能过大或损坏）')


def gitee_put_file(cfg, payload, sha=None):
    """创建用 POST；更新用 PUT（带 sha）。405 时互换一次兜底。"""
    content = base64.b64encode(
        json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    ).decode('ascii')
    body = {
        'content': content,
        'message': 'todo sync: PC seq=%s' % payload.get('seq', 0),
        'branch': cfg.get('branch') or 'master',
    }
    if sha:
        body['sha'] = sha
        method = 'PUT'
    else:
        method = 'POST'

    def send(m, b):
        status, text = _gitee_call(cfg, m, _contents_path(cfg), body=b)
        if status in (200, 201):
            return True
        if status == 405:
            other = 'POST' if m == 'PUT' else 'PUT'
            status2, text2 = _gitee_call(cfg, other, _contents_path(cfg), body=b)
            if status2 in (200, 201):
                return True
            raise _gitee_error(status2, text2)
        raise _gitee_error(status, text)

    return send(method, body)


def gitee_test(cfg):
    """测试仓库/令牌，并解析默认分支。返回 (True, 提示)。"""
    info = gitee_repo_info(cfg)
    branch = cfg.get('branch') or info.get('default_branch') or 'master'
    cfg['branch'] = branch
    save_cloud_config(cfg)
    obj, _sha, _branch = gitee_get_file(cfg)
    return True, ('连接成功，云端文件已存在' if obj is not None
                  else '连接成功，首次同步会创建 sync.json')


# ── 内容指纹 / 合并 ──
def _as_json_obj(raw):
    """把 JSON 字符串/对象统一成 dict"""
    if isinstance(raw, dict):
        return raw
    return _json_load(raw, {})


def _merge_idea_maps(a, b):
    """思路按日期键合并，ts 较新者胜"""
    out = dict(a or {})
    for date, rec in (b or {}).items():
        old = out.get(date)
        if (not isinstance(old, dict) or
                (isinstance(rec, dict) and
                 (rec.get('ts') or 0) > (old.get('ts') or 0))):
            out[date] = rec
    return out


def _normalize_cloud_payload(obj):
    """把云端文件统一成 data dict（含 __syncSeq）。
    兼容：{seq, data, ideas}（新版）与旧版扁平 latest_data。"""
    if not isinstance(obj, dict):
        return None
    if isinstance(obj.get('data'), dict):
        data = dict(obj['data'])
        seq = obj.get('seq', 0)
        ideas = obj.get('ideas')
    elif 'my_todo_list_v2' in obj:
        data = dict(obj)
        seq = obj.get('__syncSeq', 0)
        ideas = None
    else:
        return None
    merged_ideas = _as_json_obj(data.get('my_ideas'))
    if isinstance(ideas, dict):
        merged_ideas = _merge_idea_maps(merged_ideas, ideas)
    data['my_ideas'] = json.dumps(merged_ideas, ensure_ascii=False)
    try:
        data['__syncSeq'] = int(seq or data.get('__syncSeq') or 0)
    except (TypeError, ValueError):
        data['__syncSeq'] = 0
    data.setdefault('my_deleted', '{}')
    return data


def _owned_fingerprint(data):
    """电脑/手机共同关心的三个 key 的语义指纹（任务按 id、忽略顺序）。"""
    out = {}
    for key in ('my_todo_list_v2', 'my_deleted', 'my_ideas'):
        default = [] if key == 'my_todo_list_v2' else {}
        v = _json_load(data.get(key), default)
        if key == 'my_todo_list_v2':
            if not isinstance(v, list):
                v = []
            by_id = {}
            for t in v:
                if isinstance(t, dict) and t.get('id'):
                    by_id[t['id']] = t
            v = [by_id[k] for k in sorted(by_id)]
        elif not isinstance(v, dict):
            v = {}
        out[key] = v
    return _canon(out)


def _has_local_data(data):
    todos = _json_load(data.get('my_todo_list_v2'), [])
    if isinstance(todos, list) and todos:
        return True
    del_map = _json_load(data.get('my_deleted'), {})
    if isinstance(del_map, dict) and del_map:
        return True
    ideas = _json_load(data.get('my_ideas'), {})
    if isinstance(ideas, dict):
        for rec in ideas.values():
            if isinstance(rec, dict) and str(rec.get('text', '')).strip():
                return True
    return False


def _merge_mobile_keys(norm):
    """只把手机负责的三个 key 合入电脑，避免手机旧快照覆盖电脑的非任务 key。"""
    payload = {}
    for k in ('my_todo_list_v2', 'my_deleted', 'my_ideas', '__syncSeq'):
        if k in norm:
            payload[k] = norm[k]
    payload.setdefault('my_deleted', '{}')
    payload.setdefault('my_ideas', '{}')
    # notify=False：这是云端合并本身，不能再触发一轮上云，否则会形成回环
    merge_data(payload, notify=False)


def _build_cloud_payload():
    """取电脑全量快照，构造 Gitee 信封 + 三个 key 的本地指纹。"""
    with data_lock:
        data = dict(latest_data)
    data.setdefault('my_deleted', '{}')
    data.setdefault('my_ideas', '{}')
    seq = get_sync_seq(data)
    data['__syncSeq'] = seq
    payload = {
        'schema': 1,
        'seq': seq,
        'updatedAt': int(time.time() * 1000),
        'data': data,
        'ideas': _as_json_obj(data.get('my_ideas')),
        # 扁平别名：兼容旧版读取方式
        'my_todo_list_v2': data.get('my_todo_list_v2', '[]'),
        'my_deleted': data.get('my_deleted', '{}'),
        'my_ideas': data.get('my_ideas', '{}'),
    }
    return payload, _owned_fingerprint(data)


def _ensure_branch(cfg):
    if cfg.get('branch'):
        return cfg['branch']
    info = gitee_repo_info(cfg)
    cfg['branch'] = info.get('default_branch') or 'master'
    save_cloud_config(cfg)
    return cfg['branch']


cloud_sync_lock = threading.Lock()
cloud_status_lock = threading.Lock()
_gitee_service = None
_reminder_service = None
_dirty_timer = None
_dirty_timer_lock = threading.Lock()
cloud_status = {
    'busy': False,
    'last_at': 0,
    'last_ok': False,
    'last_msg': '',
    'last_error': '',
    'next_at': 0,
    'next_allowed_at': 0,
    'rate_step': 0,
}


def _cloud_snapshot():
    with cloud_status_lock:
        return dict(cloud_status)


def _cloud_set(**kw):
    with cloud_status_lock:
        cloud_status.update(kw)


def _wake_cloud_service():
    svc = _gitee_service
    if svc is not None:
        try:
            svc.wake()
        except Exception:
            pass


def mark_local_dirty():
    """本地数据真的变了：10s 防抖后唤醒自动同步；距上次同步不足 30s 则顺延。"""
    global _dirty_timer
    with _dirty_timer_lock:
        if _dirty_timer is not None:
            try:
                _dirty_timer.cancel()
            except Exception:
                pass
        st = _cloud_snapshot()
        wait = 10.0
        last = st.get('last_at') or 0
        if last and time.time() - last < 30:
            wait = max(10.0, 30.0 - (time.time() - last))
        t = threading.Timer(wait, _wake_cloud_service)
        t.daemon = True
        _dirty_timer = t
        t.start()


def _cloud_record_success(msg):
    _cloud_set(busy=False, last_at=time.time(), last_ok=True, last_msg=msg,
               last_error='', next_allowed_at=0, rate_step=0)


def _cloud_record_error(err):
    now = time.time()
    kw = {'busy': False, 'last_ok': False, 'last_error': err.message}
    if err.kind == 'rate':
        delays = [60, 120, 300, 600, 1200, 3600]
        with cloud_status_lock:
            step = min(int(cloud_status.get('rate_step', 0) or 0), len(delays) - 1)
        sec = int(delays[step] * (0.8 + random.random() * 0.4))
        kw.update(rate_step=step + 1, next_allowed_at=now + sec)
        kw['last_error'] = '触发 Gitee 限流，约 %d 分钟后再试' % max(1, sec // 60)
    elif err.kind == 'auth':
        kw.update(next_allowed_at=now + 600,
                  last_error='令牌无效或已过期，请在设置里重新填写')
    elif err.kind == 'permission':
        kw.update(next_allowed_at=now + 600,
                  last_error='令牌没有仓库权限，需要勾选 projects')
    _cloud_set(**kw)


def gitee_sync_once(cfg=None):
    """单轮同步：拉取 → 只合并手机三个 key → 内容不同才推送。
    返回 (成功, 提示)。网络/权限等错误抛 GiteeError。"""
    cfg = cfg or load_cloud_config()
    if not cfg:
        raise GiteeError('config', '未配置 Gitee 仓库/令牌')
    if not cloud_sync_lock.acquire(blocking=False):
        raise GiteeError('busy', '正在同步，请稍候')
    try:
        _ensure_branch(cfg)
        remote, sha, rb = gitee_get_file(cfg)
        if rb and not cfg.get('branch'):
            cfg['branch'] = rb
            save_cloud_config(cfg)
        norm = _normalize_cloud_payload(remote) if remote is not None else None
        if remote is not None and norm is None:
            raise GiteeError('parse', '云端文件格式无法识别，已取消同步（避免覆盖）')
        if norm:
            _merge_mobile_keys(norm)
        payload, local_fp = _build_cloud_payload()
        if remote is None:
            if not _has_local_data(payload['data']):
                return False, '本地还没有数据，等待 todo.html 首次推送'
            gitee_put_file(cfg, payload, None)
            return True, '已创建 Gitee 数据文件并上传'
        if _owned_fingerprint(norm) == local_fp:
            return True, '已是最新（无需写入）'
        for attempt in range(3):
            try:
                gitee_put_file(cfg, payload, sha)
                return True, '已同步到 Gitee'
            except GiteeError as e:
                if e.kind != 'conflict' or attempt >= 2:
                    raise
                time.sleep(0.8 * (2 ** attempt) + random.random() * 0.3)
                remote, sha, _ = gitee_get_file(cfg)
                norm = _normalize_cloud_payload(remote) if remote is not None else None
                if remote is not None and norm is None:
                    raise GiteeError('parse', '云端文件格式无法识别，已取消同步（避免覆盖）')
                if norm:
                    _merge_mobile_keys(norm)
                payload, local_fp = _build_cloud_payload()
        return False, '写入冲突重试失败'
    finally:
        cloud_sync_lock.release()


class GiteeSyncService:
    """后台自动同步线程：默认 120s 轮询，限流/令牌错误时退避。"""
    def __init__(self, root):
        self.root = root
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def wake(self):
        self._wake.set()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def _loop(self):
        # 首次延迟 10s，等 todo.html 把 localStorage 推过来
        self._wake.wait(10)
        self._wake.clear()
        while not self._stop.is_set():
            cfg = load_cloud_config()
            delay = 30
            if cfg and cfg.get('enabled', True):
                now = time.time()
                st = _cloud_snapshot()
                if st.get('next_allowed_at', 0) > now:
                    delay = min(60, max(5, st['next_allowed_at'] - now))
                else:
                    _cloud_set(busy=True)
                    try:
                        ok, msg = gitee_sync_once(cfg)
                        if ok:
                            _cloud_record_success(msg)
                        else:
                            _cloud_set(busy=False, last_ok=False, last_msg=msg)
                    except GiteeError as e:
                        if e.kind != 'busy':
                            _cloud_record_error(e)
                        else:
                            _cloud_set(busy=False)
                    except Exception as e:
                        _cloud_record_error(GiteeError('network', str(e)))
                    cfg = load_cloud_config() or cfg
                    try:
                        itv = max(60, int(cfg.get('interval', 120) or 120))
                    except (TypeError, ValueError):
                        itv = 120
                    delay = int(itv * (0.9 + random.random() * 0.2))
            _cloud_set(next_at=time.time() + delay)
            self._wake.wait(delay)
            self._wake.clear()


def _run_cloud_sync(root, on_done=None, silent=False):
    """手动同步（后台线程）。silent=True 时只更新状态，不弹完成框。"""
    import tkinter.messagebox as mb
    cfg = load_cloud_config()
    if not cfg:
        if not silent:
            mb.showinfo('云同步', '还没有配置 Gitee。\n请先在「Gitee 同步设置」里填写仓库和令牌。')
            show_gitee_settings(root)
        if on_done:
            root.after(0, lambda: on_done(False, '未配置'))
        return
    st = _cloud_snapshot()
    if st.get('busy'):
        if not silent:
            mb.showinfo('云同步', '正在同步，请稍候。')
        return
    _cloud_set(busy=True, last_error='')

    def work():
        ok, msg = False, ''
        try:
            ok, msg = gitee_sync_once(cfg)
            if ok:
                _cloud_record_success(msg)
            else:
                _cloud_set(busy=False, last_ok=False, last_msg=msg)
        except GiteeError as e:
            msg = e.message
            if e.kind != 'busy':
                _cloud_record_error(e)
            else:
                _cloud_set(busy=False)
        except Exception as e:
            msg = str(e)
            _cloud_record_error(GiteeError('network', msg))

        def done():
            if not silent:
                if ok:
                    mb.showinfo('云同步', msg)
                else:
                    mb.showerror('云同步', msg)
            if on_done:
                try:
                    on_done(ok, msg)
                except Exception:
                    pass
        try:
            root.after(0, done)
        except Exception:
            pass

    threading.Thread(target=work, daemon=True).start()


# ─────────────────────────────────────────────
# 开机自启（HKCU Run）
# ─────────────────────────────────────────────
AUTOSTART_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'
AUTOSTART_NAME = 'TodoTray'


def _autostart_command():
    if getattr(sys, 'frozen', False):
        return '"%s"' % sys.executable
    pythonw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')
    if not os.path.exists(pythonw):
        pythonw = sys.executable
    return '"%s" "%s"' % (pythonw, os.path.abspath(__file__))


def is_autostart_enabled():
    if winreg is None:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY) as k:
            value, _ = winreg.QueryValueEx(k, AUTOSTART_NAME)
        return os.path.normcase(str(value)) == os.path.normcase(_autostart_command())
    except Exception:
        return False


def set_autostart(enabled):
    """返回 (成功, 提示)"""
    if winreg is None:
        return False, '当前系统不支持开机自启设置'
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY, 0,
                                winreg.KEY_SET_VALUE) as k:
            if enabled:
                winreg.SetValueEx(k, AUTOSTART_NAME, 0, winreg.REG_SZ,
                                  _autostart_command())
            else:
                try:
                    winreg.DeleteValue(k, AUTOSTART_NAME)
                except FileNotFoundError:
                    pass
        return True, '已开启开机自启' if enabled else '已关闭开机自启'
    except Exception as e:
        return False, '设置失败：%s\n可手动把程序快捷方式放入启动文件夹。' % e


# ─────────────────────────────────────────────
# 设置窗口
# ─────────────────────────────────────────────
_gitee_settings_window = None


def show_gitee_settings(root):
    """Gitee 配置窗口（单例）。已保存的令牌不回显，留空表示不修改。"""
    global _gitee_settings_window
    try:
        if _gitee_settings_window and _gitee_settings_window.winfo_exists():
            _gitee_settings_window.deiconify()
            _gitee_settings_window.lift()
            _gitee_settings_window.focus_force()
            return
    except Exception:
        pass

    import tkinter.messagebox as mb
    import webbrowser

    cfg = load_cloud_config() or {}
    top = tk.Toplevel(root)
    _gitee_settings_window = top
    top.title('Gitee 云同步设置')
    top.configure(bg='#f5f6fa')
    top.geometry('600x680')
    top.resizable(False, False)
    try:
        top.attributes('-topmost', True)
        top.after(600, lambda: top.attributes('-topmost', False))
    except Exception:
        pass

    frm = tk.Frame(top, bg='#f5f6fa', padx=22, pady=16)
    frm.pack(fill='both', expand=True)
    tk.Label(frm, text='☁️ Gitee 云同步', font=('Microsoft YaHei UI', 14, 'bold'),
             bg='#f5f6fa', fg='#3949ab').pack(anchor='w')
    tk.Label(frm, text='电脑与手机通过 Gitee 私有仓库同步；手机页面部署在 Netlify。',
             font=('Microsoft YaHei UI', 9), bg='#f5f6fa', fg='#777').pack(anchor='w', pady=(2, 8))

    repo_var = tk.StringVar(value=cfg.get('repo', ''))
    branch_var = tk.StringVar(value=cfg.get('branch', ''))
    path_var = tk.StringVar(value=cfg.get('path', 'sync.json'))
    token_var = tk.StringVar(value='')
    interval_var = tk.StringVar(value=str(cfg.get('interval', 120)))
    web_var = tk.StringVar(value=cfg.get('web_url', ''))
    autostart_var = tk.BooleanVar(value=is_autostart_enabled())
    status_var = tk.StringVar(value='未配置' if not cfg else '已配置')
    last_var = tk.StringVar(value='—')
    next_var = tk.StringVar(value='—')
    error_var = tk.StringVar(value='')

    def field(label, var, show=None, hint=None):
        tk.Label(frm, text=label, font=('Microsoft YaHei UI', 9), bg='#f5f6fa',
                 fg='#555').pack(anchor='w', pady=(7, 2))
        tk.Entry(frm, textvariable=var, show=show or '', font=('Microsoft YaHei UI', 10),
                 relief='solid', bd=1, bg='#fff').pack(fill='x')
        if hint:
            tk.Label(frm, text=hint, font=('Microsoft YaHei UI', 8), bg='#f5f6fa',
                     fg='#999').pack(anchor='w', pady=(2, 0))

    field('仓库（owner/repo）', repo_var, hint='例如 lixiaobai2712/todo-data（必须是私有仓库）')
    field('分支（留空自动识别）', branch_var, hint='通常为 master；保存并测试时会自动补全')
    field('文件路径', path_var, hint='默认 sync.json，可放在子目录如 todo/sync.json')
    token_hint = '已保存令牌，留空表示不修改' if cfg.get('token') else 'Gitee 私人令牌，权限勾选 projects'
    field('访问令牌', token_var, show='*', hint=token_hint)
    field('自动同步间隔（秒，60–3600）', interval_var)
    field('手机版网址（Netlify）', web_var, hint='部署 docs/ 到 Netlify 后填这里，例如 https://xxx.netlify.app')

    card = tk.Frame(frm, bg='#fff', highlightbackground='#e3e6f0', highlightthickness=1)
    card.pack(fill='x', pady=(10, 6))
    tk.Label(card, textvariable=status_var, font=('Microsoft YaHei UI', 10, 'bold'),
             bg='#fff', fg='#3949ab', anchor='w').pack(fill='x', padx=12, pady=(8, 2))
    tk.Label(card, textvariable=last_var, font=('Microsoft YaHei UI', 9),
             bg='#fff', fg='#666', anchor='w').pack(fill='x', padx=12)
    tk.Label(card, textvariable=next_var, font=('Microsoft YaHei UI', 9),
             bg='#fff', fg='#666', anchor='w').pack(fill='x', padx=12)
    tk.Label(card, textvariable=error_var, font=('Microsoft YaHei UI', 9),
             bg='#fff', fg='#c62828', anchor='w', justify='left',
             wraplength=520).pack(fill='x', padx=12, pady=(0, 8))

    def refresh():
        try:
            if not top.winfo_exists():
                return
        except Exception:
            return
        st = _cloud_snapshot()
        if st.get('busy'):
            status_var.set('同步中…')
        elif st.get('last_error'):
            status_var.set('同步失败')
            error_var.set(st.get('last_error', ''))
        elif st.get('last_at'):
            status_var.set('已同步')
            error_var.set('')
        elif load_cloud_config():
            status_var.set('已配置')
            error_var.set('')
        else:
            status_var.set('未配置')
            error_var.set('')
        if st.get('last_at'):
            last_var.set('上次同步：' + time.strftime('%m-%d %H:%M:%S',
                                                     time.localtime(st['last_at'])))
        else:
            last_var.set('上次同步：—')
        if st.get('next_allowed_at', 0) > time.time():
            next_var.set('等待重试：' +
                         time.strftime('%H:%M:%S', time.localtime(st['next_allowed_at'])))
        elif st.get('next_at', 0) > time.time():
            next_var.set('下次自动：' +
                         time.strftime('%H:%M:%S', time.localtime(st['next_at'])))
        else:
            next_var.set('下次自动：—')
        try:
            autostart_var.set(is_autostart_enabled())
        except Exception:
            pass
        try:
            top.after(1000, refresh)
        except Exception:
            pass

    def collect():
        repo = repo_var.get().strip()
        if not repo or repo.count('/') != 1:
            mb.showerror('Gitee 设置', '仓库格式应为 owner/repo')
            return None
        token = token_var.get().strip() or cfg.get('token', '')
        if not token:
            mb.showerror('Gitee 设置', '请填写 Gitee 访问令牌')
            return None
        try:
            interval = int(interval_var.get().strip() or '120')
        except ValueError:
            interval = 120
        interval = max(60, min(3600, interval))
        return {
            'provider': 'gitee',
            'repo': repo,
            'branch': branch_var.get().strip(),
            'path': path_var.get().strip().lstrip('/') or 'sync.json',
            'token': token,
            'interval': interval,
            'enabled': True,
            'api_base': cfg.get('api_base', GITEE_API_BASE),
            'auth_mode': cfg.get('auth_mode', 'bearer') if token == cfg.get('token') else 'bearer',
            'web_url': web_var.get().strip(),
        }

    def save_and_test():
        nonlocal cfg
        newcfg = collect()
        if not newcfg:
            return
        if not save_cloud_config(newcfg):
            mb.showerror('Gitee 设置', '保存配置失败，请检查目录权限')
            return
        cfg = newcfg
        try:
            token_var.set('')
        except Exception:
            pass
        status_var.set('已保存，正在测试连接…')

        def work():
            ok, msg = False, ''
            try:
                ok, msg = gitee_test(newcfg)
                if ok:
                    ok, msg = gitee_sync_once(newcfg)
                    if ok:
                        _cloud_record_success(msg)
                    else:
                        _cloud_set(busy=False, last_ok=False, last_msg=msg)
                else:
                    _cloud_set(busy=False, last_ok=False, last_error=msg)
            except GiteeError as e:
                msg = e.message
                _cloud_record_error(e)
            except Exception as e:
                msg = str(e)
                _cloud_record_error(GiteeError('network', msg))

            def done():
                if ok or '还没有数据' in msg:
                    mb.showinfo('Gitee 同步', msg)
                else:
                    mb.showerror('Gitee 同步', msg)
            try:
                root.after(0, done)
            except Exception:
                pass

        threading.Thread(target=work, daemon=True).start()

    def sync_now():
        _run_cloud_sync(root, on_done=lambda ok, msg: refresh(), silent=True)

    def clear_token():
        nonlocal cfg
        if not mb.askyesno('Gitee 设置', '确定清除本机保存的访问令牌吗？\n仓库/分支配置会保留。'):
            return
        clear_cloud_token()
        cfg = dict(cfg)
        cfg['token'] = ''
        token_var.set('')
        status_var.set('已清除令牌')
        error_var.set('')

    btn_row = tk.Frame(frm, bg='#f5f6fa')
    btn_row.pack(fill='x', pady=(8, 4))
    tk.Button(btn_row, text='保存并测试', command=save_and_test, bg='#5c6bc0', fg='#fff',
              activebackground='#3949ab', activeforeground='#fff', relief='flat',
              font=('Microsoft YaHei UI', 9), padx=12, pady=5).pack(side='left')
    tk.Button(btn_row, text='立即同步', command=sync_now, bg='#e8eaf6', fg='#3949ab',
              activebackground='#c5cae9', relief='flat', font=('Microsoft YaHei UI', 9),
              padx=12, pady=5).pack(side='left', padx=(8, 0))
    tk.Button(btn_row, text='打开令牌页面',
              command=lambda: webbrowser.open('https://gitee.com/profile/personal_access_tokens/new'),
              bg='#e8eaf6', fg='#3949ab', activebackground='#c5cae9', relief='flat',
              font=('Microsoft YaHei UI', 9), padx=12, pady=5).pack(side='left', padx=(8, 0))
    tk.Button(btn_row, text='清除令牌', command=clear_token, bg='#fdecea', fg='#c62828',
              activebackground='#ffcdd2', relief='flat', font=('Microsoft YaHei UI', 9),
              padx=12, pady=5).pack(side='left', padx=(8, 0))
    tk.Button(btn_row, text='关闭', command=top.destroy, bg='#eee', fg='#555',
              activebackground='#ddd', relief='flat', font=('Microsoft YaHei UI', 9),
              padx=12, pady=5).pack(side='right')

    def toggle_autostart():
        ok, msg = set_autostart(autostart_var.get())
        if not ok:
            mb.showerror('开机自启', msg)
        autostart_var.set(is_autostart_enabled())

    tk.Checkbutton(frm, text='开机自启（登录 Windows 后自动运行悬浮球）',
                   variable=autostart_var, command=toggle_autostart,
                   font=('Microsoft YaHei UI', 9), bg='#f5f6fa',
                   activebackground='#f5f6fa').pack(anchor='w', pady=(6, 0))

    top.protocol('WM_DELETE_WINDOW', lambda: (top.destroy(),))
    refresh()


# ─────────────────────────────────────────────
# 手机版访问地址提示
# ─────────────────────────────────────────────
def show_lan_hint(root):
    """显示手机版 Netlify 地址 + 局域网备用地址。"""
    import tkinter.messagebox as mb
    cfg = load_cloud_config() or {}
    web = str(cfg.get('web_url', '') or '').strip()
    ip = get_lan_ip()
    lines = []
    if web:
        lines.append('手机版（推荐，任何网络都能用）：\n%s' % web)
        lines.append('用 Chrome 打开后「安装应用 / 添加到主屏幕」，即可当 App 使用。')
    else:
        lines.append('还没有填写手机版网址。\n请先把 docs/ 部署到 Netlify，再在「Gitee 同步设置」里填写。')
    lines.append('备用（同一 WiFi）：\nhttp://%s:8899/mobile' % ip)
    mb.showinfo('手机版访问', '\n\n'.join(lines))


# ─────────────────────────────────────────────
# tkinter 小窗（无边框圆角悬浮卡片）
# ─────────────────────────────────────────────
MINI_W, MINI_H = 420, 560       # 卡片逻辑尺寸
MINI_SHADOW = 14                # 阴影留白（逻辑像素）
MINI_RADIUS = 18                # 卡片圆角
MINI_HEADER_H = 64              # 标题栏高度
MINI_FOOTER_H = 94              # 底部进度/按钮区高度
MINI_REFRESH_MS = 3000          # 数据轮询间隔
TRANSPARENT_KEY = '#ff00ff'     # 仅用于窗口挖空，UI 中禁止使用

_mini_window = None


def _round_poly(canvas, x1, y1, x2, y2, r, **kw):
    """在 Canvas 上画圆角矩形（四角圆弧采样成多边形）"""
    r = max(0, min(int(r), (x2 - x1) // 2, (y2 - y1) // 2))
    pts = []
    corners = (
        (x1 + r, y1 + r, 180, 270),   # 左上
        (x2 - r, y1 + r, 270, 360),   # 右上
        (x2 - r, y2 - r, 0, 90),      # 右下
        (x1 + r, y2 - r, 90, 180),    # 左下
    )
    for cx, cy, a0, a1 in corners:
        for i in range(7):
            a = math.radians(a0 + (a1 - a0) * i / 6.0)
            pts.extend((cx + r * math.cos(a), cy + r * math.sin(a)))
    return canvas.create_polygon(pts, **kw)


def _blend(c1, c2, t):
    """两色线性插值，用于标题栏渐变"""
    a = tuple(int(c1[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(c2[i:i + 2], 16) for i in (1, 3, 5))
    return '#%02x%02x%02x' % tuple(
        int(round(a[j] + (b[j] - a[j]) * t)) for j in range(3))


class MiniWindow:
    """悬浮球弹出的小窗：无边框圆角卡片 + 自绘任务行 / 进度条。

    native=True 时回退为系统标题栏版本（非 Windows 或属性设置失败）。
    """

    def __init__(self, root, native=False):
        self.root = root
        self.native = native
        self.scale = dpi_scale()
        self.S = lambda v: int(round(v * self.scale))
        S = self.S
        self.after_id = None
        self.last_sig = None
        self.pill_id = 0
        self._drag = False

        self.card_w, self.card_h = S(MINI_W), S(MINI_H)
        self.pad = 0 if native else S(MINI_SHADOW)
        self.total_w = self.card_w + 2 * self.pad
        self.total_h = self.card_h + 2 * self.pad
        self.card_left, self.card_top = self.pad, self.pad
        self.card_right, self.card_bottom = self.pad + self.card_w, self.pad + self.card_h
        self.header_h = S(56) if native else S(MINI_HEADER_H)
        self.footer_h = S(MINI_FOOTER_H)
        self.body_x = self.card_left + (S(12) if native else S(MINI_RADIUS))
        self.body_w = self.card_w - 2 * (self.body_x - self.card_left)
        self.body_y = self.card_top + self.header_h + S(8)
        self.footer_y = self.card_bottom - self.footer_h - S(10)
        self.body_h = self.footer_y - self.body_y - S(4)

        self.win = tk.Toplevel(root)
        self.win.title('待办事项')
        self.win.attributes('-topmost', True)
        self.win.withdraw()
        try:
            if native:
                self.win.configure(bg='#f5f6fa')
                self.win.geometry('%dx%d' % (self.card_w, self.card_h))
                self.win.resizable(False, False)
                self.win.protocol('WM_DELETE_WINDOW', self.close)
                hf = tk.Frame(self.win, bg='#5c6bc0', height=self.header_h)
                hf.pack(fill='x')
                hf.pack_propagate(False)
                tk.Label(hf, text='待办事项', bg='#5c6bc0', fg='white',
                         font=('Microsoft YaHei UI', 14, 'bold')).pack(
                    side='left', padx=S(18))
                cbtn = tk.Label(hf, text='✕', bg='#5c6bc0', fg='#e8eaf6',
                                font=('Segoe UI', 12), cursor='hand2', padx=S(10))
                cbtn.pack(side='right', padx=S(6))
                cbtn.bind('<Button-1>', lambda e: self.close())
            else:
                self.win.overrideredirect(True)
                self.win.attributes('-transparentcolor', TRANSPARENT_KEY)
                self.win.configure(bg=TRANSPARENT_KEY)
                self.win.geometry('%dx%d' % (self.total_w, self.total_h))
                self.bg = tk.Canvas(self.win, bg=TRANSPARENT_KEY,
                                    highlightthickness=0, bd=0)
                self.bg.place(x=0, y=0, width=self.total_w, height=self.total_h)
                self._draw_chrome()
                self.win.update_idletasks()
                self.win.lift()
        except tk.TclError:
            try:
                self.win.destroy()
            except Exception:
                pass
            raise

        fam = 'Microsoft YaHei UI'
        self.f_title = tkfont.Font(root=self.win, family=fam, size=11)
        self.f_done = tkfont.Font(root=self.win, family=fam, size=11, overstrike=1)
        self.f_small = tkfont.Font(root=self.win, family=fam, size=8)
        self.f_hint = tkfont.Font(root=self.win, family=fam, size=9)
        self.f_meta = tkfont.Font(root=self.win, family=fam, size=8)
        self.f_section = tkfont.Font(root=self.win, family=fam, size=10, weight='bold')
        self.f_pct = tkfont.Font(root=self.win, family=fam, size=9, weight='bold')
        self.f_btn = tkfont.Font(root=self.win, family=fam, size=9, weight='bold')
        self.f_big = tkfont.Font(root=self.win, family=fam, size=13, weight='bold')

        self.body = tk.Canvas(self.win, bg='#f5f6fa', highlightthickness=0, bd=0)
        self.body.place(x=self.body_x, y=self.body_y,
                        width=self.body_w, height=self.body_h)
        self.inner = tk.Frame(self.body, bg='#f5f6fa')
        self.inner_id = self.body.create_window((0, 0), window=self.inner, anchor='nw')
        self.inner.bind('<Configure>', self._on_inner_configure)
        self.body.bind('<Configure>', self._on_body_configure)

        self.footer = tk.Canvas(self.win, bg='#f5f6fa', highlightthickness=0, bd=0)
        self.footer.place(x=self.body_x, y=self.footer_y,
                          width=self.body_w, height=self.footer_h)
        self._build_footer()

        self.win.bind('<MouseWheel>', self._on_wheel)
        self.win.bind('<Escape>', lambda e: self.close())
        self.win.protocol('WM_DELETE_WINDOW', self.close)

    # ── 外观 ──
    def _draw_chrome(self):
        c = self.bg
        S = self.S
        x1, y1 = self.card_left, self.card_top
        x2, y2 = self.card_right, self.card_bottom
        r = S(MINI_RADIUS)
        # 投影：透明窗口无法做半透明阴影，用两层实色向右下偏移模拟
        _round_poly(c, x1 + S(1), y1 + S(4), x2 + S(6), y2 + S(7), r + S(3),
                    fill='#eceef6', outline='')
        _round_poly(c, x1 + S(1), y1 + S(2), x2 + S(3), y2 + S(4), r + S(2),
                    fill='#e0e4f0', outline='')
        # 卡片主体
        _round_poly(c, x1, y1, x2, y2, r, fill='#f5f6fa',
                    outline='#e3e6f0', width=1)
        # 标题栏渐变（顶部圆角用弦长内缩）
        hh = self.header_h
        for i in range(hh):
            t = i / max(1, hh - 1)
            inset = 0
            if i < r:
                dy = r - i
                inset = r - int(round(math.sqrt(max(0, r * r - dy * dy))))
            c.create_line(x1 + inset, y1 + i, x2 - inset, y1 + i,
                          fill=_blend('#5c6bc0', '#3949ab', t))
        # 标题与副标题
        c.create_text(x1 + r, y1 + S(23), text='待办事项', anchor='w',
                      fill='#ffffff',
                      font=('Microsoft YaHei UI', 14, 'bold'))
        c.create_text(x1 + r, y1 + S(44),
                      text='%s · 今日概览' % datetime.date.today().isoformat(),
                      anchor='w', fill='#e8eaf6',
                      font=('Microsoft YaHei UI', 8))
        # 关闭按钮
        self._cx = x2 - r - S(12)
        self._cy = y1 + S(28)
        self._cr = S(12)
        self.close_oval = c.create_oval(
            self._cx - self._cr, self._cy - self._cr,
            self._cx + self._cr, self._cy + self._cr,
            fill='', outline='', tags=('close',))
        c.create_text(self._cx, self._cy, text='✕', fill='#e8eaf6',
                      font=('Segoe UI', 11), tags=('close',))
        c.tag_bind('close', '<Button-1>', self._on_close_click)
        c.tag_bind('close', '<Enter>', lambda e: (
            c.itemconfigure(self.close_oval, fill='#7986cb'),
            c.configure(cursor='hand2')))
        c.tag_bind('close', '<Leave>', lambda e: (
            c.itemconfigure(self.close_oval, fill=''),
            c.configure(cursor='')))
        # 标题栏拖拽
        c.bind('<ButtonPress-1>', self._on_press)
        c.bind('<B1-Motion>', self._on_motion)
        c.bind('<ButtonRelease-1>', self._on_release)

    def _on_close_click(self, e):
        self.close()
        return 'break'

    def _on_press(self, e):
        if e.y > self.card_top + self.header_h:
            return
        if ((e.x - self._cx) ** 2 + (e.y - self._cy) ** 2
                <= (self._cr + self.S(4)) ** 2):
            return
        self._drag = True
        self._dx = e.x_root - self.win.winfo_x()
        self._dy = e.y_root - self.win.winfo_y()

    def _on_motion(self, e):
        if self._drag:
            self.win.geometry('+%d+%d' % (e.x_root - self._dx,
                                          e.y_root - self._dy))

    def _on_release(self, e):
        self._drag = False

    # ── 布局 ──
    def _on_inner_configure(self, e=None):
        self.body.configure(scrollregion=self.body.bbox('all') or (0, 0, 0, 0))

    def _on_body_configure(self, e):
        self.body.itemconfigure(self.inner_id, width=e.width)

    def _on_wheel(self, e):
        try:
            first, last = self.body.yview()
            if first <= 0.0 and last >= 1.0:
                return
            self.body.yview_scroll(-3 if e.delta > 0 else 3, 'units')
        except Exception:
            pass

    def _build_footer(self):
        c = self.footer
        S = self.S
        fw = self.body_w
        c.delete('all')
        self.pill(S(0), S(54), S(88), S(32), '刷新', self.refresh, False)
        self.pill(S(96), S(54), fw - S(96), S(32), '打开待办页面',
                  self.open_page, True)

    def pill(self, x, y, w, h, text, cmd, primary):
        """圆角胶囊按钮（Canvas 自绘，带 hover）"""
        c = self.footer
        tag = 'pill%d' % self.pill_id
        self.pill_id += 1
        bg = '#5c6bc0' if primary else '#e8eaf6'
        fg = '#ffffff' if primary else '#3949ab'
        hover = '#3f51b5' if primary else '#d7dcf5'
        rect = _round_poly(c, x, y, x + w, y + h, h // 2,
                           fill=bg, outline='', tags=(tag,))
        c.create_text(x + w // 2, y + h // 2, text=text,
                      fill=fg, font=self.f_btn, tags=(tag,))
        c.tag_bind(tag, '<Enter>', lambda e: (
            c.itemconfigure(rect, fill=hover), c.configure(cursor='hand2')))
        c.tag_bind(tag, '<Leave>', lambda e: (
            c.itemconfigure(rect, fill=bg), c.configure(cursor='')))
        c.tag_bind(tag, '<Button-1>', lambda e: (cmd(), 'break'))

    # ── 数据 ──
    def _read_data(self):
        with data_lock:
            return dict(latest_data)

    def _signature(self, data):
        return (datetime.date.today().isoformat(),
                _canon(data.get('my_todo_list_v2')),
                _canon(data.get('my_today_data')))

    def _draw_progress(self, todos):
        c = self.footer
        c.delete('prog')
        S = self.S
        fw = self.body_w
        total = len(todos)
        done = sum(1 for t in todos if isinstance(t, dict) and t.get('done'))
        pct = round(sum(int(t.get('progress', 0) or 0)
                        for t in todos if isinstance(t, dict)) / total) if total else 0
        c.create_text(S(2), S(8), text='总进度', anchor='w',
                      fill='#666', font=self.f_small, tags=('prog',))
        c.create_text(fw - S(2), S(8), text='%d%%' % pct, anchor='e',
                      fill='#3949ab', font=self.f_big, tags=('prog',))
        _round_poly(c, 0, S(24), fw, S(32), S(4),
                    fill='#e8e8e8', outline='', tags=('prog',))
        fill_w = int(fw * pct / 100)
        if fill_w >= S(6):
            _round_poly(c, 0, S(24), fill_w, S(32), S(4),
                        fill='#4caf50', outline='', tags=('prog',))
        c.create_text(S(2), S(40), text='已完成 %d / %d 项' % (done, total),
                      anchor='w', fill='#999', font=self.f_small, tags=('prog',))

    def _section(self, text):
        tk.Label(self.inner, text=text, bg='#f5f6fa', fg='#3949ab',
                 font=self.f_section, anchor='w').pack(
            fill='x', pady=(self.S(6), self.S(4)))

    def _hint(self, text, color='#aaa', size=8):
        tk.Label(self.inner, text=text, bg='#f5f6fa', fg=color,
                 font=self.f_small if size <= 8 else self.f_hint,
                 anchor='w', justify='left').pack(
            fill='x', pady=(self.S(2), self.S(8)))

    def _task_row(self, t):
        S = self.S
        row_h = S(58)
        row = tk.Canvas(self.inner, height=row_h, bg='#f5f6fa',
                        highlightthickness=0, bd=0, cursor='hand2')
        row.pack(fill='x', pady=(0, S(8)))
        row._hover = False
        row.bind('<Configure>', lambda e, r=row, t=t: self._draw_row(r, t, r._hover))
        row.bind('<Enter>', lambda e, r=row, t=t: self._set_hover(r, t, True))
        row.bind('<Leave>', lambda e, r=row, t=t: self._set_hover(r, t, False))
        row.bind('<Button-1>', lambda e, tid=t.get('id'): self.toggle(tid))
        self._draw_row(row, t, False)

    def _set_hover(self, row, t, hover):
        row._hover = hover
        self._draw_row(row, t, hover)

    def _draw_row(self, row, t, hover):
        row.delete('all')
        S = self.S
        w = row.winfo_width()
        if w <= 1:
            w = self.body_w
        h = S(58)
        r = S(12)
        _round_poly(row, 0, 0, w - 1, h - 1, r,
                    fill='#eef1ff' if hover else '#ffffff', outline='')

        done = bool(t.get('done'))
        prog = int(t.get('progress', 0) or 0)
        ccx, ccy, ccr = S(28), h // 2, S(12)
        if done:
            row.create_oval(ccx - ccr, ccy - ccr, ccx + ccr, ccy + ccr,
                            fill='#4caf50', outline='')
            row.create_line(ccx - S(6), ccy, ccx - S(2), ccy + S(4),
                            ccx + S(7), ccy - S(5), fill='#ffffff',
                            width=max(2, S(2)), capstyle='round',
                            joinstyle='round')
        else:
            row.create_oval(ccx - ccr, ccy - ccr, ccx + ccr, ccy + ccr,
                            fill='#ffffff', outline='#c5cae9',
                            width=max(1, S(2)))

        tx = S(52)
        max_w = max(S(40), w - tx - S(52))
        text = t.get('text') or '(无标题)'
        font = self.f_done if done else self.f_title
        row.create_text(tx, h // 2 - S(9), text=self._ellipsize(text, font, max_w),
                        anchor='w', fill='#bbb' if done else '#333', font=font)

        meta = ['已完成' if done else '未完成']
        if t.get('favorite'):
            meta.append('★')
        if t.get('note'):
            meta.append('有备注')
        if t.get('approach'):
            meta.append('有方法')
        row.create_text(tx, h // 2 + S(10), text=' · '.join(meta),
                        anchor='w', fill='#9aa0b5', font=self.f_meta)

        if done or prog > 0:
            row.create_text(w - S(14), h // 2,
                            text=('%d%%' % (100 if done else prog)),
                            anchor='e', fill='#4caf50' if done else '#3949ab',
                            font=self.f_pct)

    def _ellipsize(self, text, font, max_px):
        if font.measure(text) <= max_px:
            return text
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi) // 2
            if font.measure(text[:mid] + '…') <= max_px:
                lo = mid + 1
            else:
                hi = mid
        return text[:max(0, lo - 1)] + '…'

    # ── 渲染与刷新 ──
    def render(self, data=None, force=False):
        if data is None:
            data = self._read_data()
        sig = self._signature(data)
        if not force and sig == self.last_sig:
            return
        self.last_sig = sig
        frac = self.body.yview()[0]
        for w in self.inner.winfo_children():
            w.destroy()

        todos = _json_load(data.get('my_todo_list_v2'), [])
        if not isinstance(todos, list):
            todos = []
        todos = [t for t in todos if isinstance(t, dict)]
        today = datetime.date.today().isoformat()
        today_map = _json_load(data.get('my_today_data'), {})
        if not isinstance(today_map, dict):
            today_map = {}
        today_ids = today_map.get(today, [])
        if not isinstance(today_ids, list):
            today_ids = []
        by_id = {t.get('id'): t for t in todos if t.get('id')}
        today_tasks = [by_id[i] for i in today_ids if i in by_id]
        pending = [t for t in todos if not t.get('done')]

        if not todos:
            self._hint('还没有任务\n打开待办页面添加后会自动同步到这里。', '#999', 9)
        else:
            self._section('今日 · %s' % today)
            if today_tasks:
                for t in today_tasks[:12]:
                    self._task_row(t)
            else:
                self._hint('今日暂无任务')
            self._section('全部待办 · %d 项' % len(pending))
            if pending:
                for t in pending:
                    self._task_row(t)
            else:
                self._hint('全部完成，太棒了 🎉', '#4caf50', 9)

        self._draw_progress(todos)
        self.win.update_idletasks()
        self.body.configure(scrollregion=self.body.bbox('all') or (0, 0, 0, 0))
        try:
            self.body.yview_moveto(frac)
        except Exception:
            pass

    def tick(self):
        self.after_id = None
        if not self.alive():
            return
        try:
            self.render()
        except Exception:
            pass
        self.schedule()

    def schedule(self):
        if not self.alive():
            return
        self.after_id = self.win.after(MINI_REFRESH_MS, self.tick)

    def refresh(self):
        self.render(force=True)

    def toggle(self, task_id):
        if not task_id:
            return
        toggle_todo_done(task_id)
        self.render(force=True)

    def open_page(self):
        page = os.path.join(app_base(), 'todo.html')
        if os.path.exists(page):
            os.startfile(page)

    # ── 生命周期 ──
    def alive(self):
        try:
            return bool(self.win.winfo_exists())
        except tk.TclError:
            return False

    def show(self):
        try:
            self.win.deiconify()
            self.win.lift()
            if not self.native:
                self.win.attributes('-topmost', True)
            self._place_window()
            self.render()
            self.win.after(10, self._focus)
            if self.after_id is None:
                self.schedule()
        except tk.TclError:
            pass

    def _focus(self):
        try:
            self.win.focus_force()
        except Exception:
            pass

    def _place_window(self):
        """默认贴在悬浮球左侧、底部对齐；没有位置记录时放屏幕右上角"""
        S = self.S
        pos = load_ball_pos(self.scale)
        if pos:
            bx, by = pos
            ball = int(round(globals().get('BALL_SIZE', 64) * self.scale))
            x = bx - self.total_w - S(6)
            if x < 0:
                x = bx + ball + S(6)
            y = by + ball - self.total_h
            if y < 0:
                y = 0
        else:
            x = max(0, self.root.winfo_screenwidth() - self.total_w - S(24))
            y = S(24)
        self.win.geometry('+%d+%d' % (x, y))

    def close(self):
        if self.after_id is not None:
            try:
                self.win.after_cancel(self.after_id)
            except Exception:
                pass
            self.after_id = None
        global _mini_window
        if _mini_window is self:
            _mini_window = None
        try:
            self.win.destroy()
        except Exception:
            pass


def show_window(root):
    """弹出小窗（单例：重复调用只会把已有窗口提到最前）"""
    global _mini_window
    if _mini_window is not None:
        try:
            if _mini_window.alive():
                _mini_window.show()
                return _mini_window
        except Exception:
            pass
        _mini_window = None
    native = (sys.platform != 'win32' or
              os.environ.get('TODO_TRAY_NATIVE_CHROME') == '1')
    try:
        _mini_window = MiniWindow(root, native=native)
    except tk.TclError:
        _mini_window = MiniWindow(root, native=True)
    _mini_window.show()
    return _mini_window


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

    autostart_var = tk.BooleanVar(value=is_autostart_enabled())

    def toggle_autostart_menu():
        ok, _msg = set_autostart(autostart_var.get())
        if not ok:
            try:
                import tkinter.messagebox as mb
                mb.showerror('开机自启', _msg)
            except Exception:
                pass
        autostart_var.set(is_autostart_enabled())

    m = tk.Menu(ball, tearoff=0)
    m.add_command(label='📋 查看待办', command=lambda: show_window(root))
    m.add_command(label='🌐 打开待办页面', command=open_page)
    m.add_command(label='📱 手机版网址', command=lambda: show_lan_hint(root))
    m.add_separator()
    m.add_command(label='☁️ 立即云同步', command=lambda: _run_cloud_sync(root))
    m.add_command(label='☁️ Gitee 同步设置…', command=lambda: show_gitee_settings(root))
    m.add_checkbutton(label='🚀 开机自启', variable=autostart_var,
                      command=toggle_autostart_menu)
    m.add_separator()
    m.add_command(label='退出', command=lambda: root.after(0, root.quit))
    # 每次弹出前刷新勾选状态（设置窗/托盘里可能改过）
    m.config(postcommand=lambda: autostart_var.set(is_autostart_enabled()))

    def on_right(e):
        try:
            m.tk_popup(e.x_root, e.y_root)
        finally:
            m.grab_release()

    lbl.bind('<Button-3>', on_right)
    return ball


# ─────────────────────────────────────────────
# 到点提醒（日期规划「时间点」到点弹窗）
# ─────────────────────────────────────────────
REMINDER_FILE = os.path.join(app_base(), 'todo_reminders.json')
REMINDER_POLL_SEC = 20          # 检查间隔（秒）
REMINDER_WINDOW_MIN = 20        # 到点后 20 分钟内有效（悬浮球晚启动/错过也不漏）
_reminder_lock = threading.Lock()
_reminded = {}
_reminder_popup = None


def _load_reminded():
    global _reminded
    try:
        if os.path.exists(REMINDER_FILE):
            with open(REMINDER_FILE, encoding='utf-8') as f:
                _reminded = json.load(f)
            if not isinstance(_reminded, dict):
                _reminded = {}
    except Exception:
        _reminded = {}


def _save_reminded():
    try:
        with open(REMINDER_FILE, 'w', encoding='utf-8') as f:
            json.dump(_reminded, f, ensure_ascii=False)
    except Exception:
        pass


def due_point_plans(plans_raw, today=None, now_str=None):
    """从 my_date_plans 原文里挑出「已到点、未完成、且本次未提醒过」的时间点规划。
    返回 [(time, id, text), ...]。today='YYYY-MM-DD'、now_str='HH:MM'，缺省取当前时间，
    传固定值便于测试。"""
    import datetime as _dt
    if today is None:
        today = _dt.date.today().isoformat()
    if now_str is None:
        now_str = _dt.datetime.now().strftime('%H:%M')
    plans = _json_load(plans_raw, [])
    if not isinstance(plans, list):
        return []
    try:
        nh, nm = map(int, now_str.split(':'))
        cur = nh * 60 + nm
    except Exception:
        return []
    due = []
    for p in plans:
        if not isinstance(p, dict):
            continue
        if p.get('type') != 'point' or p.get('date') != today or p.get('done'):
            continue
        t = p.get('time')
        if not isinstance(t, str) or ':' not in t:
            continue
        try:
            th, tm = map(int, t.split(':'))
            target = th * 60 + tm
        except Exception:
            continue
        if cur < target or cur - target > REMINDER_WINDOW_MIN:
            continue
        key = '%s|%s|%s' % (today, t, p.get('id', ''))
        with _reminder_lock:
            if _reminded.get(key):
                continue
        due.append((t, p.get('id', ''), p.get('text', '')))
    return due


def show_reminder_popup(root, items):
    """非阻塞置顶弹窗：列出到点的规划。items=[(time, id, text), ...]"""
    global _reminder_popup
    try:
        if _reminder_popup is not None and _reminder_popup.winfo_exists():
            _reminder_popup.destroy()
    except Exception:
        pass
    top = tk.Toplevel(root)
    _reminder_popup = top
    top.title('⏰ 到点提醒')
    top.configure(bg='#fffbe6')
    top.resizable(False, False)
    try:
        top.attributes('-topmost', True)
        top.after(800, lambda: top.attributes('-topmost', False))
    except Exception:
        pass

    frm = tk.Frame(top, bg='#fffbe6', padx=24, pady=16)
    frm.pack(fill='both', expand=True)
    tk.Label(frm, text='⏰ 到点提醒', font=('Microsoft YaHei UI', 15, 'bold'),
             bg='#fffbe6', fg='#e65100').pack(anchor='w')
    for (t, _pid, text) in items:
        tk.Label(frm, text='%s  %s' % (t, text or '(无内容)'),
                 font=('Microsoft YaHei UI', 11), bg='#fffbe6', fg='#333',
                 justify='left', anchor='w', wraplength=380).pack(anchor='w', pady=(10, 0))

    def close():
        try:
            top.destroy()
        except Exception:
            pass

    btns = tk.Frame(frm, bg='#fffbe6')
    btns.pack(anchor='e', pady=(16, 0))
    tk.Button(btns, text='知道了', command=close, bg='#5c6bc0', fg='#fff',
              relief='flat', padx=18, pady=6, cursor='hand2',
              font=('Microsoft YaHei UI', 10)).pack(side='left')

    top.update_idletasks()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    w, h = top.winfo_reqwidth(), top.winfo_reqheight()
    top.geometry('%dx%d+%d+%d' % (w, h, max(0, (sw - w) // 2), max(0, int(sh * 0.25))))
    try:
        root.bell()
    except Exception:
        pass


class ReminderService:
    """后台提醒线程：每 20s 检查今天的时间点规划，到点弹窗（不依赖浏览器/小窗是否打开）。"""
    def __init__(self, root):
        self.root = root
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        _load_reminded()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.wait(REMINDER_POLL_SEC):
            try:
                with data_lock:
                    plans_raw = latest_data.get('my_date_plans')
                if not plans_raw:
                    continue
                due = due_point_plans(plans_raw)
                if not due:
                    continue
                # 先记已提醒（落盘防重复），再回主线程弹窗
                with _reminder_lock:
                    today = datetime.date.today().isoformat()
                    for (t, pid, _text) in due:
                        _reminded['%s|%s|%s' % (today, t, pid)] = True
                    _save_reminded()
                self.root.after(0, lambda items=due: show_reminder_popup(self.root, items))
            except Exception:
                continue


# ─────────────────────────────────────────────
# 主程序
# ─────────────────────────────────────────────
def main():
    global _gitee_service, _reminder_service
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

    # Gitee 自动同步服务
    gitee_service = GiteeSyncService(root)
    _gitee_service = gitee_service
    gitee_service.start()

    # 到点提醒服务（常驻，不依赖浏览器打开）
    reminder_service = ReminderService(root)
    _reminder_service = reminder_service
    reminder_service.start()

    def on_show(icon, item):
        root.after(0, lambda: show_window(root))

    def on_open(icon, item):
        root.after(0, lambda: os.startfile(os.path.join(app_base(), 'todo.html')))

    def on_lan(icon, item):
        root.after(0, lambda: show_lan_hint(root))

    def on_cloud(icon, item):
        root.after(0, lambda: _run_cloud_sync(root))

    def on_cloud_settings(icon, item):
        root.after(0, lambda: show_gitee_settings(root))

    def on_autostart(icon, item):
        ok, msg = set_autostart(not is_autostart_enabled())
        if not ok:
            def show_err():
                import tkinter.messagebox as mb
                mb.showerror('开机自启', msg)
            root.after(0, show_err)

    def on_quit(icon, item):
        gitee_service.stop()
        reminder_service.stop()
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
        pystray.MenuItem('📱 手机版网址', on_lan),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('☁️ 立即云同步', on_cloud),
        pystray.MenuItem('☁️ Gitee 同步设置…', on_cloud_settings),
        pystray.MenuItem('🚀 开机自启', on_autostart,
                         checked=lambda item: is_autostart_enabled()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('退出', on_quit)
    )
    icon = pystray.Icon('todo_tray', img, '待办事项', menu)
    icon.run_detached()

    root.mainloop()
    gitee_service.stop()
    reminder_service.stop()
    _gitee_service = None
    try:
        server.shutdown()
    except Exception:
        pass


if __name__ == '__main__':
    main()
