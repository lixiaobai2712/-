// 真实页面的隔离回归：不加载个人浏览器配置，不连接托盘或 Gitee。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert/strict');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out', 'sandbox-crayon');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = url => new Promise((resolve, reject) => {
  http.get(url, r => { let s = ''; r.on('data', c => s += c); r.on('end', () => {
    try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
  }); }).on('error', reject);
});

async function run(mobile) {
  console.log('开始隔离回归：' + (mobile ? '手机' : '电脑'));
  const keepAlive = setInterval(() => {}, 1000);
  const folder = path.join(OUT, mobile ? 'mobile' : 'desktop');
  fs.mkdirSync(folder, { recursive: true });
  const source = fs.readFileSync(path.join(ROOT, mobile ? 'docs/mobile.html' : 'todo.html'), 'utf8');
  fs.writeFileSync(path.join(folder, 'page.html'), source
    .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, '')
    .replaceAll('http://127.0.0.1:8899', 'http://127.0.0.1:19999')
    .replaceAll('https://gitee.com', 'http://127.0.0.1:19998'));
  const port = mobile ? 9347 : 9346;
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + port, '--window-size=1400,900',
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'crayon-' + port + '-' + Date.now()),
    'file:///' + path.join(folder, 'page.html').replaceAll('\\', '/')], { stdio: 'ignore' });
  let ws;
  try {
    let target;
    for (let i = 0; i < 60; i++) {
      try { target = (await json('http://127.0.0.1:' + port + '/json/list')).find(t => t.type === 'page'); } catch (_) {}
      if (target) break;
      await sleep(200);
    }
    assert(target, 'Edge 已启动');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (process.env.CRAYON_DEBUG) console.log('CDP response', m.id, String(e.data).slice(0, 150)); if (pending.has(m.id)) {
      pending.get(m.id)(m); pending.delete(m.id);
    } };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP 超时：' + method)); }, 8000);
      pending.set(key, value => { clearTimeout(timer); resolve(value); });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
    const ev = async expression => {
      if (process.env.CRAYON_DEBUG) console.log('Evaluate', expression.slice(0, 100));
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert(!result.error && !result.result.exceptionDetails, JSON.stringify(result));
      return result.result.result.value;
    };
    await send('Runtime.enable');
    await sleep(1000);
    const ed = mobile ? 'mIdeasEditor' : 'ideasEditor';
    const btn = mobile ? 'mIdeasCrayonBtn' : 'ideasCrayonBtn';
    const group = mobile ? 'mIdeasPenGroup' : 'ideasPenGroup';
    const key = mobile ? 'mobile_ideas_v1' : 'my_ideas';
    const raw = '[r] 甲\n[r] 乙\n\n  保留缩进 [[链接|<b>原文</b>]]\n尾行\n';
    await ev(`localStorage.setItem(${JSON.stringify(key)}, JSON.stringify({
      '2026-10-20': {text:${JSON.stringify(raw)},ts:1}
    })); localStorage.setItem(${JSON.stringify(mobile ? 'mobile_ideas_pos' : 'my_ideas_pos')}, '2026-10-20')`);
    await send('Page.reload');
    await sleep(800);
    await ev(mobile ? `document.getElementById('ideasToggleBtn').click()` : `document.getElementById('ideasDrawer').classList.add('open')`);
    await sleep(300);
    const check = async (expression, label) => {
      assert.equal(await ev(expression), true, (mobile ? '手机：' : '电脑：') + label);
      console.log('  OK ' + (mobile ? '手机 ' : '电脑 ') + label);
    };
    await check(`document.querySelectorAll('#${ed} .idea-block.idea-red .idea-line').length === 2`, '同色两行确实位于同一块内部');
    await check(`document.getElementById('${ed}').contentEditable === 'false'`, '渲染视图只读');
    await ev(`document.getElementById('${btn}').click()`);
    await check(`document.getElementById('${ed}').classList.contains('pen-mode')`, '点击蜡笔立即进入涂抹态');
    const choose = c => ev(`document.querySelector('#${group} [data-color="${c}"]').click()`);
    const rect = i => ev(`(() => {const r=document.querySelectorAll('#${ed} .idea-line')[${i}].getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    const mouse = (type, p, buttons = 1) => send('Input.dispatchMouseEvent', { type, ...p, button: 'left', buttons, clickCount: 1 });
    const text = () => ev(`document.getElementById('ideasTextarea').value`);
    await choose('g');
    if (!mobile) {
      const a = await rect(0), b = await rect(4);
      await mouse('mousePressed', a);
      await mouse('mouseMoved', b);
      assert.equal(await text(), raw, '预览不改正文');
      await mouse('mouseReleased', b, 0);
      const painted = await text();
      assert.equal(painted, '[g] 甲\n[g] 乙\n[g] \n[g]   保留缩进 [[链接|<b>原文</b>]]\n[g] 尾行\n', '快速跨行拖动补齐中间行并保留正文');
      console.log('  OK 电脑 快速跨行、空行、缩进和链接守恒');
      await choose('e');
      const p = await rect(1);
      await mouse('mousePressed', p);
      await check(`document.querySelectorAll('#${ed} .idea-line')[1].classList.contains('pen-live-e')`, '橡皮有实时预览');
      await check(`(() => {const line=document.querySelectorAll('#${ed} .idea-line')[1]; return getComputedStyle(line).backgroundColor === 'rgb(255, 255, 255)' && getComputedStyle(line.closest('.idea-block')).backgroundColor === 'rgba(0, 0, 0, 0)';})()`, '擦除预览实际遮住旧底色');
      await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
      await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
      await mouse('mouseReleased', p, 0);
      assert.equal(await text(), painted, 'Escape 取消笔画');
      await choose('r');
      const p0 = await rect(0);
      await mouse('mousePressed', p0);
      await ev(`document.getElementById('${ed}').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))`);
      await mouse('mouseReleased', p0, 0);
      assert.equal(await text(), painted, 'pointercancel 取消笔画');
      // 日期切换必须使旧笔画失效，松手不能污染新日期。
      await mouse('mousePressed', await rect(0));
      await ev(`document.getElementById('ideasToday').click()`);
      await mouse('mouseReleased', p0, 0);
      assert.equal(await text(), '', '日期切换后旧笔画不提交');
    } else {
      await choose('e');
      const p = await rect(0);
      await mouse('mousePressed', p);
      await mouse('mouseReleased', p, 0);
      assert.equal(await text(), '甲\n[r] 乙\n\n  保留缩进 [[链接|<b>原文</b>]]\n尾行\n');
      await ev(`document.getElementById('${ed}').dispatchEvent(new Event('input',{bubbles:true}))`);
      assert((await text()).includes('[[链接|<b>原文</b>]]'), '渲染 DOM 不能反解污染原文');
    }
    await ev(`document.getElementById('${btn}').click()`);
    // 空编辑器下浏览器首先生成直接文本节点，必须能保存；手机不能在防抖保存后重排。
    await ev(`document.getElementById('${ed}').click(); const editor=document.getElementById('${ed}'); editor.focus(); editor.innerHTML=''; document.execCommand('insertText',false,'新输入');`);
    await sleep(600);
    assert.equal(await text(), '新输入', '根文本节点同步到真源');
    await check(`document.getElementById('${ed}').contentEditable === 'true'`, '防抖保存不打断编辑会话');
    if (!mobile) {
      await ev(`(() => {
        const OriginalXHR = window.XMLHttpRequest;
        window.__restoreXHR = () => { window.XMLHttpRequest = OriginalXHR; };
        const date=localStorage.getItem('my_ideas_pos');
        window.XMLHttpRequest = class {
          open(method) {this.method=method;}
          setRequestHeader() {}
          send() {
            this.status=200;
            this.responseText=JSON.stringify({data:{my_ideas:JSON.stringify({[date]:{text:'远端替换',ts:Date.now()+10000}})}});
            if(this.onload)this.onload();
          }
        };
        document.dispatchEvent(new Event('visibilitychange'));
      })()`);
      assert.equal(await text(), '新输入', '远端拉取不替换编辑中的内容');
      await check(`document.getElementById('${ed}').contentEditable === 'true'`, '同步不会结束编辑会话');
      await ev(`window.__restoreXHR()`);
    }
    // 真实键盘换行，而非手造每行 DOM：覆盖浏览器产生的根文本/嵌套 div/br。
    await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r', unmodifiedText:'\r'});
    await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
    await send('Input.insertText', {text:'第二行'});
    await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r', unmodifiedText:'\r'});
    await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
    await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r', unmodifiedText:'\r'});
    await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
    await send('Input.insertText', {text:'第四行 [[说明|<b>纯文本</b>]]'});
    const typed = '新输入\n第二行\n\n第四行 [[说明|<b>纯文本</b>]]';
    assert.equal(await text(), typed, '真实 Enter 输入和空行守恒');
    await ev(`document.getElementById('${ed}').blur()`);
    await check(`document.getElementById('${ed}').contentEditable === 'false'`, '失焦回到只读渲染');
    await ev(`document.querySelector('#${ed} .idea-line').click(); document.getElementById('${ed}').blur()`);
    assert.equal(await text(), typed, '重复进出编辑会话后原文守恒');
  } finally {
    clearInterval(keepAlive);
    if (ws) ws.close();
    child.kill();
  }
}

(async () => { await run(false); await run(true); })().catch(e => { console.error(e); process.exitCode = 1; });
