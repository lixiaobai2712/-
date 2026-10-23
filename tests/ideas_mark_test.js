/**
 * 思路整理：标记 / 悬停说明 纯逻辑测试
 * ================================
 * 直接从 todo.html 里“挖出”真实函数源码来跑，避免测试与实现分叉。
 * 运行：node tests/ideas_mark_test.js
 */

const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'todo.html');
const src = fs.readFileSync(HTML, 'utf8');

// 取出两个正则与三个核心函数（不依赖 DOM）
function grab(re, name) {
  const m = re.exec(src);
  if (!m) throw new Error('未在 todo.html 中找到: ' + name);
  return m[0];
}

const markRe = grab(/var IDEA_MARK_RE = .*?;/, 'IDEA_MARK_RE');
const linkRe = grab(/var IDEA_LINK_RE = .*?;/, 'IDEA_LINK_RE');
const parseFn = grab(/function ideaParseLine\(line\) \{[\s\S]*?\n  \}/, 'ideaParseLine');
const setFn = grab(/function ideaSetLineColor\(lines, idx, color\) \{[\s\S]*?\n  \}/, 'ideaSetLineColor');
const renderFn = grab(/function ideaRenderText\(text\) \{[\s\S]*?\n  \}/, 'ideaRenderText');

// escapeHtml：用实现里的语义（浏览器 div.textContent → innerHTML）
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sandbox = {};
const code = `
${markRe}
${linkRe}
var IDEA_COLOR_CLASS = { r: 'red', y: 'yellow', g: 'green' };
${parseFn}
${setFn}
${renderFn}
return { ideaParseLine, ideaSetLineColor, ideaRenderText, IDEA_MARK_RE, IDEA_LINK_RE };
`;
const api = new Function('escapeHtml', code)(escapeHtml);

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      期望 ' + b + '\n      实际 ' + a); }
}

console.log('\n── 1. 行首标记解析 ──');
eq(api.ideaParseLine('[r] 急着交'), { color: 'r', text: '急着交' }, '标准红色标记');
eq(api.ideaParseLine('[Y]重要不急'), { color: 'y', text: '重要不急' }, '大写 Y 归一为小写');
eq(api.ideaParseLine('[g]   很多空格'), { color: 'g', text: '很多空格' }, '标记后多空格被吞掉');
eq(api.ideaParseLine('普通一行'), { color: '', text: '普通一行' }, '无标记的行');
eq(api.ideaParseLine('[x] 非法颜色'), { color: '', text: '[x] 非法颜色' }, '非 ry g 的方括号不当标记');
eq(api.ideaParseLine('  [r] 行首有缩进'), { color: 'r', text: '行首有缩进' }, '行首空白后仍识别');
eq(api.ideaParseLine('[r]后面没空格'), { color: 'r', text: '后面没空格' }, '标记后无空格也识别');
eq(api.ideaParseLine(''), { color: '', text: '' }, '空行');
eq(api.ideaParseLine('正文里出现 [r] 不算标记'), { color: '', text: '正文里出现 [r] 不算标记' }, '行中标记不生效');

console.log('\n── 2. 打标记 / 换色 / 擦除 ──');
let lines = ['第一行', '第二行'];
api.ideaSetLineColor(lines, 0, 'r');
eq(lines, ['[r] 第一行', '第二行'], '给未标记的行加红');
api.ideaSetLineColor(lines, 0, 'g');
eq(lines, ['[g] 第一行', '第二行'], '已有标记改为绿色（不残留旧标记）');
api.ideaSetLineColor(lines, 0, '');
eq(lines, ['第一行', '第二行'], '传空字符串擦除标记');
api.ideaSetLineColor(lines, 0, 'y');
api.ideaSetLineColor(lines, 0, 'e');
eq(lines, ['第一行', '第二行'], '传 e 也擦除标记');
api.ideaSetLineColor(lines, 5, 'r');
eq(lines, ['第一行', '第二行'], '越界行号安全忽略');
api.ideaSetLineColor(lines, 1, 'r');
api.ideaSetLineColor(lines, 0, 'r');
eq(lines, ['[r] 第一行', '[r] 第二行'], '两行都标记为红');
let indented = ['  缩进\t正文 [[链接|<b>说明</b>]]'];
api.ideaSetLineColor(indented, 0, 'g');
api.ideaSetLineColor(indented, 0, 'r');
api.ideaSetLineColor(indented, 0, 'e');
eq(indented, ['  缩进\t正文 [[链接|<b>说明</b>]]'], '上色、换色、擦除后缩进与正文逐字守恒');
api.ideaSetLineColor(indented, 0, 'invalid');
eq(indented, ['  缩进\t正文 [[链接|<b>说明</b>]]'], '非法笔色不修改正文');

console.log('\n── 3. 悬停说明解析 ──');
eq(api.ideaRenderText('看 [[项目文档|https://x.com 里的说明]] 吧'),
  '看 <span class="idea-link" data-tip="https://x.com 里的说明">项目文档</span> 吧', '带说明的链接');
eq(api.ideaRenderText('[[只有显示文字]]'),
  '<span class="idea-link" data-tip="只有显示文字">只有显示文字</span>', '省略说明时回退为显示文字');
eq(api.ideaRenderText('[[文字|]]'),
  '<span class="idea-link" data-tip="文字">文字</span>', '竖线后为空也回退');
eq(api.ideaRenderText('没有链接'), '没有链接', '普通文本原样');
eq(api.ideaRenderText('[[a|1]] 和 [[b|2]]'),
  '<span class="idea-link" data-tip="1">a</span> 和 <span class="idea-link" data-tip="2">b</span>', '一行内多个链接');
eq(api.ideaRenderText('<script>x</script> & [[a|b]]'),
  '&lt;script&gt;x&lt;/script&gt; &amp; <span class="idea-link" data-tip="b">a</span>', '正文转义防注入');
eq(api.ideaRenderText('引号 " 与说明 [[a|他说 "hi"]]'),
  '引号 " 与说明 <span class="idea-link" data-tip="他说 &quot;hi&quot;">a</span>', '说明里的引号被转义，不会破坏属性');
eq(api.ideaRenderText('未闭合 [[abc'), '未闭合 [[abc', '未闭合的语法原样显示');

console.log('\n── 4. 相邻同色合并成块（渲染规则）──');
function blocksOf(text) {
  const out = [];
  String(text).split('\n').forEach(function(line) {
    const p = api.ideaParseLine(line);
    const prev = out[out.length - 1];
    if (prev && prev.color && prev.color === p.color) prev.lines.push(p.text);
    else out.push({ color: p.color, lines: [p.text] });
  });
  return out;
}
eq(blocksOf('[r] 甲\n[r] 乙\n[r] 丙'), [{ color: 'r', lines: ['甲', '乙', '丙'] }], '三行同色并成一块');
eq(blocksOf('[r] 甲\n[y] 乙\n[r] 丙').map(function(b) { return b.color; }),
  ['r', 'y', 'r'], '中间隔了别色就断开（不会跨色合并）');
eq(blocksOf('普通\n[r] 甲\n[r] 乙').map(function(b) { return b.color; }),
  ['', 'r'], '无色行不参与合并');
eq(blocksOf('[r] 甲\n\n[r] 乙').map(function(b) { return b.color; }),
  ['r', '', 'r'], '空行打断合并');

console.log('\n── 5. 与现有同步格式的兼容（text 不新增字段）──');
const storeRec = { text: '[r] 交作业\n[[文档|点我]] 说明', ts: 1700000000000 };
eq(Object.keys(storeRec).sort(), ['text', 'ts'], '记录仍只有 text + ts 两个字段');
const roundTrip = (function() {
  const ls = storeRec.text.split('\n');
  api.ideaSetLineColor(ls, 0, 'g');
  return ls.join('\n');
})();
eq(api.ideaParseLine(roundTrip.split('\n')[0]).color, 'g', '落盘后再次解析颜色为绿');

console.log('\n────────────────────────');
console.log(fail === 0 ? ('全部通过：' + pass + ' 项') : (pass + ' 通过 / ' + fail + ' 失败'));
process.exit(fail === 0 ? 0 : 1);
