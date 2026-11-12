/* test-full-write.js — 全量变量页：行内输入框渲染与提交
   ─────────────────────────────────────────────────────────────
   断言每个可写标量行自带输入框 + 写入按钮（一一对应），复合符号只给「展开」；
   BOOL 用下拉、数值用 number 框；提交发 writeTest(mode=set)；
   空值/非数字拦截；结果吐司分级；实时广播不覆盖用户已输入的值。
   前置：验证台已启动   用法：node tests/test-full-write.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'verify', 'full.js'), 'utf8');
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';

function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', className: '', hidden: false, value: '',
    dataset: {}, style: {}, children: [], tagName: id === 'sel' ? 'SELECT' : 'INPUT',
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

const sent = [];
function FakeWS() { this.readyState = 1; this.send = (s) => sent.push(JSON.parse(s)); this.close = () => {}; }

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
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

/* 造一个可提交的假行 */
function fakeRow(full, value) {
  const ctl = { value, dataset: {}, tagName: 'INPUT' };
  const nameEl = { textContent: 'GVL_MAIN.SOME_VAR' };
  return {
    dataset: { f: full },
    querySelector: (sel) => sel === '.wnum' ? ctl : (sel === '.v-name' ? nameEl : null),
  };
}

(async () => {
  console.log('① 渲染：每行自带写入控件（无需先点按钮）');
  await ctx.loadAll();
  await new Promise(r => setTimeout(r, 150));
  const tbody = document.getElementById('tbody');
  const html = tbody.innerHTML;

  const wnumCount = (html.match(/class="wnum"/g) || []).length;
  const wgoCount = (html.match(/class="wgo"/g) || []).length;
  const drillCount = (html.match(/class="drill"/g) || []).length;
  console.log(`   输入控件 ${wnumCount} 个 · 写入按钮 ${wgoCount} 个 · 展开按钮 ${drillCount} 个`);
  /* 期望值从服务端符号表实时推导，换任何演示/真实工程都适用 */
  const sym = await (await fetch(BASE + '/api/symbols')).json();
  const WRITABLE = new Set(['BOOL','BYTE','SINT','USINT','INT','UINT','WORD',
    'DINT','UDINT','DWORD','TIME','REAL','LREAL','LINT']);
  const wantW = (sym.symbols || []).filter(s => /w/i.test(s.access || '')
    && !s.elem && !s.struct && WRITABLE.has(String(s.type || '').toUpperCase())).length;
  const wantD = (sym.symbols || []).filter(s => s.elem || s.struct).length;
  ok(wnumCount === wantW, `每个可写标量行都有输入控件：${wnumCount} = 符号表 ${wantW} 个`);
  ok(wnumCount > 0, '至少存在一个可写标量');
  ok(wnumCount === wgoCount, '输入控件与写入按钮一一对应');
  ok(!/class="wbtn"/.test(html), '不再有需要先点的「写」按钮（输入框直接可见）');

  console.log('② BOOL 行 = 下拉（0/1），数字行 = number 输入框');
  const h = html;
  ok(/<select class="wnum" data-t="BOOL"/.test(h), 'BOOL 用下拉');
  ok(/0 FALSE/.test(h) && /1 TRUE/.test(h), '下拉含 FALSE/TRUE');
  ok(/<input class="wnum" type="number"/.test(h), '数字用 number 输入框');
  ok(/placeholder="输入值"/.test(h), '占位文案为「输入值」');

  console.log('③ 提交：点写入 → 发 writeTest(mode=set)');
  sent.length = 0;
  ctx.submitRowWrite(fakeRow('Application.GVL_MAIN.diTotalCount', '1234'));
  const cmd = sent.find(x => x.cmd === 'writeTest');
  ok(!!cmd, '发出了 writeTest');
  ok(cmd && cmd.key === 'GVL_MAIN.diTotalCount', 'key 去前缀：' + (cmd && cmd.key));
  ok(cmd && cmd.mode === 'set', 'mode=set');
  ok(cmd && cmd.value === 1234, 'value=1234');

  console.log('④ 空值 / 非法值拦截（不发命令）');
  sent.length = 0;
  ctx.writePending = false;
  ctx.submitRowWrite(fakeRow('Application.GVL_MAIN.diTotalCount', ''));
  ok(sent.length === 0, '空值不发命令');
  ctx.submitRowWrite(fakeRow('Application.GVL_MAIN.diTotalCount', 'abc'));
  ok(sent.length === 0, '非数字不发命令');

  console.log('⑤ 写入结果吐司');
  /* writePending 是脚本内的 let 绑定，只能用 runInContext 读写（挂在 ctx 上的是另一个变量） */
  vm.runInContext('writePending = true;', ctx);
  ctx.onRowWriteMsg({ level: 'sys', text: '│ ② 目标值 = 1234（写入后保留）' });
  ok(document.getElementById('wtoast').textContent.includes('目标值'),
    '进度进吐司：' + document.getElementById('wtoast').textContent);
  ctx.onRowWriteMsg({ level: 'ok', text: '└ ✅ 写入成功　PLC 当前值 = 1234　耗时 4ms' });
  const tEl = document.getElementById('wtoast');
  ok(tEl.className.includes('ok'), '结论行标绿（class=' + tEl.className + '）');
  ok(vm.runInContext('writePending', ctx) === false, '结论行后停止跟踪');

  console.log('⑥ 复合符号仍只能展开');
  ok(/class="drill"/.test(h), '存在展开按钮（' + drillCount + ' 个）');

  console.log('⑦ 输入框防冲掉：实时广播不覆盖用户已改的值');
  const mkTr = (ctl, focused) => {
    document.activeElement = focused ? ctl : null;
    return { querySelector: (sel) => sel === '.wnum' ? ctl : null };
  };
  /* 未改动、未聚焦 → 跟随实时值 */
  const c1 = { value: '100', dataset: {}, tagName: 'INPUT' };
  ctx.syncRowCtl(mkTr(c1, false), '250');
  ok(c1.value === '250', '未编辑时跟随实时值：' + c1.value);
  /* 已改动（dirty）→ 保留用户输入 */
  const c2 = { value: '999', dataset: { dirty: '1' }, tagName: 'INPUT' };
  ctx.syncRowCtl(mkTr(c2, false), '250');
  ok(c2.value === '999', '改过的值不被覆盖：' + c2.value);
  /* 正在聚焦输入 → 不打扰 */
  const c3 = { value: '777', dataset: {}, tagName: 'INPUT' };
  ctx.syncRowCtl(mkTr(c3, true), '250');
  ok(c3.value === '777', '聚焦输入时不打断：' + c3.value);
  /* BOOL 下拉跟随 */
  const c4 = { value: '0', dataset: {}, tagName: 'SELECT' };
  ctx.syncRowCtl(mkTr(c4, false), 'TRUE');
  ok(c4.value === '1', 'BOOL 下拉跟随 TRUE：' + c4.value);

  console.log('⑧ 可写判定');
  ok(ctx.isWritableScalar({ access: 'r', type: 'DINT' }) === false, 'access=r → 不可写');
  ok(ctx.isWritableScalar({ access: 'rw', type: 'DINT' }) === true, 'rw + DINT → 可写');
  ok(ctx.isWritableScalar({ access: 'rw', type: 'ARRAY [0..5] OF INT' }) === false, '数组 → 需展开');
  ok(ctx.isWritableScalar({ access: 'rw', type: 'T_AXIS_CONTROL' }) === false, '结构体 → 需展开');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
