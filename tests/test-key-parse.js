/* test-key-parse.js — 变量路径解析（前端 tagOf）
   ─────────────────────────────────────────────────────────────
   验证四类写法都能解析成可读标签 + 正确类型：
     标量            GVL_MAIN.diTotalCount
     数组元素        GVL_MAIN.aAlarmFlag[3]
     结构体数组成员  GVL_AXIS.aAxisCtl[3].fActPosition
     嵌套成员        GVL_AXIS.aAxisCtl[3].tState.bValid
   注意：符号名本身含点（GVL 名带点），必须按最长前缀匹配，不能按首个 . 切分。
   前置：验证台已启动   用法：node tests/test-key-parse.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'verify', 'verify.js'), 'utf8');
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';

/* ── 最小 DOM 桩 ── */
const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true });
const elCache = new Map();
function makeEl(id) {
  if (elCache.has(id)) return elCache.get(id);
  const el = {
    id, textContent: '', innerHTML: '', title: '', hidden: false, value: '', className: '',
    style: {}, classList: { _v: '', add() {}, remove() {}, toggle() {} },
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    focus() {}, select() {}, offsetWidth: 1, getContext: () => ctx2d,
    querySelector: () => makeEl('q' + Math.random()), onclick: null, onkeydown: null,
    onchange: null, oninput: null, children: [], dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  };
  elCache.set(id, el);
  return el;
}
const document = {
  getElementById: (id) => makeEl(id),
  createElement: (t) => makeEl(t + Math.random()),
  createDocumentFragment: () => makeEl('frag' + Math.random()),
  addEventListener() {}, querySelector: () => makeEl('q'), body: makeEl('body'),
  title: '', activeElement: null,
};

const ctx = {
  document,
  window: { __dbg: { msgs: {}, errors: [] } },
  localStorage: { getItem: () => null, setItem() {} },
  /* fetch 转发到真实服务端（相对路径 → 绝对） */
  fetch: (u) => fetch(u.startsWith('http') ? u : BASE + u),
  WebSocket: function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; },
  location: { protocol: 'http:', host: BASE.replace(/^https?:\/\//, '') },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, Math, Number, String, JSON, Date, isFinite, parseInt, parseFloat, Promise, Set, Map, Array, Object,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  encodeURIComponent, decodeURIComponent,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'verify.js' });

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

(async () => {
  /* 前置：本用例围绕演示工程 DEMO_MACHINE 的类型结构。当前程序若已换成
     自己的工程（变量名不同），打印「跳过」并正常退出——环境不匹配不是缺陷。 */
  {
    const need = ['GVL_MAIN.diTotalCount', 'GVL_MAIN.aAlarmFlag', 'GVL_AXIS.aAxisCtl', 'GVL_STATION.aCell'];
    const meta = await (await fetch(BASE + '/api/meta')).json();
    const ss = (await (await fetch(BASE + '/api/symbols')).json()).symbols || [];
    const have = new Set(ss.map(s => s.full.replace(/^Application\./, '').split('[')[0]));
    const miss = need.filter(n => !have.has(n));
    if (miss.length) {
      console.log('[i] 跳过：当前程序 ' + (meta.app || '?') + ' 不含 ' + miss.join(', '));
      console.log('    本用例基于演示工程 DEMO_MACHINE；换自己的工程后按 README 第 5 节改用例里的变量名');
      process.exit(77);   /* 77 = 跳过（环境不匹配） */
    }
  }

  console.log('① 加载符号表（真实 /api/symbols）');
  await ctx.loadSymbols();
  ok(true, 'loadSymbols 完成');

  console.log('② 普通标量');
  let t = ctx.tagOf('GVL_MAIN.diTotalCount');
  ok(!!t, 'label=' + (t && t.label) + '（点表内命名，非空即可）');

  console.log('③ 单层数组元素');
  t = ctx.tagOf('GVL_MAIN.aAlarmFlag[3]');
  ok(!!t && t.label === 'aAlarmFlag[3]' && t.type === 'BOOL', 'label=' + (t && t.label) + ' type=' + (t && t.type));

  console.log('④ 结构体数组成员（aAxisCtl[3].fActPosition）');
  t = ctx.tagOf('GVL_AXIS.aAxisCtl[3].fActPosition');
  ok(!!t, 'tagOf 返回非 null');
  ok(t && t.label === 'aAxisCtl[3].fActPosition', 'label=' + (t && t.label));

  console.log('⑤ 嵌套成员（.tState.bValid）');
  t = ctx.tagOf('GVL_AXIS.aAxisCtl[3].tState.bValid');
  ok(!!t && t.label === 'aAxisCtl[3].tState.bValid', 'label=' + (t && t.label));

  console.log('⑥ 类型补全后（模拟 wvals 广播 ty）');
  /* memberType 是脚本作用域内的 let，通过 selectTarget 的第二参数写入 */
  ctx.selectTarget('GVL_AXIS.aAxisCtl[3].fActPosition', 'REAL');
  t = ctx.tagOf('GVL_AXIS.aAxisCtl[3].fActPosition');
  ok(t && t.type === 'REAL', 'type=' + (t && t.type) + '（面板据此选数字控件）');
  ok(t && t.digits === 2, 'digits=' + (t && t.digits));

  console.log('⑦ 不存在的成员：前端宽松放行（type 空），严格校验在服务端');
  t = ctx.tagOf('GVL_AXIS.aAxisCtl[3].noSuchMember');
  ok(!!t && t.type === '', 'tagOf 返回对象但 type 为空 → 服务端 symTag 会拒绝写入');
  ok(/\.noSuchMember$/.test(t.label), 'label 仍可读：' + (t && t.label));

  console.log('⑧ 不存在的符号 → null');
  t = ctx.tagOf('NO_SUCH_GVL.X');
  ok(t === null, '返回 null');

  console.log('⑨ 弹窗渲染不抛异常（含结构体数组）');
  try {
    ctx.renderPickList();
    ok(true, 'renderPickList 正常返回');
  } catch (e) { ok(false, 'renderPickList 抛异常：' + e.message); }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
