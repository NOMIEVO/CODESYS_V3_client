/* verify.js — 协议验证台前端 */
'use strict';

const $ = (id) => document.getElementById(id);

let META = null;
window.__dbg = { msgs: {}, errors: [] };   // 诊断钩子（?debug 时可用 CDP 读取）
let tags = [];
let tagMap = {};
let symbols = [];          // 全量符号表（rw 标量，弹窗选择用）
let symMap = {};           // key → symbol
let curTarget = '';        // 当前写入目标 key（点表内或全量符号）
let watch = [];            // 监控列表（key 数组，localStorage 按程序持久化）
let watchEls = {};         // key → 行元素引用（实时值更新用）
let fullDisp = {};         // full 路径 → 展示值（全量广播快照）
let watchDisp = {};        // key → 展示值（服务端 wvals：数组元素/结构体成员实时值）
let memberType = {};       // key → IEC 类型（结构体成员路径的类型表，wvals 广播补全）
let ws = null;
let state = 'idle';
let lastValues = {};
let rttHistory = [];
let hsEls = {};
let logCount = 0;
let autoScroll = true;
let wPrev = {};          // key → 上次写入前的原值（用于手动恢复）
let boolTarget = {};     // key → BOOL 目标状态（1 置位 / 0 复位）
let valDirty = false;    // 写入值输入框是否已被用户手动改动（改动后不再被实时广播覆盖）
let valKey = null;       // 输入框当前所属的 key（换目标即重置脏标记）

const STEPS = [
  { n: 1, label: 'NS 查询', desc: '设备名发现' },
  { n: 2, label: '主连接 NS', desc: 'seq=02 拓扑对齐' },
  { n: 3, label: '开通道', desc: 'chId 分配' },
  { n: 4, label: '会话创建', desc: 'service 01/01' },
  { n: 5, label: '登录', desc: 'session_id 下发' },
  { n: 6, label: 'GetRoot', desc: '根句柄 + 设备令牌' },
  { n: 7, label: 'PrepareRead', desc: '名单登记' },
];

/* ══════════ PLC 配置弹窗（IP / 端口） ══════════ */
let cfgDefaults = { host: '192.168.1.92', port: 11740 };

function showEndpoint(host, port) {
  $('epHost').textContent = host;
  $('epPort').textContent = ':' + port;
  if (META) { META.host = host; META.port = port; }
}

async function openCfg() {
  $('cfgMask').hidden = false;
  $('cfgNote').textContent = '';
  $('cfgNote').className = 'cfg-note';
  try {
    const d = await (await fetch('/api/config')).json();
    if (d.defaults) cfgDefaults = d.defaults;
    $('cfgHost').value = d.host || '';
    $('cfgPort').value = d.port || '';
    $('cfgNote').textContent = d.source === 'file'
      ? '当前配置来自 plc-config.json（界面保存过）'
      : d.source === 'env' ? '当前配置来自环境变量（保存后以文件为准）' : '当前为内置默认值';
  } catch (e) {
    $('cfgHost').value = META ? META.host : '';
    $('cfgPort').value = META ? META.port : '';
    $('cfgNote').textContent = '读取当前配置失败：' + e.message;
  }
  $('cfgHost').focus();
  $('cfgHost').select();
}
function closeCfg() { $('cfgMask').hidden = true; }

async function saveCfg() {
  const host = $('cfgHost').value.trim();
  const port = $('cfgPort').value.trim();
  const note = $('cfgNote');
  /* 前端先做一遍格式检查，避免明显错误也去打扰 PLC
     ⚠️ 纯数字点 / 前三段是数字 → 必须按 IPv4 严格校验
        （否则 999.1.1.1、192.168.1.1a 都会被主机名规则放行） */
  const looksLikeIp = /^[\d.]+$/.test(host) || /^\d+\.\d+\.\d+\./.test(host);
  const ipOk = looksLikeIp
    ? (host.split('.').length === 4 && host.split('.').every(x => /^\d{1,3}$/.test(x) && +x <= 255))
    : /^[A-Za-z0-9]([A-Za-z0-9\-.]*[A-Za-z0-9])?$/.test(host);
  const p = Number(port);
  if (!ipOk) { note.className = 'cfg-note bad'; note.textContent = '✗ IP 格式不正确（例：192.168.1.92，每段 0..255）'; return; }
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    note.className = 'cfg-note bad'; note.textContent = '✗ 端口须为 1..65535 的整数'; return;
  }
  const btn = $('cfgSave');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await fetch(`/api/config?host=${encodeURIComponent(host)}&port=${p}`, { method: 'POST' });
    const d = await r.json();
    if (!d.ok) { note.className = 'cfg-note bad'; note.textContent = '✗ ' + (d.error || '保存失败'); return; }
    showEndpoint(d.host, d.port);
    note.className = 'cfg-note ok';
    note.textContent = '✓ 已保存，正在用新地址重新握手…';
    pushLog('sys', `── PLC 地址已改为 ${d.host}:${d.port}，重连中 ──`);
    setTimeout(closeCfg, 900);
  } catch (e) {
    note.className = 'cfg-note bad';
    note.textContent = '✗ 请求失败：' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '保存并重连';
  }
}

/* ══════════ 初始化 ══════════ */
async function boot() {
  META = await (await fetch('/api/meta')).json();
  tags = META.tags;
  tags.forEach(t => { tagMap[t.key] = t; });

  showEndpoint(META.host, META.port);
  $('periodSel').value = String(META.period || 500);
  /* 顶栏只留「协议验证台」，程序名在中间列的程序列表里看（原来这里的副标题已移除） */
  if (META.period !== undefined) document.title = '协议验证台 · ' + (META.app || '');

  renderHandshake();
  await loadSymbols();
  loadWatch();
  renderPickTarget();
  renderWatch();
  bindImport();
  loadApps();
  checkEnv();          /* 导入依赖 python：打开页面就把环境问题摆出来 */
  drawRtt();
  bindUI();
  connectWS();
}

/* ══════════ 全量符号表（写入验证弹窗数据源） ══════════ */
async function loadSymbols() {
  try {
    const d = await (await fetch('/api/symbols')).json();
    /* 收三类：① rw 标量（原样可直接写）
       ② rw 数组 —— 弹窗里展开成 aAlarmFlag[0] / aAxisCtl[3] 逐个可选；
          元素是结构体时再往下钻到成员（/api/members）
       ③ rw 结构体符号 —— 直接展开成员 */
    symbols = (d.symbols || []).filter(s => {
      if (!/w/i.test(s.access || '')) return false;
      if (s.elem) return true;
      if (/^ARRAY/.test(s.type || '')) return false;    /* 数组解析失败（无 elem 元信息），不可展开 */
      if (/^D_/.test(s.type || '')) return false;       /* 设备类型，无成员表 */
      return true;                                      /* 标量 或 T_ 结构体 */
    });
    symMap = {};
    symbols.forEach(s => { symMap[s.full.replace(/^Application\./, '')] = s; });
  } catch (e) {
    symbols = []; symMap = {};
  }
}

/* 可直接写入的 IEC 元素类型（与后端 WRITABLE_IEC 对齐） */
const WRITABLE_BASE = new Set(['BOOL', 'BYTE', 'SINT', 'USINT', 'INT', 'UINT', 'WORD',
  'DINT', 'UDINT', 'DWORD', 'TIME', 'REAL', 'LREAL', 'LINT']);

/* 数组元素 key 解析：GVL_MAIN.aAlarmFlag[3] → {base, idx} */
function parseElemKey(k) {
  const m = /^(.*)\[(-?\d+)\]$/.exec(String(k || ''));
  return m ? { base: m[1], idx: Number(m[2]) } : null;
}

/* 拆分「符号名 + 路径后缀」。
   ⚠️ 符号名本身可能含点（GVL 名与变量名都以点分隔），不能按第一个 . 切，
   必须取符号表里的最长匹配前缀。 */
function splitKeyBase(k) {
  const s = String(k || '');
  if (symMap[s]) return { base: s, suffix: '' };
  let best = '';
  for (const b of Object.keys(symMap)) {
    if ((s.startsWith(b + '.') || s.startsWith(b + '[')) && b.length > best.length) best = b;
  }
  return best ? { base: best, suffix: s.slice(best.length) } : { base: s, suffix: '' };
}

/* ══════════ 握手时间线 ══════════ */
function renderHandshake() {
  const box = $('handshake');
  box.innerHTML = '';
  hsEls = {};
  const sum = document.createElement('div');
  sum.className = 'hs-summary';
  sum.id = 'hsSummary';
  sum.innerHTML = '<b>链路</b> 空闲<br><b>拓扑</b> 单连接 · 读写互斥队列';
  STEPS.forEach(s => {
    const el = document.createElement('div');
    el.className = 'hs-item pending';
    el.innerHTML = `
      <div class="hs-dot">${s.n}</div>
      <div class="hs-body">
        <div class="hs-name">${s.label}</div>
        <div class="hs-detail">${s.desc}</div>
      </div>
      <div class="hs-ms"></div>`;
    box.appendChild(el);
    hsEls[s.n] = el;
  });
  box.appendChild(sum);
  updateHsCount();
}

function updateHandshake(list) {
  // 重置
  STEPS.forEach(s => {
    const el = hsEls[s.n];
    if (!el) return;
    el.className = 'hs-item pending';
    el.querySelector('.hs-detail').textContent = s.desc;
    el.querySelector('.hs-ms').textContent = '';
  });
  (list || []).forEach(it => {
    const el = hsEls[it.n];
    if (!el) return;
    el.className = 'hs-item ' + (it.status || 'pending');
    el.querySelector('.hs-detail').textContent = it.detail || '';
    el.querySelector('.hs-ms').textContent = it.ms != null ? it.ms + 'ms' : '';
  });
  updateHsCount();
  renderSummary();
}

function updateHsCount() {
  const done = Object.values(hsEls).filter(el => el.classList.contains('ok')).length;
  $('hsCount').textContent = done + '/7';
}

function renderSummary() {
  const el = $('hsSummary');
  if (!el) return;
  const ok = Object.values(hsEls).filter(e => e.classList.contains('ok')).length;
  const cx = ws && ws.readyState === 1 ? '在线' : '离线';
  el.innerHTML = `<b>完成</b> <span class="v">${ok}/7</span> 阶段　<b>WebSocket</b> ${cx}<br>`
    + `<b>拓扑</b> 单连接 · 读写互斥队列`;
}

/* ══════════ XML 导入 · 程序列表 · 切换（中列面板） ══════════ */
function impStatus(text, cls) {
  const el = $('impStatus');
  el.hidden = false;
  el.className = 'imp-status ' + (cls || '');
  el.textContent = text;
}

async function loadApps() {
  try {
    const d = await (await fetch('/api/apps')).json();
    renderApps(d);
  } catch (e) {
    $('appList').innerHTML = '<div class="app-empty">程序列表加载失败：' + e.message + '</div>';
  }
}

function renderApps(d) {
  const box = $('appList');
  box.innerHTML = '';
  d.apps.forEach(a => {
    const row = document.createElement('div');
    row.className = 'app-row' + (a.app === d.current ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'app-info';
    info.innerHTML = `<div class="app-name">${a.app}</div>
      <div class="app-sub">${a.points} 点 · ${a.generatedAt || '时间未知'}</div>`;
    row.appendChild(info);
    if (a.app === d.current) {
      const b = document.createElement('span');
      b.className = 'app-cur';
      b.textContent = '当前';
      row.appendChild(b);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn sm ghost';
      btn.textContent = '切换';
      btn.onclick = () => selectApp(a.app);
      row.appendChild(btn);
    }
    const del = document.createElement('button');
    del.className = 'btn sm ghost app-del';
    del.textContent = '删除';
    del.title = '删除该程序的全部生成数据与原始 XML';
    del.onclick = () => deleteApp(a.app);
    row.appendChild(del);
    box.appendChild(row);
  });
  if (!d.apps.length) box.innerHTML = '<div class="app-empty">还没有已导入程序——把 XML 拖到上方虚线框</div>';
  $('impMeta').textContent = `${d.apps.length} 个程序 · 当前 ${d.current}`;
}

async function deleteApp(app) {
  const cur = (META && META.app) || '';
  const lines = [
    `删除程序「${app}」？`,
    '',
    '将清理：点表 / 符号表 / 类型库 / 选点档案 / 全量表与钻取缓存 / 固件点表，以及 Test\\ 下的原始 XML。',
  ];
  if (app === cur) lines.push('这是当前程序——删除后将自动切换到剩余最新导入的程序。');
  lines.push('删除后不可恢复（需要时可重新导入 XML）。', '', '确定删除？');
  if (!confirm(lines.join('\n'))) return;
  impStatus(`删除 ${app} …`);
  try {
    const r = await fetch('/api/delete?app=' + encodeURIComponent(app), { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      let msg = `✓ 已删除 ${d.app}（清理 ${d.removed.length} 项）`;
      if (d.current !== d.app) msg += `，当前程序已切换为 ${d.current}`;
      impStatus(msg, 'ok');
    } else impStatus('✗ ' + d.error, 'err');
  } catch (e) { impStatus('✗ ' + e.message, 'err'); }
  loadApps();
}

async function selectApp(app) {
  impStatus(`切换到 ${app} …`);
  try {
    const r = await fetch('/api/select?app=' + encodeURIComponent(app), { method: 'POST' });
    const d = await r.json();
    if (d.ok) impStatus(`✓ 已切换 ${d.app}（${d.points} 点 · ${d.symbolCount} 符号），正在重新握手…`, 'ok');
    else impStatus('✗ ' + d.error, 'err');
  } catch (e) { impStatus('✗ ' + e.message, 'err'); }
  loadApps();
}

async function doImport(file) {
  /* 先问一句本机 python 能不能跑：不能跑就别让用户白等一轮生成，直接讲清原因 */
  const env = await checkEnv();
  if (env && env.ok === false && env.python && env.python.ok === false) {
    impStatus('✗ 导入中止：本机没有可用的 Python ' + env.python.need + '\n' + env.python.help, 'err');
    return;
  }
  impStatus(`导入 ${file.name}（${(file.size / 1024).toFixed(1)} KB）→ 生成数据文件中…`);
  $('drop').classList.add('busy');
  try {
    const buf = await file.arrayBuffer();
    const r = await fetch('/api/import?name=' + encodeURIComponent(file.name), { method: 'POST', body: buf });
    const d = await r.json();
    if (d.ok) {
      impStatus(`✓ 导入成功：程序 ${d.app}（${d.points} 点 · ${d.symbolCount} 符号），已自动切换并重新握手`, 'ok');
      loadApps();
    } else {
      impStatus('✗ 导入失败：' + d.error + (d.output ? '\n' + d.output : ''), 'err');
      /* python 缺失属环境问题：顺手把顶部检查条也刷成最新结论 */
      if (d.hint === 'python-missing') checkEnv();
    }
  } catch (e) { impStatus('✗ ' + e.message, 'err'); }
  $('drop').classList.remove('busy');
}

/* ── 环境自检：python 是否可用于导入（对应「gen_tags.py 退出码 9009」） ──
   9009 是 Windows 的「命令未找到」，说明子进程根本没跑脚本：没装 python、
   装时没勾 Add to PATH、或命中了 Microsoft Store 的占位别名。
   这里在页面打开时主动暴露，而不是等用户拖完文件才报错。 */
let envCache = null;
async function checkEnv(force) {
  if (envCache && !force) return envCache;
  try {
    const d = await (await fetch('/api/env')).json();
    envCache = d;
    const box = $('impEnv');
    if (d.python && d.python.ok === false) {
      box.innerHTML = '<b>导入不可用：本机没有可用的 Python ' + d.python.need + '+</b>\n'
        + '探测结果：\n' + d.python.tried.map(t => '  · ' + t).join('\n') + '\n\n'
        + d.python.help;
      box.hidden = false;
      $('drop').classList.add('busy');
    } else {
      box.hidden = true;
      $('drop').classList.remove('busy');
    }
    return d;
  } catch (e) { return null; }
}

function bindImport() {
  const drop = $('drop'), fi = $('fileInput');
  drop.onclick = () => fi.click();
  fi.onchange = () => { if (fi.files.length) doImport(fi.files[0]); fi.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = [...e.dataTransfer.files].find(f => /\.xml$/i.test(f.name));
    if (f) doImport(f); else impStatus('✗ 只接受 .xml 文件', 'err');
  };
}

/* 周期值：卡片区已让位 XML 导入面板——只维护 lastValues 供写入面板回读 */
function applyValues(items) {
  items.forEach(it => { lastValues[it.key] = it.value; });
  syncWritePanel();
}

/* 值格式化（写入面板用） */
function fmt(t, v) {
  if (v === null || v === undefined) return '—';
  if (t.type === 'BOOL') return v ? 'TRUE' : 'FALSE';
  const d = t.digits != null ? t.digits : 2;
  return Number(v).toFixed(d);
}

/* ══════════ RTT 图 ══════════ */
function drawRtt() {
  const cv = $('rttCanvas');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);

  const padT = 12, padB = 14, padL = 2, padR = 2;
  const gw = W - padL - padR, gh = H - padT - padB;

  const data = rttHistory;
  const maxV = Math.max(20, ...data) * 1.15;
  const minV = 0;

  // 网格
  ctx.strokeStyle = '#141D28';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + gh * (i / 3);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
  }

  if (data.length < 2) {
    ctx.fillStyle = '#2E3B4A';
    ctx.font = '500 18px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('等待采样', W / 2, H / 2 + 6);
    return;
  }

  const n = 80;
  const x = (i) => padL + gw * (i / (n - 1));
  const y = (v) => padT + gh * (1 - (v - minV) / (maxV - minV));

  // 面积
  const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, 'rgba(43,224,176,.28)');
  grad.addColorStop(1, 'rgba(43,224,176,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), H - padB);
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(data.length - 1), H - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // 折线
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = '#2BE0B0';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 末点
  const lx = x(data.length - 1), ly = y(data[data.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#2BE0B0'; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(43,224,176,.18)'; ctx.fill();

  // y 轴上限标注
  ctx.fillStyle = '#33414F';
  ctx.font = '500 15px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(Math.round(maxV) + 'ms', W - padR - 4, padT + 12);
}

/* ══════════ 统计 ══════════ */
let lastStats = { reads: 0, ok: 0, fail: 0, txFrames: 0, rxFrames: 0 };
/* 读成功率按**最近 80 次**算（与 RTT 图窗口一致）。
   窗口由服务端按真实发生顺序维护（snap/rtt 里带 readWin）；
   服务端未带时退化为「相邻快照增量」推算——那份顺序不可靠，仅作兜底。 */
const READ_WIN = 80;
let readWin = [];                        /* 1 = 成功，0 = 失败 */
let serverWin = null;                    /* 服务端下发的权威窗口 */
let statsPrev = { reads: 0, fail: 0 };   /* 兜底路径：上一次快照的累计值 */

function applyStats(st, rtt, win) {
  if (win) serverWin = win;
  if (st) {
    const reads = Number(st.reads) || 0;
    const fail = Number(st.fail) || 0;
    if (reads < statsPrev.reads || fail < statsPrev.fail) {
      readWin = [];                      /* 计数归零（复位统计 / 重连重建）：窗口重开 */
    } else {
      const dReads = reads - statsPrev.reads;
      const dFail = fail - statsPrev.fail;
      if (dReads > 0) {
        const dOk = Math.max(0, dReads - dFail);
        for (let i = 0; i < dOk; i++) readWin.push(1);
        for (let i = 0; i < dFail; i++) readWin.push(0);
        if (readWin.length > READ_WIN) readWin.splice(0, readWin.length - READ_WIN);
      }
    }
    statsPrev = { reads, fail };
    lastStats = st;
  }
  const { reads, txFrames, rxFrames } = lastStats;
  const winArr = Array.isArray(serverWin) ? serverWin : readWin;
  const n = winArr.length;
  const okN = winArr.reduce((a, b) => a + b, 0);
  const rate = n ? (okN / n * 100) : 0;
  const kRate = $('kpiRate');
  kRate.textContent = n ? rate.toFixed(1) + '%' : '—';
  kRate.className = 'kpi-v ' + (n === 0 ? '' : rate >= 99 ? 'good' : rate >= 90 ? '' : 'bad');
  $('kpiReads').textContent = reads;
  $('txrx').textContent = `TX ${txFrames} / RX ${rxFrames}`;

  if (rtt != null) {
    $('kpiRtt').innerHTML = rtt + '<span class="u">ms</span>';
    const d = rttHistory;
    if (d.length) {
      const mn = Math.min(...d), mx = Math.max(...d);
      const av = d.reduce((a, b) => a + b, 0) / d.length;
      $('rttMin').textContent = mn + 'ms';
      $('rttAvg').textContent = av.toFixed(1) + 'ms';
      $('rttMax').textContent = mx + 'ms';
    }
    drawRtt();
  }
  /* 读帧数标红：只看最近 80 次里有没有失败（历史失败不该一直标红） */
  $('kpiReads').className = 'kpi-v ' + (n && okN < n ? 'bad' : '');
}

/* ══════════ 状态 ══════════ */
const STATUS_TEXT = {
  idle: '未连接', connecting: '握手中', online: '在线', reconnecting: '重连中', error: '握手失败',
};

function applyState(s) {
  const prev = state;
  state = s.state;
  const cls = s.state === 'error' ? 'error' : s.state;
  $('status').className = 'status ' + (cls === 'idle' ? '' : cls);
  $('statusText').textContent = STATUS_TEXT[s.state] || s.state;
  $('epDot').style.background = s.state === 'online' ? '#2BE0B0' : s.state === 'error' ? '#FF5F5F' : '#4E5D70';
  $('epDot').style.boxShadow = s.state === 'online' ? '0 0 8px rgba(43,224,176,.8)' : 'none';

  if (s.handshake) updateHandshake(s.handshake);

  /* 重新上线：以此刻为界，此前的故障一律视为历史，不再往顶栏弹 */
  if (s.state === 'online' && prev !== 'online') {
    onlineSince = Date.now();
    /* 刚恢复：故障条再留 3s，让人看到"刚才出了什么问题"，随后自动收起 */
    const bar = $('lastErr');
    if (bar && !bar.hidden) {
      clearTimeout(errHideTimer);
      errHideTimer = setTimeout(() => { if (state === 'online') bar.hidden = true; }, 3000);
    }
  }

  /* 故障留痕：快照带最近 12 条事件（含很久以前的历史失败）。
     ⚠️ 不能见 err 就弹——此前每帧快照都会把 11:04 的旧失败重新顶到顶栏，
     造成"报警一直残留"。只有本次上线之后发生的故障才弹横幅。 */
  if (Array.isArray(s.events) && s.events.length) {
    const f = [...s.events].reverse().find(e => e.kind === 'err' || e.kind === 'sock');
    if (f) {
      rememberFault(f);                                    /* 悬停仍可查到最近异常 */
      if (s.state !== 'online' || f.ts > onlineSince) noteFault(f);
    }
  }

  if (s.stats) applyStats(s.stats, s.rtt && s.rtt.length ? s.rtt[s.rtt.length - 1] : null, s.readWin);
  if (s.rtt) { rttHistory = s.rtt.slice(-80); drawRtt(); }
  if (s.period) $('periodSel').value = String(s.period);

  $('btnConnect').textContent = s.state === 'online' ? '断开' : '连接';
  $('btnConnect').className = 'btn ' + (s.state === 'online' ? 'ghost' : 'primary');

  if (s.lastError) showError(s.lastError);
  if (s.lastBefore) { wPrev = Object.assign({}, s.lastBefore, wPrev); syncWritePanel(); }
  renderSummary();
}

let errShown = '';
function showError(msg) {
  if (msg === errShown) return;
  errShown = msg;
  pushLog('err', '✗ ' + msg);
}

/* ══════════ 日志 ══════════ */
function pushLog(level, text, hex) {
  const body = $('consoleBody');
  const d = new Date();
  const ts = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  const tagMap2 = { sys: '──', tx: '→', rx: '←', ok: '✓', err: '✗', warn: '!' };

  const line = document.createElement('div');
  line.className = 'line ' + level;
  line.innerHTML = `<span class="ts">${ts}</span><span class="tag">${tagMap2[level] || '·'}</span><span class="msg"></span>`;
  line.querySelector('.msg').textContent = text + (hex ? '   ' + hex : '');
  body.appendChild(line);
  logCount++;

  if (logCount > 400) { body.removeChild(body.firstChild); logCount--; }
  if (autoScroll) body.scrollTop = body.scrollHeight;
}

$('consoleBody').addEventListener('scroll', () => {
  const b = $('consoleBody');
  autoScroll = b.scrollTop + b.clientHeight >= b.scrollHeight - 24;
});

/* ══════════ 写入面板（全量模式） ══════════ */
function wlog(level, text) {
  const box = $('wLog');
  const div = document.createElement('div');
  div.className = level;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  /* 底部报文流水由服务端 log 事件写入，此处不重复 */
}

/* 取变量元数据：点表内直接取；点表外按全量符号表 XML 类型合成；
   结构体成员路径（ARR[3].Member）类型由 /api/members 或 wvals 广播补全 */
function tagOf(k) {
  if (tagMap[k]) return tagMap[k];
  const pe = parseElemKey(k);
  if (pe) {                        /* 数组元素：取父符号的元素基类型 */
    const arr = symMap[pe.base];
    if (!arr || !arr.elem) return null;
    const { lo, hi, base } = arr.elem;
    if (pe.idx < lo || pe.idx > hi) return null;
    const iec = String(base || '').toUpperCase();
    return { key: k, label: `${arr.name}[${pe.idx}]`, unit: '', type: iec,
             digits: iec === 'REAL' || iec === 'LREAL' ? 2 : 0 };
  }
  const s = symMap[k];
  if (s) return { key: k, label: s.name, unit: '', type: String(s.type).toUpperCase(), digits: 2 };
  /* 结构体成员：符号名 + 路径后缀（类型可能还没拿到，等 wvals 补上） */
  const { base, suffix } = splitKeyBase(k);
  if (suffix && symMap[base]) {
    const iec = String(memberType[k] || '').toUpperCase();
    return { key: k, label: base.split('.').pop() + suffix, unit: '', type: iec,
             digits: iec === 'REAL' || iec === 'LREAL' ? 2 : 0 };
  }
  return null;
}

/* 当前写入目标显示 */
function renderPickTarget() {
  const t = tagOf(curTarget);
  $('wTarget').textContent = t ? `${t.label} · ${t.type}` : '（未选择）';
  $('wTarget').classList.toggle('empty', !t);
}

/* 手动恢复行：显示上次写入前的原值 */
function updateRecall() {
  const k = curTarget;
  const box = $('wRecall');
  const t = tagOf(k);
  const prev = wPrev[k];
  if (!k || !t || prev === undefined || prev === null) { box.hidden = true; return; }
  box.hidden = false;
  $('wPrev').textContent = fmt(t, prev) + (t.unit ? ' ' + t.unit : '');
}

/* ══════════ 写入面板同步（按类型切换控件） ══════════
   BOOL  → 置位/复位 开关组
   其他  → 数字输入框 + 当前+1 */
function syncWritePanel() {
  const k = curTarget;
  const t = tagOf(k);
  const isBool = !!t && t.type === 'BOOL';

  /* 换目标即清除脏标记：新变量默认跟随实时值 */
  if (k !== valKey) { valKey = k; valDirty = false; }

  $('numRow').hidden = isBool;
  $('boolRow').hidden = !isBool;

  if (t && lastValues[k] !== undefined) {
    $('writeCur').textContent = fmt(t, lastValues[k]) + (t.unit ? ' ' + t.unit : '');
    /* 只在用户没动过输入框时跟随实时值，否则会把手填/「当前+1」冲掉 */
    if (!isBool && !valDirty && document.activeElement !== $('writeVal')) {
      $('writeVal').value = Number(lastValues[k]);
    }
  } else {
    $('writeCur').textContent = '—';
    if (!isBool && !valDirty && document.activeElement !== $('writeVal')) $('writeVal').value = '';
  }

  if (isBool) {
    /* 未选目标时默认取反当前值，一点即可写入 */
    const cur = Number(lastValues[k]) === 1 ? 1 : 0;
    if (boolTarget[k] === undefined) boolTarget[k] = cur ? 0 : 1;
    const tv = boolTarget[k];
    $('boolOn').classList.toggle('on', tv === 1);
    $('boolOff').classList.toggle('off-sel', tv === 0);
    $('btnSet').textContent = tv === 1 ? '写入 TRUE' : '写入 FALSE';
  } else {
    $('btnSet').textContent = '写入值';
  }

  /* 写入提示 */
  const hint = $('wHint');
  const tips = [];
  if (t && t.inputMapped) tips.push('<b>输入映射点</b> 写入 status=0 但被 PLC 扫描周期立即覆盖，值不会保持');
  if (t && t.type === 'BOOL') tips.push('BOOL 按 1 字节写入（4 字节会被 PLC 以 0x0F 拒绝）');
  if (t && t.type === '') tips.push('<b>类型未知</b> 请从「选择变量」里重新选该成员以获取类型');
  if (t && symMap[k]) tips.push('<b>点表外变量</b> 临时登记读取/写入，不影响主点表轮询');
  /* 结构体成员：明确是「按成员名寻址」，与整块读回按偏移换算不是一回事 */
  const sp = splitKeyBase(k);
  if (sp.suffix && symMap[sp.base]) tips.push('<b>结构体成员</b> 按成员名直接寻址写入（PLC 侧原子生效）');
  hint.innerHTML = tips.join('　');
  hint.hidden = tips.length === 0;

  updateRecall();
}

/* ══════════ 变量选择弹窗 ══════════ */
let pickOpenArrs = new Set();      /* 已展开的数组 base key */
let pickOpenStruct = new Set();    /* 已展开的结构体元素 key（如 GVL_AXIS.aAxisCtl[3]） */
let pickFocusElem = null;          /* 最近通过"元素切换"跳到过的元素 key（可能不在前 64 行内） */
const pickMemberCache = {};        /* key → 成员树（/api/members 结果，含 pending） */
const PICK_ARR_ROWS = 64;          /* 每个数组展开时最多渲染多少元素行 */

function openPick() {
  $('pickMask').hidden = false;
  $('pickSearch').value = '';
  renderPickList();
  $('pickSearch').focus();
}
function closePick() { $('pickMask').hidden = true; }

/* 设为写入目标（数组元素 / 结构体成员 / 点表外变量自动进监控，否则读不到实时值）
   type 已知时（从成员表点进来）先记下，面板可立刻用对控件，不等广播 */
function selectTarget(key, type) {
  if (type) memberType[key] = String(type).toUpperCase();
  curTarget = key;
  delete boolTarget[key];
  $('wLog').innerHTML = '';
  const needWatch = !tagMap[key] && !watch.includes(key);
  if (needWatch) { watch.push(key); saveWatch(); renderWatch(); }
  closePick();
  renderPickTarget();
  syncWritePanel();
}

/* 单行渲染（标量 / 数组元素 / 结构体成员共用）：点击选中为写入目标
   depth>0 时按层级缩进，视觉上体现从属关系 */
function pickRow(key, name, sub, frag, depth, type) {
  const row = document.createElement('div');
  row.className = 'pick-row' + (depth ? ' pick-elem' : '');
  if (depth) row.style.marginLeft = (18 + depth * 14) + 'px';
  row.title = key + (sub ? ' — ' + sub : '');
  const info = document.createElement('div');
  info.className = 'pick-info';
  info.innerHTML = `<div class="pick-name">${name}</div>
    <div class="pick-sub">${sub}${watch.includes(key) ? ' · 已监控' : ''}</div>`;
  row.appendChild(info);
  const wBtn = document.createElement('button');
  wBtn.className = 'btn sm ghost';
  wBtn.textContent = watch.includes(key) ? '已监控' : '＋监控';
  wBtn.onclick = (e) => {
    e.stopPropagation();
    if (!watch.includes(key)) { watch.push(key); saveWatch(); renderWatch(); wBtn.textContent = '已监控'; }
  };
  row.appendChild(wBtn);
  /* 结构体成员行：点击行即选中，同时把类型交给面板 */
  row.onclick = () => {
    selectTarget(key, type);
  };
  frag.appendChild(row);
  return row;
}

/* 结构体元素行：点开才去后端要成员树（一个结构体数组可能有几十个元素，全预取太浪费）
   成员树逐级折叠：结构体/数组子节点渲染成可展开的组，不直接平铺 149 行 */
function pickStructRow(key, name, sub, frag, depth) {
  const open = pickOpenStruct.has(key);
  const row = document.createElement('div');
  row.className = 'pick-row arr' + (open ? ' open' : '');
  if (depth) row.style.marginLeft = (18 + depth * 14) + 'px';
  row.title = key + ' — ' + sub;
  const info = document.createElement('div');
  info.className = 'pick-info';
  info.innerHTML = `<div class="pick-name">${name}
      <span class="arr-tag struct">结构体</span></div>
    <div class="pick-sub">${sub}</div>`;
  row.appendChild(info);
  const tBtn = document.createElement('button');
  tBtn.className = 'btn sm ghost';
  tBtn.textContent = open ? '收起' : '展开成员';
  row.appendChild(tBtn);
  row.onclick = (e) => {
    e.stopPropagation();
    if (pickOpenStruct.has(key)) pickOpenStruct.delete(key);
    else pickOpenStruct.add(key);
    if (pickOpenStruct.has(key) && !pickMemberCache[key]) loadMembers(key);
    renderPickList();
  };
  frag.appendChild(row);

  if (!open) return;
  renderMemberArea(key, depth + 1, frag, $('pickSearch').value.trim().toLowerCase());
}

/* 元素切换条：从一个结构体元素（xx[3]）直接跳到同数组的其它元素（xx[0]/[1]/…），
   不必收起再展开。
   为什么需要：一个结构体数组往往有十几个元素，每个元素的成员都一样（如 tState/...），
   逐个元素点「展开成员」再找同一个成员，操作代价很高；切换条可以停在成员树上平移。 */
function elemNavInfo(key) {
  const m = /^(.*)\[(\d+)\]$/.exec(String(key || ''));
  if (!m) return null;
  const meta = symMap[m[1]];                    /* 父数组符号（带 elem: lo/hi/base） */
  if (!meta || !meta.elem) return null;
  return { base: m[1], idx: Number(m[2]), lo: meta.elem.lo, hi: meta.elem.hi, name: meta.name };
}

function renderElemNav(key, depth, frag) {
  const n = elemNavInfo(key);
  if (!n) return;
  const box = document.createElement('div');
  box.className = 'pick-elemnav';
  box.style.marginLeft = (18 + depth * 14) + 'px';
  box.onclick = (e) => e.stopPropagation();

  const prev = document.createElement('button');
  prev.className = 'btn sm ghost';
  prev.textContent = '◀';
  prev.title = '上一个元素';
  prev.disabled = n.idx <= n.lo;
  prev.onclick = () => switchElem(key, n.idx - 1);
  box.appendChild(prev);

  const label = document.createElement('span');
  label.className = 'pick-elemnav-label';
  label.innerHTML = `元素 <b>${n.idx}</b> / ${n.name} · ${n.lo}..${n.hi}`;
  box.appendChild(label);

  const next = document.createElement('button');
  next.className = 'btn sm ghost';
  next.textContent = '▶';
  next.title = '下一个元素';
  next.disabled = n.idx >= n.hi;
  next.onclick = () => switchElem(key, n.idx + 1);
  box.appendChild(next);

  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = n.lo; inp.max = n.hi;
  inp.placeholder = '下标';
  inp.onclick = (e) => e.stopPropagation();
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const i = Number(inp.value);
    if (!Number.isInteger(i) || i < n.lo || i > n.hi) { inp.classList.add('bad'); return; }
    switchElem(key, i);
  };
  box.appendChild(inp);
  frag.appendChild(box);
}

/* 把"已展开"状态从当前元素搬到目标元素，并复用同一份成员缓存（同类型数组成员结构一致） */
function switchElem(fromKey, toIdx) {
  const n = elemNavInfo(fromKey);
  if (!n) return;
  if (!Number.isInteger(toIdx) || toIdx < n.lo || toIdx > n.hi) return;
  const toKey = `${n.base}[${toIdx}]`;
  pickOpenStruct.delete(fromKey);
  pickOpenStruct.add(toKey);
  pickFocusElem = toKey;                 /* 目标可能超出前 64 行，渲染时单独补一行 */
  if (!pickMemberCache[toKey]) loadMembers(toKey);
  renderPickList();
}

/* 成员区：loading / 错误 / 空 / 递归树 */
function renderMemberArea(key, depth, frag, q) {
  renderElemNav(key, depth, frag);
  const c = pickMemberCache[key];
  if (!c) {
    const ld = document.createElement('div');
    ld.className = 'pick-loading';
    ld.style.marginLeft = (18 + depth * 14) + 'px';
    ld.textContent = '正在读取成员表…';
    frag.appendChild(ld);
    return;
  }
  if (c.error) {
    const er = document.createElement('div');
    er.className = 'pick-loading bad';
    er.style.marginLeft = (18 + depth * 14) + 'px';
    er.textContent = '✗ ' + c.error;
    frag.appendChild(er);
    return;
  }
  if (!c.nodes || !c.nodes.length) {
    const em = document.createElement('div');
    em.className = 'pick-loading';
    em.style.marginLeft = (18 + depth * 14) + 'px';
    em.textContent = '该结构体内没有可写标量成员';
    frag.appendChild(em);
    return;
  }
  renderMemberNodes(c.nodes, key, depth, frag, q);
  if (c.truncated) {
    const tr = document.createElement('div');
    tr.className = 'pick-loading';
    tr.style.marginLeft = (18 + depth * 14) + 'px';
    tr.textContent = '节点过多，仅展开前若干项';
    frag.appendChild(tr);
  }
}

/* 拼接成员完整 key。
   ⚠️ 服务端 rel 是**相对根节点**的完整后缀（可含 tState.bValid / biAbsEn[0]），
   递归时不能再用父节点 key 去拼，否则会出现 xxx.tState.tState.bValid 这种重复前缀。 */
function joinMemberKey(rootKey, rel) {
  if (!rel) return rootKey;
  return String(rel).startsWith('[') ? rootKey + rel : rootKey + '.' + rel;
}

/* 递归渲染成员节点：叶子=可选行，组=可折叠行（默认全部收起） */
function renderMemberNodes(nodes, rootKey, depth, frag, q) {
  nodes.forEach(nd => {
    const key = joinMemberKey(rootKey, nd.rel);
    if (nd.leaf) {
      pickRow(key, nd.name, nd.type, frag, depth, nd.type);
      return;
    }
    /* 组节点：搜索结果命中内部成员时自动展开，便于定位 */
    const hit = q ? nodeHasMatch(nd, q) : false;
    const open = pickOpenStruct.has(key) || hit;
    const row = document.createElement('div');
    row.className = 'pick-row arr mem-group' + (open ? ' open' : '');
    row.style.marginLeft = (18 + depth * 14) + 'px';
    row.title = key + ' — ' + nd.type;
    const info = document.createElement('div');
    info.className = 'pick-info';
    const tagCls = nd.kind === 'array' ? '' : ' struct';
    const tagTxt = nd.kind === 'array' ? '子数组' : '子结构';
    info.innerHTML = `<div class="pick-name">${nd.name}
        <span class="arr-tag${tagCls}">${tagTxt}</span></div>
      <div class="pick-sub">${nd.type}${nd.count ? ' · ' + nd.count + ' 项' : ''}</div>`;
    row.appendChild(info);
    const b = document.createElement('button');
    b.className = 'btn sm ghost';
    b.textContent = open ? '收起' : '展开';
    row.appendChild(b);
    row.onclick = (e) => {
      e.stopPropagation();
      if (pickOpenStruct.has(key)) pickOpenStruct.delete(key);
      else pickOpenStruct.add(key);
      renderPickList();
    };
    frag.appendChild(row);

    if (!open) return;
    renderMemberNodes(nd.children || [], rootKey, depth + 1, frag, q);
    if (nd.note) {
      const nt = document.createElement('div');
      nt.className = 'pick-loading';
      nt.style.marginLeft = (18 + (depth + 1) * 14) + 'px';
      nt.textContent = nd.note;
      frag.appendChild(nt);
    }
  });
}

/* 节点内部是否有匹配搜索词的可写叶子 */
function nodeHasMatch(nd, q) {
  if (!nd) return false;
  if (nd.leaf) return (nd.name + ' ' + nd.type).toLowerCase().includes(q);
  return (nd.children || []).some(c => nodeHasMatch(c, q));
}

/* 拉取某结构体元素的可写成员（结果缓存，切换程序时清空） */
function loadMembers(key) {
  if (pickMemberCache[key]) return;
  pickMemberCache[key] = { pending: true };
  const { base, suffix } = splitKeyBase(key);
  fetch(`/api/members?base=${encodeURIComponent(base)}&path=${encodeURIComponent(suffix)}`)
    .then(r => r.json())
    .then(d => {
      pickMemberCache[key] = d.ok
        ? { nodes: d.nodes || [], truncated: !!d.truncated }
        : { error: d.error || '读取失败' };
    })
    .catch(e => { pickMemberCache[key] = { error: e.message }; })
    .then(() => { if (pickOpenStruct.has(key)) renderPickList(); });
}

/* 数组行：标题 + 展开/收起，展开后逐个元素可选（结构体元素可再下钻到成员） */
function pickArrayRow(s, q, frag) {
  const baseKey = s.full.replace(/^Application\./, '');
  const { lo, hi, base, count, writable } = s.elem;
  /* 搜索词里带 [ 时自动展开（明确在找某个元素），否则保持用户手动的开合状态 */
  const open = pickOpenArrs.has(baseKey) || /\[/.test(q || '');

  const row = document.createElement('div');
  row.className = 'pick-row arr' + (open ? ' open' : '');
  row.title = s.full + ` — ARRAY[${lo}..${hi}] OF ${base}`;
  const info = document.createElement('div');
  info.className = 'pick-info';
  info.innerHTML = `<div class="pick-name">${s.name}
      <span class="arr-tag">数组</span></div>
    <div class="pick-sub">${s.gvl || ''} · ARRAY[${lo}..${hi}] OF ${base} · ${count} 个元素`
    + (writable ? '' : ' · 元素为结构体，可继续展开到成员') + '</div>';
  row.appendChild(info);
  const tBtn = document.createElement('button');
  tBtn.className = 'btn sm ghost';
  tBtn.textContent = open ? '收起' : '展开';
  row.appendChild(tBtn);
  row.onclick = (e) => {
    e.stopPropagation();
    if (pickOpenArrs.has(baseKey)) pickOpenArrs.delete(baseKey);
    else pickOpenArrs.add(baseKey);
    renderPickList();
  };
  frag.appendChild(row);

  if (!open) return;
  /* 展开：最多 PICK_ARR_ROWS 行，其余提示用下标直达 */
  const lim = Math.min(count, PICK_ARR_ROWS);
  for (let i = 0; i < lim; i++) {
    const idx = lo + i;
    const key = `${baseKey}[${idx}]`;
    if (writable) {
      pickRow(key, `${s.name}[${idx}]`, `${s.gvl || ''} · ${base} · 元素 ${idx}`, frag, 1, base);
    } else {
      pickStructRow(key, `${s.name}[${idx}]`, `${s.gvl || ''} · ${base} · 元素 ${idx}`, frag, 1);
    }
  }
  /* 通过"元素切换"跳到超出前 PICK_ARR_ROWS 行的元素时，单独补一行，
     否则成员区会渲染在一个列表里根本不存在的行下面 */
  if (pickFocusElem && pickFocusElem.startsWith(baseKey + '[') && pickFocusElem.endsWith(']')) {
    const fi = Number(pickFocusElem.slice(baseKey.length + 1, -1));
    if (Number.isInteger(fi) && fi >= lo + lim && fi <= hi) {
      const tag = document.createElement('div');
      tag.className = 'pick-loading';
      tag.textContent = '↓ 已跳到元素 ' + fi + '（不在前 ' + lim + ' 行内）';
      frag.appendChild(tag);
      const k = `${baseKey}[${fi}]`;
      if (writable) pickRow(k, `${s.name}[${fi}]`, `${s.gvl || ''} · ${base} · 元素 ${fi}`, frag, 1, base);
      else pickStructRow(k, `${s.name}[${fi}]`, `${s.gvl || ''} · ${base} · 元素 ${fi}`, frag, 1);
    }
  }
  if (count > lim) {
    const more = document.createElement('div');
    more.className = 'pick-more';
    more.innerHTML = `<span>共 ${count} 个元素，已列前 ${lim} 个</span>
      <input type="number" min="${lo}" max="${hi}" placeholder="${lo}..${hi}">
      <button class="btn sm ghost">${writable ? '选该下标' : '展开该下标'}</button>`;
    const inp = more.querySelector('input');
    const go = () => {
      const idx = Number(inp.value);
      if (!Number.isInteger(idx) || idx < lo || idx > hi) {
        inp.classList.add('bad'); return;
      }
      const key = `${baseKey}[${idx}]`;
      if (writable) { selectTarget(key); return; }
      pickOpenStruct.add(key); loadMembers(key); renderPickList();
    };
    more.querySelector('button').onclick = (e) => { e.stopPropagation(); go(); };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); };
    inp.onclick = (e) => e.stopPropagation();
    frag.appendChild(more);
  }
}

function renderPickList() {
  const q = $('pickSearch').value.trim().toLowerCase();
  const box = $('pickList');
  box.innerHTML = '';
  /* 搜索：数组除名称/注释外，还匹配 aAlarmFlag[3] 这种带下标的写法 */
  const src = q
    ? symbols.filter(s => {
        const base = s.full.replace(/^Application\./, '');
        return (s.full + ' ' + s.type + ' ' + (s.comment || '')).toLowerCase().includes(q)
          || (s.elem && (`${base}[`).toLowerCase().includes(q));
      })
    : symbols;
  const arrCount = src.filter(s => s.elem).length;
  const structCount = src.filter(s => s.struct).length;
  $('pickMeta').textContent =
    `${src.length} 个可写项（${arrCount} 个数组 / ${structCount} 个结构体，可逐级展开到成员）`
    + (q ? ' · 已过滤' : '');
  const frag = document.createDocumentFragment();
  src.forEach(s => {
    const base = s.full.replace(/^Application\./, '');
    if (s.elem) pickArrayRow(s, q, frag);
    else if (s.struct) pickStructRow(base, s.name, `${s.gvl || ''} · ${s.type} · ${s.bytes}B`, frag, 0);
    else pickRow(base, s.name, `${s.gvl || ''} · ${s.type} · ${s.bytes}B`, frag, 0, s.type);
  });
  box.appendChild(frag);
  if (!src.length) box.innerHTML = '<div class="app-empty">无匹配变量</div>';
}

/* ══════════ 监控列表（服务端 wvals 广播驱动实时值） ══════════ */
function watchStoreKey() { return 'watch_' + ((META && META.app) || ''); }
function loadWatch() {
  try { watch = JSON.parse(localStorage.getItem(watchStoreKey()) || '[]'); } catch (_) { watch = []; }
  watch = watch.filter(k => !!tagOf(k));     /* tagOf 支持数组元素，不能只看 symMap */
}
function saveWatch() {
  try { localStorage.setItem(watchStoreKey(), JSON.stringify(watch)); } catch (_) {}
  syncWatchToServer();
}
/* 把监控列表交给服务端登记（数组元素 / 点表外标量不在主点表里，必须单独登记才有实时值） */
function syncWatchToServer() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cmd: 'watchSet', keys: watch }));
}
function renderWatch() {
  const box = $('watchList');
  box.innerHTML = '';
  watchEls = {};
  watch.forEach(k => {
    const t = tagOf(k);
    const row = document.createElement('div');
    row.className = 'watch-row';
    row.title = k + '（点击设为写入目标）';
    const name = document.createElement('div');
    name.className = 'watch-name';
    name.textContent = t ? t.label : k;
    const val = document.createElement('b');
    val.className = 'watch-val';
    val.textContent = '—';
    const rm = document.createElement('button');
    rm.className = 'watch-rm';
    rm.textContent = '✕';
    rm.title = '移除监控';
    rm.onclick = (e) => {
      e.stopPropagation();
      watch = watch.filter(x => x !== k);
      saveWatch(); renderWatch();
    };
    row.appendChild(name); row.appendChild(val); row.appendChild(rm);
    row.onclick = () => {
      curTarget = k; delete boolTarget[k];
      renderPickTarget(); syncWritePanel();
    };
    box.appendChild(row);
    watchEls[k] = val;
    /* 已有快照则立即显示：优先 wvals（元素级），退回 full（整符号摘要） */
    const d = watchDisp[k] !== undefined ? watchDisp[k] : fullDisp['Application.' + k];
    if (d !== undefined) { val.textContent = d; applyFullVal(k, d); }
  });
  $('watchCount').textContent = String(watch.length);
  if (!watch.length)
    box.innerHTML = '<div class="app-empty">在「选择变量」弹窗里点 ＋监控 添加</div>';
}

/* full 广播条目值 → 数值/布尔（写面板 prefill 用），展示值原样保留 */
function applyFullVal(key, disp) {
  if (disp === 'TRUE' || disp === 'true') { lastValues[key] = 1; return; }
  if (disp === 'FALSE' || disp === 'false') { lastValues[key] = 0; return; }
  const n = Number(disp);
  if (disp !== '' && isFinite(n)) { lastValues[key] = n; return; }
  delete lastValues[key];          /* 数组摘要/none 等不可直接写 */
}

/* ══════════ WebSocket ══════════ */
let wsRetry = 3000;      /* 断线重连退避：3s → 5s → 8s → 10s 封顶 */
let lastFault = null;    /* 最近一次故障留痕（服务端 t:'event'） */
let lastFaultId = '';    /* 已展示故障指纹（ts|text）：同一故障只弹一次 */
let onlineSince = 0;     /* 最近一次转为在线的时刻：早于此的故障属历史，不再弹横幅 */
let errHideTimer = null;

const faultId = (m) => `${m.ts}|${m.text}`;

let lastEvent = null;    /* 最近一条事件（含正常状态跃迁） */

/* 状态徽章悬停：最新事件 + 最近异常（横幅关掉后仍可查） */
function updateStatusTitle() {
  const line = (tag, m) => `${tag} ${new Date(m.ts).toLocaleTimeString()} · ${m.text}`;
  const parts = [];
  if (lastEvent) parts.push(line('最新', lastEvent));
  if (lastFault && (!lastEvent || faultId(lastEvent) !== faultId(lastFault)))
    parts.push(line('最近异常', lastFault));
  $('status').title = parts.join('\n');
}

/* 只记住故障（供状态徽章悬停查看），不动横幅 */
function rememberFault(m) {
  lastFault = m;
  updateStatusTitle();
}

/* 弹横幅：同一故障重复到达（快照回放历史事件）不会重弹 */
function noteFault(m) {
  rememberFault(m);
  const id = faultId(m);
  if (id === lastFaultId) return;
  lastFaultId = id;
  const bar = $('lastErr');
  if (!bar) return;
  clearTimeout(errHideTimer);
  bar.hidden = false;
  bar.textContent = '';
  const b = document.createElement('b');
  b.textContent = new Date(m.ts).toLocaleTimeString();
  bar.appendChild(b);
  bar.appendChild(document.createTextNode(' ' + m.text));
  /* 恢复在线 15s 后自动淡出，避免常驻噪音 */
  errHideTimer = setTimeout(() => { if (state === 'online') bar.hidden = true; }, 15000);
}

/* 恢复在线：历史故障横幅立即收起，不再等 15s，也不被下一帧快照顶回来 */
function hideFaultBar() {
  clearTimeout(errHideTimer);
  const bar = $('lastErr');
  if (bar) bar.hidden = true;
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsRetry = 3000;
    pushLog('sys', '── 验证台已连接服务端 ──');
    renderSummary();
    syncWatchToServer();       /* 已存监控列表交给服务端登记（数组元素需单独登记） */
  };

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    window.__dbg.msgs[m.t] = (window.__dbg.msgs[m.t] || 0) + 1;
    switch (m.t) {
      case 'state':
        applyState(m);
        break;
      case 'values':
        if (m.rtt) { rttHistory.push(m.rtt); if (rttHistory.length > 80) rttHistory.shift(); }
        applyValues(m.items);
        if (m.rtt) applyStats(null, m.rtt);
        break;
      case 'plccfg':
        /* PLC 地址变更广播（任一页面改完，其他页面同步顶栏） */
        showEndpoint(m.host, m.port);
        if (!$('cfgMask').hidden && m.source === 'file') {
          $('cfgHost').value = m.host;
          $('cfgPort').value = m.port;
        }
        pushLog('sys', `── PLC 地址：${m.host}:${m.port}${m.changed ? '（已变更，重连中）' : ''} ──`);
        break;
      case 'app':
        /* 程序切换广播（导入/选择/删除自动切换）：刷新点表、符号表、页面标识 */
        META.app = m.app;
        tags = m.tags || [];
        tagMap = {};
        tags.forEach(t => { tagMap[t.key] = t; });
        curTarget = '';          /* 旧程序目标与监控列表全部失效 */
        lastValues = {}; boolTarget = {}; wPrev = {}; fullDisp = {};
        if (m.app) document.title = '协议验证台 · ' + m.app;
        loadSymbols().then(() => {
          watchDisp = {};                    /* 换程序：元素值快照作废 */
          memberType = {};                   /* 类型表同理（新程序成员可能不同） */
          Object.keys(pickMemberCache).forEach(k => delete pickMemberCache[k]);
          pickOpenArrs.clear(); pickOpenStruct.clear();
          loadWatch(); renderWatch(); renderPickTarget(); syncWritePanel();
          syncWatchToServer();
        });
        loadApps();
        break;
      case 'full':
        /* 全量广播：驱动监控列表与写入目标的实时值（230 符号每轮一包） */
        for (const it of m.items || []) fullDisp[it.f] = it.d;
        watch.forEach(k => {
          const d = fullDisp['Application.' + k];
          const el = watchEls[k];
          if (el && d !== undefined) {
            if (el.textContent !== d) {
              el.textContent = d;
              el.classList.remove('flash');
              void el.offsetWidth;      /* 重启动画 */
              el.classList.add('flash');
            }
            applyFullVal(k, d);
          }
        });
        if (curTarget) {
          const d = fullDisp['Application.' + curTarget];
          if (d !== undefined) { applyFullVal(curTarget, d); syncWritePanel(); }
        }
        break;
      case 'wvals':
        /* 监控列表实时值（数组元素 / 结构体成员 / 点表外标量走这里） */
        (m.items || []).forEach(it => {
          watchDisp[it.key] = it.d;
          if (it.ty && memberType[it.key] !== it.ty) memberType[it.key] = it.ty;  /* 类型补全（刷新后靠这个恢复 BOOL 控件） */
          applyFullVal(it.key, it.d);
          const el = watchEls[it.key];
          if (el && el.textContent !== it.d) {
            el.textContent = it.d;
            el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
          }
        });
        if (curTarget && watchDisp[curTarget] !== undefined) {
          applyFullVal(curTarget, watchDisp[curTarget]);
          syncWritePanel();
        }
        break;
      case 'rtt':
        rttHistory.push(m.rtt); if (rttHistory.length > 80) rttHistory.shift();
        applyStats(m.stats, m.rtt, m.readWin);
        break;
      case 'log':
        pushLog(m.level || 'sys', m.text, m.hex);
        break;
      case 'wtest':
        wlog(m.level === 'err' ? 'err' : m.level === 'ok' ? 'ok' : 'sys', m.text);
        break;
      case 'wprev':
        if (m.key && m.before !== undefined) { wPrev[m.key] = m.before; syncWritePanel(); }
        break;
      case 'wcur':
        if (m.key && m.value !== undefined) {
          lastValues[m.key] = m.value;
          if (m.key === curTarget) valDirty = false;   /* 写入已落地：输入框回归跟随实时值 */
          syncWritePanel();
        }
        break;
      case 'period':
        $('periodSel').value = String(m.ms);
        break;
      case 'event':
        /* 故障留痕：状态跃迁 / TCP 断开 / 握手失败，红色时鼠标悬停状态徽章可看原因 */
        lastEvent = m;
        if (m.kind === 'err' || m.kind === 'sock') noteFault(m);
        else updateStatusTitle();
        break;
    }
  };

  ws.onerror = (e) => { window.__dbg.errors.push('ws error'); pushLog('err', 'WebSocket 错误'); };
  ws.onclose = () => {
    pushLog('warn', '服务端连接断开（后端重启 / 网络中断），' + Math.round(wsRetry / 1000) + 's 后重试…');
    $('status').className = 'status error';
    $('statusText').textContent = '服务端离线';
    /* 用当前时刻合成一条新故障（后端已失联，拿不到它的 lastFault） */
    noteFault({ ts: Date.now(), text: '验证台与后端失联（后端重启中）' });
    setTimeout(connectWS, wsRetry);
    wsRetry = Math.min(Math.round(wsRetry * 1.6), 10000);
  };
}

/* ══════════ UI 绑定 ══════════ */
function bindUI() {
  /* PLC 配置：点顶栏地址即可修改 IP / 端口 */
  $('endpointBox').onclick = openCfg;
  $('cfgClose').onclick = closeCfg;
  $('cfgCancel').onclick = closeCfg;
  $('cfgSave').onclick = saveCfg;
  $('cfgMask').addEventListener('click', (e) => { if (e.target === $('cfgMask')) closeCfg(); });
  $('cfgDefault').onclick = () => {
    $('cfgHost').value = cfgDefaults.host;
    $('cfgPort').value = cfgDefaults.port;
    $('cfgNote').className = 'cfg-note';
    $('cfgNote').textContent = '已填入默认值，点「保存并重连」生效';
  };
  /* 弹窗里回车即保存 */
  ['cfgHost', 'cfgPort'].forEach(id => {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeCfg(); return; }
      if (e.key === 'Enter') saveCfg();
    });
  });

  $('btnConnect').onclick = () => {
    if (state === 'online' || state === 'connecting') {
      ws.send(JSON.stringify({ cmd: 'disconnect' }));
    } else {
      rttHistory = []; drawRtt();
      ws.send(JSON.stringify({ cmd: 'connect' }));
    }
  };

  $('btnReset').onclick = () => {
    rttHistory = []; lastValues = {}; ecReset(); drawRtt();
    readWin = []; serverWin = null; statsPrev = { reads: 0, fail: 0 };   /* 成功率窗口一并重开 */
    $('kpiRtt').innerHTML = '—<span class="u">ms</span>';
    $('kpiRate').textContent = '—';
    $('kpiReads').textContent = '0';
    $('rttMin').textContent = '—'; $('rttAvg').textContent = '—'; $('rttMax').textContent = '—';
    ws.send(JSON.stringify({ cmd: 'resetStats' }));
  };

  $('periodSel').onchange = (e) => {
    ws.send(JSON.stringify({ cmd: 'period', ms: Number(e.target.value) }));
  };

  /* 变量选择弹窗 */
  $('btnPickVar').onclick = openPick;
  $('pickClose').onclick = closePick;
  $('pickMask').addEventListener('click', (e) => { if (e.target === $('pickMask')) closePick(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('pickMask').hidden) closePick();
    if (e.key === 'Escape' && !$('cfgMask').hidden) closeCfg();
  });
  $('pickSearch').addEventListener('input', renderPickList);
  $('btnWatchClear').onclick = () => { watch = []; saveWatch(); renderWatch(); };

  /* 顶部故障横幅：点一下即收起（历史故障仍可在状态徽章悬停查到） */
  const errBar = $('lastErr');
  if (errBar) {
    errBar.title = '点击关闭（最近故障仍可在左侧状态徽章悬停查看）';
    errBar.onclick = hideFaultBar;
  }

  /* BOOL 置位 / 复位选择 */
  $('boolOn').onclick = () => { boolTarget[curTarget] = 1; syncWritePanel(); };
  $('boolOff').onclick = () => { boolTarget[curTarget] = 0; syncWritePanel(); };

  $('btnNoop').onclick = () => {
    const k = curTarget;
    if (!k) { wlog('err', '✗ 请先选择变量'); return; }
    $('wLog').innerHTML = '';
    wlog('sys', '▶ 回写当前值（零变化）：' + (tagOf(k)?.label || k));
    ws.send(JSON.stringify({ cmd: 'writeTest', key: k, mode: 'noop' }));
  };

  /* 写入值：直接写入并保留（不自动还原） */
  $('btnSet').onclick = () => {
    const k = curTarget;
    if (!k) { wlog('err', '✗ 请先选择变量'); return; }
    const t = tagOf(k);
    const isBool = !!t && t.type === 'BOOL';
    const v = isBool ? (boolTarget[k] === 1 ? 1 : 0) : Number($('writeVal').value);
    if (!isBool && !isFinite(v)) { wlog('err', '✗ 写入值无效'); return; }
    $('wLog').innerHTML = '';
    wlog('sys', `▶ 写入 ${t?.label || k} = ${t ? fmt(t, v) : v}（写入后保留）`);
    ws.send(JSON.stringify({ cmd: 'writeTest', key: k, mode: 'set', value: v }));
  };

  /* 手动恢复：把上次写入前的原值写回 */
  $('btnRecall').onclick = () => {
    const k = curTarget;
    const prev = wPrev[k];
    if (!k || prev === undefined || prev === null) return;
    $('wLog').innerHTML = '';
    const tt = tagOf(k);
    if (tt && tt.type === 'BOOL') boolTarget[k] = Number(prev) ? 1 : 0;
    else { $('writeVal').value = prev; valDirty = false; }
    syncWritePanel();
    wlog('sys', `▶ 恢复原值 ${tt?.label || k} = ${fmt(tt, prev)}`);
    ws.send(JSON.stringify({ cmd: 'writeTest', key: k, mode: 'set', value: prev }));
  };

  $('btnFill').onclick = () => {
    const k = curTarget;
    const t = tagOf(k);
    if (!t) return;
    const cur = Number(lastValues[k]);
    if (t.type === 'BOOL') { boolTarget[k] = cur ? 0 : 1; syncWritePanel(); return; }
    /* 基数优先取输入框已有值（连点即连加），仅空/非法时退化成当前读值 */
    const boxRaw = $('writeVal').value.trim();
    const box = boxRaw === '' ? NaN : Number(boxRaw);
    const base = isFinite(box) ? box : (isFinite(cur) ? cur : 0);
    $('writeVal').value = base + 1;
    valDirty = true;          /* 已构造写入值：挡住后续广播覆盖，否则会被当前读值冲回去 */
    $('writeVal').focus();
    $('writeVal').select();
  };

  /* 手输内容同样标记为脏，避免周期广播把值重置 */
  $('writeVal').addEventListener('input', () => { valDirty = true; });

  $('btnClearLog').onclick = () => { $('consoleBody').innerHTML = ''; logCount = 0; };
}

function ecReset() {}

/* 首屏默认：连接按钮可用 */
boot().catch(e => {
  document.body.innerHTML = '<div style="padding:40px;font-family:monospace;color:#FF5F5F">启动失败：' + e.message + '</div>';
});
