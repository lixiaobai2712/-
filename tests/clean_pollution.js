/**
 * 清理我这次浏览器测试造成的污染：my_ideas["2026-10-18"] 测试文本
 * ----------------------------------------------------------------
 * 只删这一个日期键，其它一律不动；操作前先备份。
 * 运行：node tests/clean_pollution.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POLLUTED_DATE = '2026-10-18';
const EXPECTED_TEST_TEXT = '[r] 今天必须交的实验报告';

const syncFile = path.join(ROOT, 'todo_sync.json');
const pullFile = path.join(ROOT, 'todo_pull.json');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bkDir = path.join(__dirname, 'out', 'cleanup_' + stamp);
fs.mkdirSync(bkDir, { recursive: true });

function backup(p) {
  fs.copyFileSync(p, path.join(bkDir, path.basename(p)));
}

// ── todo_sync.json ──
backup(syncFile);
const sync = JSON.parse(fs.readFileSync(syncFile, 'utf8'));
const ideas = JSON.parse(sync.my_ideas || '{}');
const rec = ideas[POLLUTED_DATE];

if (!rec) {
  console.log('todo_sync.json: ' + POLLUTED_DATE + ' 不存在，无需清理');
} else if (typeof rec.text !== 'string' || rec.text.indexOf(EXPECTED_TEST_TEXT) !== 0) {
  console.log('todo_sync.json: ' + POLLUTED_DATE + ' 存在但不是我的测试文本，**不删**，请人工确认：');
  console.log(JSON.stringify(rec).slice(0, 200));
  process.exitCode = 2;
} else {
  console.log('todo_sync.json: 删除 ' + POLLUTED_DATE + '（确认是测试文本：' +
              JSON.stringify(rec.text.slice(0, 30)) + '...）');
  delete ideas[POLLUTED_DATE];
  sync.my_ideas = JSON.stringify(ideas);
  fs.writeFileSync(syncFile, JSON.stringify(sync), 'utf8');
  console.log('  剩余日期: ' + Object.keys(ideas).sort().join(', '));
}

// ── todo_pull.json（悬浮球推给网页的增量，payload 是任务列表，不含思路）──
// 这里只校验它没被污染；payload 结构是任务数组
backup(pullFile);
const pull = JSON.parse(fs.readFileSync(pullFile, 'utf8'));
const payload = JSON.parse(pull.payload || '[]');
const bad = payload.filter(t => t && typeof t.text === 'string' && t.text.indexOf(EXPECTED_TEST_TEXT) === 0);
console.log('todo_pull.json: 任务 ' + payload.length + ' 条，含测试文本的 ' + bad.length + ' 条');
if (bad.length) {
  console.log('  ⚠ 发现污染任务，需处理: ' + JSON.stringify(bad.map(t => t.text)));
  process.exitCode = 2;
}

console.log('\n备份目录: ' + bkDir);
