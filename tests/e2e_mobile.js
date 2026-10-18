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
  check(await evalJs(`!!document.getElementById('mIdeasPreview')`), '手机端预览容器存在');
  check(await evalJs(`!!document.getElementById('mIdeasPenGroup')`), '手机端画笔工具条存在');
  await evalJs(`document.getElementById('ideasToggleBtn').click(); true`);
  await sleep(400);
  check(await evalJs(`document.getElementById('ideasDrawer').classList.contains('show')`), '抽屉已打开');

  console.log('\n── 2. 写入内容并渲染 ──');
  const content = '[r] 急着交的报告\n问老师 [[评分标准|占 40%，迟交扣 10%]]\n\n看剧\n打游戏';
  await evalJs(`(function(){ var ta=document.getElementById('ideasTextarea');
      ta.value = ${JSON.stringify(content)};
      ta.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await sleep(500);
  check(await evalJs(`document.querySelectorAll('#mIdeasPreview .idea-block.idea-red').length === 1`), '红块 1 块');
  check(await evalJs(`document.querySelectorAll('#mIdeasPreview .idea-ball').length === 1`), '小球 1 个');
  check(await evalJs(`document.querySelectorAll('#mIdeasPreview .idea-link').length === 1`), '说明链接 1 个');

  console.log('\n── 3. 点按打标记（手机交互）──');
  await evalJs(`document.querySelector('.ideas-pen[data-color="g"]').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideasTextarea').style.display === 'none'`), '标记模式隐藏编辑框');
  check(await evalJs(`document.getElementById('mIdeasPenGroup').style.display !== 'none'`), '画笔组显示');

  // 点第 4、5 行（看剧、打游戏）
  const lines = JSON.parse(await evalJs(`JSON.stringify(Array.prototype.map.call(
      document.querySelectorAll('#mIdeasPreview .idea-line'), function(e){ var r=e.getBoundingClientRect();
        return { i: parseInt(e.dataset.line,10), x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; }))`));
  async function tap(i) {
    const p = lines.find(l => l.i === i);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(400);
  }
  await tap(3);
  await tap(4);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[g] 看剧'`), '点按第 4 行 → 上绿');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[4] === '[g] 打游戏'`), '点按第 5 行 → 上绿');
  check(await evalJs(`document.querySelectorAll('#mIdeasPreview .idea-block.idea-green').length === 1`), '相邻两行合并 1 块');
  check(await evalJs(`document.querySelectorAll('#mIdeasPreview .idea-block.idea-green .idea-ball').length === 1`), '合并块 1 个小球');
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'mobile-pen.png'), Buffer.from(shot.result.data, 'base64'));

  // 橡皮
  await evalJs(`document.querySelector('.ideas-pen[data-color="e"]').click(); true`);
  await sleep(250);
  await tap(0);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[0] === '急着交的报告'`), '橡皮点按 → 清除标记');

  console.log('\n── 4. 点链接看说明 ──');
  await evalJs(`document.getElementById('mIdeasModeRead').click(); true`);
  await sleep(350);
  const lp = JSON.parse(await evalJs(`(function(){ var r=document.querySelector('#mIdeasPreview .idea-link').getBoundingClientRect();
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

  console.log('\n────────────────────────');
  console.log(fail === 0 ? ('手机端全部通过：' + pass + ' 项') : (pass + ' 通过 / ' + fail + ' 失败'));
  try { ws.close(); } catch (e) {}
  edge.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试出错:', e && e.message); process.exit(1); });
