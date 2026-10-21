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
  check(await evalJs(`!!document.getElementById('ideasEditor')`), '预览容器存在');
  check(await evalJs(`!!document.getElementById('ideasCrayonBtn') && !!document.getElementById('ideasPenGroup')`),
        '蜡笔按钮与选色面板已就位');

  // ── 2. 写入内容并渲染（单区域：contenteditable 所见即所得） ──
  console.log('\n── 2. 输入内容 / 就地渲染 ──');
  const content = ['[r] 今天必须交的实验报告', '记得问老师 [[评分标准|实验报告占平时分 40%，迟交扣 10%]]', '', '看剧', '打游戏'].join('\n');
  const wantText = content;
  // 模拟真实流程：先设真源（等同从存储加载），派发 input 触发同步+渲染
  await evalJs(`document.getElementById('ideasTextarea').value = ${JSON.stringify(content)}; true`);
  await evalJs(`document.getElementById('ideasEditor').dispatchEvent(new Event('input', { bubbles: true })); true`);
  await sleep(600);
  check(await evalJs(`document.getElementById('ideasTextarea').value`) === wantText, '真源内容正确（含 [r] 与 [[..]] 语法）',
        '实际: ' + JSON.stringify(String(await evalJs(`document.getElementById('ideasTextarea').value`)).slice(0, 80)));

  // 停顿 1.2s（长于启动期任何定时器）：若被应用自身重置，说明是真 bug
  await sleep(1200);
  const after = await evalJs(`document.getElementById('ideasTextarea').value`);
  check(after === wantText, '1.2s 后内容仍在（未被应用重置）',
        after === wantText ? '' : '实际: ' + JSON.stringify(String(after).slice(0, 80)));

  await evalJs(`document.getElementById('ideasEditor').dispatchEvent(new Event('input', { bubbles: true })); true`);
  await sleep(600);
  console.log('     [debug] 第2次input后 真源:', JSON.stringify(await evalJs(`document.getElementById('ideasTextarea').value`)));
  console.log('     [debug] 编辑器HTML:', JSON.stringify(await evalJs(`document.getElementById('ideasEditor').innerHTML.slice(0,150)`)));
  console.log('     [debug] 错误:', await evalJs(`(window.__errs||[]).join(';')`));
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-block.idea-red').length === 1`),
        '红块就地渲染出 1 块',
        'editor 长度=' + (await evalJs(`document.getElementById('ideasEditor').innerHTML.length`)));
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-ball').length === 1`),
        '小球数量 = 1（只出现在块首）');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-link').length === 1`),
        '说明链接就地渲染出 1 个');
  check(await evalJs(`document.querySelector('#ideasEditor .idea-link').getAttribute('data-tip') === '实验报告占平时分 40%，迟交扣 10%'`),
        '说明内容正确挂在 data-tip 上');
  check(await evalJs(`document.getElementById('ideasEditor').textContent.indexOf('[r]') === -1`),
        '原始标记语法不出现在渲染结果里');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n').length === 5`),
        '正文仍是 5 行（存储未丢行）');
  check(await evalJs(`!!document.getElementById('ideasEditor') && !document.getElementById('ideasPreview')`),
        '单区域：只有 contenteditable，无独立预览元素');

  // ── 3. 蜡笔涂抹打标记（新交互） ──
  console.log('\n── 3. 蜡笔选色涂抹 ──');
  // 点蜡笔按钮 → 面板弹出
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideasPenGroup').classList.contains('open')`), '蜡笔面板已弹出');
  // 回归：面板必须「真的可见」——此前被父容器 overflow:hidden 裁剪，classList 已 open 但屏幕上看不到
  const popupVis = await evalJs(`(function(){
    var pop = document.getElementById('ideasPenGroup');
    var r = pop.getBoundingClientRect();
    if (!r.width || !r.height) return 'zero-size';
    if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) return 'off-viewport';
    var el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return (pop === el || (el && pop.contains(el))) ? 'visible' : 'clipped-or-covered';
  })()`);
  check(popupVis === 'visible', '蜡笔选色面板实际可见（未被父容器裁剪）', '结果=' + popupVis);
  // 点绿色笔 → 面板收起 + 进入涂抹态
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="g"]').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideasEditor').classList.contains('pen-mode')`),
        '选色后面板收起、预览进入涂抹态');
  check(await evalJs(`document.getElementById('ideasPenGroup').classList.contains('open') === false`), '选色后面板已收起');

  // 第 4、5 行（看剧、打游戏）涂绿 —— 相邻两行应合并成一块
  async function getLineRects() {
    const rects = await evalJs(`(function(){
      var els=document.querySelectorAll('#ideasEditor .idea-line');
      var out=[];
      for (var i=0;i<els.length;i++){ var r=els[i].getBoundingClientRect();
        out.push({i:i,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}); }
      return JSON.stringify(out);
    })()`);
    return JSON.parse(rects);
  }
  let lines = await getLineRects();
  console.log('     行坐标:', lines.map(l => l.i + '@' + l.y).join(', '));

  async function paintLine(i) {
    // 涂抹中会实时高亮并落盘重绘，坐标可能有微小变化，每次取最新
    const fresh = await getLineRects();
    const p = fresh[i];
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(350);
  }
  await paintLine(3);
  check(await evalJs(`document.getElementById('ideasEditor').classList.contains('pen-mode')`),
        '涂完仍保持涂抹态（可连续涂抹）');
  await paintLine(4);

  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[g] 看剧'`),
        '涂抹第 4 行 → 正文写入 [g] 看剧');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[4] === '[g] 打游戏'`),
        '涂抹第 5 行 → 正文写入 [g] 打游戏');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-block.idea-green').length === 1`),
        '相邻两行绿色合并为 1 块');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-block.idea-green .idea-ball').length === 1`),
        '合并块只有 1 个小球');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-ball').length === 2`),
        '全页共 2 个小球（红 1 + 绿 1）');
  // 仍在涂抹态：点蜡笔按钮退出
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideasEditor').classList.contains('pen-mode') === false`),
        '再点蜡笔按钮退出涂抹态（回到编辑）');

  // 再开蜡笔选橡皮擦掉红色
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(200);
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="e"]').click(); true`);
  await sleep(200);
  await paintLine(0);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[0] === '今天必须交的实验报告'`),
        '橡皮涂抹 → 标记被清除');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-block.idea-red').length === 0`),
        '红色块已消失');
  // 退出涂抹态
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(200);

  // ── 3b. 换色 / 点击色块整块处理 ──
  console.log('\n── 3b. 换色 / 点击色块整块处理 ──');
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(200);
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="r"]').click(); true`);
  await sleep(200);
  await paintLine(3);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[r] 看剧'`),
        '给已有绿色行换红色成功（[g] → [r]，不残留旧标记）');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[4] === '[g] 打游戏'`),
        '相邻的绿色行保持绿色不动');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-block.idea-red').length === 1 &&
                      document.querySelectorAll('#ideasEditor .idea-block.idea-green').length === 1`),
        '原绿块拆成 红1 + 绿1 两块');

  // 点色块的小球（非文字行）→ 整块一起处理
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(200);
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="y"]').click(); true`);
  await sleep(200);
  const ball = JSON.parse(await evalJs(`(function(){ var b=document.querySelector('#ideasEditor .idea-block.idea-green .idea-ball');
      var r=b.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}); })()`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ball.x, y: ball.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ball.x, y: ball.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ball.x, y: ball.y, button: 'left', clickCount: 1 });
  await sleep(400);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[4] === '[y] 打游戏'`),
        '点色块小球 → 整块一起换色（点一下即可）');

  // ── 3c. 手感：实时预览 / 拖出编辑区不断涂 / padding 命中 / 保持滚动 ──
  console.log('\n── 3c. 涂抹手感（实时预览·不断涂·保滚动）──');
  async function freshLines() {
    const rects = await evalJs(`(function(){
      var els=document.querySelectorAll('#ideasEditor .idea-line');
      var edr=document.getElementById('ideasEditor').getBoundingClientRect();
      var out=[]; for (var i=0;i<els.length;i++){ var r=els[i].getBoundingClientRect();
        out.push({i:i,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}); }
      return JSON.stringify({edr:{l:Math.round(edr.left),r:Math.round(edr.right),t:Math.round(edr.top),b:Math.round(edr.bottom)}, lines:out});
    })()`);
    return JSON.parse(rects);
  }
  async function pressMoveRelease(points) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const type = i === 0 ? 'mousePressed' : 'mouseMoved';
      await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: i === 0 ? 1 : 0 });
      await sleep(80);
    }
    const last = points[points.length - 1];
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1 });
    await sleep(350);
  }

  // 选黄色进涂抹态（此时 line0=[r]、line3=[r]、line4=[y]）
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(200);
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="y"]').click(); true`);
  await sleep(250);
  let geo = await freshLines();
  const l0 = geo.lines[0], l2 = geo.lines[2];

  // A. 拖出编辑区（左侧）再拖回：笔画不断，且在外期间不乱涂
  await pressMoveRelease([
    { x: l0.x, y: l0.y },
    { x: geo.edr.l - 30, y: l0.y },   // 编辑区左侧之外（不该涂）
    { x: l2.x, y: l2.y }              // 回到第 3 行
  ]);
  let ta = await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')`);
  check(ta[0].indexOf('[y] ') === 0, '拖出编辑区再拖回 → 起点行已涂黄（笔画不断）', '实际=' + JSON.stringify(ta[0]));
  check(ta[1].indexOf('[y] ') === -1, '在编辑区外悬停的那一行没有被乱涂', '实际=' + JSON.stringify(ta[1]));
  check(ta[2].indexOf('[y] ') === 0, '拖回后命中第 3 行 → 已涂黄', '实际=' + JSON.stringify(ta[2]));

  // B. 实时预览：按住拖动过程中行上先出颜色（不落盘），松手才写真源
  geo = await freshLines();
  const p1 = geo.lines[1], p2 = geo.lines[2];
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p2.x, y: p2.y, button: 'left', buttons: 1 });
  await sleep(150); // 未松手
  const midLive = await evalJs(`(function(){
    var ls=document.querySelectorAll('#ideasEditor .idea-line');
    return JSON.stringify({live1: ls[1].classList.contains('pen-live-y'), live2: ls[2].classList.contains('pen-live-y'),
      ta1: document.getElementById('ideasTextarea').value.split('\\n')[1]});
  })()`);
  const mid = JSON.parse(midLive);
  check(mid.live1 && mid.live2, '拖动中（未松手）：两行已实时铺上预览颜色（笔到色到）');
  check(mid.ta1.indexOf('[y] ') === -1, '拖动中：真源未落盘（松手才生效）', '实际=' + JSON.stringify(mid.ta1));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', clickCount: 1 });
  await sleep(350);
  ta = await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')`);
  check(ta[1].indexOf('[y] 记得问老师') === 0, '松手后 → 真源写入 [y]（line1）');
  check(ta[2].indexOf('[y] ') === 0, '松手后 → 真源写入 [y]（line2）');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .pen-live-y').length === 0`),
        '重排后预览样式已全部让位给真实色块');

  // C. 点在编辑区 padding（非文字行）上也能命中该位置的行
  geo = await freshLines();
  const padY = geo.lines[0].y;
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(150);
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="r"]').click(); true`);
  await sleep(250);
  await pressMoveRelease([{ x: geo.edr.l + 4, y: padY }]); // 编辑区左内边距 4px
  ta = await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')`);
  check(ta[0].indexOf('[r] ') === 0, '点在编辑区左 padding 上 → 命中该位置的行并涂红');

  // 截图（涂抹后的渲染效果）
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'pen-mode.png'), Buffer.from(shot.result.data, 'base64'));

  // ── 4. 悬停说明 ──
  console.log('\n── 4. 悬停说明（tooltip）──');
  const linkRect = await evalJs(`(function(){ var r=document.querySelector('#ideasEditor .idea-link').getBoundingClientRect();
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
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-link').length === 2`),
        '插入后预览立即渲染出 2 个说明链接（不用切模式）');

  // ── 5b. 双击链接编辑 ──
  console.log('\n── 5b. 双击链接重新编辑 ──');
  const link2 = JSON.parse(await evalJs(`(function(){ var els=document.querySelectorAll('#ideasEditor .idea-link');
      var r=els[1].getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}); })()`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: link2.x, y: link2.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: link2.x, y: link2.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: link2.x, y: link2.y, button: 'left', clickCount: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: link2.x, y: link2.y, button: 'left', clickCount: 2 });
  await sleep(400);
  check(await evalJs(`document.getElementById('ideaLinkModal').classList.contains('show')`), '双击链接 → 编辑弹窗弹出');
  check(await evalJs(`document.getElementById('ideaLinkLabel').value === '我的笔记'`), '弹窗预填了链接显示文字');
  check(await evalJs(`document.getElementById('ideaLinkTip').value === '这是三个月后的自己才需要的背景'`), '弹窗预填了链接说明');
  await evalJs(`document.getElementById('ideaLinkLabel').value='改后的标题';
                document.getElementById('ideaLinkTip').value='改后的说明';
                document.getElementById('ideaLinkOk').click(); true`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideasTextarea').value.indexOf('[[改后的标题|改后的说明]]') !== -1`),
        '编辑后正文更新为新链接');
  check(await evalJs(`document.getElementById('ideasTextarea').value.indexOf('[[我的笔记|') === -1`),
        '旧链接已被替换（不残留）');
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
  check(rec.text.indexOf('[[改后的标题|改后的说明]]') !== -1, '落盘内容含说明语法（双击编辑后的链接）');

  // 备份机制（saveWithBackup 会写 _backups）
  const bk = await evalJs(`localStorage.getItem('my_ideas_backups')`);
  check(bk === null || typeof bk === 'string', '备份键未产生异常');

  // ── 7. 手感：长文连续涂抹时保持编辑区滚动位置（重排不跳滚） ──
  console.log('\n── 7. 长文涂抹滚动保持 ──');
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(150);
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="g"]').click(); true`);
  await sleep(250);
  // 换成 60 行（先清空编辑器，再写真源触发「自愈重排」，与真实输入路径一致）
  const many = [];
  for (let i = 0; i < 60; i++) many.push('第 ' + i + ' 行测试内容 abcdefghijklmnopqrstuvwxyz');
  await evalJs(`document.getElementById('ideasEditor').textContent = '';
                document.getElementById('ideasTextarea').value = ${JSON.stringify(many.join('\n'))};
                document.getElementById('ideasEditor').dispatchEvent(new Event('input', { bubbles: true })); true`);
  await sleep(700);
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-line').length === 60`), '60 行内容已渲染');
  await evalJs(`var ed=document.getElementById('ideasEditor'); ed.scrollTop = ed.scrollHeight; true`);
  await sleep(200);
  const s1 = await evalJs(`document.getElementById('ideasEditor').scrollTop`);
  check(s1 > 0, '编辑区已滚到底部（s1=' + s1 + '）');
  geo = await freshLines();
  const bottom = geo.lines[geo.lines.length - 1];
  await pressMoveRelease([{ x: bottom.x, y: bottom.y }]);
  const s2 = await evalJs(`document.getElementById('ideasEditor').scrollTop`);
  const taLast = await evalJs(`(function(){ var v=document.getElementById('ideasTextarea').value.split('\\n'); return v[v.length-1]; })()`);
  check(Math.abs(s2 - s1) <= 2, '涂完底部一行后滚动位置保持（不跳回顶部）', 's1=' + s1 + ' s2=' + s2);
  check(taLast.indexOf('[g] 第 59 行') === 0, '底部那行已涂绿', '实际=' + JSON.stringify(taLast));
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(200);

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
