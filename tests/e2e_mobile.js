/**
 * 手机版（docs/mobile.html）思路标记 E2E —— Edge headless + CDP
 * ==========================================================
 * 安全：跑在临时副本上，并把 Gitee 接口地址改掉，绝不联网、绝不碰真实数据。
 * 运行：node tests/e2e_mobile.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const SANDBOX = path.join(OUT, 'sandbox-mobile');
fs.mkdirSync(SANDBOX, { recursive: true });

function makeSandbox() {
  let html = fs.readFileSync(path.join(ROOT, 'docs', 'mobile.html'), 'utf8');
  // 断开一切真实网络：Gitee 域名指向不可达端口
  html = html.split('https://gitee.com/api/v5').join('http://127.0.0.1:19998');
  html = html.split('https://gitee.com').join('http://127.0.0.1:19998');
  fs.writeFileSync(path.join(SANDBOX, 'mobile.html'), html, 'utf8');
  return 'file:///' + path.join(SANDBOX, 'mobile.html').replace(/\\/g, '/');
}
const PAGE = makeSandbox();

let pass = 0, fail = 0;
const check = (c, l, e) => c ? (pass++, console.log('  ✓ ' + l))
                              : (fail++, console.log('  ✗ ' + l + (e ? '\n      ' + e : '')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

(async () => {
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'mob-e2e-' + Date.now()),
    '--window-size=420,900', PAGE], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { t = (await getJson('http://127.0.0.1:' + PORT + '/json/list')).find(x => x.type === 'page' && x.webSocketDebuggerUrl); if (t) break; } catch (e) {}
  }
  if (!t) { console.log('无法连接 Edge'); edge.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const evalJs = async x => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1500);

  console.log('\n── 1. 打开思路抽屉 ──');
  check(await evalJs(`!!document.getElementById('mIdeasEditor')`), '手机端单区域编辑区存在');
  check(await evalJs(`!!document.getElementById('mIdeasPenGroup')`), '手机端画笔工具条存在');
  await evalJs(`document.getElementById('ideasToggleBtn').click(); true`);
  await sleep(400);
  check(await evalJs(`document.getElementById('ideasDrawer').classList.contains('show')`), '抽屉已打开');

  console.log('\n── 2. 写入内容并渲染 ──');
  // 模拟真实输入：编辑器里已有渲染内容（每行一个 div，含 ]]，触发同步真源+重排）
  await evalJs(`(function(){
      var ed=document.getElementById('mIdeasEditor');
      ed.innerHTML = '<div class="idea-line">[r] 急着交的报告</div><div class="idea-line">问老师 <span class="idea-link" contenteditable="false" data-raw="[[评分标准|占 40%，迟交扣 10%]]" data-tip="占 40%，迟交扣 10%">评分标准</span></div><div class="idea-line"><br></div><div class="idea-line">看剧</div><div class="idea-line">打游戏</div>';
      ed.dispatchEvent(new Event('input',{bubbles:true}));
      return true; })()`);
  await sleep(500);
  check(await evalJs(`document.getElementById('ideasTextarea').value.indexOf('[r] 急着交的报告') !== -1`), '真源同步了 [r] 语法');
  check(await evalJs(`document.querySelectorAll('#mIdeasEditor .idea-block.idea-red').length === 1`), '红块 1 块');
  check(await evalJs(`document.querySelectorAll('#mIdeasEditor .idea-ball').length === 1`), '小球 1 个');
  check(await evalJs(`document.querySelectorAll('#mIdeasEditor .idea-link').length === 1`), '说明链接 1 个');
  check(await evalJs(`!document.getElementById('mIdeasPreview')`), '单区域：无独立预览元素');

  console.log('\n── 3. 蜡笔点按打标记（手机交互）──');
  await evalJs(`document.getElementById('mIdeasCrayonBtn').click(); true`);
  await sleep(200);
  await evalJs(`document.querySelector('#mIdeasPenGroup .ideas-pen[data-color="g"]').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('mIdeasEditor').classList.contains('pen-mode')`), '涂抹态：编辑区进入画布模式');
  check(await evalJs(`document.getElementById('mIdeasPenGroup').style.display !== 'none'`), '画笔组显示');

  // 点第 4、5 行（看剧、打游戏）
  async function getMobileLineRects() {
    return JSON.parse(await evalJs(`JSON.stringify(Array.prototype.map.call(
      document.querySelectorAll('#mIdeasEditor .idea-line'), function(e){ var r=e.getBoundingClientRect();
        return { i: parseInt(e.dataset.line,10), x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; }))`));
  }
  async function tap(i) {
    // 每次点击前重取坐标（涂抹/重排后坐标会变化）
    const fresh = await getMobileLineRects();
    const p = fresh.find(l => l.i === i);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(400);
  }
  await tap(3);
  console.log('     tap3后真源:', JSON.stringify(await evalJs(`document.getElementById('ideasTextarea').value`)));
  await tap(4);
  console.log('     tap4后真源:', JSON.stringify(await evalJs(`document.getElementById('ideasTextarea').value`)));
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[g] 看剧'`), '点按第 4 行 → 上绿');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[4] === '[g] 打游戏'`), '点按第 5 行 → 上绿');
  check(await evalJs(`document.querySelectorAll('#mIdeasEditor .idea-block.idea-green').length === 1`), '相邻两行合并 1 块');
  check(await evalJs(`document.querySelectorAll('#mIdeasEditor .idea-block.idea-green .idea-ball').length === 1`), '合并块 1 个小球');
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'mobile-pen.png'), Buffer.from(shot.result.data, 'base64'));

  // 再点蜡笔退出涂抹态
  await evalJs(`document.getElementById('mIdeasCrayonBtn').click(); true`);
  await sleep(250);

  // 橡皮（重新进蜡笔选橡皮）
  await evalJs(`document.getElementById('mIdeasCrayonBtn').click(); true`);
  await sleep(200);
  await evalJs(`document.querySelector('#mIdeasPenGroup .ideas-pen[data-color="e"]').click(); true`);
  await sleep(250);
  await tap(0);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[0] === '急着交的报告'`), '橡皮点按 → 清除标记');
  await evalJs(`document.getElementById('mIdeasCrayonBtn').click(); true`);
  await sleep(200);

  console.log('\n── 4. 点链接看说明 ──');
  const lp = JSON.parse(await evalJs(`(function(){ var r=document.querySelector('#mIdeasEditor .idea-link').getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}); })()`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lp.x, y: lp.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lp.x, y: lp.y, button: 'left', clickCount: 1 });
  await sleep(500);
  check(await evalJs(`document.getElementById('mIdeaTip').classList.contains('show')`), '点链接 → 说明气泡显示');
  check(await evalJs(`document.getElementById('mIdeaTip').textContent === '占 40%，迟交扣 10%'`), '气泡内容正确');
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'mobile-tip.png'), Buffer.from(shot.result.data, 'base64'));

  console.log('\n── 5. 数据格式 ──');
  const rec = JSON.parse(await evalJs(`localStorage.getItem('mobile_ideas_v1')`) || '{}');
  const rk = Object.keys(rec)[0];
  check(rk && Object.keys(rec[rk]).sort().join(',') === 'text,ts', '记录仍只有 text,ts');
  check(rec[rk].text.indexOf('[g] 看剧') !== -1, '落盘含标记');

  console.log('\n── 6. 主界面思路摘要（去掉语法只显示纯文字）──');
  // 关掉抽屉，让主界面的摘要重新渲染
  await evalJs(`document.getElementById('ideasClose').click(); true`);
  await sleep(600);
  const summary = await evalJs(`document.getElementById('ideasSummary').textContent`);
  check(typeof summary === 'string' && summary.length > 0, '摘要已渲染：' + JSON.stringify(String(summary).slice(0, 50)));
  check(summary.indexOf('[g]') === -1 && summary.indexOf('[r]') === -1, '摘要不含标记语法');
  check(summary.indexOf('[[') === -1 && summary.indexOf(']]') === -1, '摘要不含说明语法');
  check(summary.indexOf('评分标准') !== -1, '摘要保留了说明的显示文字');

  console.log('\n── 7. 到点提醒（时间点规划）──');
  const hmNow = await evalJs(`(function(){ var d=new Date(); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); })()`);
  const todayNow = await evalJs(`(function(){ var d=new Date(); return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); })()`);
  // 注入今天当前时刻的一条时间点规划（my_date_plans 必须存 JSON 字符串）
  await evalJs(`(function(){
    var plans = JSON.stringify([{id:'e2e-remind', type:'point', date:${JSON.stringify(todayNow)}, time:${JSON.stringify(hmNow)}, text:'E2E 到点提醒', done:false}]);
    localStorage.setItem('mobile_todo_cache_v1', JSON.stringify({seq:0, data:{my_date_plans: plans}}));
    return true; })()`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  // 确定性驱动真实代码路径：页面回到前台时 visibilitychange → checkReminders 立即补查
  await evalJs(`document.dispatchEvent(new Event('visibilitychange')); true`);
  await sleep(600);
  const shown1 = await evalJs(`document.getElementById('remindModal').classList.contains('show')`);
  check(shown1, '到点后弹出提醒（注入 ' + todayNow + ' ' + hmNow + '）');
  if (shown1) {
    check((await evalJs(`document.getElementById('remindText').textContent`)).indexOf('E2E 到点提醒') !== -1, '弹窗内容含规划文本');
    await evalJs(`document.getElementById('remindOk').click(); true`);
    await sleep(300);
    check(!(await evalJs(`document.getElementById('remindModal').classList.contains('show')`)), '点「知道了」关闭弹窗');
    check((await evalJs(`localStorage.getItem('mobile_reminded_v1')`)).indexOf('e2e-remind') !== -1, '已提醒状态落盘');
  }
  // 防重复：再次触发补查，已提醒的不应再弹
  await evalJs(`document.dispatchEvent(new Event('visibilitychange')); true`);
  await sleep(600);
  check(!(await evalJs(`document.getElementById('remindModal').classList.contains('show')`)), '已提醒的规划不重复弹');

  console.log('\n────────────────────────');
  console.log(fail === 0 ? ('手机端全部通过：' + pass + ' 项') : (pass + ' 通过 / ' + fail + ' 失败'));
  try { ws.close(); } catch (e) {}
  edge.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试出错:', e && e.message); process.exit(1); });
