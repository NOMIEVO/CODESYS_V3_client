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

/* ── 启动 ── */
(async function init() {
  await loadAll();
  connect();
})();

/* 载入元信息 + 符号表并重建表格（程序切换时复用，不重连 WS） */
async function loadAll() {
  try {
    const m = await (await fetch('/api/meta')).json();
    if (m.app) $('fbarApp').textContent = `程序 ${m.app} · XML 符号表 · 分批登记 · 单轮 ExecuteRead 全量轮询`;
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
    if (comp) {
      act = `<button class="drill" data-f="${esc(s.full)}">展开</button>`;
    } else if (isWritableScalar(s)) {
      /* 行内直接给输入框：不用先点「写」才出现，看到就能改 */
      act = writeCtlHtml(s);
    } else {
      act = `<span class="ro">${rw ? '不可单值写' : '只读'}</span>`;
    }
    return `<tr data-f="${esc(s.full)}">
      <td class="v-name"><span class="gvl">${esc(gvlShort)}.</span>${esc(s.name)}</td>
      <td class="v-type">${esc(s.type)}</td>
      <td class="v-val" data-v="${esc(s.full)}">--</td>
      <td class="v-size">${s.bytes}B</td>
      <td class="v-act">${act}</td>
    </tr>`;
  }).join('');
  $('resultHint').textContent = `${list.length} 个`;
  paint();
}

/* 把 VALUES 刷到表格（只改变化的单元格）
   行内输入框：非聚焦且未被用户改过时才跟随实时值，否则会把正在填的数字冲掉 */
function paint() {
  const tb = $('tbody');
  tb.querySelectorAll('td.v-val').forEach(td => {
    const f = td.dataset.v;
    const v = VALUES[f];
    if (!v) return;
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
      paint();
    }
    if (m.t === 'drill') renderDrill(m);
    if (m.t === 'drillw') onDrillWrite(m);
    if (m.t === 'wtest') { showDrillHint(m); onRowWriteMsg(m); }
    if (m.t === 'wcur') onRowWriteCur(m);
    if (m.t === 'app') {
      /* 程序切换：表格里的符号全变了，写入条与值一并作废（WS 已连着，不必重连） */
      writePending = false; VALUES = {}; changedSet = new Set();
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
