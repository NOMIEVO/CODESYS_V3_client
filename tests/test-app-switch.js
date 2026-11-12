/* 单测：导入/切换程序后，全量变量页必须重置筛选条件（否则表格被旧 GVL 筛成空表）
   用法: node tools/t-app-switch.js      （需验证台在 8095 运行）
   做法：DOM 桩 + vm 加载 verify/full.js，直接验证 resetFilters / loadAll / filtered 的行为。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'verify', 'full.js'), 'utf8');
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';

function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', className: '', hidden: false, value: '', checked: false,
    dataset: {}, style: {}, children: [],
    tagName: id === 'sel' ? 'SELECT' : 'INPUT',
    addEventListener() {}, appendChild() {}, focus() {}, select() {},
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
}
const elCache = new Map();
const document = {
  getElementById: (id) => { if (!elCache.has(id)) elCache.set(id, makeEl(id)); return elCache.get(id); },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  activeElement: null,
};
function FakeWS() { this.readyState = 1; this.send = () => {}; this.close = () => {}; }

const ctx = {
  document,
  fetch: (u) => fetch(u.startsWith('http') ? u : BASE + u),
  WebSocket: FakeWS,
  location: { protocol: 'http:', host: BASE.replace(/^https?:\/\//, '') },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, Math, Number, String, JSON, Date, isFinite, parseInt, parseFloat, Promise, Set, Map, Array, Object,
  CSS: { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') },
  requestAnimationFrame: (f) => setTimeout(f, 0),
  encodeURIComponent, decodeURIComponent,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'full.js' });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const rowCount = () => (document.getElementById('tbody').innerHTML.match(/<tr data-f=/g) || []).length;
const get = (expr) => vm.runInContext(expr, ctx);
const set = (expr) => vm.runInContext(expr, ctx);

(async () => {
  await ctx.loadAll();
  await new Promise(r => setTimeout(r, 120));

  const total = get('SYMS.length');
  ok(total > 0, `符号表已载入（${total} 个）`);
  ok(rowCount() === total, `默认「全部」渲染 ${rowCount()} 行 = 符号数`);

  /* 找一个真实的 GVL 分组（模拟用户导入前点过它） */
  const someGvl = get('SYMS.find(s => s.gvl && s.gvl !== "*")?.gvl || "*"');
  console.log(`\n② 模拟导入前的筛选状态：分组=${someGvl} · 搜索=zzz · 只看变化=on`);
  set(`curGvl = ${JSON.stringify(someGvl)}; q = 'zzz'; onlyChanged = true;`);
  document.getElementById('q').value = 'zzz';
  document.getElementById('onlyChanged').checked = true;
  ctx.buildTable();
  ok(rowCount() === 0, `筛选后表格为空（${rowCount()} 行）—— 这就是用户看到的"没数据"`);

  console.log('\n③ 收到 app 广播 → loadAll()（换程序/重新导入的真实路径）');
  await ctx.loadAll();
  await new Promise(r => setTimeout(r, 120));
  ok(get('curGvl') === '*', '分组已重置为「全部」：' + get('curGvl'));
  ok(get('q') === '', '搜索词已清空');
  ok(get('onlyChanged') === false, '「只看变化」已关闭');
  ok(document.getElementById('q').value === '', '搜索框内容已清空：' + JSON.stringify(document.getElementById('q').value));
  ok(document.getElementById('onlyChanged').checked === false, '复选框已取消勾选');
  ok(rowCount() === total, `表格恢复全部 ${rowCount()} 行`);

  console.log('\n④ 防御：分组失效（旧程序有、新程序没有）时自动回退');
  set(`curGvl = 'Application.NOT_EXIST_GVL'`);
  ctx.buildTable();
  ok(get('curGvl') === '*', '自动回退到「全部」');
  ok(rowCount() === total, `表格未被筛空（${rowCount()} 行）`);


  console.log('\n⑤ 刷新活性指示（最近更新 / 无值）');
  ok(typeof ctx.markFullFrame === 'function', 'markFullFrame 已导出');
  ok(typeof ctx.countNoVal === 'function', 'countNoVal 已导出');
  ctx.markFullFrame();
  const upd1 = document.getElementById('stUpd').textContent;
  ok(/^\d{2}:\d{2}:\d{2}$/.test(upd1), '「最近更新」显示 HH:MM:SS：' + upd1);
  ctx.markFullFrame();
  ok(/已收到 \d+ 帧/.test(document.getElementById('stUpd').title), 'title 带帧数计数');

  ctx.countNoVal([{ f: 'a', d: '1' }, { f: 'b', d: '--' }, { f: 'c', d: '--' }, { f: 'd', d: 'TRUE' }]);
  const noValEl = document.getElementById('stNoVal');
  ok(noValEl.textContent === '2/4', '无值统计 2/4：' + noValEl.textContent);
  ok(String(noValEl.className).includes('bad'), '有无值时标红');
  ctx.countNoVal([{ f: 'a', d: '1' }, { f: 'b', d: '2' }]);
  ok(noValEl.textContent === '0', '全部有值时显示 0：' + noValEl.textContent);
  ok(!String(noValEl.className).includes('bad'), '全部有值时不标红');

  console.log('\n⑥ 「只看变化」勾选后表格要能跟着变化更新');
  vm.runInContext('onlyChanged = true; changedSet = new Set([SYMS[0].full])', ctx);
  ctx.buildTable();
  const onlyOne = rowCount();
  ok(onlyOne === 1, `只显示有变化的 ${onlyOne} 行`);
  /* 模拟再来一帧：第二行也变化了 → 节流后表格应变成 2 行 */
  vm.runInContext(`changedSet.add(SYMS[1].full)`, ctx);
  await new Promise(r => setTimeout(r, 700));   /* 等节流窗口 */
  ctx.buildTable();
  ok(rowCount() === 2, `新增变化后变成 ${rowCount()} 行（此前需手动重勾才更新）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
