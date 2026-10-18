/**
 * 对比：当前本地 todo_sync.json 与 Gitee 上一个未污染提交（1ed793202e）
 * 目的：确认除 my_ideas 外没有其它 key 被我这次测试影响。
 * 运行：node tests/diff_cloud.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud_config.json'), 'utf8'));
const BASE = cfg.api_base || 'https://gitee.com/api/v5';
const REF = '1ed793202e';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('非JSON: ' + d.slice(0, 200))); } });
    }).on('error', reject);
  });
}

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

(async () => {
  const url = BASE + '/repos/' + cfg.repo + '/contents/' + cfg.path +
              '?ref=' + REF + '&access_token=' + encodeURIComponent(cfg.token);
  const r = await get(url);
  const cloudRaw = Buffer.from(r.content, 'base64').toString('utf8');
  const cloud = JSON.parse(cloudRaw);
  const cloudData = cloud.data || cloud;

  const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'todo_sync.json'), 'utf8'));

  const keys = Array.from(new Set(Object.keys(local).concat(Object.keys(cloudData)))).sort();
  console.log('本地 keys :', Object.keys(local).sort().join(', '));
  console.log('云端 keys :', Object.keys(cloudData).sort().join(', '));
  console.log('云端 seq  :', cloud.seq, ' 本地 __syncSeq:', local.__syncSeq);
  console.log('\n=== 逐 key 对比 ===');
  let diffs = 0;
  for (const k of keys) {
    const a = local[k], b = cloudData[k];
    // 任务/思路这类字符串化 JSON：按解析后语义比较；其余原样比较
    let sa, sb;
    try { sa = stable(typeof a === 'string' ? JSON.parse(a) : a); } catch (e) { sa = stable(a); }
    try { sb = stable(typeof b === 'string' ? JSON.parse(b) : b); } catch (e) { sb = stable(b); }
    const same = sa === sb;
    if (!same) diffs++;
    console.log((same ? '  [同] ' : '  [差] ') + k + (same ? '' : '  (本地 ' + sa.length + ' 字 / 云端 ' + sb.length + ' 字)'));
  }

  // my_ideas 单独细看
  console.log('\n=== my_ideas 日期键对比 ===');
  const li = JSON.parse(local.my_ideas || '{}');
  const ci = JSON.parse(cloudData.my_ideas || '{}');
  const dk = Array.from(new Set(Object.keys(li).concat(Object.keys(ci)))).sort();
  dk.forEach(d => {
    const l = li[d], c = ci[d];
    const lt = l ? l.ts : null, ct = c ? c.ts : null;
    const sameText = l && c && l.text === c.text;
    console.log('  ' + d + '  本地ts=' + lt + '  云端ts=' + ct +
                (l && !c ? '  ← 本地独有(疑似我造成)' : '') +
                (!l && c ? '  ← 云端独有' : '') +
                (sameText ? '  [正文相同]' : ''));
  });

  console.log('\n差异 key 数: ' + diffs);
})();
