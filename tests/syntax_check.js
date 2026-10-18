/**
 * 提取 todo.html / docs/mobile.html 的内联脚本做语法检查（不执行）。
 * 运行：node tests/syntax_check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = [
  path.join(__dirname, '..', 'todo.html'),
  path.join(__dirname, '..', 'docs', 'mobile.html')
];

let fail = 0;
files.forEach(function(file) {
  const html = fs.readFileSync(file, 'utf8');
  // 取出所有没有 src 的内联 <script> 块
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0, total = 0;
  while ((m = re.exec(html)) !== null) {
    i++;
    const code = m[1];
    total += code.length;
    const line = html.slice(0, m.index).split('\n').length;
    try {
      new vm.Script(code, { filename: file + ':inline#' + i });
      console.log('  ✓ ' + path.basename(file) + ' 内联脚本 #' + i +
                  '（起点第 ' + line + ' 行，' + code.length + ' 字符）语法正确');
    } catch (e) {
      fail++;
      console.log('  ✗ ' + path.basename(file) + ' 内联脚本 #' + i +
                  '（起点第 ' + line + ' 行）语法错误：' + e.message);
    }
  }
  if (i === 0) { fail++; console.log('  ✗ ' + path.basename(file) + ' 未找到内联脚本'); }
  else console.log('  → ' + path.basename(file) + '：' + i + ' 个内联脚本，共 ' + total + ' 字符');
});

console.log(fail === 0 ? '\n语法检查全部通过' : '\n有 ' + fail + ' 处语法错误');
process.exit(fail === 0 ? 0 : 1);
