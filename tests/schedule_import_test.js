// 从页面提取真实课表解析函数；样本保留课程数据，去除学生身份信息。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'todo.html'), 'utf8');
const begin = html.indexOf('  // 文件导入课表（JSON 或 XLS）');
const end = html.indexOf('  function importFromJSONFile(', begin);
assert(begin >= 0 && end > begin);
const defaults = html.match(/var DEFAULT_TIME_SLOTS = \[[\s\S]*?\n  \];/)[0];
const api = {};
const stableSource = html.match(/function stableStringify\(v\) \{[\s\S]*?\n  \}/)[0];
const defaultStart = html.indexOf('  // 2026-10-16 学校导出课表');
const defaultEnd = html.indexOf('  function loadScheduleData()', defaultStart);
vm.runInNewContext(defaults + '\n' + stableSource + '\n' + html.slice(begin, end) + '\n' + html.slice(defaultStart, defaultEnd), api);
const plain = x => JSON.parse(JSON.stringify(x));
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/schedule-multi-weeks.json'), 'utf8'));
const courses = plain(api.parseScheduleJSON(rows));

assert.equal(courses.length, 35, '34 条文件安排加上用户确认的连堂后半段');
assert.equal(new Set(courses.map(c => c.name)).size, 8, '8 个课程名称完整保留');
const info = courses.find(c => c.day === 1 && c.slot === 0 && c.name === '信息论基础');
assert(info, '保留完整课程名，不拆成单个汉字');
assert.deepEqual(info.weeks, [1, 2, 3, 4, 6, 7, 8, 9], '逗号分隔周次精确展开');
assert.equal(info.teacher, '邢键教授');
assert.equal(info.location, '成栋楼305');
assert.deepEqual(courses.filter(c => c.day === 1 && c.slot === 0).map(c => c.name),
  ['信息论基础', '数字信号处理'], '同格多门课各自保留名称和地点');
const saturday = courses.find(c => c.day === 6 && c.slot === 0);
assert.deepEqual(saturday.weeks, [6], '单周补课');
assert(courses.some(c => c.name === '传感器与检测技术' && c.endWeek === 18), '第 18 周末尾课程不遗漏');
assert(!courses.some(c => c.name.includes('备注') || c.name.includes('课程设计')), '无日期的备注不冒充排课');

const parsed = api.parseScheduleTable(rows);
assert.equal(parsed.timeSlots.length, 6, '六个时段包括晚间空行');
assert.equal(parsed.timeSlots[0].time, '08:00~09:35', '源表缺少时刻时保留默认作息');
assert(parsed.notes.includes('FPGA综合设计') && parsed.notes.includes('思想政治理论课实践'), '表尾备注完整保存');
assert.equal(api.scheduleCourseHasWeek(info, 5), false, '缺课周不显示');
assert.equal(api.scheduleCourseHasWeek(info, 6), true, '恢复上课周显示');
assert.equal(api.scheduleWeeksLabel(info), '1-4,6-9', '显示与编辑保留不连续周次');
assert.equal(api.scheduleCourseHasWeek({startWeek: 2, endWeek: 4}, 3), true, '旧版连续周次数据兼容');
assert.equal(api.scheduleCourseHasWeek({startWeek: 2, endWeek: 4}, 5), false);

const legacy = JSON.parse(fs.readFileSync(path.join(root, '课表打印.json'), 'utf8').replace(/^\uFEFF/, ''));
const oldCourses = plain(api.parseScheduleJSON(legacy));
assert.equal(oldCourses.length, 19, '旧课表 19 条安排仍可导入');
assert.equal(oldCourses[0].name, '信息论基础');
assert(oldCourses.some(c => c.location === '成栋楼(成栋楼826)'), '保留原有括号地点');
assert.deepEqual(plain(api.parseCourseCell('课程甲[甲老师]\n1-4，6、8-9周；楼 A 305\n课程乙[乙老师]\n7周;楼B')),
  [
    {name:'课程甲',teacher:'甲老师',weeks:[1,2,3,4,6,8,9],startWeek:1,endWeek:9,location:'楼 A 305'},
    {name:'课程乙',teacher:'乙老师',weeks:[7],startWeek:7,endWeek:7,location:'楼B'}
  ], '中文逗号、顿号、分号和含空格地点');
assert.equal(api.parseOneCourse('课程[老师] 5周;教室').endWeek, 5, '编辑单周课程时不把地点当结束周');
assert.throws(() => api.parseCourseCell('课程[老师] 9-2周;教室'), /周次/, '非法周次不能静默吞掉');
const broken = plain(rows);
broken[3][1] += ' 未识别课程[老师] 周次未知;教室';
assert.throws(() => api.parseScheduleTable(broken), /星期一|第.*行|未识别/, '部分解析失败时拒绝覆盖旧课表');

const reordered = rows.map(row => [row[0],row[7],row[2],row[3],row[4],row[5],row[6],row[1]]);
assert(api.parseScheduleJSON(reordered).some(c => c.name === '信息论基础' && c.slot === 0 && c.day === 1),
  '星期列位置变化时以表头为准');
// 导入正确还不够：用户已有的错误缓存需要能升级，同时保留自定义课表。
const oldBroken = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/schedule-legacy-corrupt.json'), 'utf8'));
const cached = {semesterStart:'2026-08-31', timeSlots:[{time:'08:10~09:45'}],courses:oldBroken};
assert.equal(api.upgradeKnownSchedule(cached), true, '已核实的旧错误缓存升级');
assert.deepEqual(plain(cached.courses), courses, '修复结果与提供的新课表完全一致');
assert.equal(cached.semesterStart, '2026-08-31');
assert.equal(cached.timeSlots[0].time, '08:10~09:45', '修复保留作息');
assert.equal(api.upgradeKnownSchedule(cached), false, '修复幂等，不重复替换');
assert.equal(cached.courses.filter(c => c.day >= 6 && api.scheduleCourseHasWeek(c, 8)).length, 4,
  '本周六日四个时段齐全，周六下午跨两个时段');
const afternoon = courses.filter(c => c.day === 6 && api.scheduleCourseHasWeek(c, 8));
assert.deepEqual(afternoon.map(c => c.slot).sort(), [2, 3], '周六第5–8节连上');
assert(afternoon.every(c => c.name === '嵌入式系统原理' && c.location === '成栋楼820'));
const continuation = courses.find(c => c.day === 6 && c.slot === 3 && c.name === '嵌入式系统原理');
assert.deepEqual(continuation.weeks, [8], '不把其他周的空白格一律补满');
const previousImport = {courses: courses.filter(c => c !== continuation),notes:'原有备注'};
assert.equal(api.upgradeKnownSchedule(previousImport), true, '上一版34条缓存也自动补上连堂');
assert(previousImport.notes.startsWith('原有备注\n'), '保留原备注');
assert.equal(api.upgradeKnownSchedule(previousImport), false, '连堂不重复追加');
const customized = {courses:plain(oldBroken),notes:'手动备注'};
customized.courses.push({name:'手动新增',day:1,slot:0,startWeek:1,endWeek:20});
const originalCustom = plain(customized);
assert.equal(api.upgradeKnownSchedule(customized), false, '不覆盖手动增删过的课表');
assert.deepEqual(customized, originalCustom);
const legacyDefault = {courses:JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/schedule-legacy-default.json'), 'utf8'))};
assert.equal(api.upgradeKnownSchedule(legacyDefault), true, '旧预置课表同步更新');
console.log('课表解析回归全部通过：新表及已确认连堂 35 条、旧表 19 条、缓存升级与异常保护。');
