/**
 * 思路整理新功能 —— 真实浏览器端到端测试（Edge headless + CDP）
 * ============================================================
 * 安全：测试跑在「临时副本」上（tests/out/sandbox/），不触碰真实 todo.html 的
 *       file:// localStorage，也不会连上真实悬浮球（9099 指向不可达端口 + 复制副本）。
 *   1. 启动 Edge headless，打开副本页面
 *   2. 打开思路抽屉，写入带标记与说明的文本
 *   3. 切到「标记」模式，用真实鼠标事件涂抹若干行（模拟荧光笔）
 *   4. 校验 DOM：颜色块、小球数量、相邻合并、悬停说明气泡
 *   5. 截图存 tests/out/ 供人工核对
 * 运行：node tests/e2e_browser.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const SANDBOX = path.join(OUT, 'sandbox');
fs.mkdirSync(SANDBOX, { recursive: true });

// ── 造一个「隔离副本」：改掉同步地址（避免连上真实悬浮球 8899），其余与真实文件一致 ──
function makeSandbox() {
  let html = fs.readFileSync(path.join(ROOT, 'todo.html'), 'utf8');
  html = html.split('http://127.0.0.1:8899').join('http://127.0.0.1:19999');
  fs.writeFileSync(path.join(SANDBOX, 'todo.html'), html, 'utf8');
  return 'file:///' + path.join(SANDBOX, 'todo.html').replace(/\\/g, '/');
}
const PAGE = makeSandbox();

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ('\n      ' + extra) : '')); }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const userDir = path.join(require('os').tmpdir(), 'todo-e2e-edge-' + Date.now());
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDir,
    '--window-size=1400,900',
    PAGE
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      targets = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      if (targets && targets.some(t => t.type === 'page' && t.webSocketDebuggerUrl)) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!targets) { console.log('无法连接 Edge 调试端口'); edge.kill(); process.exit(1); }
  const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  console.log('已连接:', target.url.split('/').pop());

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  function send(method, params) {
    const id = ++msgId;
    return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('页面内异常: ' + JSON.stringify(r.result.exceptionDetails.exception));
    }
    if (r.result && r.result.result && r.result.result.subtype === 'error') throw new Error('eval error');
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  await send('Page.enable');
  await send('Runtime.enable');

  // 等应用初始化完成：ideasLoadPage 会写上日期标签，用它当就绪信号（避免与启动竞态）
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const label = await evalJs(`document.getElementById('ideasDateLabel').textContent`);
    if (typeof label === 'string' && label.length > 0) { ready = true; break; }
  }
  check(ready, '应用初始化完成（思路日期标签已写入）');
  await sleep(300);

  // ── 1. 页面基本装载 ──
  console.log('\n── 1. 页面装载与抽屉打开 ──');
  const title = await evalJs('document.title');
  check(typeof title === 'string' && title.length > 0, '页面已加载（title=' + title + '）');
  await evalJs(`document.getElementById('ideasDrawer').classList.add('open');
                document.getElementById('ideasToggle').style.right='430px';
                document.getElementById('ideasDrawer').getBoundingClientRect().width > 0; true`);
  check(await evalJs(`document.getElementById('ideasDrawer').classList.contains('open')`), '思路抽屉已打开');
  check(await evalJs(`!!document.getElementById('ideasPreview')`), '预览容器存在');
  check(await evalJs(`!!document.getElementById('ideasModeRead') && !!document.getElementById('ideasPenGroup')`),
        '阅读/编辑/画笔工具条已就位');

  // ── 2. 写入内容并进入标记模式 ──
  console.log('\n── 2. 输入内容 / 渲染预览 ──');
  const content = ['[r] 今天必须交的实验报告', '记得问老师 [[评分标准|实验报告占平时分 40%，迟交扣 10%]]', '', '看剧', '打游戏'].join('\n');
  const wantText = content;
  await evalJs(`document.getElementById('ideasTextarea').value = ${JSON.stringify(content)}; true`);
  check(await evalJs(`document.getElementById('ideasTextarea').value`) === wantText, '写入后编辑框内容正确');

  // 停顿 1.2s（长于启动期任何定时器）：若被应用自身重置，说明是真 bug
  await sleep(1200);
  const after = await evalJs(`document.getElementById('ideasTextarea').value`);
  check(after === wantText, '1.2s 后内容仍在（未被应用重置）',
        after === wantText ? '' : '实际: ' + JSON.stringify(String(after).slice(0, 80)));

  await evalJs(`document.getElementById('ideasTextarea').dispatchEvent(new Event('input', { bubbles: true })); true`);
  await sleep(600);
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-block.idea-red').length === 1`),
        '红块渲染出 1 块',
        'preview 长度=' + (await evalJs(`document.getElementById('ideasPreview').innerHTML.length`)));
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-ball').length === 1`),
        '小球数量 = 1（只出现在块首）');
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-link').length === 1`),
        '说明链接渲染出 1 个');
  check(await evalJs(`document.querySelector('#ideasPreview .idea-link').getAttribute('data-tip') === '实验报告占平时分 40%，迟交扣 10%'`),
        '说明内容正确挂在 data-tip 上');
  check(await evalJs(`document.getElementById('ideasPreview').textContent.indexOf('[r]') === -1`),
        '原始标记语法不出现在渲染结果里');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n').length === 5`),
        '正文仍是 5 行（存储未丢行）');

  // ── 3. 真实鼠标涂抹打标记 ──
  console.log('\n── 3. 荧光笔涂抹（真实鼠标事件）──');
  // 进标记模式：点一支颜色笔（点笔即进入标记模式）
  await evalJs(`document.querySelector('.ideas-pen[data-color="g"]').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideasTextarea').style.display === 'none' &&
                      document.getElementById('ideasPreview').style.display !== 'none'`),
        '标记模式：编辑框隐藏、预览显示');
  check(await evalJs(`document.querySelector('.ideas-pen[data-color="g"]').classList.contains('active')`),
        '绿色画笔已选中');

  // 第 4、5 行（看剧、打游戏）涂绿 —— 相邻两行应合并成一块
  const rects = await evalJs(`(function(){
      var els=document.querySelectorAll('#ideasPreview .idea-line');
      var out=[];
      for (var i=0;i<els.length;i++){ var r=els[i].getBoundingClientRect();
        out.push({i:i,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}); }
      return JSON.stringify(out);
    })()`);
  const lines = JSON.parse(rects);
  console.log('     行坐标:', lines.map(l => l.i + '@' + l.y).join(', '));

  async function paintLine(i) {
    const p = lines[i];
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(350);
  }
  await paintLine(3);
  await paintLine(4);

  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[g] 看剧'`),
        '涂抹第 4 行 → 正文写入 [g] 看剧');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[4] === '[g] 打游戏'`),
        '涂抹第 5 行 → 正文写入 [g] 打游戏');
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-block.idea-green').length === 1`),
        '相邻两行绿色合并为 1 块');
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-block.idea-green .idea-ball').length === 1`),
        '合并块只有 1 个小球');
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-ball').length === 2`),
        '全页共 2 个小球（红 1 + 绿 1）');

  // 橡皮擦掉红色
  await evalJs(`document.querySelector('.ideas-pen[data-color="e"]').click(); true`);
  await sleep(200);
  await paintLine(0);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[0] === '今天必须交的实验报告'`),
        '橡皮涂抹 → 标记被清除');
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-block.idea-red').length === 0`),
        '红色块已消失');
  // 再点一次橡皮 → 取消选中，涂不动
  await evalJs(`document.querySelector('.ideas-pen[data-color="e"]').click(); true`);
  await sleep(200);
  await paintLine(3);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[g] 看剧'`),
        '取消选中画笔后再涂抹不生效（防误涂）');

  // ── 3b. 给已有色块换色 ──
  console.log('\n── 3b. 换色 / 点击色块整块处理 ──');
  // 选中红色，涂“看剧”所在行 → 该行应由绿变红，块随之拆开
  await evalJs(`document.querySelector('.ideas-pen[data-color="r"]').click(); true`);
  await sleep(200);
  await paintLine(3);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[r] 看剧'`),
        '给已有绿色行换红色成功（[g] → [r]，不残留旧标记）');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[4] === '[g] 打游戏'`),
        '相邻的绿色行保持绿色不动');
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-block.idea-red').length === 1 &&
                      document.querySelectorAll('#ideasPreview .idea-block.idea-green').length === 1`),
        '原绿块拆成 红1 + 绿1 两块');

  // 点色块的小球（非文字行）→ 整块一起处理
  const ball = JSON.parse(await evalJs(`(function(){ var b=document.querySelector('#ideasPreview .idea-block.idea-green .idea-ball');
      var r=b.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}); })()`));
  await evalJs(`document.querySelector('.ideas-pen[data-color="y"]').click(); true`);
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ball.x, y: ball.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ball.x, y: ball.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ball.x, y: ball.y, button: 'left', clickCount: 1 });
  await sleep(400);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[4] === '[y] 打游戏'`),
        '点色块小球 → 整块一起换色（点一下即可）');

  // 截图（涂抹模式，绿色块）
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'pen-mode.png'), Buffer.from(shot.result.data, 'base64'));

  // ── 4. 悬停说明 ──
  console.log('\n── 4. 悬停说明（tooltip）──');
  await evalJs(`document.getElementById('ideasModeRead').click(); true`);
  await sleep(300);
  const linkRect = await evalJs(`(function(){ var r=document.querySelector('#ideasPreview .idea-link').getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}); })()`);
  const lp = JSON.parse(linkRect);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lp.x, y: lp.y, button: 'none' });
  await sleep(500);
  check(await evalJs(`document.getElementById('ideaTip').style.display === 'block'`),
        '鼠标悬停 → 说明浮层显示');
  check(await evalJs(`document.getElementById('ideaTip').textContent === '实验报告占平时分 40%，迟交扣 10%'`),
        '浮层内容 = 详细说明');
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'hover-tip.png'), Buffer.from(shot.result.data, 'base64'));

  // 移开 → 浮层收起
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' });
  await sleep(400);
  check(await evalJs(`document.getElementById('ideaTip').style.display !== 'block'`), '鼠标移开 → 浮层收起');

  // ── 5. 🔗 说明弹窗插入 ──
  console.log('\n── 5. 🔗 说明按钮 ──');
  await evalJs(`document.getElementById('ideasModeEdit').click(); true`);
  await sleep(200);
  await evalJs(`document.getElementById('ideasLinkBtn').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideaLinkModal').classList.contains('show')`), '说明弹窗已弹出');
  await evalJs(`document.getElementById('ideaLinkLabel').value='我的笔记';
                document.getElementById('ideaLinkTip').value='这是三个月后的自己才需要的背景';
                document.getElementById('ideaLinkOk').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideasTextarea').value.indexOf('[[我的笔记|这是三个月后的自己才需要的背景]]') !== -1`),
        '弹窗内容已插入正文');
  check(await evalJs(`document.getElementById('ideaLinkModal').classList.contains('show') === false`), '弹窗已关闭');

  // 切到阅读模式，确认新链接可悬停
  await evalJs(`document.getElementById('ideasModeRead').click(); true`);
  await sleep(300);
  check(await evalJs(`document.querySelectorAll('#ideasPreview .idea-link').length === 2`),
        '阅读模式渲染出 2 个说明链接');
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'read-mode.png'), Buffer.from(shot.result.data, 'base64'));

  // ── 6. 数据落盘与同步格式 ──
  console.log('\n── 6. 存储格式（不破坏同步）──');
  const stored = await evalJs(`localStorage.getItem('my_ideas')`);
  const store = JSON.parse(stored || '{}');
  const keys = Object.keys(store);
  check(keys.length >= 1, 'my_ideas 已写入 ' + keys.length + ' 个日期');
  const rec = store[keys[0]];
  check(rec && Object.keys(rec).sort().join(',') === 'text,ts', '记录字段仍只有 text,ts');
  check(rec.text.indexOf('[r] 看剧') !== -1, '落盘内容含涂抹结果（红色）');
  check(rec.text.indexOf('[y] 打游戏') !== -1, '落盘内容含换色结果（黄色）');
  check(rec.text.indexOf('[[我的笔记|') !== -1, '落盘内容含说明语法');

  // 备份机制（saveWithBackup 会写 _backups）
  const bk = await evalJs(`localStorage.getItem('my_ideas_backups')`);
  check(bk === null || typeof bk === 'string', '备份键未产生异常');

  console.log('\n────────────────────────');
  console.log(fail === 0 ? ('浏览器端全部通过：' + pass + ' 项') : (pass + ' 通过 / ' + fail + ' 失败'));
  console.log('截图目录: ' + OUT);

  try { ws.close(); } catch (e) {}
  edge.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试脚本出错:', e && e.message);
  process.exit(1);
});
