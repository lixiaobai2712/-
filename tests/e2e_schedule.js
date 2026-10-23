// 课表导入隔离 E2E；可传入实际 XLS 文件，测试副本不连接真实托盘。
// node tests/e2e_schedule.js [课表打印.xls]
// XLS 测试复用页面相同版本的库：tests/out/schedule/xlsx.full.min.js。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert/strict');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out', 'sandbox-schedule');
const PORT = 9348;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((resolve, reject) => {
  const req = http.get(url, r => { let body = ''; r.on('data', c => body += c); r.on('end', () => {
    try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
  }); });
  req.on('error', reject);
  req.setTimeout(2000, () => req.destroy(new Error('CDP HTTP timeout')));
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const actualXls = process.argv[2] && path.resolve(process.argv[2]);
  const library = path.join(__dirname, 'out/schedule/xlsx.full.min.js');
  if (actualXls) {
    assert(fs.existsSync(actualXls), '测试 XLS 文件存在');
    assert(fs.existsSync(library), '请将页面使用的 xlsx@0.18.5 库缓存到 tests/out/schedule/xlsx.full.min.js');
    fs.copyFileSync(library, path.join(OUT, 'xlsx.full.min.js'));
  }
  let html = fs.readFileSync(path.join(ROOT, 'todo.html'), 'utf8')
    .replaceAll('http://127.0.0.1:8899', 'http://127.0.0.1:19999')
    .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi,
      actualXls ? '<script src="./xlsx.full.min.js"></script>' : '');
  fs.writeFileSync(path.join(OUT, 'todo.html'), html);
  const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
    '--remote-debugging-port=' + PORT, '--window-size=1500,1100',
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'schedule-e2e-' + Date.now()),
    'file:///' + path.join(OUT, 'todo.html').replaceAll('\\', '/')
  ], { stdio: 'ignore' });
  const keepAlive = setInterval(() => {}, 1000);
  let ws;
  try {
    let target;
    for (let i = 0; i < 60; i++) {
      try { target = (await getJson('http://127.0.0.1:' + PORT + '/json/list')).find(t => t.type === 'page'); } catch (_) {}
      if (target) break;
      await sleep(200);
    }
    assert(target, 'Edge 调试页面可用');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const pending = new Map();
    let seq = 0;
    ws.onmessage = e => { const data = JSON.parse(e.data); if (pending.has(data.id)) pending.get(data.id)(data); };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP 超时：' + method)); }, 10000);
      pending.set(id, data => { clearTimeout(timer); pending.delete(id); resolve(data); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const ev = async expression => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert(!r.error && !r.result.exceptionDetails, JSON.stringify(r));
      return r.result.result.value;
    };
    await send('Runtime.enable');
    for (let i = 0; i < 30; i++) {
      if (await ev(`!!document.getElementById('ideasDateLabel').textContent`)) break;
      await sleep(100);
    }
    await ev(`window.__alerts=[]; window.alert=m=>window.__alerts.push(m); document.getElementById('floatScheduleBtn').click()`);
    const upload = async (bytes, name) => {
      const base64 = Buffer.from(bytes).toString('base64');
      const before = await ev('window.__alerts.length');
      await ev(`(() => {
        const binary=atob(${JSON.stringify(base64)}), data=Uint8Array.from(binary,c=>c.charCodeAt(0));
        const transfer=new DataTransfer(); transfer.items.add(new File([data],${JSON.stringify(name)}));
        const input=document.getElementById('schedFileInput'); input.files=transfer.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      for (let i = 0; i < 40; i++) {
        if (await ev('window.__alerts.length') > before) return ev('window.__alerts[window.__alerts.length-1]');
        await sleep(100);
      }
      throw Error('导入未返回结果');
    };
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/schedule-multi-weeks.json'), 'utf8'));
    const importSample = () => actualXls ? upload(fs.readFileSync(actualXls), path.basename(actualXls))
      : upload(JSON.stringify(rows), '课表.json');
    const result = await importSample();
    assert.match(result, /成功.*35/);
    const stored = () => ev(`JSON.parse(localStorage.getItem('my_schedule_data'))`);
    const imported = await stored();
    assert.equal(imported.courses.length, 35);
    assert.equal(new Set(imported.courses.map(c => c.name)).size, 8);
    assert.equal(imported.semesterStart, '2026-08-31', '打印日期不能替代开学日期');
    console.log('  OK ' + (actualXls ? '实际 XLS 文件' : 'JSON 样本') + '：8 门课程、35 条安排（含已确认连堂）');
    const setWeek = week => ev(`(() => {
      let current=Number(document.getElementById('schedWeekLabel').textContent.match(/第(\\d+)周/)[1]);
      while(current!==${week}) {document.getElementById(current<${week}?'schedNextWeek':'schedPrevWeek').click(); current+=current<${week}?1:-1;}
    })()`);
    const cell = (day, slot) => ev(`document.querySelector('#scheduleTable td[data-day="${day}"][data-slot="${slot}"]').textContent`);
    await setWeek(4);
    assert.match(await cell(1, 0), /信息论基础/);
    assert.match(await cell(1, 0), /1-4,6-9周/);
    await setWeek(5);
    assert.equal(await cell(1, 0), '', '第 5 周星期一第一二节无课');
    assert.equal(await cell(3, 0), '', '第 5 周星期三第一二节无课');
    assert.equal(await cell(2, 1), '', '第 5 周星期二第三四节无课');
    await setWeek(6);
    assert.match(await cell(1, 0), /信息论基础/);
    assert.match(await cell(6, 0), /信息论基础/);
    await setWeek(7);
    assert.match(await cell(7, 1), /高频电子线路/);
    await setWeek(8);
    assert.match(await cell(6, 2), /嵌入式系统原理/, '第 8 周周六第五六节课程');
    assert.match(await cell(6, 2), /成栋楼820/);
    assert.match(await cell(6, 3), /嵌入式系统原理/, '第8周周六第七八节连堂后半段');
    assert.match(await cell(6, 3), /成栋楼820/);
    assert.match(await cell(7, 0), /嵌入式系统原理/, '第 8 周周日第一二节课程');
    assert.match(await cell(7, 0), /成栋楼311/);
    assert.match(await cell(7, 1), /信息论基础/);
    assert.match(await cell(7, 1), /成栋楼305/);
    assert(!/高频电子线路/.test(await cell(7, 1)));
    await setWeek(18);
    assert.match(await cell(5, 2), /传感器与检测技术/);
    assert.match(await ev(`document.getElementById('scheduleNotes').textContent`), /FPGA综合设计/);
    console.log('  OK 第 4/5/6/7/8/18 周显示、周末补课和表尾备注');

    await setWeek(6);
    await ev(`window.prompt=(message,value)=>{window.__editDefault=value; return value.replace('成栋楼305','测试教室');}; document.getElementById('schedModeToggle').click(); document.querySelector('#scheduleTable td[data-day="1"][data-slot="0"]').click()`);
    assert.match(await ev('window.__editDefault'), /1-4,6-9周/);
    assert.match(await cell(1, 0), /测试教室/);
    await setWeek(11);
    assert.match(await cell(1, 0), /数字信号处理/, '编辑第 6 周课程不删除第 11 周同格课程');
    console.log('  OK 编辑不连续周次，同时保留同格其他周课程');

    const before = JSON.stringify(await stored());
    const invalid = JSON.parse(JSON.stringify(rows));
    invalid[3][1] += ' 错误课程[教师] 无效周次;教室';
    assert.match(await upload(JSON.stringify(invalid), '无效课表.json'), /第 4 行.*星期一/);
    assert.equal(JSON.stringify(await stored()), before, '部分失败不覆盖已有课程');
    console.log('  OK 解析失败提示位置并完整保留旧课表');
    await upload(fs.readFileSync(path.join(ROOT, '课表打印.json')), '旧版课表.json');
    assert.equal((await stored()).courses.length, 19, '带 BOM 的旧版 JSON 可导入');
    await importSample();
    // 复现用户现场：已经存下的旧版错误课表，刷新后也必须修好，而不只测试重新导入。
    const corrupt = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/schedule-legacy-corrupt.json'), 'utf8'));
    await ev(`(() => {
      const data=JSON.parse(localStorage.getItem('my_schedule_data'));
      data.courses=${JSON.stringify(corrupt)};
      delete data.notes;
      data.timeSlots[0].time='08:10~09:45';
      data.semesterStart='2026-08-31';
      localStorage.setItem('my_schedule_data',JSON.stringify(data));
    })()`);
    await send('Page.reload');
    await sleep(700);
    await ev(`document.getElementById('floatScheduleBtn').click()`);
    await setWeek(8);
    assert.match(await cell(6, 2), /嵌入式系统原理/, '旧缓存刷新后周六课程恢复');
    assert.match(await cell(6, 3), /嵌入式系统原理/, '旧缓存刷新后周六连堂后半段恢复');
    assert.match(await cell(7, 0), /嵌入式系统原理/, '旧缓存刷新后周日第一二节恢复');
    assert.match(await cell(7, 1), /信息论基础/, '旧缓存刷新后周日第三四节恢复');
    assert.equal((await stored()).timeSlots[0].time,'08:10~09:45','修复保留自定义作息');
    assert(await ev(`JSON.parse(localStorage.getItem('my_schedule_data_backups') || '[]').some(b=>JSON.parse(b.data).courses.length===${corrupt.length})`), '修复前自动备份');
    console.log('  OK 旧错误缓存刷新后，本周六日四处课程恢复，原数据已备份');
    // 用户上轮已更新到34条缓存，同样必须在刷新后补齐第7–8节。
    await ev(`(() => {
      const data=JSON.parse(localStorage.getItem('my_schedule_data'));
      data.courses=data.courses.filter(c=>!(c.day===6 && c.slot===3 && c.name==='嵌入式系统原理'));
      localStorage.setItem('my_schedule_data',JSON.stringify(data));
    })()`);
    await send('Page.reload');
    await sleep(700);
    await ev(`document.getElementById('floatScheduleBtn').click()`);
    await setWeek(8);
    assert.match(await cell(6, 2), /嵌入式系统原理/);
    assert.match(await cell(6, 3), /嵌入式系统原理/);
    assert.equal((await stored()).courses.length,35,'旧版34条数据升级且不重复');
    console.log('  OK 上一轮34条缓存刷新后，第5–8节连堂完整显示');
    const image = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'schedule-week8.png'), Buffer.from(image.result.data, 'base64'));
    console.log('课表浏览器回归全部通过。');
  } finally {
    clearInterval(keepAlive);
    if (ws) ws.close();
    child.kill();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
