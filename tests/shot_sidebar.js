/**
 * 截图：手机版思路整理右侧侧边栏（验证布局改动）
 * 运行在隔离副本上，不碰真实数据。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9352;
const ROOT = path.join(__dirname, '..');

let html = fs.readFileSync(path.join(ROOT, 'docs', 'mobile.html'), 'utf8');
html = html.split('https://gitee.com/api/v5').join('http://127.0.0.1:19998');
const sandbox = path.join(ROOT, 'tests', 'out', 'sandbox-side');
fs.mkdirSync(sandbox, { recursive: true });
fs.writeFileSync(path.join(sandbox, 'mobile.html'), html, 'utf8');
const PAGE = 'file:///' + path.join(sandbox, 'mobile.html').replace(/\\/g, '/');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = u => new Promise((res, rej) => http.get(u, r => {
  let d = ''; r.on('data', c => d += c);
  r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
}).on('error', rej));

(async () => {
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'side' + Date.now()),
    '--window-size=420,900', PAGE
  ], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      t = (await getJson('http://127.0.0.1:' + PORT + '/json/list')).find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) break;
    } catch (e) {}
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) return 'ERR:' + r.result.exceptionDetails.exception.description;
    return r.result.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1800);

  await ev(`document.getElementById('ideasToggleBtn').click(); true`);
  await sleep(500);
  const info = await ev(`(function(){var d=document.getElementById('ideasDrawer');var r=d.getBoundingClientRect();
    return JSON.stringify({left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,show:d.classList.contains('show')});})()`);
  console.log('抽屉几何:', info);

  await ev(`document.getElementById('ideasTextarea').value='[r] 急着交的报告\\n问老师 [[评分标准|占40%]]\\n\\n看剧\\n打游戏'; true`);
  await ev(`document.getElementById('ideasTextarea').dispatchEvent(new Event('input',{bubbles:true})); true`);
  await sleep(400);
  await ev(`document.querySelector('.ideas-pen[data-color="g"]').click(); true`);
  await sleep(400);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, 'tests', 'out', 'mobile-sidebar.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('已截图 tests/out/mobile-sidebar.png');
  ws.close(); edge.kill(); process.exit(0);
})().catch(e => { console.error('截图脚本出错:', e && e.message); process.exit(1); });
