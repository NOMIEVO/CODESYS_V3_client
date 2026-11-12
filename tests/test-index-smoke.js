/* test-index-smoke.js — 首页启动冒烟（严格 DOM 桩）
   ─────────────────────────────────────────────────────────────
   DOM 桩只暴露 index.html 里真实存在的 id（其余返回 null），
   因此能抓出「脚本访问已删除元素」这类空引用。
   覆盖：boot 正常完成、标题、状态广播处理、顶栏端点可显示、配置弹窗入口存在。
   前置：验证台已启动   用法：node tests/test-index-smoke.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'verify', 'verify.js'), 'utf8');
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';
const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true });

/* 严格 DOM 桩：getElementById 返回 null 时如实返回 null，能暴露「访问已删除元素」 */
const HTML = fs.readFileSync(path.join(__dirname, '..', 'verify', 'index.html'), 'utf8');
const ids = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

const elCache = new Map();
function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', title: '', hidden: true, value: '', className: '',
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, addEventListener() {}, focus() {}, select() {}, offsetWidth: 1,
    getContext: () => ctx2d, querySelector: () => makeEl('child'), querySelectorAll: () => [],
    onclick: null, onkeydown: null, onchange: null, oninput: null,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  };
}

const document = {
  getElementById: (id) => {
    if (!ids.has(id)) return null;                 /* 页面里没有 = null，和真实浏览器一致 */
    if (!elCache.has(id)) elCache.set(id, makeEl(id));
    return elCache.get(id);
  },
  createElement: () => makeEl(''),
  createDocumentFragment: () => makeEl('frag'),
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  body: makeEl('body'), title: '', activeElement: null,
};

const sent = [];
function FakeWS() { this.readyState = 1; this.send = (s) => sent.push(JSON.parse(s)); this.close = () => {}; }

const ctx = {
  document,
  window: { __dbg: { msgs: {}, errors: [] } },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: (u) => fetch(u.startsWith('http') ? u : BASE + u),
  WebSocket: FakeWS,
  location: { protocol: 'http:', host: BASE.replace(/^https?:\/\//, '') },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, Math, Number, String, JSON, Date, isFinite, parseInt, parseFloat, Promise, Set, Map, Array, Object,
  CSS: { escape: (s) => s },
  requestAnimationFrame: (f) => setTimeout(f, 0),
  encodeURIComponent, decodeURIComponent,
};
ctx.globalThis = ctx;
vm.createContext(ctx);

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

(async () => {
  console.log('① index.html 已无 brandApp 元素');
  ok(!ids.has('brandApp'), '页面不含 id=brandApp');
  ok(ids.has('brand-title') || /brand-title/.test(HTML), '仍保留「协议验证台」标题');

  console.log('② 加载 verify.js 并执行 boot（不再访问 brandApp）');
  let bootErr = null;
  vm.runInContext(SRC, ctx, { filename: 'verify.js' });
  try { await ctx.boot(); } catch (e) { bootErr = e; }
  ok(!bootErr, bootErr ? 'boot 抛错：' + bootErr.message : 'boot 正常完成');
  ok(ctx.document.title.includes('协议验证台'), 'document.title = ' + ctx.document.title);

  console.log('③ 程序切换广播（t:app）不含 brandApp 赋值');
  let switchErr = null;
  try {
    await vm.runInContext(`(async()=>{ 
      applyState({ t:'state', state:'online', handshake:[], stats:{reads:1,ok:1,fail:0}, rtt:[], events:[] });
      await new Promise(r=>setTimeout(r,50));
    })()`, ctx);
  } catch (e) { switchErr = e; }
  ok(!switchErr, switchErr ? '广播处理抛错：' + switchErr.message + '\n' + (switchErr.stack||'').split('\n').slice(1,4).join('\n') : '状态广播处理正常');

  console.log('④ 顶栏端点仍可显示 / 修改');
  ok(document.getElementById('epHost').textContent.length > 0, 'epHost = ' + document.getElementById('epHost').textContent);
  ok(document.getElementById('epPort').textContent.startsWith(':'), 'epPort = ' + document.getElementById('epPort').textContent);
  ok(typeof ctx.openCfg === 'function', 'openCfg 存在（点地址可配置）');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
