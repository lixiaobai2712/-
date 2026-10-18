/**
 * 同步格式回归测试：确认新的内联语法在「真实同步代码」里原样往返
 * ==============================================================
 * 目的：验证目标里「不破坏现有 my_ideas 同步格式」这一条。
 * 做法：
 *   1. 把 todo_tray.py 复制到隔离沙箱目录（其 DATA_FILE 等路径随之落在沙箱内，
 *      绝不碰真实 todo_sync.json），再用 python 导入它；
 *   2. 直接调用真实的 merge_from_web / _normalize_cloud_payload / _owned_fingerprint，
 *      把带 [r]/[[..]] 语法的思路数据走一遍合并与云端信封；
 *   3. 断言合并后正文逐字不变、日期键不变、字段仍只有 text+ts。
 * 运行：node tests/sync_format_test.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PY = 'C:\\Users\\ASUS\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const SANDBOX = path.join(__dirname, 'out', 'sandbox-tray');
fs.mkdirSync(SANDBOX, { recursive: true });

// 隔离：复制 tray 脚本到沙箱，路径随之隔离
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

# 保证沙箱隔离：确认数据文件指向沙箱，而不是真实项目目录
print('DATA_FILE =', T.DATA_FILE)
check(os.path.dirname(os.path.abspath(T.DATA_FILE)) == os.path.dirname(os.path.abspath(__file__)),
      'DATA_FILE 落在沙箱内（未指向真实数据）')

SYNTAX_TEXT = '[r] 今天必须交的实验报告\n记得问老师 [[评分标准|实验报告占平时分 40%，迟交扣 10%]]\n\n[g] 看剧\n[g] 打游戏'
rec = {'text': SYNTAX_TEXT, 'ts': 1792289318557}
ideas_json = json.dumps({'2026-10-18': rec}, ensure_ascii=False)
check(set(rec.keys()) == {'text', 'ts'}, '记录字段仍只有 text + ts')

print('\n-- 1. merge_from_web（网页旧格式推送）--')
T.latest_data = {'my_ideas': json.dumps({'2026-10-17': {'text': '旧记录', 'ts': 1}}, ensure_ascii=False),
                 'my_todo_list_v2': '[]', 'my_deleted': '{}'}
ok, seq = T.merge_from_web({'my_ideas': ideas_json, 'my_todo_list_v2': '[]'}, notify=False)
merged = json.loads(T.latest_data['my_ideas'])
got = merged.get('2026-10-18', {}).get('text')
check(got == SYNTAX_TEXT, 'merge_from_web 后正文逐字不变')
check('2026-10-17' in merged, '旧日期记录保留')
check(set(merged['2026-10-18'].keys()) == {'text', 'ts'}, '合并后字段未增未减')

print('\n-- 2. merge_data（手机/增量来路）--')
T.latest_data = {'my_ideas': '{}', 'my_todo_list_v2': '[]', 'my_deleted': '{}'}
T.merge_data({'my_ideas': ideas_json, 'my_todo_list_v2': '[]', 'my_deleted': '{}'}, notify=False)
merged2 = json.loads(T.latest_data['my_ideas'])
check(merged2.get('2026-10-18', {}).get('text') == SYNTAX_TEXT, 'merge_data 后正文逐字不变')

print('\n-- 3. 云端信封 _normalize_cloud_payload 往返 --')
data = {'my_ideas': ideas_json, 'my_todo_list_v2': '[]', 'my_deleted': '{}', '__syncSeq': 7}
envelope = {'schema': 1, 'seq': 7, 'data': data, 'ideas': json.loads(ideas_json),
            'my_todo_list_v2': '[]', 'my_deleted': '{}', 'my_ideas': ideas_json}
norm = T._normalize_cloud_payload(envelope)
check(norm is not None, '云端信封可解析')
back = json.loads(norm['my_ideas'])
check(back.get('2026-10-18', {}).get('text') == SYNTAX_TEXT, '云端往返后正文逐字不变')

print('\n-- 4. 语义指纹 _owned_fingerprint 不把语法当差异 --')
fp1 = T._owned_fingerprint({'my_ideas': ideas_json, 'my_todo_list_v2': '[]', 'my_deleted': '{}'})
fp2 = T._owned_fingerprint({'my_ideas': ideas_json, 'my_todo_list_v2': '[]', 'my_deleted': '{}'})
check(fp1 == fp2, '相同内容指纹一致（不会误判为变化、不会空转刷提交）')
fp3 = T._owned_fingerprint({'my_ideas': json.dumps({'2026-10-18': {'text': SYNTAX_TEXT + 'x', 'ts': 1}}, ensure_ascii=False),
                            'my_todo_list_v2': '[]', 'my_deleted': '{}'})
check(fp1 != fp3, '内容真变化时指纹不同')

print('\n-- 5. ts 较新者胜仍生效（语法文本不干扰裁决）--')
T.latest_data = {'my_ideas': json.dumps({'2026-10-18': {'text': '[r] 旧', 'ts': 100}}, ensure_ascii=False),
                 'my_todo_list_v2': '[]', 'my_deleted': '{}'}
T.merge_from_web({'my_ideas': ideas_json, 'my_todo_list_v2': '[]'}, notify=False)   # ts 更新
check(json.loads(T.latest_data['my_ideas'])['2026-10-18']['text'] == SYNTAX_TEXT, '新 ts 覆盖旧 ts')
T.merge_from_web({'my_ideas': json.dumps({'2026-10-18': {'text': '[g] 更旧的', 'ts': 1}}, ensure_ascii=False),
                  'my_todo_list_v2': '[]'}, notify=False)
check(json.loads(T.latest_data['my_ideas'])['2026-10-18']['text'] == SYNTAX_TEXT, '旧 ts 不会覆盖新 ts')

print('')
print(('全部通过' if not fails else ('失败: ' + str(fails))))
sys.exit(0 if not fails else 1)
`;

const pyFile = path.join(SANDBOX, 'run_sync_check.py');
fs.writeFileSync(pyFile, script, 'utf8');

const r = spawnSync(PY, [pyFile], { encoding: 'utf8', cwd: SANDBOX });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
