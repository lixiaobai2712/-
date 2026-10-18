/**
 * 把 Gitee 云端 sync.json 恢复到未污染提交（本轮回归修复）
 * ------------------------------------------------------
 * 背景：浏览器测试期间悬浮球在运行，把测试文本合并进 my_ideas 的 2026-10-18
 *       并随自动同步推到了 Gitee（提交 b79f9d2ea0 / seq=171）。
 *       上一提交 1ed793202e（seq=168）是污染前的干净状态。
 * 做法：取 1ed793202e 的原始内容，以当前 sha 覆盖写入 → 生成一个新的干净提交。
 * 安全：写入前校验「目标内容确实不含测试文本」，写入后回读校验。
 * 运行：node tests/restore_cloud.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud_config.json'), 'utf8'));
const BASE = (cfg.api_base || 'https://gitee.com/api/v5').replace(/\/$/, '');
const CLEAN_REF = '1ed793202e';
const POLLUTED_MARK = '今天必须交的实验报告';

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json;charset=UTF-8' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = d;
        try { parsed = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: d });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const token = '?access_token=' + encodeURIComponent(cfg.token);
  const fileUrl = BASE + '/repos/' + cfg.repo + '/contents/' + cfg.path;

  // 1. 取干净版本内容
  const clean = await req('GET', fileUrl + '?ref=' + CLEAN_REF + '&access_token=' + encodeURIComponent(cfg.token));
  if (clean.status !== 200) throw new Error('取干净版本失败: ' + clean.status + ' ' + clean.raw.slice(0, 200));
  const cleanContent = Buffer.from(clean.body.content, 'base64').toString('utf8');
  const cleanObj = JSON.parse(cleanContent);
  console.log('干净版本 ref=' + CLEAN_REF + ' seq=' + cleanObj.seq);
  console.log('干净版本 my_ideas 日期: ' +
    Object.keys(JSON.parse(cleanObj.data.my_ideas || cleanObj.my_ideas || '{}')).sort().join(', '));

  if (cleanContent.indexOf(POLLUTED_MARK) !== -1) {
    throw new Error('干净版本里竟然含测试文本，中止，需要人工确认');
  }

  // 2. 取当前 sha
  const cur = await req('GET', fileUrl + token);
  if (cur.status !== 200) throw new Error('取当前文件失败: ' + cur.status + ' ' + cur.raw.slice(0, 200));
  console.log('当前云端 sha=' + cur.body.sha + '（污染提交）');
  const curObj = JSON.parse(Buffer.from(cur.body.content, 'base64').toString('utf8'));
  const curSeq = Number(curObj.seq || 0);

  // 关键：seq 保持单调且高于污染提交，否则已同步过的设备可能不采纳这次回退。
  // 除 my_ideas 外，各 key 与干净版本逐字相同（已用 tests/diff_cloud.js 验证）。
  const newSeq = Math.max(curSeq, Number(cleanObj.seq || 0)) + 1;
  cleanObj.seq = newSeq;
  cleanObj.updatedAt = Date.now();
  if (cleanObj.data) cleanObj.data.__syncSeq = newSeq;
  if (typeof cleanObj.__syncSeq !== 'undefined') cleanObj.__syncSeq = newSeq;
  const outContent = JSON.stringify(cleanObj);
  console.log('本次写回 seq: ' + newSeq + '（污染提交 seq=' + curSeq + '）');
  if (outContent.indexOf(POLLUTED_MARK) !== -1) {
    throw new Error('待写内容含测试文本，中止');
  }

  // 3. 覆盖写回干净内容
  const put = await req('PUT', fileUrl, {
    access_token: cfg.token,
    content: Buffer.from(outContent, 'utf8').toString('base64'),
    message: 'revert: 移除测试期间误同步的思路(2026-10-18)',
    sha: cur.body.sha,
    branch: cfg.branch || 'master'
  });
  if (put.status !== 200 && put.status !== 201) {
    throw new Error('写回失败: ' + put.status + ' ' + put.raw.slice(0, 300));
  }
  console.log('已写回，新 sha=' + (put.body.content ? put.body.content.sha : put.body.sha));

  // 4. 回读校验
  const verify = await req('GET', fileUrl + token);
  const vContent = Buffer.from(verify.body.content, 'base64').toString('utf8');
  const vObj = JSON.parse(vContent);
  const vIdeas = JSON.parse(vObj.data.my_ideas || '{}');
  console.log('\n=== 回读校验 ===');
  console.log('云端 seq = ' + vObj.seq);
  console.log('云端 my_ideas 日期 = ' + Object.keys(vIdeas).sort().join(', '));
  const ok = vContent.indexOf(POLLUTED_MARK) === -1 && !vIdeas['2026-10-18'];
  console.log(ok ? '✓ 云端已不含测试文本，2026-10-18 已移除' : '✗ 云端仍含测试文本');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('出错: ' + e.message); process.exit(1); });
