/* full.js — 全量变量浏览器：符号表 + WS 实时值 + GVL 分组/搜索过滤 */
'use strict';
const $ = (id) => document.getElementById(id);

let SYMS = [];                 // /api/symbols
let VALUES = {};               // full → { disp, kind }
let curGvl = '*';
let q = '';
let onlyChanged = false;
let changedSet = new Set();

let ws = null;
let refilterTimer = null;   /* 「只看变化」下的表格重建节流句柄 */


/* ── 启动 ── */
(async function init() {
  await loadAll();
  connect();
})();

/* 清空筛选条件（换程序 / 重新导入后必须做）
   旧程序的 GVL 分组名与搜索词在新程序里往往不存在：分组留着 → filtered() 一行都匹配不到，
   表格空白、导航却显示「全部 N 个符号」，看上去就像"值不刷新"。 */
function resetFilters() {
  curGvl = '*';
  q = '';
  onlyChanged = false;
  const box = $('q'); if (box) box.value = '';
  const oc = $('onlyChanged'); if (oc) oc.checked = false;
}

/* 载入元信息 + 符号表并重建表格（程序切换时复用，不重连 WS） */
async function loadAll() {
  resetFilters();
  try {
    const m = await (await fetch('/api/meta')).json();
    if (m.app) $('fbarApp').textContent = `程序 ${m.appDisplay || m.app} · XML 符号表 · 分批登记 · 单轮 ExecuteRead 全量轮询`;
    const r = await fetch('/api/symbols');
    const d = await r.json();
    SYMS = d.symbols;
    buildNav(d);
    buildTable();
    $('resultHint').textContent = `${SYMS.length} 个符号`;
  } catch (e) {
    $('tbody').innerHTML = '<tr><td colspan="5" class="fempty">符号表加载失败：' + e.message + '</td></tr>';
  }
}

function buildNav(d) {
  const byGvl = {};
  SYMS.forEach(s => { byGvl[s.gvl] = (byGvl[s.gvl] || 0) + 1; });
  const nav = $('fnav');
  nav.innerHTML = '<div class="fnav-h">GVL 分组</div>' +
    `<button class="gvl active" data-gvl="*">全部<span class="cnt">${SYMS.length}</span></button>` +
    Object.entries(byGvl).sort().map(([g, n]) =>
      `<button class="gvl" data-gvl="${g}">${g.replace(/^.*\./, '')}<span class="cnt">${n}</span></button>`).join('');
  nav.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      nav.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      curGvl = b.dataset.gvl;
      buildTable();
    };
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* 可直接写入的 IEC 标量类型（与服务端 WRITABLE_IEC 对齐） */
const WRITABLE_IEC = new Set(['BOOL', 'BYTE', 'SINT', 'USINT', 'INT', 'UINT', 'WORD',
  'DINT', 'UDINT', 'DWORD', 'TIME', 'REAL', 'LREAL', 'LINT']);

function filtered() {
  /* 防御：分组已失效（换过程序 / 重导入后旧 GVL 不存在）时回退到「全部」，
     否则整张表会被一个不存在的分组筛成空表 */
  if (curGvl !== '*' && !SYMS.some(s => s.gvl === curGvl)) {
    curGvl = '*';
    const nav = $('fnav');
    if (nav) {
      const bs = nav.querySelectorAll('button.gvl');
      bs.forEach(b => b.classList.toggle('active', b.dataset.gvl === '*'));
    }
  }
  return SYMS.filter(s => {
    if (curGvl !== '*' && s.gvl !== curGvl) return false;
    if (q && !(s.name.toLowerCase().includes(q) || s.full.toLowerCase().includes(q)
      || (s.comment || '').toLowerCase().includes(q))) return false;
    if (onlyChanged && !changedSet.has(s.full)) return false;
    return true;
  });
}

/* ── 表格内直接写入（非展开变量：rw 标量符号本身） ──
   复合符号（数组/结构体/设备类型）整体无法一次写入，只能「展开」后写成员；
   标量符号以前只能看在展开弹窗里写，现在**每一行自带输入框 + 写入按钮**，直接改直接写，
   与展开弹窗里的写法完全一致（cmd:writeTest + mode:set，写入后保留，服务端按 XML access 复验）。 */
let writePending = false;  /* 正在等待写入结果（wtest 广播 → 吐司提示） */

function isWritableScalar(s) {
  if (!/w/i.test(s.access || '')) return false;
  return WRITABLE_IEC.has(String(s.type || '').toUpperCase());
}

/* 行内写入控件：BOOL 下拉（0/1），其余数字框；初值 = 当前值 */
function writeCtlHtml(s) {
  const cur = VALUES[s.full];
  const curTxt = cur ? cur.disp : '';
  const t = String(s.type || '').toUpperCase();
  if (t === 'BOOL') {
    const on = curTxt === 'TRUE' ? '1' : '0';
    return `<select class="wnum" data-t="BOOL" title="选择 TRUE / FALSE 后点写入">
      <option value="0"${on === '0' ? ' selected' : ''}>0 FALSE</option>
      <option value="1"${on === '1' ? ' selected' : ''}>1 TRUE</option></select>
      <button class="wgo">写入</button>`;
  }
  const num = /^-?\d+(\.\d+)?$/.test(curTxt) ? curTxt : '';
  return `<input class="wnum" type="number" step="any" value="${esc(num)}"
      placeholder="输入值" title="改数字后点写入，或直接回车">
    <button class="wgo">写入</button>`;
}

function buildTable() {
  const list = filtered();
  const tb = $('tbody');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="5" class="fempty">无匹配变量</td></tr>';
    $('resultHint').textContent = '0 个';
    return;
  }
  tb.innerHTML = list.map(s => {
    const gvlShort = s.gvl.replace(/^.*\./, '');
    const comp = /^(ARRAY|D_|T_)/.test(s.type);
    const rw = /w/i.test(s.access || '');
    let act = '';
    if (s.elem && s.elem.writable) {
      /* 元素是标量（BOOL/INT/REAL…）：弹窗分页看全部元素值，一页 20 个 */
      const on = arrView && arrView.full === s.full && !$('amodal').hidden;
      act = `<button class="apbtn${on ? ' on' : ''}" data-f="${esc(s.full)}">${on ? '已打开' : '分页'}</button>`;
    } else if (comp) {
      /* 结构体数组 / 结构体 / 设备类型：成员树弹窗 */
      act = `<button class="drill" data-f="${esc(s.full)}">展开</button>`;
    } else if (isWritableScalar(s)) {
      /* 行内直接给输入框：不用先点「写」才出现，看到就能改 */
      act = writeCtlHtml(s);
    } else {
      act = `<span class="ro">${rw ? '不可单值写' : '只读'}</span>`;
    }
    const row = `<tr data-f="${esc(s.full)}">
      <td class="v-name"><span class="gvl">${esc(gvlShort)}.</span>${esc(s.name)}</td>
      <td class="v-type">${esc(s.type)}</td>
      <td class="v-val" data-v="${esc(s.full)}">--</td>
      <td class="v-size">${s.bytes}B</td>
      <td class="v-act">${act}</td>
    </tr>`;
    return row;
  }).join('');
  $('resultHint').textContent = `${list.length} 个`;
  paint();
}

/* ────────── 大数组分页弹窗 ──────────
   元素上千的数组（ARRAY[0..1999] OF REAL）不能整表铺开：
   弹窗里一页 20 个，可 ◀ / ▶ 翻页、直接输页码跳转，**每个元素都能单独写入**。
   写入沿用首页同一契约（writeTest / mode=set），服务端复验 XML access + 类型。 */

const AP_SIZE = 20;          /* 每页元素数 */

let arrView = null;          /* { full, name, base, lo, hi, total, page, pages, size, values } */
let arrLoading = false;
let arrPaintAt = 0;          /* 上次刷新时刻（节流） */

/* 打开弹窗并载入指定页 */
/* fresh=true 时绕过服务端缓存强制重读（大数组一次重读≈72 次往返，只给「刷新」按钮用） */
async function openArrPage(full, page, fresh) {
  const sym = SYMS.find(s => s.full === full);
  if (!sym || !sym.elem) return;
  if (!arrView || arrView.full !== full) {
    arrView = { full, name: sym.name, base: sym.elem.base, lo: sym.elem.lo,
                hi: sym.elem.hi, total: sym.elem.count, page: 0,
                pages: Math.ceil(sym.elem.count / AP_SIZE), size: AP_SIZE, values: [] };
    $('aname').textContent = (sym.gvl ? sym.gvl.replace(/^.*\./, '') + '.' : '') + sym.name;
    $('atype').textContent = sym.type + (sym.bytes ? ' · ' + sym.bytes + 'B' : '');
    $('acomment').textContent = sym.comment || '';
    $('amodal').hidden = false;
    $('atbody').innerHTML = '<tr><td colspan="4" class="ap-empty">正在读取…</td></tr>';
    $('ahint').textContent = '';
    $('ahint').className = 'dhint';
  }
  arrLoading = true;
  try {
    const r = await fetch(`/api/arrayvals?key=${encodeURIComponent(full)}&page=${page}&size=${AP_SIZE}`
      + (fresh ? "&fresh=1" : ""));
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || '读取失败');
    arrView = Object.assign(arrView, d);
    arrView.error = null;
  } catch (e) {
    if (arrView) arrView.error = e.message;
  }
  arrLoading = false;
  arrPaintAt = Date.now();
  renderArrPage();
}

function closeArrPage() {
  arrView = null;
  $('amodal').hidden = true;
  buildTable();          /* 让行上的按钮从「已打开」回到「分页」 */
}

/* 渲染当前页：工具栏状态 + 元素行（每行自带写入控件） */
function renderArrPage() {
  const v = arrView;
  if (!v) return;

  /* ── 工具栏 ── */
  const inp = $('apage');
  if (document.activeElement !== inp) inp.value = v.page + 1;
  inp.max = v.pages;
  $('apages').textContent = v.pages;
  $('arange').textContent = `元素 ${v.from}..${v.to}`;
  $('ams').textContent = `${v.total} 个`;
  $('ameta').textContent = `${v.base} · 每元素 ${v.esz}B`
    + (v.error ? ' · ✗ ' + v.error : (v.online === false ? ' · 离线（结构来自 XML）' : ''));
  $('aprev').disabled = arrLoading || v.page <= 0;
  $('anext').disabled = arrLoading || v.page >= v.pages - 1;

  /* ── 元素行：值 + 写入控件 ── */
  const tb = $('atbody');
  const t = String(v.base || '').toUpperCase();
  const isBool = t === 'BOOL';
  const writable = !!v.writable;

  /* 行集合变了才重建（翻页 / 换数组），同页刷新只改值与行内控件 */
  const sig = `${v.full}|${v.page}|${v.values.length}`;
  if (tb.dataset.sig !== sig) {
    tb.dataset.sig = sig;
    tb.innerHTML = v.values.map(x => {
      let ctl = '<span class="ro">只读</span>';
      if (writable) {
        ctl = isBool
          ? `<select class="dnum" data-i="${x.i}" data-t="BOOL">
               <option value="0">0 · FALSE</option><option value="1">1 · TRUE</option></select>
             <button class="dw" data-i="${x.i}">写入</button>`
          : `<input class="dnum" data-i="${x.i}" type="number" step="any" placeholder="写入值">
             <button class="dw" data-i="${x.i}">写入</button>`;
      }
      return `<tr data-i="${x.i}">
        <td class="a-idx">[${x.i}]</td>
        <td class="d-type">${esc(v.base)}</td>
        <td class="d-val" data-v="${x.i}">${esc(x.d)}</td>
        <td class="d-wio">${ctl}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" class="ap-empty">该页没有元素</td></tr>';
    /* 新页：写入框留空（不预填当前值，避免误提交旧值；点值可一键带入） */
    tb.querySelectorAll('select.dnum').forEach(sel => {
      const tr = sel.closest('tr');
      const cur = tr && tr.querySelector('.d-val').textContent;
      if (cur === 'TRUE') sel.value = '1';
    });
  } else {
    /* 同页刷新：只更新值文本，不动用户正在编辑的输入框 */
    tb.querySelectorAll('td.d-val').forEach(td => {
      const x = v.values.find(y => String(y.i) === td.dataset.v);
      if (!x) return;
      if (td.textContent === x.d) return;
      td.textContent = x.d;
      const tr = td.closest('tr');
      if (tr) { tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); }
      /* BOOL 下拉跟随（未改动、未聚焦时） */
      const sel = tr && tr.querySelector('select.dnum');
      if (sel && document.activeElement !== sel && sel.dataset.dirty !== '1') {
        if (x.d === 'TRUE') sel.value = '1';
        else if (x.d === 'FALSE') sel.value = '0';
      }
    });
  }

  $('ahint').className = 'dhint' + (v.error ? ' bad' : '');
  $('ahint').textContent = v.error
    ? '✗ ' + v.error
    : (v.online === false
      ? '链路离线：结构来自 XML，值待上线后刷新'
      : '值随链路自动刷新（每 500ms）· 写入按元素名单独下发，写入后保留');
}

function gotoPage(page) {
  if (!arrView || arrLoading) return;
  const p = Math.max(0, Math.min(arrView.pages - 1, page));
  if (p === arrView.page) return;
  arrView.page = p;
  openArrPage(arrView.full, p);
}

/* 全量帧到达时刷新当前页（节流 800ms） */
function refreshArrIfOpen() {
  if (!arrView || arrLoading || $('amodal').hidden) return;
  if (Date.now() - arrPaintAt < 800) return;
  arrPaintAt = Date.now();
  openArrPage(arrView.full, arrView.page);
}

/* ── 事件：翻页 / 页码跳转 / 关闭 / 写入 ── */
$('aprev').onclick = () => gotoPage((arrView ? arrView.page : 0) - 1);
$('anext').onclick = () => gotoPage((arrView ? arrView.page : 0) + 1);
$('aclose').onclick = () => closeArrPage();
$('arefresh').onclick = () => { if (arrView) openArrPage(arrView.full, arrView.page, true); };
$('amodal').addEventListener('click', (e) => { if (e.target === $('amodal')) closeArrPage(); });

$('apage').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const n = Number($('apage').value);
  if (!Number.isInteger(n) || n < 1 || n > (arrView ? arrView.pages : 1)) {
    $('apage').classList.add('bad'); return;
  }
  $('apage').classList.remove('bad');
  gotoPage(n - 1);                            /* 界面 1 基 → 内部 0 基 */
};
$('apage').onblur = () => {
  $('apage').classList.remove('bad');
  if (arrView) $('apage').value = arrView.page + 1;
};

/* 写入控件：改动标记（不被刷新覆盖） */
$('atbody').addEventListener('input', (e) => {
  const c = e.target.closest('.dnum'); if (c) c.dataset.dirty = '1';
});
$('atbody').addEventListener('change', (e) => {
  const c = e.target.closest('.dnum'); if (c) c.dataset.dirty = '1';
});

/* 点当前值：一键带入写入框（常用「改一点点」场景） */
$('atbody').addEventListener('click', (e) => {
  const td = e.target.closest('td.d-val');
  if (!td) return;
  const tr = td.closest('tr');
  const ctl = tr && tr.querySelector('.dnum');
  if (!ctl) return;
  if (ctl.tagName === 'SELECT') return;
  ctl.value = td.textContent;
  ctl.dataset.dirty = '1';
  ctl.focus(); ctl.select && ctl.select();
});

/* 行内「写入」/ 回车提交 */
$('atbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button.dw');
  if (btn) submitArrWrite(btn.closest('tr'));
});
$('atbody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const ctl = e.target.closest('.dnum');
  if (!ctl) return;
  e.preventDefault();
  submitArrWrite(ctl.closest('tr'));
});

function submitArrWrite(tr) {
  if (!tr || !arrView) return;
  const idx = tr.dataset.i;
  const ctl = tr.querySelector('.dnum');
  if (!ctl) return;
  if (ctl.value === '') { $('ahint').className = 'dhint bad'; $('ahint').textContent = '⚠ 请先填入写入值'; return; }
  const val = Number(ctl.value);
  if (!isFinite(val)) { $('ahint').className = 'dhint bad'; $('ahint').textContent = '⚠ 写入值无效'; return; }
  const key = `${arrView.full.replace(/^Application\./, '')}[${idx}]`;
  arrWriteTarget = key;
  writePending = true;
  $('ahint').className = 'dhint';
  $('ahint').textContent = `写入中：${arrView.name}[${idx}] ← ${val} …`;
  /* 与首页/表格同一契约：key 不带 Application. 前缀，mode=set 写入后保留 */
  ws && ws.send(JSON.stringify({ cmd: 'writeTest', key, mode: 'set', value: val }));
}

/* writeTest 结论回填到弹窗（只接住本弹窗发起的写入，避免与首页写入互相干扰） */
let arrWriteTarget = null;

/* 弹窗写入结论：只在弹窗打开且这次写入由弹窗发起时接管 */
function onArrWriteMsg(m) {
  if (!arrWriteTarget || !arrView || $('amodal').hidden) return;
  const hint = $('ahint');
  if (!hint) return;
  hint.className = 'dhint' + (m.level === 'err' ? ' bad' : m.level === 'ok' ? ' ok' : '');
  hint.textContent = m.text || '';
  if (/^└/.test(m.text || '')) {
    const okRun = /成功/.test(m.text || '');
    if (!okRun) { console.log('[arr] 写入未达预期：' + m.text); }
    arrWriteTarget = null;
    writePending = false;
    /* 立刻回读当前页，让改动马上反映出来（不等下一帧节流） */
    openArrPage(arrView.full, arrView.page);
  }
}

/* 分页按钮：表格行上点「分页」打开弹窗 */
$('tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button.apbtn');
  if (!btn) return;
  arrWriteTarget = null;
  openArrPage(btn.dataset.f, 0);
});

/* 把 VALUES 刷到表格（只改变化的单元格）
   行内输入框：非聚焦且未被用户改过时才跟随实时值，否则会把正在填的数字冲掉 */
function paint() {
  const tb = $('tbody');
  tb.querySelectorAll('td.v-val').forEach(td => {
    const f = td.dataset.v;
    const v = VALUES[f];
    if (!v) {
      /* 默认是完整读，所以走到这里几乎都是「PLC 上没有这个变量 / 类型不可读」。
         唯一例外：管理员显式设了 MYX_BIG_SYM_BYTES>0 开启按需读，
         那这类符号确实不参与轮询，必须说清楚是「刻意不扫」而不是刷新失效。 */
      const s = SYMS.find(x => x.full === f);
      if (s && s.onDemand && td.textContent === '--') {
        td.textContent = '按需';
        td.className = 'v-val od';
        td.title = `该符号 ${s.bytes}B，已按 MYX_BIG_SYM_BYTES 配置排除在周期扫描之外\n`
          + '（默认配置是完整读，不会出现此状态）\n'
          + '点右侧「' + (s.elem && s.elem.writable ? '分页' : '展开') + '」时按需读一次';
      }
      return;
    }
    const tr = td.closest('tr');
    if (tr) syncRowCtl(tr, v.disp);
    if (td.textContent === v.disp) return;
    td.textContent = v.disp;
    td.className = 'v-val ' + valClass(v.disp, v.kind);
  });
}

/* 实时值 → 行内控件回填（BOOL 下拉选当前值，数字框填数值） */
function syncRowCtl(tr, disp) {
  const ctl = tr.querySelector('.wnum');
  if (!ctl) return;
  if (document.activeElement === ctl) return;      /* 正在输入：不打扰 */
  if (ctl.dataset.dirty === '1') return;           /* 已手工改过：保留用户意图 */
  if (ctl.tagName === 'SELECT') {
    const want = disp === 'TRUE' ? '1' : '0';
    if (ctl.value !== want && (disp === 'TRUE' || disp === 'FALSE')) ctl.value = want;
  } else if (/^-?\d+(\.\d+)?$/.test(disp)) {
    if (ctl.value !== disp) ctl.value = disp;
  }
}

function valClass(disp, kind) {
  if (kind === 'array') return 'arr';
  if (kind === 'blob') return 'blob';
  if (disp === 'TRUE') return 't';
  if (disp === 'FALSE') return 'f';
  return 'num';
}

/* ── WS ── */
const ST_TEXT = { idle: '未连接', connecting: '握手中', online: '在线', reconnecting: '重连中', error: '握手失败' };
let wsRetry = 3000;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.onopen = () => {
    wsRetry = 3000;
    $('linkDot').className = 'dot on';
    $('linkText').textContent = '已连接';
  };
  ws.onclose = () => {
    $('linkDot').className = 'dot err';
    $('linkText').textContent = '服务端离线 · ' + Math.round(wsRetry / 1000) + 's 重连';
    setTimeout(connect, wsRetry);
    wsRetry = Math.min(Math.round(wsRetry * 1.6), 10000);
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'state') {
      if (m.state === 'online') { $('linkDot').className = 'dot on'; $('linkText').textContent = '在线'; }
      else if (m.state === 'error') { $('linkDot').className = 'dot err'; $('linkText').textContent = '握手失败'; }
      else { $('linkDot').className = 'dot'; $('linkText').textContent = ST_TEXT[m.state] || m.state; }
      /* 故障留痕：悬停顶栏状态可看最近一次异常原因与时间 */
      if (Array.isArray(m.events)) {
        const f = [...m.events].reverse().find(e => e.kind === 'err' || e.kind === 'sock');
        if (f) $('linkText').title = '最近异常 ' + new Date(f.ts).toLocaleTimeString() + ' · ' + f.text;
      }
      if (m.fullStats) renderStats(m.fullStats);
    }
    if (m.t === 'full') {
      const items = m.items || [];
      items.forEach(it => {
        const prev = VALUES[it.f];
        VALUES[it.f] = { disp: it.d, kind: kindOf(it.d) };
        if (it.c) { changedSet.add(it.f); flashRow(it.f); }
        else if (prev) changedSet.delete(it.f);
      });
      renderStats(m.stats);
      $('stSeq').textContent = m.seq;
      markFullFrame();
      countNoVal(items);
      paint();
      /* 「只看变化」勾选时，行集合取决于 changedSet，必须重建表格；
         否则勾上那一刻的行就是全部（通常为空），之后有变化也不出现。
         500ms 节流，避免每帧重排两百多行。 */
      if (onlyChanged && !refilterTimer) {
        refilterTimer = setTimeout(() => { refilterTimer = null; buildTable(); }, 500);
      }
      refreshArrIfOpen();          /* 分页面板开着：跟随刷新当前页的值 */
    }
    if (m.t === 'drill') renderDrill(m);
    if (m.t === 'drillw') onDrillWrite(m);
    if (m.t === 'wtest') { showDrillHint(m); onRowWriteMsg(m); onArrWriteMsg(m); }
    if (m.t === 'wcur') onRowWriteCur(m);
    if (m.t === 'app') {
      /* 程序切换：表格里的符号全变了，写入条与值一并作废（WS 已连着，不必重连） */
      writePending = false; VALUES = {}; changedSet = new Set();
      arrView = null;              /* 换程序：符号都变了，分页面板作废 */
      loadAll();
    }
  };
}

function kindOf(disp) {
  if (disp.startsWith('[')) return 'array';
  if (/\dB · /.test(disp)) return 'blob';
  return 'scalar';
}

function flashRow(full) {
  const tr = document.querySelector(`tr[data-f="${CSS.escape(full)}"]`);
  if (!tr) return;
  tr.classList.remove('changed');
  void tr.offsetWidth;
  tr.classList.add('changed');
}

function renderStats(s) {
  if (!s) return;
  $('stLists').textContent = s.lists || '--';
  $('stEntries').textContent = s.entries || '--';
  $('stBytes').textContent = s.bytes ? (s.bytes / 1024).toFixed(1) + ' KB' : '--';
  $('stMs').textContent = s.ms ? s.ms + ' ms' : '--';

  /* 扫描耗时 = 块数 × 单块往返（PLC 强制逐块 ACK，无法省）。
     这里只负责把「为什么是这个数」讲清楚，不改行为：
       · 全部符号都参与轮询（默认完整读），所以数据量决定块数
       · 单块往返由链路决定，换有线/关 VPN/关网卡节能才有效
     若真实刷新间隔明显超过目标周期，说明「一轮读不完」，如实标黄而不是假装正常。 */
  const per = (s.blocks && s.ms) ? s.ms / s.blocks : 0;
  const slowLink = per > 3;
  const lag = s.gapMs && s.period ? (s.gapMs > s.period * 2.2) : false;
  if (s.blocks && s.ms) {
    $('stMs').title = `共 ${s.blocks} 块 · 每块 ${per.toFixed(2)}ms\n`
      + '（PLC 按 448B/块 分包，每块都要单独 ACK；耗时 ≈ 块数 × 单块往返）'
      + (s.onDemand
          ? `\n已启用按需读：${s.onDemand} 个符号（${(s.onDemandBytes / 1024).toFixed(1)}KB）不参与轮询`
          : '\n完整读：全部符号每轮都刷新（这是默认行为）')
      + (s.gapMs ? `\n实际刷新间隔 ${s.gapMs}ms（目标 ${s.period}ms）` : '')
      + (slowLink ? '\n\n单块往返偏高（' + per.toFixed(1) + 'ms）：多为 Wi-Fi / 跨网段 / 网卡节能。'
        + '\n换网线直连、设 MYX_SRC 固定有线、关 VPN/代理，可降到 1ms 以下。' : '')
      + (lag && !slowLink ? '\n\n实际间隔明显大于目标周期：一轮读不完与周期的差额，属正常（不会丢数据）。' : '');
    $('stMs').style.color = (slowLink || lag) ? '#FFB020' : '';
  } else {
    $('stMs').title = '全量扫描一轮耗时';
    $('stMs').style.color = '';
  }
}

/* 刷新活性指示：每收到一帧全量数据就记时刻。
   PLC 值本身可能长时间不变（设备静止），只靠"数字变了"看不出还在刷新，
   所以这里显式给出最近一次刷新时间；同时统计读不到值的符号数，
   用来区分「没刷新」和「刷新了但这台 PLC 上没有这个变量」。 */
let lastFullAt = 0;
let fullFrames = 0;
function markFullFrame() {
  lastFullAt = Date.now();
  fullFrames++;
  const el = $('stUpd');
  if (!el) return;
  const d = new Date(lastFullAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  el.textContent = hh + ':' + mm + ':' + ss;
  el.title = `最近一次全量刷新 ${hh}:${mm}:${ss} · 已收到 ${fullFrames} 帧`;
}

function countNoVal(items) {
  const bad = items.filter(it => it.d === '--').length;
  const el = $('stNoVal');
  if (!el) return;
  el.textContent = bad ? `${bad}/${items.length}` : '0';
  el.className = bad ? 'bad' : '';
  el.title = bad
    ? `有 ${bad} 个符号读不到值：多为该变量不存在于当前 PLC（点表来自别的工程），或类型不支持读取`
    : '全部符号都能读到值';
}

/* ── 交互 ── */
let qt = null;
$('q').oninput = (e) => {
  clearTimeout(qt);
  qt = setTimeout(() => {
    q = e.target.value.trim().toLowerCase();
    buildTable();
  }, 180);
};
$('onlyChanged').onchange = (e) => { onlyChanged = e.target.checked; buildTable(); };

/* ────────── 结构体钻取：展开成员值 + 可写成员直接写入 ────────── */
let drillKey = null;
const NUM_TYPES = new Set(['BOOL', 'SINT', 'USINT', 'BYTE', 'INT', 'UINT', 'WORD', 'DINT', 'UDINT', 'DWORD', 'REAL', 'LREAL', 'TIME']);

/* 事件委托：展开按钮（表格会被搜索/分组反复重建，委托到 tbody 最稳） */
$('tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button.drill');
  if (!btn) return;
  openDrill(btn.dataset.f);
});

/* ── 表格内写入：点「写入」或输入框回车即提交 ── */
$('tbody').addEventListener('click', (e) => {
  const go = e.target.closest('button.wgo');
  if (go) submitRowWrite(go.closest('tr'));
});

/* 输入框改动标记：用户改过之后不再被实时广播覆盖 */
$('tbody').addEventListener('input', (e) => {
  const ctl = e.target.closest('.wnum');
  if (ctl) ctl.dataset.dirty = '1';
});
$('tbody').addEventListener('change', (e) => {
  const ctl = e.target.closest('.wnum');
  if (ctl) ctl.dataset.dirty = '1';
});

$('tbody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const ctl = e.target.closest('.wnum');
  if (!ctl) return;
  e.preventDefault();
  submitRowWrite(ctl.closest('tr'));
});

function submitRowWrite(tr) {
  if (!tr) return;
  const f = tr.dataset.f;
  if (!f) return;
  const ctl = tr.querySelector('.wnum');
  if (!ctl || ctl.value === '') { toast('⚠ 请先填入写入值', 'err'); return; }
  const val = Number(ctl.value);
  if (!isFinite(val)) { toast('⚠ 写入值无效', 'err'); return; }
  const name = tr.querySelector('.v-name').textContent.replace(/^[^.]*\./, '');
  writePending = true;
  toast(`写入中：${name} ← ${ctl.value} …`, '');
  /* 与服务端 writeTest 同一契约：key 不带 Application. 前缀，mode=set 写入后保留 */
  const key = f.replace(/^Application\./, '');
  ws && ws.send(JSON.stringify({ cmd: 'writeTest', key, mode: 'set', value: val }));
}

/* 底部吐司提示（写入结果 / 参数问题），3.5s 自动消失 */
let toastTimer = null;
function toast(text, kind) {
  const box = $('wtoast');
  if (!box) return;
  box.hidden = false;
  box.className = 'wtoast' + (kind ? ' ' + kind : '');
  box.textContent = text;
  clearTimeout(toastTimer);
  if (kind && kind !== 'run') {
    toastTimer = setTimeout(() => { box.hidden = true; }, 3500);
  }
}

/* wtest 广播 → 吐司提示；结论行（└ 开头）落地后停止跟踪 */
function onRowWriteMsg(m) {
  if (!writePending) return;
  const t = m.text || '';
  const kind = m.level === 'err' ? 'err' : m.level === 'ok' ? 'ok' : 'run';
  toast(t.replace(/^[│┌└]\s*/, ''), kind);      /* 去掉树形前缀，吐司里更干净 */
  if (/^└/.test(t)) writePending = false;
}

/* 写入落地后即时刷新该行显示（不必等下一轮全量广播） */
function onRowWriteCur(m) {
  if (!m || !m.key) return;
  const f = 'Application.' + m.key;
  const td = document.querySelector(`td.v-val[data-v="${CSS.escape(f)}"]`);
  const disp = typeof m.value === 'boolean' ? (m.value ? 'TRUE' : 'FALSE') : String(m.value);
  if (td) { td.textContent = disp; td.className = 'v-val ' + valClass(disp, 'scalar'); }
  VALUES[f] = { disp, kind: 'scalar' };
  const tr = td ? td.closest('tr') : null;
  if (tr) syncRowCtl(tr, disp);
}

function openDrill(full) {
  drillKey = full;
  $('dmodal').hidden = false;
  $('dname').textContent = '载入中…';
  $('dtype').textContent = '';
  $('dcomment').textContent = '';
  $('dms').textContent = '';
  $('dtbody').innerHTML = '';
  $('dhint').textContent = '正在读取成员…';
  ws && ws.send(JSON.stringify({ cmd: 'drill', key: full }));
}

$('dclose').onclick = () => { $('dmodal').hidden = true; drillKey = null; };
$('drefresh').onclick = () => { drillKey && openDrill(drillKey); };
$('dmodal').addEventListener('click', (e) => { if (e.target === $('dmodal')) $('dclose').onclick(); });

function renderDrill(m) {
  if (m.error) {
    $('dhint').textContent = '✗ ' + m.error;
    $('dname').textContent = drillKey || '--';
    return;
  }
  drillKey = m.key;
  drillExpanded = new Set();                      /* 展开状态：重开/刷新重置，默认只显示第一层 */
  const short = m.sym.gvl.replace(/^.*\./, '') + '.' + m.sym.name;
  $('dname').textContent = short;
  $('dtype').textContent = m.sym.type + (m.sym.bytes ? ' · ' + m.sym.bytes + 'B' : '');
  $('dcomment').textContent = m.sym.comment || '';
  const rm = m.readMode === 'whole'
    ? `整读 1 次 ${m.blobBytes}B`
    : (m.readMode === 'names' ? '成员名分批读' : '离线结构');
  $('dms').textContent = `${m.leafCount || 0} 叶子 · ${(m.rows || []).length} 行 · ${rm}${m.online ? ' · ' + m.ms + 'ms' : ''}`;
  if (m.learnNote) $('dms').textContent = m.learnNote + ' · ' + $('dms').textContent;

  const tb = $('dtbody');
  tb.innerHTML = (m.rows || []).map(r => {
    const anc = r.anc || '';
    if (r.note) return `<tr class="dnote" data-anc="${esc(anc)}" data-depth="${r.depth || 0}">
      <td colspan="4" style="padding-left:${10 + (r.depth || 0) * 18}px">… ${esc(r.note)}</td></tr>`;

    const shortP = String(r.path).replace(/^Application\./, '').replace(/^.*?([^.[]*(?:\[[^\]]*\])?)$/, '$1');
    const indent = 10 + (r.depth || 0) * 18;
    if (r.node) {
      /* 中间层（数组元素 / 子结构体）：带展开按钮，值列显示成员数 */
      return `<tr data-p="${esc(r.path)}" data-anc="${esc(anc)}" data-depth="${r.depth || 0}" class="dnode">
        <td class="d-path" style="padding-left:${indent}px">
          <button class="dtoggle" data-k="${esc(r.path)}">▸</button>
          <span class="dn-name">${esc(shortP)}</span>
        </td>
        <td class="d-type">${esc(r.type)}</td>
        <td class="d-val dim">${r.childCount} 项</td>
        <td class="d-wio"></td>
      </tr>`;
    }

    const val = r.value === null || r.value === undefined ? '--' : String(r.value);
    const valTxt = r.enumName ? `${esc(val)} · ${esc(r.enumName)}` : esc(val);
    let wio = '';
    if (r.writable && NUM_TYPES.has(String(r.type || '').toUpperCase())) {
      if (String(r.type).toUpperCase() === 'BOOL') {
        wio = `<select class="dnum" data-k="${esc(r.path)}" data-t="BOOL">
          <option value="0">0 (FALSE)</option><option value="1">1 (TRUE)</option></select>
          <button class="dw" data-k="${esc(r.path)}">写</button>`;
      } else if (r.enumMap) {
        const opts = Object.entries(r.enumMap).sort((a, b) => a[1] - b[1])
          .map(([n, v]) => `<option value="${v}">${esc(n)} (${v})</option>`).join('');
        wio = `<select class="dnum" data-k="${esc(r.path)}">${opts}</select>
          <button class="dw" data-k="${esc(r.path)}">写</button>`;
      } else {
        wio = `<input class="dnum" data-k="${esc(r.path)}" type="number" step="any" value="${esc(val === '--' ? '' : val)}">
          <button class="dw" data-k="${esc(r.path)}">写</button>`;
      }
    }
    return `<tr data-p="${esc(r.path)}" data-anc="${esc(anc)}" data-depth="${r.depth || 0}">
      <td class="d-path" style="padding-left:${indent}px"><span class="leaf-dot"></span>${esc(shortP)}</td>
      <td class="d-type">${esc(r.type)}</td>
      <td class="d-val">${valTxt}</td>
      <td class="d-wio">${wio}</td>
    </tr>`;
  }).join('');

  $('dhint').textContent = !m.online
    ? '结构来自 XML 符号配置（PLC 离线）——实时值待链路在线后点「刷新」读取'
    : m.learnNote
      ? m.learnNote
      : m.readMode === 'whole'
        ? '整符号一次读取 · 成员按 XML 偏移本地解码 · 写入按成员名单独写'
        : m.shiftWarn
          ? '⚠ 整读不可用已回退成员名读取，部分条目异常时列表后半段值可能错位'
          : '该符号不支持整读（UNION 等），已按成员名分批读 · 写入按成员名单独写';

  /* 默认值选中：BOOL / 枚举下拉框定位到当前值 */
  tb.querySelectorAll('select.dnum').forEach(sel => {
    const tr = sel.closest('tr');
    const cur = tr && tr.querySelector('.d-val');
    if (!cur) return;
    const num = (cur.textContent.split('·')[0] || '').trim();
    if (/^\d+(\.\d+)?$/.test(num)) sel.value = num;
  });

  applyDrillVisibility();
}

/* 折叠可见性：某行可见 = 其全部祖先都在 drillExpanded 中（第一层恒可见） */
let drillExpanded = new Set();

function applyDrillVisibility() {
  document.querySelectorAll('#dtbody tr[data-anc]').forEach(tr => {
    const anc = (tr.dataset.anc || '').split('|').filter(Boolean);
    tr.hidden = !anc.every(p => drillExpanded.has(p));
  });
}

/* 展开/收起：父行按钮切换 + 图标随状态切换 */
$('dtbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button.dtoggle');
  if (!btn) return;
  const p = btn.dataset.k;
  if (drillExpanded.has(p)) {
    /* 收起：同时收起所有更深层的展开状态 */
    drillExpanded.forEach(x => { if (x.startsWith(p + '.') || x.startsWith(p + '[')) drillExpanded.delete(x); });
    drillExpanded.delete(p);
    btn.textContent = '▸';
    btn.classList.remove('open');
  } else {
    drillExpanded.add(p);
    btn.textContent = '▾';
    btn.classList.add('open');
  }
  applyDrillVisibility();
});

/* 写入按钮：把成员路径 + 输入值发给服务端（服务端会再验 XML access 与登记缓存） */
$('dtbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button.dw');
  if (!btn) return;
  const tr = btn.closest('tr');
  const input = tr && (tr.querySelector('input.dnum') || tr.querySelector('select.dnum'));
  if (!input || input.value === '') { $('dhint').textContent = '⚠ 请先输入要写入的值'; return; }
  $('dhint').textContent = `写入中：${btn.dataset.k} ← ${input.value} …`;
  ws && ws.send(JSON.stringify({ cmd: 'drillWrite', key: btn.dataset.k, value: Number(input.value) }));
});

function onDrillWrite(m) {
  const tr = document.querySelector(`tr[data-p="${CSS.escape(m.key)}"]`);
  if (tr) {
    const td = tr.querySelector('.d-val');
    if (td && m.value !== null && m.value !== undefined) td.textContent = String(m.value);
    tr.classList.remove('changed'); void tr.offsetWidth; tr.classList.add('changed');
  }
}

function showDrillHint(m) {
  const hint = $('dhint');
  hint.textContent = m.text || '';
  hint.className = 'dhint ' + (m.level === 'err' ? 'err' : m.level === 'ok' ? 'ok' : '');
}
