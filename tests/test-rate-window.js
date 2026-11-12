/* test-rate-window.js — 读成功率「最近 N 次」滑动窗口算法
   ─────────────────────────────────────────────────────────────
   用 DOM 桩 + vm 加载前端脚本，直接断言 kpiRate 的显示文本。
   覆盖：累计 100% → 单次失败 98.8% → 旧失败滑出窗口 → 突发失败 → 复位清空
        → 服务端下发权威窗口优先 → 全部成功回到 100%
   前置：验证台已启动（默认 http://127.0.0.1:8095，可用 MYX_TEST_BASE 覆盖）
   用法：node tests/test-rate-window.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'verify', 'verify.js'), 'utf8');

/* ── 最小 DOM 桩：任意 id 都返回一个可读写属性的普通对象 ── */
const elCache = new Map();
function makeEl(id) {
  const cls = { _v: '', add() {}, remove() {}, toggle() {} };
  const style = {};
  const el = {
    id, textContent: '', innerHTML: '', title: '', hidden: false,
    value: '', className: '', style, classList: cls,
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    focus() {}, select() {}, offsetWidth: 1,
    getContext: () => ctx2d,
    querySelector: () => makeEl('q'), onclick: null, onkeydown: null, onchange: null, oninput: null,
    children: [], dataset: {},
  };
  return el;
}
/* canvas 2D 上下文桩：drawRtt 会真的画图，全部吞掉 */
const ctx2d = new Proxy({}, {
  get: () => () => {},
  set: () => true,
});
const document = {
  getElementById: (id) => {
    if (!elCache.has(id)) elCache.set(id, makeEl(id));
    return elCache.get(id);
  },
  createElement: (t) => makeEl(t),
  createDocumentFragment: () => makeEl('frag'),
  addEventListener() {},
  querySelector: () => makeEl('q'),
  body: makeEl('body'),
  title: '',
  activeElement: null,
};
const ctx = {
  document,
  window: {},
  localStorage: { getItem: () => null, setItem() {} },
  fetch: () => Promise.reject(new Error('no network in test')),
  WebSocket: function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; },
  location: { protocol: 'http:', host: (process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095').replace(/^https?:\/\//, '') },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, Math, Number, String, JSON, Date, isFinite, parseInt, parseFloat,
  requestAnimationFrame: (f) => setTimeout(f, 0),
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'verify.js' });

const rate = () => ctx.document.getElementById('kpiRate').textContent;
const readsCls = () => ctx.document.getElementById('kpiReads').className;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('① 首帧累计 100 读 100 成功 → 窗口内 100%');
ctx.applyStats({ reads: 100, ok: 100, fail: 0, txFrames: 0, rxFrames: 0 }, 5);
ok(rate() === '100.0%', 'rate=' + rate());
ok(!/bad/.test(readsCls()), '读帧数不标红');

console.log('② 再失败 1 次（101 读 1 失败）→ 80 次里 1 次失败 = 98.75%');
ctx.applyStats({ reads: 101, ok: 100, fail: 1, txFrames: 0, rxFrames: 0 }, 5);
ok(rate() === '98.8%', 'rate=' + rate() + '（应为 98.8%）');

console.log('③ 后面 80 次全成功（181 读 1 失败）→ 失败已滑出窗口 = 100%');
ctx.applyStats({ reads: 181, ok: 180, fail: 1, txFrames: 0, rxFrames: 0 }, 5);
ok(rate() === '100.0%', 'rate=' + rate() + '（历史失败不该影响）');
ok(!/bad/.test(readsCls()), '读帧数不再标红');

console.log('④ 一次性新增 5 读 5 失败（186 读 6 失败）→ 80 窗口里 5 失败 = 93.8%');
ctx.applyStats({ reads: 186, ok: 180, fail: 6, txFrames: 0, rxFrames: 0 }, 5);
ok(rate() === '93.8%', 'rate=' + rate() + '（应为 93.8%）');
ok(/bad/.test(readsCls()), '读帧数标红（近期有失败）');

console.log('⑤ 复位统计（reads 归零）→ 窗口清空，显示 —');
ctx.applyStats({ reads: 0, ok: 0, fail: 0, txFrames: 0, rxFrames: 0 }, 5);
ok(rate() === '—', 'rate=' + rate());

console.log('⑥ 复位后 1 读 1 成功 → 100%');
ctx.applyStats({ reads: 1, ok: 1, fail: 0, txFrames: 0, rxFrames: 0 }, 5);
ok(rate() === '100.0%', 'rate=' + rate());

console.log('⑦ 服务端下发权威窗口（80 项含 2 失败）→ 取服务端窗口 97.5%');
const win = new Array(80).fill(1); win[10] = 0; win[11] = 0;
ctx.applyStats({ reads: 1000, ok: 998, fail: 2, txFrames: 0, rxFrames: 0 }, 5, win);
ok(rate() === '97.5%', 'rate=' + rate() + '（应为 97.5%，与累计值 99.8% 无关）');

console.log('⑧ 服务端窗口全成功 → 100%（历史失败彻底不影响）');
ctx.applyStats({ reads: 1080, ok: 1078, fail: 2, txFrames: 0, rxFrames: 0 }, 5, new Array(80).fill(1));
ok(rate() === '100.0%', 'rate=' + rate());

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
