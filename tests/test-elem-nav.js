/* test-elem-nav.js — 结构体数组元素的「元素切换」（同数组元素间平移）
   ─────────────────────────────────────────────────────────────
   展开某元素（aAxisCtl[3]）的成员后，可在成员区顶部用 ◀ / ▶ / 下标直达
   跳到同数组的其它元素，不必收起再展开；越界与非法下标被拒。

   做法：DOM 桩 + vm 加载 verify/verify.js，调 elemNavInfo / switchElem 断言状态。
   前置：验证台已启动，且当前程序含结构体数组（演示工程 GVL_AXIS.aAxisCtl 即可）
   用法：node tests/test-elem-nav.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'verify', 'verify.js'), 'utf8');
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';

const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true });
const elCache = new Map();
function makeEl(id) {
  if (elCache.has(id)) return elCache.get(id);
  const el = {
    id, textContent: '', innerHTML: '', title: '', hidden: false, value: '', className: '',
    style: {}, disabled: false, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    focus() {}, select() {}, offsetWidth: 1, getContext: () => ctx2d,
    querySelector: () => makeEl('q' + Math.random()),
    querySelectorAll: () => [],
    onclick: null, onkeydown: null, onchange: null, oninput: null,
    children: [], dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
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

function FakeWS() { this.readyState = 1; this.send = () => {}; this.close = () => {}; }

const ctx = {
  document, fetch: (u) => fetch(u.startsWith('http') ? u : BASE + u),
  WebSocket: FakeWS, location: { protocol: 'http:', host: BASE.replace(/^https?:\/\//, '') },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, Math, Number, String, JSON, Date, isFinite, parseInt, parseFloat,
  Promise, Set, Map, Array, Object, CSS: { escape: (s) => s },
  requestAnimationFrame: (f) => setTimeout(f, 0),
  encodeURIComponent, decodeURIComponent, localStorage: {
    getItem: () => null, setItem() {}, removeItem() {},
  },
  window: {}, navigator: { userAgent: 'node' },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'verify.js' });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const run = (expr) => vm.runInContext(expr, ctx);

(async () => {
  console.log('① 载入符号表');
  await ctx.loadSymbols();
  const arrays = run('symbols.filter(s => s.elem && !s.elem.writable).map(s => s.full.replace(/^Application\\./, ""))');
  ok(arrays.length > 0, `找到结构体数组 ${arrays.length} 个：${arrays.slice(0, 3).join(', ')}`);
  const base = arrays[0];
  const meta = run(`symMap[${JSON.stringify(base)}].elem`);
  ok(!!meta, `父数组 ${base} 带 elem 元信息（${meta && meta.lo}..${meta && meta.hi}）`);

  console.log('\n② 元素 key → 切换信息');
  const key3 = `${base}[3]`;
  const n3 = ctx.elemNavInfo(key3);
  ok(!!n3, `elemNavInfo("${key3}") 有结果`);
  ok(n3 && n3.idx === 3, '解析出下标 3：' + (n3 && n3.idx));
  ok(n3 && n3.base === base, '解析出父数组：' + (n3 && n3.base));
  ok(n3 && n3.lo === meta.lo && n3.hi === meta.hi, `范围 ${n3 && n3.lo}..${n3 && n3.hi} 与符号表一致`);
  ok(ctx.elemNavInfo(base) === null, '非元素 key（数组名本身）返回 null');
  ok(ctx.elemNavInfo('GVL_MAIN.diTotalCount') === null, '标量 key 返回 null');

  console.log('\n③ 切换：▶ 到下一个元素');
  run("pickOpenStruct = new Set(['" + key3 + "'])");
  ctx.switchElem(key3, 4);
  ok(run(`pickOpenStruct.has('${base}[4]')`), '新元素已展开');
  ok(!run(`pickOpenStruct.has('${key3}')`), '旧元素已收起（不会两个同时展开）');
  ok(run('pickFocusElem') === `${base}[4]`, '记住聚焦元素：' + run('pickFocusElem'));

  console.log('\n④ 切换：◀ 回到上一个元素');
  ctx.switchElem(`${base}[4]`, 3);
  ok(run(`pickOpenStruct.has('${key3}')`), '回到 [' + 3 + '] 并展开');

  console.log('\n⑤ 越界与非法输入被拒');
  const before = run('[...pickOpenStruct].join(",")');
  ctx.switchElem(key3, meta.hi + 1);
  ok(run('[...pickOpenStruct].join(",")') === before, `下标 ${meta.hi + 1} 越界 → 状态不变`);
  ctx.switchElem(key3, meta.lo - 1);
  ok(run('[...pickOpenStruct].join(",")') === before, `下标 ${meta.lo - 1} 越界 → 状态不变`);
  ctx.switchElem(key3, 1.5);
  ok(run('[...pickOpenStruct].join(",")') === before, '小数下标 → 状态不变');
  ctx.switchElem(key3, NaN);
  ok(run('[...pickOpenStruct].join(",")') === before, 'NaN → 状态不变');

  console.log('\n⑥ 边界元素：两端按钮应禁用（elemNavInfo 提供判断依据）');
  const lo = ctx.elemNavInfo(`${base}[${meta.lo}]`);
  const hi = ctx.elemNavInfo(`${base}[${meta.hi}]`);
  ok(lo.idx === meta.lo && lo.idx <= lo.lo, `首元素 ${meta.lo}：◀ 禁用条件成立`);
  ok(hi.idx === meta.hi && hi.idx >= hi.hi, `末元素 ${meta.hi}：▶ 禁用条件成立`);

  console.log('\n⑦ 超出前 64 行的元素也能落到渲染结果里');
  /* 造一个 lo..hi 跨度 > 64 的数组（真实工程常见 [0..500] 这类大数组） */
  const big = run('symbols.find(s => s.elem && (s.elem.count > 70))');
  if (big) {
    const b = big.full.replace(/^Application\./, '');
    const far = big.elem.lo + 80;
    run(`pickFocusElem = '${b}[${far}]'`);
    const frag = ctx.document.createDocumentFragment();
    /* pickArrayRow 需要 elm 结构；这里只验证"补行"分支被触发（不抛错即可） */
    let threw = null;
    try {
      ctx.pickArrayRow({
        full: big.full, name: big.name, gvl: big.gvl, type: big.type,
        elem: { lo: big.elem.lo, hi: big.elem.hi, base: big.elem.base,
                count: big.elem.hi - big.elem.lo + 1, writable: big.elem.writable },
      }, '', frag);
    } catch (e) { threw = e; }
    ok(!threw, threw ? '渲染抛错：' + threw.message : `跨 80 个元素跳转可渲染（${b}[${far}]）`);
  } else {
    console.log('  – 跳过：当前程序没有 >70 元素的数组');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
