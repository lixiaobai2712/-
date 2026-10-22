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

  // ── 2. 写入内容并渲染（方案A：真源 → 只读渲染视图；点击编辑器进入纯文本编辑会话） ──
  console.log('\n── 2. 输入内容 / 渲染视图 ──');
  const content = ['[r] 今天必须交的实验报告', '记得问老师 [[评分标准|实验报告占平时分 40%，迟交扣 10%]]', '', '看剧', '打游戏'].join('\n');
  const wantText = content;
  // 模拟真实流程：设真源（等同从存储加载）→ 渲染视图
  await evalJs(`document.getElementById('ideasTextarea').value = ${JSON.stringify(content)}; true`);
  await evalJs(`window.__ideasApi.render(); true`);
  await sleep(600);
  check(await evalJs(`document.getElementById('ideasTextarea').value`) === wantText, '真源内容正确（含 [r] 与 [[..]] 语法）',
        '实际: ' + JSON.stringify(String(await evalJs(`document.getElementById('ideasTextarea').value`)).slice(0, 80)));

  // 停顿 1.2s（长于启动期任何定时器）：若被应用自身重置，说明是真 bug
  await sleep(1200);
  const after = await evalJs(`document.getElementById('ideasTextarea').value`);
  check(after === wantText, '1.2s 后内容仍在（未被应用重置）',
        after === wantText ? '' : '实际: ' + JSON.stringify(String(after).slice(0, 80)));

  // 渲染视图：只读（contenteditable=false）+ 色块/链接/小球就位
  check(await evalJs(`document.getElementById('ideasEditor').contentEditable === 'false'`),
        '渲染视图为只读（contenteditable=false）');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-block.idea-red').length === 1`),
        '红块渲染出 1 块',
        'editor 长度=' + (await evalJs(`document.getElementById('ideasEditor').innerHTML.length`)));
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-ball').length === 1`),
        '小球数量 = 1（只出现在块首）');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-link').length === 1`),
        '说明链接渲染出 1 个');
  check(await evalJs(`document.querySelector('#ideasEditor .idea-link').getAttribute('data-tip') === '实验报告占平时分 40%，迟交扣 10%'`),
        '说明内容正确挂在 data-tip 上');
  check(await evalJs(`document.getElementById('ideasEditor').textContent.indexOf('[r]') === -1`),
        '原始标记语法不出现在渲染结果里');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n').length === 5`),
        '正文仍是 5 行（存储未丢行）');
  check(await evalJs(`!!document.getElementById('ideasEditor') && !document.getElementById('ideasPreview')`),
        '单区域：只有 contenteditable，无独立预览元素');

  // ── 2b. 编辑会话 round-trip：渲染 → 点击进入纯文本编辑 → 失焦渲染，内容守恒 ──
  console.log('\n── 2b. 编辑会话数据守恒（方案A核心） ──');
  // 点击编辑器（渲染视图）→ 进入纯文本编辑会话（点第 4 行「看剧」，无链接无标记）
  const g2 = await freshLines();
  const p2b = g2.lines[3];
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p2b.x, y: p2b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2b.x, y: p2b.y, button: 'left', clickCount: 1 });
  await sleep(400);
  check(await evalJs(`document.getElementById('ideasEditor').contentEditable === 'true'`),
        '点击渲染视图 → 进入可编辑会话');
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-link').length === 0`),
        '编辑会话为纯文本（无结构元素）');
  check(await evalJs(`document.getElementById('ideasEditor').children.length === 5`),
        '编辑会话仍是 5 行（空行 <br> 占位保留）');
  // 编辑会话中修改一行，失焦后渲染：修改保留 + 内容守恒（enterEdit 已把光标放到行尾）
  await evalJs(`(() => {
    var ed = document.getElementById('ideasEditor');
    ed.focus();
    document.execCommand('insertText', false, '完');
    return true;
  })()`);
  await sleep(300);
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n').length === 5`),
        '编辑会话输入实时同步真源（仍是 5 行）');
  // 失焦 → 渲染视图，round-trip 无丢行
  await evalJs(`document.getElementById('ideasEditor').dispatchEvent(new Event('blur', { bubbles: true })); true`);
  await sleep(400);
  const rt = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
  check(rt.length === 5, '编辑→失焦 round-trip 行数守恒（含空行）', '实际=' + rt.length);
  check(rt[0] === '[r] 今天必须交的实验报告' && rt[1].indexOf('[[评分标准|') !== -1,
        'round-trip 后标记与链接语法原样保留', '实际=' + JSON.stringify([rt[0], rt[1]]));
  check(rt[2] === '' && rt[3] === '看剧完' && rt[4] === '打游戏', 'round-trip 后空行与修改保留（修改在点击行尾）', '实际=' + JSON.stringify([rt[2], rt[3], rt[4]]));
  check(await evalJs(`document.getElementById('ideasEditor').contentEditable === 'false'`),
        '失焦后回到只读渲染视图');

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

  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[g] 看剧完'`),
        '涂抹第 4 行 → 正文写入 [g] 看剧完');
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
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')[3] === '[r] 看剧完'`),
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
        out.push({i:i,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
                  t:Math.round(r.top),b:Math.round(r.bottom)}); }
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

  // C2. 单击只涂目标行：点 line1，line2 不能被连带误涂（v12.3 回归：click 在重排后再命中会错位到下一行）
  geo = await freshLines();
  const c1 = geo.lines[1];
  await pressMoveRelease([{ x: c1.x, y: c1.y }]);
  ta = await evalJs(`document.getElementById('ideasTextarea').value.split('\\n')`);
  check(ta[1].indexOf('[r] 记得问老师') === 0, '单击 line1 → 该行涂红', '实际=' + JSON.stringify(ta[1]));
  check(ta[2].indexOf('[y] ') === 0, '单击 line1 后 line2 未被连带涂色（单击不误涂下一行）',
        '实际=' + JSON.stringify(ta[2]));

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
  check(await evalJs(`document.getElementById('ideasEditor').contentEditable === 'true' &&
                     document.querySelectorAll('#ideasEditor .idea-link').length === 0`),
        '插入后停留在纯文本编辑会话（可继续输入，不失焦不渲染）');
  // 失焦 → 渲染视图，插入的链接以蓝色链接显示
  await evalJs(`document.getElementById('ideasEditor').dispatchEvent(new Event('blur', { bubbles: true })); true`);
  await sleep(400);
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-link').length === 2`),
        '失焦渲染后出现 2 个说明链接（1 个原链接 + 1 个新插入）');

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
  check(rec.text.indexOf('[r] 看剧完') !== -1, '落盘内容含涂抹结果（红色）');
  check(rec.text.indexOf('[y]') !== -1, '落盘内容含换色结果（黄色）', '实际=' + JSON.stringify(rec.text));
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
  // 换成 60 行（方案A：设真源 + 显式渲染视图）
  const many = [];
  for (let i = 0; i < 60; i++) many.push('第 ' + i + ' 行测试内容 abcdefghijklmnopqrstuvwxyz');
  await evalJs(`document.getElementById('ideasTextarea').value = ${JSON.stringify(many.join('\n'))};
                window.__ideasApi.render(); true`);
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

  // ── 8. 富数据逐行单击不误涂（diff 式：点击前后只允许目标行变化） ──
  console.log('\n── 8. 富数据逐行单击不误涂 ──');
  const rich = [
    '[r] 红块第一行', '[r] 红块第二行', '',
    '[y] 黄行', '普通行带着 [[链接|说明内容]] 测试',
    '最后一行收尾', ''
  ].join('\n');
  await evalJs(`document.getElementById('ideasTextarea').value = ${JSON.stringify(rich)};
                window.__ideasApi.render(); true`);
  await sleep(600);
  check(await evalJs(`document.querySelectorAll('#ideasEditor .idea-line').length === 7`), '富数据 7 行已渲染');
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(150);
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="g"]').click(); true`);
  await sleep(250);
  // 边界抖动（用户反馈「点击后下一行也出现颜色」）：按下在第 1 行底部 1px 处，
  // 向下移动 6px 跨过行边界进入第 2 行——位移 ≤ 阈值 8px，仍算单击，只涂按下那一行
  {
    const gb = await freshLines();
    const p0 = gb.lines[0];   // 红块第一行，t=200 b=224
    const pressY = p0.b - 1;
    const moveY = p0.b + 5;   // 跨边界进入下一行
    const beforeTxt = await evalJs(`document.getElementById('ideasTextarea').value`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: pressY, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p0.x, y: moveY, button: 'left', buttons: 1 });
    await sleep(80);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p0.x, y: moveY, button: 'left', clickCount: 1 });
    await sleep(350);
    const after = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    const b4 = beforeTxt.split('\n');
    const changed = [];
    for (let j = 0; j < after.length; j++) if (after[j] !== b4[j]) changed.push(j);
    check(changed.length === 1 && changed[0] === 0 && after[0] === '[g] 红块第一行',
          '边界手抖单击（位移6px跨行边界）→ 只涂第 1 行，下一行不被连带',
          'diff=' + JSON.stringify(changed) + ' 行1=' + JSON.stringify(after[1] ? after[1].slice(0,10) : ''));
  }
  // 依次单击第 3~6 行（含空行/色块/链接/普通行），每次记录点击前后 diff
  for (let i = 2; i <= 5; i++) {
    const g = await freshLines();
    const p = g.lines[i];
    const beforeTxt = await evalJs(`document.getElementById('ideasTextarea').value`);
    await pressMoveRelease([{ x: p.x, y: p.y }]);   // 纯单击：press→release 同坐标零位移
    const after = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    const b4 = beforeTxt.split('\n');
    const changed = [];
    for (let j = 0; j < after.length; j++) if (after[j] !== b4[j]) changed.push(j);
    const expectOne = after[i] === ('[g] ' + b4[i].replace(/^\[[ryg]\] /, ''));
    check(changed.length === 1 && changed[0] === i && expectOne,
          '单击第 ' + (i + 1) + ' 行 → 只有该行由无色变绿（diff=' + JSON.stringify(changed) + '）',
          '点击后=' + JSON.stringify(after[i].slice(0, 16)));
  }
  // 微抖单击（向下 2px，仍落在同一行内）：也不该涂到下一行
  {
    const g = await freshLines();
    const p = g.lines[6];   // 最后一行空行（未涂过）
    const beforeTxt = await evalJs(`document.getElementById('ideasTextarea').value`);
    await pressMoveRelease([{ x: p.x, y: p.y }, { x: p.x, y: p.y + 2 }]);
    const after = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    const b4 = beforeTxt.split('\n');
    const changed = [];
    for (let j = 0; j < after.length; j++) if (after[j] !== b4[j]) changed.push(j);
    check(changed.length === 1 && changed[0] === 6,
          '带 2px 微抖单击最后一行空行 → 只涂该行',
          'diff=' + JSON.stringify(changed));
  }
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(200);

  // ── 9. 拖拽涂抹多行：正文内容完整（不消失） ──
  console.log('\n── 9. 拖拽涂抹内容完整性 ──');
  const rich9 = ['红块第一行', '红块第二行', '', '黄行', '普通行带着 [[链接|说明内容]] 测试', '最后一行收尾', ''].join('\n');
  await evalJs(`document.getElementById('ideasTextarea').value = ${JSON.stringify(rich9)};
                window.__ideasApi.render(); true`);
  await sleep(600);
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(150);
  await evalJs(`document.querySelector('#ideasPenGroup .ideas-pen[data-color="g"]').click(); true`);
  await sleep(250);
  // 场景A：从行0 拖到行2（经过空行1）——涂三行，正文都要在
  {
    let gA = await freshLines();
    const p0 = gA.lines[0], p1 = gA.lines[1], p2 = gA.lines[2];
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p1.x, y: p1.y, button: 'left', buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p2.x, y: p2.y, button: 'left', buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const tA = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    check(tA.length === 7, '拖涂后仍是 7 行（行数不丢）', '实际=' + tA.length);
    check(tA[0] === '[g] 红块第一行', '行0 涂绿且正文在', '实际=' + JSON.stringify(tA[0]));
    check(tA[1] === '[g] 红块第二行', '行1 涂绿且正文在', '实际=' + JSON.stringify(tA[1]));
    check(tA[2] === '[g] ', '行2 空行涂绿（保持空）', '实际=' + JSON.stringify(tA[2]));
    check(tA[3] === '黄行', '行3 未被波及（正文在）', '实际=' + JSON.stringify(tA[3]));
  }
  // 场景B：拖到链接行（行4），链接语法必须完整还原
  {
    let gB = await freshLines();
    const p3 = gB.lines[3], p4 = gB.lines[4];
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p3.x, y: p3.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p4.x, y: p4.y, button: 'left', buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p4.x, y: p4.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const tB = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    check(tB[3] === '[g] 黄行', '行3 涂绿且正文在', '实际=' + JSON.stringify(tB[3]));
    check(tB[4] === '[g] 普通行带着 [[链接|说明内容]] 测试',
          '行4 涂绿且链接语法完整还原', '实际=' + JSON.stringify(tB[4]));
    check(tB[5] === '最后一行收尾', '行5 未被波及', '实际=' + JSON.stringify(tB[5]));
  }
  // 场景C：快速拖拽（事件无停顿）模拟手速快
  {
    let gC = await freshLines();
    const p5 = gC.lines[5], p6 = gC.lines[6];
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p5.x, y: p5.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p6.x, y: p6.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p6.x, y: p6.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const tC = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    check(tC[5] === '[g] 最后一行收尾', '快速拖涂行5 正文在', '实际=' + JSON.stringify(tC[5]));
    check(tC[6] === '[g] ', '快速拖涂行6 空行在', '实际=' + JSON.stringify(tC[6]));
  }
  // 场景D：涂抹提交后立即派发 input（模拟重排后浏览器合成 input）——真源不能被改写丢行
  {
    const beforeD = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    const gD = await freshLines();
    const p0 = gD.lines[0];
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p0.x, y: p0.y, button: 'left', clickCount: 1 });
    await sleep(300);
    await evalJs(`document.getElementById('ideasEditor').dispatchEvent(new Event('input', { bubbles: true })); true`);
    await sleep(500);
    const tD = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    check(tD.length === 7, '渲染视图 input 事件被忽略（真源不被污染）', '实际=' + tD.length);
    check(tD[0].indexOf('红块第一行') !== -1 && tD[1].indexOf('红块第二行') !== -1,
          'input 同步后行0/1 正文仍在', '实际=' + JSON.stringify([tD[0], tD[1]]));
    check(tD[4].indexOf('[[链接|说明内容]]') !== -1, 'input 同步后链接语法仍在', '实际=' + JSON.stringify(tD[4]));
    void beforeD;
  }
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(200);

  // ── 10. 点蜡笔即涂 + 涂抹态防文本选择（「两行消失」回归） ──
  console.log('\n── 10. 点蜡笔即涂 / 防文本选择误删 ──');
  const rich10 = ['第一行内容', '第二行内容', '', '第四行内容'].join('\n');
  await evalJs(`document.getElementById('ideasTextarea').value = ${JSON.stringify(rich10)};
                window.__ideasApi.render(); true`);
  await sleep(600);
  // 点蜡笔（不选色）→ 应立即进入涂抹态（默认红色），面板同步弹出
  await evalJs(`document.getElementById('ideasCrayonBtn').click(); true`);
  await sleep(250);
  check(await evalJs(`document.getElementById('ideasEditor').classList.contains('pen-mode')`),
        '点蜡笔（不选色）→ 直接进入涂抹态');
  check(await evalJs(`document.getElementById('ideasPenGroup').classList.contains('open')`),
        '点蜡笔后面板同步弹出');
  // 立即拖动两行（不选色）→ 应涂上当前笔色，内容不丢；轨迹只涂有事件经过的行
  {
    const g10 = await freshLines();
    const a = g10.lines[0], b = g10.lines[2];
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'left', buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const t10 = (await evalJs(`document.getElementById('ideasTextarea').value`)).split('\n');
    check(/^\[[ryg]\] 第一行内容$/.test(t10[0]) && t10[0].indexOf('第一行内容') !== -1,
          '未选色直接拖动 → 当前笔色涂上且正文在', '实际=' + JSON.stringify(t10[0]));
    check(t10[1] === '第二行内容', '行1 未被误涂（正文原样）', '实际=' + JSON.stringify(t10[1]));
    check(/^\[[ryg]\] $/.test(t10[2]) && t10[3] === '第四行内容',
          '空行涂上笔色、末行不受波及', '实际=' + JSON.stringify([t10[2], t10[3]]));
    // 即使存在选区，涂抹态 Delete/Backspace 拦截 → 内容不可被删（两行消失的最终防线）
    await evalJs(`window.getSelection().removeAllRanges(); true`);
    check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n').length === 4`),
          '拖拽后行数仍 4 行');
  }
  // 涂抹态下 Delete/Backspace 必须被拦截（防误删选中内容）
  check(await evalJs(`(() => {
    var ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    document.getElementById('ideasEditor').dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`), '涂抹态 Delete 键被拦截');
  check(await evalJs(`(() => {
    var ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    document.getElementById('ideasEditor').dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`), '涂抹态 Backspace 键被拦截');
  check(await evalJs(`document.getElementById('ideasTextarea').value.split('\\n').length === 4`),
        '键盘拦截后行数仍 4 行');
  // 退出涂抹态
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
