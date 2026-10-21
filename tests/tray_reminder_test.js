/**
 * 悬浮球「到点提醒」回归测试
 * ==============================================================
 * 直接导入真实 todo_tray.py 里的 due_point_plans / _load_reminded / _save_reminded，
 * 用固定时间验证时间点规划的判定规则（到点、未完成、窗口期、防重复）。
 * 运行：node tests/tray_reminder_test.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PY = 'C:\\Users\\ASUS\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const SANDBOX = path.join(__dirname, 'out', 'sandbox-reminder');
fs.mkdirSync(SANDBOX, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'todo_tray.py'), path.join(SANDBOX, 'todo_tray.py'));

const script = String.raw`
# -*- coding: utf-8 -*-
import json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import todo_tray as T

fails = []
def check(cond, label):
    print(('  OK  ' if cond else '  FAIL') + ' ' + label)
    if not cond: fails.append(label)

print('DATA_FILE =', T.DATA_FILE)
check(os.path.dirname(os.path.abspath(T.DATA_FILE)) == os.path.dirname(os.path.abspath(__file__)),
      'DATA_FILE 落在沙箱内（未指向真实数据）')

TODAY = '2026-10-21'

def plans(*items):
    return json.dumps(list(items), ensure_ascii=False)

def point(id, date, time, done=False, text='提醒文本'):
    return {'id': id, 'type': 'point', 'date': date, 'time': time, 'text': text, 'done': done}

def rng(id, date, text='范围'):
    return {'id': id, 'type': 'range', 'date': date, 'text': text, 'done': False}

# 每次测试前清空已提醒状态（隔离沙箱内不会写真实文件）
T._reminded = {}

print('\n-- 1. 基础判定（08:30 到点 / 08:35 检查）--')
T._reminded = {}
due = T.due_point_plans(plans(
    point('a', TODAY, '08:30', text='早会'),
    point('b', TODAY, '09:00', text='还没到'),
    point('c', TODAY, '09:40', text='还没到'),
    point('d', TODAY, '09:00', done=True, text='已完成不提醒'),
    rng('e', TODAY),
    point('f', '2026-10-20', '08:30', text='昨天的'),
), today=TODAY, now_str='08:35')
got = sorted([x[0] for x in due])
check(got == ['08:30'], '只有已到点(08:30)且未完成、在20分钟窗口内的才提醒；实际=' + str(got))
check(due[0][2] == '早会', '返回文本正确')

print('\n-- 2. 到点后 20 分钟内仍有效（错过不丢）--')
T._reminded = {}
due = T.due_point_plans(plans(point('a', TODAY, '08:30')), today=TODAY, now_str='08:49')
check(len(due) == 1, '08:30 的规划在 08:49（19分钟后）仍提醒')
T._reminded = {}
due = T.due_point_plans(plans(point('a', TODAY, '08:30')), today=TODAY, now_str='08:51')
check(len(due) == 0, '超过 20 分钟窗口（08:51）不再提醒')

print('\n-- 3. 未到点不提醒 / 非法数据安全 --')
T._reminded = {}
due = T.due_point_plans(plans(point('a', TODAY, '12:00')), today=TODAY, now_str='11:59')
check(len(due) == 0, '11:59 时 12:00 的规划不提醒')
T._reminded = {}
due = T.due_point_plans('', today=TODAY, now_str='10:00')
check(due == [], '空字符串输入安全返回 []')
due = T.due_point_plans('not json', today=TODAY, now_str='10:00')
check(due == [], '非法 JSON 输入安全返回 []')
due = T.due_point_plans(json.dumps({'a': 1}), today=TODAY, now_str='10:00')
check(due == [], '非数组输入安全返回 []')
due = T.due_point_plans(plans(point('a', TODAY, 'bad:time')), today=TODAY, now_str='10:00')
check(due == [], '时间格式非法被跳过')
due = T.due_point_plans(plans(point('a', TODAY, '')), today=TODAY, now_str='10:00')
check(due == [], '空时间被跳过')

print('\n-- 4. 防重复：已提醒过的不再弹 --')
T._reminded = {}
due = T.due_point_plans(plans(point('a', TODAY, '08:30')), today=TODAY, now_str='08:30')
check(len(due) == 1, '首次到点提醒')
# 模拟服务线程：弹窗前先记录已提醒
for (t, pid, text) in due:
    T._reminded['%s|%s|%s' % (TODAY, t, pid)] = True
due2 = T.due_point_plans(plans(point('a', TODAY, '08:30')), today=TODAY, now_str='08:31')
check(len(due2) == 0, '已提醒过的规划不重复弹')

print('\n-- 5. 已提醒状态落盘/读回（重启不重弹）--')
T._reminded = {'2026-10-21|08:30|a': True}
T._save_reminded()
T._reminded = {}
T._load_reminded()
check(T._reminded.get('2026-10-21|08:30|a') is True, 'todo_reminders.json 落盘后可读回')
print('REMINDER_FILE =', T.REMINDER_FILE)

print('')
print(('全部通过' if not fails else ('失败: ' + str(fails))))
sys.exit(0 if not fails else 1)
`;

const pyFile = path.join(SANDBOX, 'run_reminder_check.py');
fs.writeFileSync(pyFile, script, 'utf8');

const r = spawnSync(PY, [pyFile], { encoding: 'utf8', cwd: SANDBOX });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
