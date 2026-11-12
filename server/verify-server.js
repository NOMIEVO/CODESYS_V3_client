/* verify-server.js — CODESYS V3 协议验证台（HTTP 静态 + WebSocket 实时推送）
   ─────────────────────────────────────────────────────────────
   把纯 Node 客户端（codesys-v3-client.js）的完整能力可视化成仪表盘：
     · 握手七阶段逐步可视化（耗时 / 关键标识 / 原始报文摘要）
     · 全量符号分批登记 + 单轮 ExecuteRead 全量轮询（唯一模式，主点表仅供写入回读）
     · XML 导入（/api/import 上传 → 自动生成数据 → 热切换程序）+ 程序列表切换
     · 写入闭环验证（no-op 回写 / 改值→回读），白名单强制
     · 协议报文流水（命令码 / 载荷长度 / 耗时）
   单连接串行队列：PLC 11740 一次只服务一个 TCP 连接，读写必须互斥。

   启动：node verify-server.js          → http://127.0.0.1:8095
   环境：MYX_APP（程序点表，未设自动选最新导入）
         MYX_HOST / MYX_PLC_PORT / MYX_VERIFY_PORT / MYX_READONLY=1
   点表：server/gen/<APP>.tags.json（tools/gen_tags.py 从 XML 自动生成，禁手改） */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { CodesysV3Client } = require('./codesys-v3-client');

/* ────────── PLC 连接参数（可在界面上改，落盘 server/plc-config.json） ──────────
   优先级：plc-config.json（界面保存） > 环境变量 > 内置默认。
   改完立即生效：断开旧连接 → 用新地址重连，无需重启进程。 */
const CFG_FILE = path.join(__dirname, 'plc-config.json');
const DEFAULT_PLC_HOST = '192.168.1.92';   /* 内置默认 PLC 地址（界面可改，改后落盘 plc-config.json） */
const DEFAULT_PLC_PORT = 11740;

function readPlcConfig() {
  try {
    const d = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    const host = String(d.host || '').trim();
    const port = Number(d.port);
    if (host && port >= 1 && port <= 65535) return { host, port, source: 'file' };
  } catch (_) {}
  return null;
}
function savePlcConfig(host, port) {
  fs.writeFileSync(CFG_FILE, JSON.stringify({ host, port, savedAt: new Date().toISOString() }, null, 2) + '\n');
}
/* 校验：IPv4 / 主机名；端口 1..65535
   ⚠️ 纯数字加点的一律按 IPv4 严格校验（否则 999.1.1.1 会被主机名规则放行） */
function validatePlcAddr(host, port) {
  const h = String(host || '').trim();
  if (!h) return 'IP 地址不能为空';
  if (!/^[A-Za-z0-9.\-]+$/.test(h)) return 'IP 只能包含数字、字母、点、连字符';
  /* 看起来像 IP 就必须是合法 IP：纯数字点，或「前三段都是数字」（192.168.1.1a 属于打字漏了数字） */
  const looksLikeIp = /^[\d.]+$/.test(h) || /^\d+\.\d+\.\d+\./.test(h);
  if (looksLikeIp) {
    const parts = h.split('.');
    if (parts.length !== 4 || !parts.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255))
      return 'IP 格式不正确（例：192.168.1.92，每段 0..255）';
  } else if (!/^[A-Za-z0-9]([A-Za-z0-9\-.]*[A-Za-z0-9])?$/.test(h)) {
    return 'IP 格式不正确（例：192.168.1.92）';
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return '端口须为 1..65535 的整数';
  return null;
}

let PLC_CFG = readPlcConfig() || {
  host: process.env.MYX_HOST || DEFAULT_PLC_HOST,
  port: Number(process.env.MYX_PLC_PORT || DEFAULT_PLC_PORT),
  source: process.env.MYX_HOST ? 'env' : 'default',
};
let HOST = PLC_CFG.host;
let PLC_PORT = PLC_CFG.port;
const WEB_PORT = Number(process.env.MYX_VERIFY_PORT || 8095);
const ROOT = path.join(__dirname, '..', 'verify');
const READONLY = process.env.MYX_READONLY === '1';

/* ────────── 程序数据（XML → 数据，禁止手写类型） ──────────
   点表/符号表/类型库/白名单统一由 loadAppData(app) 热加载；
   导入 XML（/api/import）或切换程序（/api/select）后原地刷新并重连，不重启进程。
   文件由 tools/gen_tags.py 从 XML 符号配置生成；换点请编辑
   server/profiles/<APP>.profile.json 后重跑生成器，不要改这里。 */

let APP_DISPLAY = '';   /* 界面显示的程序名（原名，可含中文） */
let APP_ID = (() => {
  const env = process.env.MYX_APP;
  if (env) return env;
  const fsx = require('fs');
  const genDir = path.join(__dirname, 'gen');
  let best = null;
  const avail = [];
  try {
    for (const f of fsx.readdirSync(genDir)) {
      if (!f.endsWith('.tags.json')) continue;
      try {
        const d = JSON.parse(fsx.readFileSync(path.join(genDir, f), 'utf8'));
        avail.push({ app: d.app || f.replace(/\.tags\.json$/, ''),
                     n: d.tags ? d.tags.length : '?', at: d.generatedAt || '' });
      } catch (_) {}
    }
  } catch (_) {}
  /* 排序：生成时间新→旧；同批生成时间相同（--all 一次重导全部）时确定取 TBJ，
     再退回按名称——保证每次启动选择一致，不抖动 */
  const rank = (a) => a.app === 'DEMO_MACHINE' ? 1 : 0;
  avail.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1
    : rank(b) - rank(a) || (a.app < b.app ? -1 : 1)));
  if (!avail.length) { console.error('[app] server/gen/ 下没有已导入程序——把 XML 放进 example/ 或 Test/ 后跑 1-gen-tags.bat'); return 'DEMO_MACHINE'; }
  best = avail[0].app;
  console.log('[app] 已导入程序（新→旧）:');
  avail.forEach(a => console.log(`      ${a.app}（${a.n} 点 · ${a.at}）`));
  console.log(`[app] 未指定 MYX_APP → 自动选用最新导入: ${best}（2-run-verify.bat <程序名> 可手动指定）`);
  return best;
})();
/* ── 钻取核心逻辑（纯模块 server/drill-core.js，可离线单测）：
   类型导航 / 层级树展开（含 UNION·可疑布局标记）/ 叶子解码编码 / 460B 分批
   / learnUnionLayout（整读 blob ↔ 逐名读基准 对账，学习真实布局） ── */
const {
  init: drillInit, xmlTypeName, expandTree, flattenTree, readBase, typeDef,
  decodeLeaf, encodeLeaf, packPaths, learnUnionLayout,
} = require('./drill-core');

/* ── UNION 学习布局持久化：out/<APP>/drill-layout.json（按程序隔离，换 XML 自动失效） ──
   条目：{ [符号全路径]: { ok, blobBytes, stride, off:{成员路径→绝对偏移}, weakFams, checkedAt } }
   缓存命中时整读尺寸必须与 blobBytes 严格一致，程序重编译/布局变化即自动作废重学。 */
let DRILL_LAYOUT_FILE = path.join(__dirname, '..', 'out', APP_ID, 'drill-layout.json');
function loadDrillLayout() {
  try { return JSON.parse(fs.readFileSync(DRILL_LAYOUT_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveDrillLayout(store) {
  try {
    fs.mkdirSync(path.dirname(DRILL_LAYOUT_FILE), { recursive: true });
    fs.writeFileSync(DRILL_LAYOUT_FILE, JSON.stringify(store, null, 1));
  } catch (e) { console.error('[drill-layout] 保存失败: ' + e.message); }
}

/* ── 程序数据热加载：点表 + 全量符号表 + 类型库 + 写白名单，一次全部刷新 ── */
let GEN_TAGS = null, TAGS = [];
let SYMBOLS = [], SCALARS = [], COMPOSITES = [];
let TYPES = {};
let WHITELIST = [];

function loadAppData(app) {
  APP_ID = app;
  /* 主点表（周期读 + 写入回读用） */
  GEN_TAGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'gen', app + '.tags.json'), 'utf8'));
  TAGS = GEN_TAGS.tags;
  /* 显示名：XML ProjectInfo 原名（可能含中文）。程序 ID 必须是 ASCII 标识符
     （同时作文件名与 /api/select?app= 参数），原名只用于界面展示。 */
  APP_DISPLAY = GEN_TAGS.appDisplay || GEN_TAGS.app || app;
  /* 类型库（结构体钻取用，XML 为唯一准则） */
  try { TYPES = JSON.parse(fs.readFileSync(path.join(__dirname, 'gen', app + '.types.json'), 'utf8')).types || {}; }
  catch (e) { console.error('[types] 类型库加载失败 → 结构体钻取不可用: ' + e.message); TYPES = {}; }
  drillInit(TYPES);
  /* 全量符号表（分批登记 + 全量浏览器用） */
  const src = path.join(__dirname, '..', 'out', app, 'tag_table.json');
  try {
    const d = JSON.parse(fs.readFileSync(src, 'utf8'));
    SYMBOLS = d.symbols.map((s) => {
      const type = s.iecType || '';
      const m = type.match(/^ARRAY\s*\[\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\]\s*OF\s+(\w+)/i);
      const n = m ? (+m[2] - +m[1] + 1) : 0;
      return {
        gvl: (s.gvl || '').replace(/^Application\./, ''),
        name: s.name,
        type,
        bytes: s.bytes || 0,
        full: s.symbolPath,
        access: s.access || '',
        trusted: s.layoutVerified ? 'verified' : '',
        comment: s.comment || '',
        elem: m ? { lo: +m[1], hi: +m[2], base: m[3].toUpperCase(),
                    size: s.elemStride || (n ? s.bytes / n : 0) } : null,
      };
    });
  } catch (e) {
    console.error(`[symbols] 全量表加载失败 ${src} → ${e.message}`);
    console.error(`[symbols] 请先跑: python tools/gen_tags.py <XML 路径>`);
    SYMBOLS = [];
  }
  SCALARS = SYMBOLS.filter(s => !/^ARRAY|^D_|^T_/.test(s.type));
  COMPOSITES = SYMBOLS.filter(s => /^ARRAY|^D_|^T_/.test(s.type));
  /* 写白名单（单一事实源 write-whitelist.json，按当前程序过滤换程序残留项） */
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'write-whitelist.json'), 'utf8')).allow || [];
    const inTags = new Set(TAGS.map(t => t.key));
    WHITELIST = all.filter(w => inTags.has(w.name));
    const dropped = all.length - WHITELIST.length;
    if (dropped) console.log(`[whitelist] 过滤 ${dropped} 项不在 ${app} 点表中的白名单（换程序残留项）`);
  } catch (_) { WHITELIST = []; }
  /* 钻取布局缓存路径随程序切换 */
  DRILL_LAYOUT_FILE = path.join(__dirname, '..', 'out', app, 'drill-layout.json');
  console.log(`[tags] 程序点表 ${app}：${TAGS.length} 点 · 符号 ${SYMBOLS.length}（生成于 ${GEN_TAGS.generatedAt}）`);
}
loadAppData(APP_ID);

/* ────────── 值解码 ────────── */
function decode(tag, buf) {
  if (!buf || buf.length === 0) return null;
  switch (tag.type) {
    case 'BOOL':  return buf.readUInt32LE(0) ? 1 : 0;
    case 'REAL':  return Number(buf.readFloatLE(0).toFixed(3));
    case 'LREAL': return Number(buf.readDoubleLE(0).toFixed(3));
    case 'DINT':  return buf.readInt32LE(0);
    default:      return buf.readUInt32LE(0);
  }
}

/* ────────── 全量值解码 + 通用解码（数据由 loadAppData 提供） ────────── */

/* 全量值解码：标量 → 数字/布尔；小数组 → 数组；大块 → 摘要 */
function decodeSymbol(sym, buf) {
  if (!buf || buf.length === 0) return { kind: 'none' };
  if (sym.elem) {
    const base = sym.elem.base;
    const esz = Math.max(1, Math.round(sym.elem.size));
    const n = sym.elem.hi - sym.elem.lo + 1;
    if (esz <= 8 && n <= 64) {
      const arr = [];
      for (let i = 0; i < n; i++) {
        const off = i * esz;
        if (off + esz > buf.length) break;
        const v = readBase(base, buf, off);
        arr.push(v === null ? buf.readUInt8(off) : v);
      }
      return { kind: 'array', value: arr, base, n };
    }
    return { kind: 'blob', bytes: buf.length, head: buf.slice(0, 16).toString('hex'), n };
  }
  if (/^D_|^T_/.test(sym.type)) {
    return { kind: 'blob', bytes: buf.length, head: buf.slice(0, 16).toString('hex') };
  }
  return { kind: 'scalar', value: readBase(sym.type.toUpperCase(), buf, 0) };
}

/* 展示文本（全量表格用） */
function dispSymbol(sym, dec) {
  if (!dec || dec.kind === 'none') return '--';
  if (dec.kind === 'scalar') {
    if (dec.value === null || dec.value === undefined) return '--';
    if (sym.type === 'BOOL') return dec.value ? 'TRUE' : 'FALSE';
    return String(dec.value);
  }
  if (dec.kind === 'array') return '[' + dec.value.slice(0, 8).join(', ') + (dec.value.length > 8 ? ', …' : '') + ']';
  return `${dec.bytes}B · ${dec.head}`;
}

/* 值编码（写用）：按类型 → Buffer
   ⚠️ BOOL 必须 1 字节（IEC BOOL = 1B）——发 4B 会被 PLC 以 status=0x0F 拒绝（长度不符） */
function encode(tag, value) {
  if (tag.type === 'BOOL')  { const b = Buffer.alloc(1); b.writeUInt8(value ? 1 : 0); return b; }
  if (tag.type === 'LREAL') { const b = Buffer.alloc(8); b.writeDoubleLE(Number(value)); return b; }
  if (tag.type === 'REAL' || tag.type === 'DINT' || tag.type === 'UDINT') {
    const b = Buffer.alloc(4);
    if (tag.type === 'REAL') b.writeFloatLE(Number(value));
    else b.writeInt32LE(Number(value) | 0);
    return b;
  }
  const b = Buffer.alloc(4); b.writeInt32LE(Number(value) | 0); return b;
}

/* ══════════ 任意深路径解析：GVL.ARR[3].Member.Sub ══════════
   PLC 侧按完整成员名寻址（钻取 drillWrite 已验证同一机制），因此结构体/嵌套数组
   内部的标量成员都能直接读写，不必整块读回来按偏移换算。 */
const WRITABLE_IEC = new Set(['BOOL', 'BYTE', 'SINT', 'USINT', 'INT', 'UINT', 'WORD',
  'DINT', 'UDINT', 'DWORD', 'TIME', 'REAL', 'LREAL', 'LINT']);

/* 解析纯路径段：'[3].tState.bValid' → [{idx:3},{name:'tState'},{name:'bValid'}] */
function parseSegs(s) {
  const segs = [];
  const re = /\[(-?\d+)\]|\.([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(String(s || '')))) segs.push(m[1] !== undefined ? { idx: Number(m[1]) } : { name: m[2] });
  return segs;
}

/* 把 key 拆成「符号名 + 路径段」。
   ⚠️ 符号名本身可能含点（如 GVL_AXIS.aAxisCtl —— GVL 名与变量名都以点分隔），不能按第一个 . 切，
   必须在符号表里找**最长匹配前缀**（aAxisCtl 与 aAxisCtl[3].fActPosition 两种写法都覆盖）。 */
function splitPath(key) {
  const s = String(key || '');
  let best = null;
  for (const sym of SYMBOLS) {
    const bare = sym.full.replace(/^Application\./, '');
    if (bare === s) return { base: bare, segs: [] };
    if ((s.startsWith(bare + '.') || s.startsWith(bare + '[')) && (!best || bare.length > best.length))
      best = bare;
  }
  if (!best) return { base: s, segs: [] };
  return { base: best, segs: parseSegs(s.slice(best.length)) };
}

/* 沿路径走类型库，返回终点叶子的 IEC 类型；不可写/不存在返回 null。
   segs 为空表示整符号（只有标量才可写）。 */
function resolvePathType(symType, segs) {
  let cur = symType;
  for (const seg of segs) {
    const t = typeDef(cur);
    if (!t) return null;
    if (seg.idx !== undefined) {
      if (t.kind !== 'TypeArray') return null;
      if (seg.idx < t.lo || seg.idx > t.hi) return null;
      cur = t.basetype;
      continue;
    }
    if (!Array.isArray(t.members)) return null;
    const mb = t.members.find(x => x.name === seg.name);
    if (!mb) return null;
    if (mb.access && !/write/i.test(mb.access)) return null;      /* 成员只读 */
    cur = mb.type;
  }
  const leaf = typeDef(cur);
  if (!leaf || leaf.kind !== 'TypeSimple') return null;           /* 结构体/数组本身不可写 */
  const iec = String(leaf.iec || cur).toUpperCase();
  return WRITABLE_IEC.has(iec) ? iec : null;
}

function symTag(key) {
  const { base, segs } = splitPath(key);
  const s = SYMBOLS.find(x => x.full === 'Application.' + base);
  if (!s) return null;
  if (!String(s.access || '').toLowerCase().includes('w')) return null;
  const iec = resolvePathType(s.type, segs);
  if (!iec) return null;
  /* 标签：符号显示名 + 路径后缀（ARR[3].fSet 这类，与全量监控写法一致） */
  const suffix = segs.map(g => g.idx !== undefined ? `[${g.idx}]` : '.' + g.name).join('');
  return { key, label: s.name + suffix, unit: '', type: iec,
           digits: iec === 'REAL' || iec === 'LREAL' ? 2 : 0, sym: true };
}

/* ══════════ 成员树（弹窗逐级折叠，不一次性平铺） ══════════
   node = { rel, name, type, leaf:true }                                    可写标量
        | { rel, name, type, leaf:false, kind:'struct', count, children }   结构体组
        | { rel, name, type, leaf:false, kind:'array',  count, children }   数组组
   rel 是相对父节点的路径后缀（含 [n] / .Member），前端拼 parentKey + '.' + rel 得到完整 key。 */
const MEMBER_MAX = 600;    /* 单次返回的节点上限（防止巨型结构体把弹窗撑爆） */
const MEMBER_DEPTH = 6;    /* 递归深度上限 */

function buildMemberNode(typeName, rel, name, counter, depth) {
  counter.n++;
  const t = typeDef(typeName);
  if (!t) return null;

  if (t.kind === 'TypeSimple') {
    const iec = String(t.iec || typeName).toUpperCase();
    return WRITABLE_IEC.has(iec) ? { rel, name, type: iec, leaf: true } : null;
  }

  /* 枚举：本质是整数，按基类型当叶子（否则结构体里的枚举成员会被整棵丢掉）。
     type 里带 E_ 前缀便于前端识别并显示枚举名。 */
  if (t.enums && Object.keys(t.enums).length) {
    const base = typeDef(t.basetype);
    const iec = String((base && base.iec) || t.basetype || 'INT').toUpperCase();
    if (!WRITABLE_IEC.has(iec)) return null;
    return { rel, name, type: iec, leaf: true, enumName: t.iec || typeName };
  }

  if (t.kind === 'TypeArray') {
    const n = t.hi - t.lo + 1;
    const lim = Math.min(n, 32);                 /* 组内数组默认只列前 32 个元素 */
    const children = [];
    for (let i = 0; i < lim && counter.n < MEMBER_MAX && depth < MEMBER_DEPTH; i++) {
      const c = buildMemberNode(t.basetype, `${rel}[${t.lo + i}]`, `[${t.lo + i}]`, counter, depth + 1);
      if (c) children.push(c);
    }
    if (!children.length) return null;
    return { rel, name, type: `ARRAY[${t.lo}..${t.hi}]`, leaf: false, kind: 'array', count: n,
             children, note: n > lim ? `共 ${n} 个元素，已列前 ${lim} 个` : '' };
  }

  if (Array.isArray(t.members) && t.members.length && depth < MEMBER_DEPTH) {
    const children = [];
    for (const mb of t.members) {
      if (counter.n >= MEMBER_MAX) break;
      if (mb.access && !/write/i.test(mb.access)) continue;   /* 成员只读：跳过 */
      const c = buildMemberNode(mb.type, rel ? rel + '.' + mb.name : mb.name, mb.name, counter, depth + 1);
      if (c) children.push(c);
    }
    if (!children.length) return null;
    return { rel, name, type: t.iec || typeName, leaf: false, kind: 'struct',
             count: children.length, children };
  }
  return null;
}

/* 构建某类型的成员树（顶层逐个成员成节点，组自动折叠） */
function buildMemberTree(typeName) {
  const counter = { n: 0 };
  const t = typeDef(typeName);
  if (!t) return { nodes: [], truncated: false };
  let nodes = [];
  if (t.kind === 'TypeArray') {
    const c = buildMemberNode(typeName, '', '', counter, 0);
    if (c) nodes = [c];
  } else if (Array.isArray(t.members)) {
    for (const mb of t.members) {
      if (counter.n >= MEMBER_MAX) break;
      if (mb.access && !/write/i.test(mb.access)) continue;
      const n = buildMemberNode(mb.type, mb.name, mb.name, counter, 0);
      if (n) nodes.push(n);
    }
  } else {
    const n = buildMemberNode(typeName, '', '', counter, 0);
    if (n) nodes = [n];
  }
  return { nodes, truncated: counter.n >= MEMBER_MAX };
}

/* 把 socket / 协议异常的英文原文翻译成一句人话（原始文本仍留在日志区） */
function friendlyErr(msg) {
  if (!msg) return '未知原因';
  const s = String(msg);
  if (/ECONNREFUSED/.test(s)) return '目标端口拒绝连接（PLC 未监听 / 网关未启动）';
  if (/ECONNRESET/.test(s)) return '连接被重置（PLC 单连接可能被其他客户端抢占）';
  if (/ETIMEDOUT|timed? ?out|超时/i.test(s)) return '应答超时（网络抖动 / PLC 忙 / 通道号耗尽）';
  if (/EHOSTUNREACH|ENETUNREACH/.test(s)) return '目标不可达（IP 或网段不通）';
  if (/NAMES?_?INVALID|名字无效|0x14/i.test(s)) return '变量名无效（须带 Application. 前缀）';
  return s;
}

/* 读成功率窗口长度（与前端 RTT 图一致：只看最近 80 次） */
const READ_WIN = 80;

/* ════════════════ 运行器：单连接 + 串行队列 + 周期读 ════════════════ */
class Runner {
  constructor() {
    this.client = null;
    this.state = 'idle';          /* idle | connecting | online | reconnecting | error */
    this.step = 0;
    this.handshake = [];          /* [{n,label,status,ms,detail}] */
    this.values = {};             /* key → 解码值 */
    this.rawValues = {};          /* key → Buffer */
    this.seq = 0;
    this.period = 500;
    this.stats = { reads: 0, ok: 0, fail: 0, txFrames: 0, rxFrames: 0, txBytes: 0, rxBytes: 0 };
    /* 最近 80 次读结果（1 成功 / 0 失败）：读成功率按此窗口算，不用累计值——
       否则跑一整天后单次失败会被 99.99% 稀释，看不出近期其实不稳 */
    this.readWin = [];
    this.rtt = [];                /* 最近 80 次 */
    this.lastError = null;
    this.lastReadAt = null;
    /* ── 故障留痕：记录每次状态跃迁 / TCP 事件 / 错误，最多 60 条 ── */
    this.events = [];             /* [{ts, kind, text}] */
    this._lastState = 'idle';
    this.intentional = false;     /* 主动断开（切模式/用户点断开）标记，避免误记为故障 */
    this.gen = 0;                 /* 连接代号：旧连接的回调一律作废，防止重连风暴 */
    this.reconnectTimer = null;   /* 全局唯一重连排期，杜绝多条重连链叠加 */
    this.chain = Promise.resolve();   /* 串行队列 */
    this.timer = null;
    this.wsSet = new Set();
    this.oneshots = {};
    /* ── 全量模式（唯一模式：主点表分批 + 全量符号列表都登记） ── */
    this.tagHandle = null;        /* 首批主点表句柄（写入时复用） */
    this.tagTasks = [];           /* 主点表分批列表（协议约束：单次登记 ≤2 块）[{start,names,handle}] */
    this.fullTasks = [];          /* [{kind, names[], syms[], handle}] */
    this.fullValues = {};         /* fullName → { dec, disp, ts } */
    /* ── 大数组分页查看 ──
       元素数上千的数组（ARRAY[0..1999] OF REAL 这类）不能整表铺开，
       前端按页要值。为了不在翻页时额外读 PLC，scanFull 顺手把**被查看符号**的
       原始 buffer 留一份（每轮覆盖，天然最新）；没被查看的符号不占内存。 */
    this.keepRaw = new Set();     /* 正在被分页查看的符号 full 名 */
    this.arrayRaw = {};           /* fullName → { buf, ts } 最近一轮的原始字节 */
    /* ── 前端监控列表（含数组元素 / 点表外标量）实时值 ──
       这些名字不在主点表也不在整符号级全量列表里，需单独分批登记读取 */
    this.watchKeys = [];          /* 前端传来的 key（不含 Application. 前缀） */
    this.watchTasks = [];         /* [{names[], handle}] 每批 ≤460B */
    this.watchValues = {};        /* key → 展示值 */
    this.fullStats = { lists: 0, entries: 0, bytes: 0, ms: 0, regMs: 0 };
    /* ── 结构体钻取 ── */
    this.drillCache = {};         /* 成员路径 → 叶子（drillWrite 登记用） */
    this.drillLayout = loadDrillLayout();  /* UNION 已对账布局（落盘缓存，符号全路径 → 布局） */
    this.learnFail = {};          /* 学习失败记录（仅本会话，防止反复对账：符号 → 原因） */
  }

  /* 串行执行（读写互斥：PLC 单连接） */
  q(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.wsSet) { if (ws.readyState === 1) ws.send(s); }
  }

  log(level, text, hex) {
    this.broadcast({ t: 'log', ts: Date.now(), level, text, hex: hex || null });
  }

  /* 故障留痕：写环形缓冲 + 广播，供前端"最近异常"面板与事后定位 */
  note(kind, text, extra) {
    const ev = Object.assign({ ts: Date.now(), kind, text }, extra || {});
    this.events.push(ev);
    if (this.events.length > 60) this.events.shift();
    this.broadcast(Object.assign({ t: 'event' }, ev));
    return ev;
  }

  snap() {
    return {
      t: 'state', state: this.state, step: this.step, handshake: this.handshake,
      stats: this.stats, rtt: this.rtt, lastError: this.lastError,
      readWin: this.readWin,          /* 最近 80 次读结果（成功率按此算） */
      lastReadAt: this.lastReadAt, host: HOST, port: PLC_PORT,
      period: this.period, readonly: READONLY, lastBefore: this.lastBefore || {},
      fullStats: this.fullStats,
      symbolCount: SYMBOLS.length,
      events: this.events.slice(-12),
    };
  }

  emitState() {
    if (this._lastState !== this.state) {
      const from = this._lastState;
      const kind = this.state === 'error' ? 'err' : (this.state === 'online' ? 'ok' : 'state');
      /* 文案面向看板读者：只讲"怎么了"，原始报文留在日志区；from/to 结构化存档供复盘 */
      let txt;
      if (this.state === 'error') txt = '握手失败 · ' + friendlyErr(this.lastError);
      else if (this.state === 'online') txt = '链路在线';
      else if (this.state === 'reconnecting') txt = '链路中断，自动重连中';
      else txt = '未连接';
      this.note(kind, txt, { from, to: this.state });
      this._lastState = this.state;
    }
    this.broadcast(this.snap());
  }

  /* ── 握手 ── */
  stepStart(n, label) {
    this.step = n;
    this.handshake.push({ n, label, status: 'run', ms: null, detail: '' });
    this.emitState();
    return { n, t0: Date.now() };
  }
  stepEnd(ctx, detail, status = 'ok') {
    const it = this.handshake[this.handshake.length - 1];
    if (it && it.n === ctx.n) {
      it.status = status; it.ms = Date.now() - ctx.t0; it.detail = detail;
    }
    this.emitState();
  }

  async connect() {
    if (this.state === 'connecting' || this.state === 'online') return;
    /* 单飞：一次只允许一条连接链；旧连接先彻底丢弃，避免 PLC 单连接名额被旧 socket 占住 */
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const gen = ++this.gen;
    try { if (this.client && this.client.sock) this.client.sock.destroy(); } catch (_) {}
    this.client = null;
    this.intentional = false;
    this.state = 'connecting';
    this.handshake = [];
    this.lastError = null;
    this.emitState();
    this.log('sys', `── 建立连接 ${HOST}:${PLC_PORT} ──`);

    try {
      const c = new CodesysV3Client(HOST, PLC_PORT, { allowWrite: !READONLY });
      this.client = c;
      this.hookFrames(c);

      let ctx = this.stepStart(1, 'NS 查询');
      this.log('tx', '→ 01 NS 查询（独立短连接 seq=01）');
      const name = await c.nsQuery();
      this.log('rx', `← NS 响应 · 设备名 "${name}"`);
      this.stepEnd(ctx, '设备名 ' + name);

      ctx = this.stepStart(2, '主连接 NS');
      await c.connect();
      /* TCP 层留痕：能区分"被 PLC/网络踢掉"与"应用层协议失败"
         gen 校验：只有当前这代连接的事件才处理，旧连接的迟到 close 一律丢弃 */
      c.sock.on('error', (e) => {
        if (gen !== this.gen) return;
        this.note('sock', 'TCP 错误 ' + (e.code || e.message));
      });
      c.sock.on('close', () => {
        if (gen !== this.gen) return;
        const hadError = !this.intentional;
        this.note(hadError ? 'sock' : 'sys',
          hadError ? 'TCP 连接被对端关闭（PLC 单连接被抢占 / 网络中断）' : 'TCP 已按请求关闭');
        if (hadError && (this.state === 'online' || this.state === 'connecting')) {
          this.lastError = 'TCP 连接被对端关闭';
          this.scheduleReconnect(500);
        }
      });
      await c.nsQueryOnMain();
      this.log('rx', '← 主连接 NS 对齐（seq=02）');
      this.stepEnd(ctx, 'seq=02 拓扑对齐');

      ctx = this.stepStart(3, '开通道');
      this.log('tx', '→ 通道请求 c3/0101');
      const chId = await c.openChannel();
      this.log('rx', '← 通道建立 · chId = 0x' + chId.toString(16).toUpperCase());
      this.stepEnd(ctx, 'chId = 0x' + chId.toString(16).toUpperCase());

      ctx = this.stepStart(4, '会话创建');
      this.log('tx', '→ service 01/01 会话创建（空载荷）');
      const n1 = await c.sessionCreate();
      this.log('rx', `← 会话响应 ${n1}B`);
      this.stepEnd(ctx, n1 + 'B 响应');

      ctx = this.stepStart(5, '登录');
      this.log('tx', '→ service 01/02 登录（32B 授权块）');
      const sid = await c.login();
      this.log('rx', '← session_id = 0x' + sid.toString(16).toUpperCase().padStart(8, '0'));
      this.stepEnd(ctx, 'session = 0x' + sid.toString(16).toUpperCase().padStart(8, '0'));

      ctx = this.stepStart(6, 'GetRoot');
      this.log('tx', '→ 09/07 GetRoot');
      const root = await c.getRoot();
      this.log('rx', '← root = 0x' + root.toString(16).toUpperCase().padStart(8, '0')
        + ' · 令牌 = 0x' + ((c.deviceToken || 0) >>> 0).toString(16).toUpperCase().padStart(8, '0'));
      this.stepEnd(ctx, 'root = 0x' + root.toString(16).toUpperCase().padStart(8, '0')
        + ' · 令牌 0x' + ((c.deviceToken || 0) >>> 0).toString(16).toUpperCase().padStart(8, '0'));

      ctx = this.stepStart(7, 'PrepareRead');
      /* 主点表按 460B 预算分批登记（协议硬约束：服务消息 >2 块必挂 8400——
         19/21 点整表带 Application. 前缀约 950~1070B 跨入 3 块死区；
         分批后每批 ≤1 块，与全量列表同一套已验证机制） */
      const tagBatches = packPaths(TAGS.map(t => 'Application.' + t.key));
      this.log('tx', `→ 09/01 PrepareRead（${TAGS.length} 点 · ${tagBatches.length} 批登记 + 设备令牌）`);
      this.tagTasks = [];
      let idx = 0;
      for (const b of tagBatches) {
        const h = await c.prepareRead(b);
        this.tagTasks.push({ start: idx, names: b, handle: h });
        idx += b.length;
      }
      this.tagHandle = this.tagTasks[0].handle;   /* 兼容旧恢复路径（drill/写后还原句柄） */
      this.log('rx', `← ${this.tagTasks.length} 个读取列表就绪 · 首句柄 0x` + this.tagHandle.toString(16).toUpperCase().padStart(8, '0'));
      this.stepEnd(ctx, `${TAGS.length} 点 / ${this.tagTasks.length} 批 · 首句柄 0x${this.tagHandle.toString(16).toUpperCase().padStart(8, '0')}`);

      ctx = this.stepStart(8, '全量列表');
      this.log('tx', `→ 分批登记全量符号（${SYMBOLS.length} 个，每批 1 块）`);
      await this.buildFullLists(c);
      this.log('rx', `← ${this.fullTasks.length} 个列表就绪 · 登记耗时 ${this.fullStats.regMs}ms`);
      this.stepEnd(ctx, `${this.fullTasks.length} 列表 / ${SYMBOLS.length} 符号 · ${this.fullStats.regMs}ms`);

      this.state = 'online';
      this.lastError = null;
      this.emitState();
      this.log('ok', '✅ 握手完成，链路在线');
      /* 重连后把前端已登记的监控列表重新登记（数组元素 / 点表外标量） */
      if (this.watchKeys.length) {
        this.watchTasks = [];
        await this.refreshWatch(this.watchKeys).catch(() => {});
      }
      this.startLoop();
    } catch (e) {
      /* 过期连接链的失败不影响当前状态 */
      if (gen !== this.gen) return;
      this.state = 'error';
      this.lastError = e.message;
      const it = this.handshake[this.handshake.length - 1];
      if (it && it.status === 'run') { it.status = 'fail'; it.ms = null; it.detail = e.message.slice(0, 80); }
      this.emitState();
      this.log('err', '✗ 握手失败：' + e.message);
      /* 失败后彻底释放 socket：不清理会占住 PLC 唯一连接名额，导致后续每次握手都超时 */
      this.intentional = true;
      try { if (this.client && this.client.sock) this.client.sock.destroy(); } catch (_) {}
      this.client = null;
      this.scheduleReconnect(3000);
    }
  }

  /* 帧计数 hook */
  hookFrames(c) {
    const origSend = c.sendFrame.bind(c);
    c.sendFrame = (d) => { this.stats.txFrames++; this.stats.txBytes += d.length + 8; return origSend(d); };
    const origWait = c.waitForFrame.bind(c);
    c.waitForFrame = (ms) => origWait(ms).then((d) => { this.stats.rxFrames++; this.stats.rxBytes += d.length + 8; return d; },
      (e) => { throw e; });
  }

  /* ── 全量列表建立 ──
     协议约束（实测）：PrepareRead 载荷 >1 块（468B）会触发 PLC 接收缓冲配额问题，
     连续 2 次 2 块登记后第 3 次必回通道错误 8400。因此每批严格控制在 1 块以内，
     标量切 ~25 批、复合符号每符号 1 批，共约 46 个列表；之后每轮仅发 ExecuteRead。 */
  async buildFullLists(c) {
    const BUDGET = 460, HEAD = 24;
    const entrySize = (f) => { const n = Buffer.byteLength(f) + 1; return (n + 4 + 3) & ~3; };
    const pack = (list) => {
      const out = []; let cur = [], sz = HEAD;
      for (const s of list) {
        const e = entrySize(s.full);
        if (sz + e > BUDGET && cur.length) { out.push(cur); cur = []; sz = HEAD; }
        cur.push(s); sz += e;
      }
      if (cur.length) out.push(cur);
      return out;
    };

    const tasks = [
      ...pack(SCALARS).map((b, i) => ({ kind: '标量批' + (i + 1), syms: b, names: b.map(s => s.full) })),
      ...COMPOSITES.map((s) => ({ kind: '复合 ' + s.name, syms: [s], names: [s.full] })),
    ];

    const t0 = Date.now();
    let ok = 0;
    for (const t of tasks) {
      try { t.handle = await c.prepareRead(t.names); ok++; }
      catch (e) { this.log('err', `✗ ${t.kind} 登记失败：${e.message.slice(0, 60)}`); }
    }
    this.fullTasks = tasks.filter(t => t.handle);
    this.fullStats = { lists: this.fullTasks.length, entries: 0, bytes: 0, ms: 0, regMs: Date.now() - t0 };
    return ok;
  }

  startLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setTimeout(() => this.tick(), 80);
  }

  /* ── 前端监控列表登记（数组元素 / 点表外标量） ──
     只对**新增**的名字做分批 prepareRead（每批 ≤460B = 1 块，安全），
     已登记过的直接复用句柄，避免反复建列表把 PLC 列表资源吃掉。 */
  async refreshWatch(keys) {
    if (this.state !== 'online' || !this.client) return;
    const want = [...new Set((keys || []).map(k => 'Application.' + k))];
    this.watchKeys = want;
    const known = new Set(this.watchTasks.flatMap(t => t.names));
    const add = want.filter(f => !known.has(f));
    for (const batch of add.length ? packPaths(add) : []) {
      try {
        const h = await this.client.prepareRead(batch);
        this.watchTasks.push({ names: batch, handle: h });
      } catch (e) { this.log('err', '✗ 监控列表登记失败：' + e.message.slice(0, 60)); }
    }
    const wantSet = new Set(want);
    this.watchTasks = this.watchTasks
      .map(t => ({ names: t.names.filter(f => wantSet.has(f)), handle: t.handle }))
      .filter(t => t.names.length);
  }

  /* 扫描监控列表 → 广播实时值（数组元素靠这里拿值，不走整符号摘要） */
  async scanWatch(c) {
    if (!this.watchTasks.length) return;
    const items = [];
    const prevH = c.readListHandle;
    try {
      for (const t of this.watchTasks) {
        c.readListHandle = t.handle;
        const bufs = await c.executeRead();
        t.names.forEach((f, i) => {
          const key = f.replace(/^Application\./, '');
          const tag = symTag(key);
          const raw = bufs[i] || null;
          let disp = '--';
          if (raw && raw.length && tag) {
            const v = readBase(tag.type, raw, 0);
            if (v !== null && v !== undefined)
              disp = tag.type === 'BOOL' ? (v ? 'TRUE' : 'FALSE') : String(v);
          }
          this.watchValues[key] = disp;
          items.push({ key, d: disp, ty: tag ? tag.type : '' });      /* ty：前端据此决定 BOOL/数字控件 */
        });
      }
    } finally { c.readListHandle = prevH; }
    if (items.length) this.broadcast({ t: 'wvals', ts: Date.now(), items });
  }

  /* 最近 80 次读结果窗口（1 成功 / 0 失败） */
  pushReadWin(okFlag) {
    this.readWin.push(okFlag ? 1 : 0);
    if (this.readWin.length > READ_WIN) this.readWin.splice(0, this.readWin.length - READ_WIN);
  }

  async tick() {
    if (this.state !== 'online') return;
    await this.q(async () => {
      if (this.state !== 'online') return;
      const c = this.client;
      const t0 = Date.now();
      try {
        /* 主点表已分批（tagTasks）：逐列表 ExecuteRead，结果按 start 合并回 TAGS 顺序 */
        const bufs = new Array(TAGS.length).fill(null);
        let readMs = 0;
        for (const t of this.tagTasks) {
          c.readListHandle = t.handle;
          const t0b = Date.now();
          const bb = await c.executeRead();
          readMs += Date.now() - t0b;
          bb.forEach((b, j) => { bufs[t.start + j] = b; });
        }
        const ms = readMs;
        this.stats.reads++; this.stats.ok++;
        this.pushReadWin(1);
        this.pushRtt(ms);
        this.seq++;
        this.lastReadAt = Date.now();
        const out = [];
        TAGS.forEach((tag, i) => {
          const raw = bufs[i] || null;
          const v = raw ? decode(tag, raw) : null;
          const prev = this.values[tag.key];
          this.rawValues[tag.key] = raw;
          out.push({ key: tag.key, value: v, changed: prev !== undefined && prev !== v, hex: raw ? raw.toString('hex') : null });
          if (v !== null) this.values[tag.key] = v;
        });
        this.broadcast({ t: 'values', seq: this.seq, ts: Date.now(), rtt: ms, items: out });
        /* 监控列表（数组元素 / 点表外标量）：少量列表，紧跟主点表读 */
        if (this.watchTasks.length) {
          try { await this.scanWatch(c); }
          catch (e) { this.log('err', '✗ 监控扫描失败：' + e.message.slice(0, 60)); }
        }
        /* 全量扫描：继续遍历全部列表（约 46 次 ExecuteRead） */
        if (this.fullTasks.length) {
          const tf = Date.now();
          try { await this.scanFull(c); }
          catch (e) { this.log('err', '✗ 全量扫描失败：' + e.message.slice(0, 60)); }
          this.fullStats.ms = Date.now() - tf;
        }
        if (this.seq % 5 === 1) {
          this.log('tx', `→ 09/03 ExecuteRead（8B：句柄 0x${c.readListHandle.toString(16).toUpperCase()}）`);
          this.log('rx', `← 09/03 响应 #${this.seq}　${bufs.length} 条目　RTT ${ms}ms　payload ${(c.lastReadPayload || { length: 0 }).length}B`);
        }
      } catch (e) {
        this.stats.reads++; this.stats.fail++;
        this.pushReadWin(0);
        this.lastError = e.message;
        this.log('err', '✗ 周期读失败：' + e.message);
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.intentional = true;
        try { this.client.sock && this.client.sock.destroy(); } catch (_) {}
        this.client = null;
        this.scheduleReconnect(1000);
        return;
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.tick(), this.period);
    });
  }

  /* ── 全量扫描：遍历所有列表，仅发 ExecuteRead（8B，无配额限制） ── */
  async scanFull(c) {
    this.fullStats.entries = 0;
    this.fullStats.bytes = 0;
    const items = [];
    for (const t of this.fullTasks) {
      c.readListHandle = t.handle;
      const bufs = await c.executeRead();
      this.fullStats.bytes += (c.lastReadPayload || { length: 0 }).length;
      t.syms.forEach((sym, i) => {
        const raw = bufs[i] || null;
        /* 正在被分页查看的数组：留一份原始字节，翻页时本地解码，不再打扰 PLC */
        if (raw && this.keepRaw.has(sym.full)) this.arrayRaw[sym.full] = { buf: raw, ts: Date.now() };
        const dec = raw ? decodeSymbol(sym, raw) : { kind: 'none' };
        const disp = dispSymbol(sym, dec);
        const prev = this.fullValues[sym.full];
        const changed = !!prev && prev.disp !== disp;
        this.fullValues[sym.full] = { dec, disp, changed, ts: Date.now() };
        items.push({ f: sym.full, d: disp, c: changed });
        this.fullStats.entries++;
      });
    }
    this.broadcast({ t: 'full', seq: this.seq, ts: Date.now(), items, stats: this.fullStats });
  }

  /* ── 大数组分页取值 ──
     元素数上千的数组（ARRAY[0..1999] OF REAL）不能整表铺开：一页 20 个正好能看全，
     又不会把表格撑到 2000 行。
     数据来源优先级：
       ① scanFull 上一轮为该符号留下的原始字节（每 500ms 自动更新，翻页零额外通讯）
       ② 缓存缺失/过期 → 从已登记的读取列表里取一次（不新建 PrepareRead）
     解码在服务端做（readBase 按元素基类型 + 步长），前端只拿 20 个字符串。 */
  async arrayPage(key, page = 0, size = 20) {
    const full = 'Application.' + String(key || '').replace(/^Application\./, '');
    const sym = SYMBOLS.find(s => s.full === full);
    if (!sym) throw new Error('符号不存在：' + key);
    if (!sym.elem) throw new Error(key + ' 不是数组（无元素元信息）');

    const { lo, hi } = sym.elem;
    const total = hi - lo + 1;
    const per = Math.max(1, Math.min(200, Number(size) || 20));
    const pages = Math.max(1, Math.ceil(total / per));
    const pg = Math.max(0, Math.min(pages - 1, Number(page) || 0));

    this.keepRaw.add(full);          /* 请求后即纳入缓存，后续轮次自动保留 */

    const esz = Math.max(1, Math.round(sym.elem.size || 1));
    const base = String(sym.elem.base || '').toUpperCase();

    /* 取原始字节：先看缓存（2s 内算新鲜），否则读一次 */
    let raw = null;
    const cached = this.arrayRaw[full];
    if (cached && Date.now() - cached.ts < 2000) raw = cached.buf;
    if (!raw && this.state === 'online' && this.client) {
      raw = await this.q(async () => {
        const c = this.client;
        const prevH = c.readListHandle;
        const slot = (() => {
          for (const t of this.fullTasks) {
            const i = t.names.indexOf(full);
            if (i >= 0) return { task: t, index: i };
          }
          return null;
        })();
        try {
          if (slot) {
            c.readListHandle = slot.task.handle;
            const bufs = await c.executeRead();
            return bufs[slot.index] || null;
          }
          /* 兜底：单符号临时登记（1 块，安全），读完只恢复句柄指针 */
          await c.prepareRead([full]);
          const bufs = await c.executeRead();
          return bufs[0] || null;
        } finally { c.readListHandle = prevH; }
      });
      if (raw) this.arrayRaw[full] = { buf: raw, ts: Date.now() };
    }

    const from = lo + pg * per;
    const to = Math.min(hi, from + per - 1);
    const values = [];
    for (let i = from; i <= to; i++) {
      const off = (i - lo) * esz;
      let d = '--';
      if (raw && off + esz <= raw.length) {
        const v = readBase(base, raw, off);
        if (v !== null && v !== undefined) d = base === 'BOOL' ? (v ? 'TRUE' : 'FALSE') : String(v);
      }
      values.push({ i, d });
    }
    /* 能否逐个写：元素基类型属可写 IEC 且符号 access 含 w
       （WRITABLE_IEC 是主点表/全量页共用的那套白名单，与 symTag() 判定一致） */
    const writable = WRITABLE_IEC.has(base)
      && String(sym.access || '').toLowerCase().includes('w');

    return {
      ok: true, full: sym.full, name: sym.name, base, esz, writable,
      lo, hi, total, size: per, page: pg, pages,
      from, to, values,
      ts: cached ? cached.ts : Date.now(),
      online: this.state === 'online',
    };
  }

  pushRtt(ms) {
    this.rtt.push(ms);
    if (this.rtt.length > 80) this.rtt.shift();
    this.broadcast({ t: 'rtt', rtt: ms, stats: this.stats, readWin: this.readWin });
  }

  /* 唯一重连排期：多个失败源同时触发也只排一次，杜绝连接风暴
     （PLC 11740 只服务一个 TCP 连接，并发连接会互相把对方挤成"读帧超时"） */
  scheduleReconnect(delay = 3000) {
    if (this.reconnectTimer) return;                 /* 已有排期，不叠加 */
    if (this.state !== 'error') { this.state = 'reconnecting'; this.emitState(); }
    this.log('sys', Math.round(delay / 1000) + ' 秒后重连…');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.intentional = true;
      try { this.client && this.client.sock && this.client.sock.destroy(); } catch (_) {}
      this.client = null;
      this.state = 'idle';
      this.connect();
    }, delay);
  }

  reconnect() { this.scheduleReconnect(3000); }

  /* ── 程序切换（XML 导入后 / 首页选择）：热加载新程序数据并重连 ──
     同名重导入也走全流程：数据文件刚被重新生成，必须重载。 */
  switchApp(app) {
    loadAppData(app);
    /* 停轮询 + 断 PLC + 作废旧连接回调（防旧 close 触发重连） */
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.gen++;
    this.intentional = true;
    try { this.client && this.client.sock && this.client.sock.destroy(); } catch (_) {}
    this.client = null;
    this.state = 'idle'; this.handshake = [];
    /* 清空旧程序运行态（值缓存/全量表/钻取登记/学习记录） */
    this.values = {}; this.rawValues = {};
    this.fullTasks = []; this.fullValues = {};
    this.arrayRaw = {};          /* 换程序：符号都变了，缓存作废 */
    this.drillCache = {}; this.learnFail = {}
    this.drillLayout = loadDrillLayout();
    this.emitState();
    /* 通知所有页面：程序已切换（点表/白名单/符号数随行） */
    this.broadcast({ t: 'app', app: APP_ID, appDisplay: APP_DISPLAY,
      points: TAGS.length, symbolCount: SYMBOLS.length,
      tags: TAGS, whitelist: WHITELIST });
    this.log('sys', `── 程序已切换：${APP_ID}（${TAGS.length} 点 · ${SYMBOLS.length} 符号），重新握手 ──`);
    /* 给 PLC 留出释放上一个连接的时间，统一走唯一排期 */
    this.scheduleReconnect(1200);
  }

  /* ── 修改 PLC 地址并重连（界面「PLC 配置」用） ──
     落盘后立即生效：停轮询 → 断旧连接 → 作废旧回调 → 用新地址重新握手。
     换设备（IP 变了）时旧的点表/符号表仍按当前程序载入，无需重新导入 XML。 */
  applyPlcConfig(host, port, opts) {
    const o = opts || {};
    const err = validatePlcAddr(host, port);
    if (err) throw new Error(err);
    const h = String(host).trim();
    const p = Number(port);
    const changed = (h !== HOST) || (p !== PLC_PORT);

    HOST = h; PLC_PORT = p;
    PLC_CFG = { host: h, port: p, source: 'file' };
    if (o.persist !== false) savePlcConfig(h, p);

    /* 停轮询 + 断 PLC + 作废旧连接回调（防旧 close 触发重连） */
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.gen++;
    this.intentional = true;
    try { this.client && this.client.sock && this.client.sock.destroy(); } catch (_) {}
    this.client = null;
    this.state = 'idle'; this.handshake = []; this.lastError = null;
    /* 连接态清空（点表/符号表保留：还是同一个程序） */
    this.values = {}; this.rawValues = {};
    this.fullTasks = []; this.fullValues = {};
    this.arrayRaw = {};
    this.watchTasks = []; this.watchValues = {}
    this.drillCache = {}; this.learnFail = {};
    this.emitState();

    /* 通知所有页面：地址已更新 */
    this.broadcast({ t: 'plccfg', host: HOST, port: PLC_PORT, source: 'file', changed });
    if (changed) {
      this.log('sys', `── PLC 地址已更新：${HOST}:${PLC_PORT}，重新握手 ──`);
      this.scheduleReconnect(600);
    } else {
      this.log('sys', `── PLC 地址未变化（${HOST}:${PLC_PORT}），已重新握手 ──`);
      this.scheduleReconnect(600);
    }
    return { host: HOST, port: PLC_PORT, changed };
  }

  /* ── 结构体钻取：成员结构来自 XML（离线即可展开），在线时附加实时值（层级树） ── */
  async drill(key) {
    return this.q(async () => {
      const sym = SYMBOLS.find(s => s.full === key);
      if (!sym) throw new Error('符号不存在：' + key);
      const counter = { n: 0 };
      const tree = expandTree(sym.full, xmlTypeName(sym.type), sym.access === 'rw', 4, counter);

      /* 收集叶子（真正发读请求的对象） */
      const leaves = [];
      const collect = (n) => {
        if (n.children) n.children.forEach(collect);
        else if (n.path && !n.note) leaves.push(n);
      };
      collect(tree);
      if (!leaves.length) throw new Error('没有可展开的成员');

      /* 值读取：仅链路在线时执行；离线照样返回结构（value=null，前端显示 --）
         策略（用户规则）：读走整符号一次读（blob）+ 本地按偏移解码；写入永远按成员名单独写。
         ① 布局可信（counter.learn 未置位）→ 整读优先，被拒/尺寸不符自动回退按成员名分批读；
         ② 含 UNION/可疑布局 → 两段式：首次「学习」＝逐名读做基准 + 整读对账推导真实布局
            （元素步长、重叠成员偏移），全叶一致才落盘缓存；此后每次直接整读按缓存偏移解码
            （快路径）；对不上 → 回退逐名读，本会话不再试学。 */
      const online = this.state === 'online';
      const needLearn = !!counter.learn;
      let needBytes = 0;
      for (const l of leaves) needBytes = Math.max(needBytes, (l.off || 0) + (l.size || 0));

      const readMap = {};
      let readBlob = null, readMode = 'offline', shiftWarn = false, learnNote = '';
      const t0 = Date.now();
      const c = this.client;
      if (online) {
        if (!needLearn) {
          /* ① 可信布局：整读优先（一次 09/04 拿回整个符号，本地按 XML 偏移解码） */
          try {
            await c.prepareRead([sym.full]);
            const bufs = await c.executeRead();
            const blob = bufs && bufs[0];
            if (blob && needBytes > 0 && blob.length >= needBytes) {
              readBlob = blob;
              readMode = 'whole';
            }
          } catch (_) { /* 整读被拒 → 回退 */ }
          finally { c.readListHandle = this.tagHandle; }
          /* 回退：按成员名分批读（460B 预算） */
          if (readMode !== 'whole') {
            try {
              for (const batch of packPaths(leaves.map(l => l.path))) {
                await c.prepareRead(batch);
                const bufs = await c.executeRead();
                if (bufs.length < batch.length) shiftWarn = true;   /* 错误条目会吞掉一个槽位 */
                batch.forEach((p, j) => { readMap[p] = bufs[j] || null; });
              }
              readMode = 'names';
            } finally {
              c.readListHandle = this.tagHandle;
            }
          }
        } else {
          /* ② 可疑布局（含 UNION）：缓存快路径（弱验证须抽查）→ 对账学习 → 逐名回退 */
          let cached = this.drillLayout[sym.full];
          if (cached && cached.ok) {
            let blob = null, probeBad = false;
            try {
              await c.prepareRead([sym.full]);
              const bufs = await c.executeRead();
              blob = bufs && bufs[0];
            } catch (_) { blob = null; }
            finally { c.readListHandle = this.tagHandle; }
            if (blob && blob.length === cached.blobBytes) {
              for (const l of leaves) if (cached.off[l.path] != null) l.off = cached.off[l.path];
              /* 弱验证条目（对账时值恒同，偏移未唯一确定）→ 每次命中逐名抽查，
                 不符立即作废重学——杜绝"推算位不是真位"的静默错值 */
              if (Array.isArray(cached.weak) && cached.weak.length) {
                const probes = [];
                for (const fam of cached.weak) {
                  const rep = leaves.find(l => l.flagged && l.path.replace(/\[\d+\]/g, '[*]') === fam);
                  if (rep) probes.push(rep);
                }
                if (probes.length) {
                  try {
                    for (const batch of packPaths(probes.map(p => p.path))) {
                      await c.prepareRead(batch);
                      const bufs = await c.executeRead();
                      batch.forEach((p, j) => {
                        const l = probes.find(x => x.path === p);
                        const o = cached.off[p], n = l.size || 0;
                        const raw = bufs[j];
                        if (!raw || !raw.length || !(o >= 0) || o + n > blob.length) { probeBad = true; return; }
                        if (decodeLeaf(l, blob.subarray(o, o + n)).value !== decodeLeaf(l, raw).value) probeBad = true;
                      });
                      if (probeBad) break;
                    }
                  } catch (_) { probeBad = true; }
                  finally { c.readListHandle = this.tagHandle; }
                }
              }
              if (!probeBad) {
                readBlob = blob;
                readMode = 'whole';
                learnNote = (Array.isArray(cached.weak) && cached.weak.length)
                  ? `UNION 布局缓存命中 + 弱验证抽查通过（${cached.checkedAt} 对账）`
                  : `UNION 布局缓存命中（${cached.checkedAt} 对账）`;
              }
            } else { probeBad = false; cached = null; }
            if (readMode !== 'whole') {
              cached = null;
              delete this.drillLayout[sym.full];
              this.log('sys', `钻取 ${sym.name}：缓存布局失效（${probeBad ? '弱验证抽查不符' : '整读尺寸不符/异常'}），重新对账学习`);
            }
          }
          if (readMode !== 'whole') {
            /* 基准：逐名读全部叶子（真值） */
            try {
              for (const batch of packPaths(leaves.map(l => l.path))) {
                await c.prepareRead(batch);
                const bufs = await c.executeRead();
                if (bufs.length < batch.length) shiftWarn = true;
                batch.forEach((p, j) => { readMap[p] = bufs[j] || null; });
              }
              readMode = 'names';
            } finally {
              c.readListHandle = this.tagHandle;
            }
            /* 学习：整读一次 → learnUnionLayout 推导布局并与基准对账 */
            if (!cached && !this.learnFail[sym.full]) {
              try {
                await c.prepareRead([sym.full]);
                const bufs = await c.executeRead();
                const blob = bufs && bufs[0];
                const res = (blob && blob.length)
                  ? learnUnionLayout(sym, leaves, readMap, blob)
                  : { ok: false, reason: '整读无返回' };
                if (res.ok) {
                  const entry = { ok: true, blobBytes: res.blobBytes, stride: res.stride,
                    off: res.off, weak: res.weak, checkedAt: new Date().toISOString() };
                  this.drillLayout[sym.full] = entry;
                  saveDrillLayout(this.drillLayout);
                  for (const l of leaves) if (res.off[l.path] != null) l.off = res.off[l.path];
                  readBlob = blob;
                  readMode = 'whole';
                  learnNote = (res.weak && res.weak.length)
                    ? `UNION 对账通过但 ${res.weak.length} 个成员族值恒同（取 IEC 推算位，弱验证——缓存命中时逐名抽查）`
                    : `UNION 对账通过：整读 ${res.blobBytes}B / 步长 ${res.stride}B，${res.famCount} 成员族与逐名读全一致`;
                  this.log('sys', `钻取 ${sym.name}：${learnNote} → 布局已缓存，后续直接整读`);
                } else {
                  this.learnFail[sym.full] = res.reason;
                  learnNote = `UNION 对账失败：${res.reason}`;
                  this.log('err', `钻取 ${sym.name}：${learnNote} → 回退逐名读（本会话不再试学）`);
                }
              } catch (e) {
                this.learnFail[sym.full] = '整读异常：' + e.message;
                this.log('sys', `钻取 ${sym.name}：整读学习未成（${e.message}），按逐名读展示`);
              } finally { c.readListHandle = this.tagHandle; }
            }
          }
        }
      }
      const ms = Date.now() - t0;

      /* 叶子填值 + 写缓存登记 */
      this.drillCache = this.drillCache || {};
      for (const l of leaves) {
        let raw = null;
        if (readBlob) {
          const o = l.off || 0, n = l.size || 0;
          raw = n > 0 && readBlob.length >= o + n ? readBlob.subarray(o, o + n) : null;
        } else if (online) {
          raw = readMap[l.path] || null;
        }
        const d = raw && raw.length ? decodeLeaf(l, raw) : { value: null };
        l.value = d.value; l.enumName = d.enumName || null;
        l.hex = raw && raw.length ? raw.toString('hex') : '';
        if (l.writable && !READONLY) this.drillCache[l.path] = l;
      }
      const rows = flattenTree(tree);
      rows.forEach((r) => { if (r.path && r.node) r.writable = false; });

      if (online) {
        const m = learnNote || (readMode === 'whole'
          ? `整读 1 次 ${readBlob.length}B`
          : `成员名分批读（整读不可用，已回退）`);
        this.log('sys', `钻取 ${sym.gvl}.${sym.name}：${leaves.length} 叶子 · ${rows.length} 行 · ${m} · ${ms}ms`);
      } else {
        this.log('sys', `钻取 ${sym.gvl}.${sym.name}：${leaves.length} 叶子（离线结构预览，实时值待上电）`);
      }
      this.broadcast({
        t: 'drill', key: sym.full, rows, ms, shiftWarn, online, readMode, learnNote,
        blobBytes: readBlob ? readBlob.length : 0,
        leafCount: leaves.length,
        sym: { gvl: sym.gvl, name: sym.name, type: sym.type, bytes: sym.bytes, comment: sym.comment || '' },
      });
    });
  }

  /* ── 钻取成员写入：须先 drill 登记；XML access 含 Write 才放行 ── */
  async drillWrite(key, value) {
    return this.q(async () => {
      const leaf = (this.drillCache || {})[key];
      if (!leaf) throw new Error('成员路径未经钻取登记，请先展开其父符号');
      if (!leaf.writable) throw new Error('该成员只读（XML access）');
      if (READONLY) throw new Error('服务以只读模式启动（MYX_READONLY=1）');
      if (this.state !== 'online') throw new Error('链路不在线（state=' + this.state + '）');

      const emit = (level, text) => {
        this.log(level, text);
        this.broadcast({ t: 'wtest', ts: Date.now(), level, text });
      };
      const c = this.client;
      const data = encodeLeaf(leaf.type, value);
      emit('sys', `┌ 成员写入：${key} ← ${value}`);
      const t0 = Date.now();
      try {
        const w = await c.writeValue(key, data);
        emit(w.ok ? 'ok' : 'err', `│ 09/04 写入 status=0x${w.status.toString(16)} · ${Date.now() - t0}ms`);
        if (!w.ok) { emit('err', '└ ✗ 写入被拒（status≠0）'); return; }
        /* 写后回读验证（单条临时列表） */
        await c.prepareRead([key]);
        const bufs = await c.executeRead();
        const raw = bufs[0] || null;
        const d = raw && raw.length ? decodeLeaf(leaf, raw) : { value: null };
        const back = d.value;
        const same = typeof back === 'number'
          ? Math.abs(back - Number(value)) < 1e-6
          : String(back) === String(value);
        emit(same ? 'ok' : 'err', `└ 回读 = ${back}${same ? '　✓ 与目标一致' : '　✗ 不一致'}`);
        this.broadcast({ t: 'drillw', key, value: back, ok: same });
      } finally {
        c.readListHandle = this.tagHandle;
      }
    });
  }

  /* ── 写入操作 ──
     mode = 'set'    写目标值 → 回读校验 → **保留生效**（HMI 正常写值行为）
     mode = 'noop'   读原值 → 写回原值 → 回读比对（零副作用，验证链路）
     mode = 'change' 写目标值 → 回读 → 写回原值（自动还原，仅脚本自检用，UI 不再暴露）
     每次写入前的原值会广播给前端（t:'wprev'），供手动"恢复原值"按钮使用。 */
  async writeTest(key, mode, value) {
    return this.q(async () => {
      const started = Date.now();
      const emit = (level, text) => {
        this.log(level, text);
        this.broadcast({ t: 'wtest', ts: Date.now(), level, text });
      };
      const tag = TAGS.find(t => t.key === key)
        || symTag(key);                                  /* 点表外：全量符号表 rw 标量（全量写入验证） */
      if (!tag) throw new Error('未知变量：' + key + '（点表与全量符号表中均不存在，或类型/维度不支持写入）');
      /* 写权限以 XML access 为唯一准则（rw 才可写）；白名单不再拦截 */
      const sym = SYMBOLS.find(s => s.full === 'Application.' + key);
      if (sym && !String(sym.access || '').toLowerCase().includes('w'))
        throw new Error(`只读符号（XML access=${sym.access}）：${key}`);
      if (READONLY) throw new Error('服务以只读模式启动（MYX_READONLY=1）');
      if (this.state !== 'online') throw new Error('链路不在线（state=' + this.state + '）');
      /* 点表内沿用主表编码/解码；点表外标量按 XML IEC 类型走 drill-core 全类型编解码 */
      const enc = (v) => tag.sym ? encodeLeaf(tag.type, v) : encode(tag, v);
      const dec = (buf) => tag.sym ? readBase(tag.type, buf, 0) : decode(tag, buf);

      const c = this.client;
      const full = 'Application.' + key;
      const idx = TAGS.findIndex(t => t.key === key);   /* -1 = 点表外 */

      /* 在全量列表里定位某个符号已登记的槽位（复用它读取，零新增 PrepareRead） */
      const findFullSlot = (fq) => {
        for (const task of this.fullTasks) {
          const i = task.names.indexOf(fq);
          if (i >= 0) return { task, index: i };
        }
        return null;
      };

      /* 单次读取当前值。
         ⚠️ 协议硬约束：PrepareRead 载荷 >1 块（468B）连发即触发 PLC 通道错误 8400。
         主点表整表带前缀约 950~1070B 已跨入 3 块死区，所以这里
         ① 绝不整表重登记；② 优先复用已登记句柄，读完只把 readListHandle 指回去。 */
      const readOnce = async () => {
        const prevH = c.readListHandle;
        if (idx >= 0) {
          /* 主点表已分批（tagTasks）：必须按 idx 定位所在批，用批内偏移取值；
             一律用首批句柄会导致后批变量读错值/越界 */
          const b = this.tagTasks.find(t => idx >= t.start && idx < t.start + t.names.length);
          if (!b) throw new Error('主点表未登记（链路未就绪）');
          try {
            c.readListHandle = b.handle;
            const bufs = await c.executeRead();
            return dec(bufs[idx - b.start]);
          } finally { c.readListHandle = prevH; }
        }
        /* 点表外：优先复用全量列表的既有句柄 */
        const slot = findFullSlot(full);
        if (slot) {
          try {
            c.readListHandle = slot.task.handle;
            const bufs = await c.executeRead();
            return dec(bufs[slot.index]);
          } finally { c.readListHandle = prevH; }
        }
        /* 兜底：单变量临时登记（1 块，安全）。读完不重登记任何列表，仅恢复句柄指针 */
        try {
          await c.prepareRead([full]);
          const bufs = await c.executeRead();
          return dec(bufs[0]);
        } finally { c.readListHandle = prevH; }
      };

      emit('sys', '┌ 写入开始：' + tag.label + '（' + key + '）');
      const before = idx >= 0 ? this.values[key] : await readOnce();
      emit('sys', '│ ① 写入前当前值 = ' + fmt(tag, before));
      this.lastBefore = this.lastBefore || {};
      this.lastBefore[key] = before;
      this.broadcast({ t: 'wprev', key, before });

      let target = before;
      if (mode === 'noop') {
        emit('sys', '│ ② 回写同一值（零变化验证）');
      } else {
        target = value;
        emit('sys', '│ ② 目标值 = ' + fmt(tag, target) + (mode === 'change' ? '（脚本模式：自动还原）' : '（写入后保留）'));
      }

      const t1 = Date.now();
      const w = await c.writeValue(full, enc(target));
      emit(w.ok ? 'ok' : 'err', `│ ③ 09/04 写入 status=0x${w.status.toString(16)} · ${Date.now() - t1}ms`);
      if (!w.ok) { emit('err', '└ ✗ 写入被拒（status≠0），PLC 未变更'); return { ok: false, status: w.status }; }

      /* 写入后作废该符号的分页缓存：不删的话 /api/arrayvals 会继续返回
         2s 内的旧字节，界面表现为"写了但值没变"（尤其数组元素） */
      const rootFull = full.replace(/\[\d+\]$/, '');
      delete this.arrayRaw[rootFull];
      delete this.arrayRaw[full];

      const back = await readOnce();
      this.broadcast({ t: 'wcur', key, value: back });   /* 前端回读值同步（点表外变量靠这个刷新） */
      const same = Math.abs(Number(back) - Number(target)) < 1e-9 || (tag.type === 'BOOL' && +!!back === +!!target);
      emit(same ? 'ok' : 'err', `│ ④ 回读校验 = ${fmt(tag, back)}　${same ? '与目标一致 ✓' : '不一致 ✗'}`);
      if (!same && tag.inputMapped) {
        emit('sys', '│ ④′ 该点为 PLC 输入映射（物理输入 → 映像区），'
          + '写入被扫描周期立即覆盖——通讯写不进，属正常安全设计');
      }

      /* 只有脚本自检模式才还原；正常写值（set / noop）直接保留 */
      let restored = true;
      if (mode === 'change') {
        const w2 = await c.writeValue(full, enc(before));
        emit(w2.ok ? 'ok' : 'err', `│ ⑤ 还原原值 ${fmt(tag, before)}　status=0x${w2.status.toString(16)}`);
        const back2 = await readOnce();
        restored = Math.abs(Number(back2) - Number(before)) < 1e-9 || (tag.type === 'BOOL' && +!!back2 === +!!before);
        emit(restored ? 'ok' : 'err', `│ ⑥ 还原校验 = ${fmt(tag, back2)}　${restored ? '已恢复原值 ✓' : '⚠️ 未恢复，请手动确认！'}`);
      } else if (same && idx >= 0) {
        /* 立即用新值刷新缓存，卡片不等下一轮周期读 */
        this.values[key] = target;
      }

      const pass = same && restored;
      const verdict = pass ? '✅ 写入成功'
        : (tag.inputMapped ? '⚠ 写入已送达（status=0）但被 PLC 扫描覆盖——输入映射点不可改写' : '✗ 写入未达预期');
      emit(pass ? 'ok' : 'err',
        `└ ${verdict}　PLC 当前值 = ${fmt(tag, pass ? target : before)}　耗时 ${Date.now() - started}ms`);
      return { ok: pass, before, target };
    });
  }
}

function fmt(tag, v) {
  if (v === null || v === undefined) return '--';
  if (tag.type === 'BOOL') return v ? 'TRUE' : 'FALSE';
  return Number(v).toFixed(tag.digits ?? 2) + (tag.unit ? ' ' + tag.unit : '');
}

/* python 探测已独立成模块（server/py-probe.js）：导入 XML 前先确认本机 python 能跑，
   避免把 Windows 的 9009「命令未找到」原样丢给用户。 */
const { probePython, PY_NEED, PY_HELP } = require('./py-probe');

const runner = new Runner();

/* ════════════════ HTTP 静态服务 ════════════════ */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/* ════════════════ 导入 / 切换 / 删除 API（POST） ════════════════
   /api/import?name=<文件名>  body = XML 原始字节
     → 存 Test\ → spawn gen_tags.py → 解析 APP= → 自动切换重连
   /api/select?app=<程序名>  → 校验 gen/<APP>.tags.json 存在 → 切换重连
   /api/delete?app=<程序名>  → 清理该程序全部生成产物 + Test 原始 XML
     （gen 三表 / 选点档案 / out 全量表与钻取缓存 / 固件点表 / 原始 XML）；
     删除当前程序时自动切到剩余最新；唯一程序不可删（验证台无程序可用）
   /api/config?host=&port=  → 修改 PLC 地址（落盘 plc-config.json + 立即重连） */
function handleApiPost(p, qp, body, res) {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (p === '/api/config') {
    if (READONLY) { json(403, { ok: false, error: '服务以只读模式启动（MYX_READONLY=1），不能改连接参数' }); return; }
    const host = String(qp.get('host') || '').trim();
    const port = Number(qp.get('port'));
    const bad = validatePlcAddr(host, port);
    if (bad) { json(400, { ok: false, error: bad }); return; }
    try {
      const r = runner.applyPlcConfig(host, port);
      json(200, { ok: true, host: r.host, port: r.port, changed: r.changed, source: 'file' });
    } catch (e) { json(400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/select') {    const app = String(qp.get('app') || '').trim();
    if (!/^\w+$/.test(app) || !fs.existsSync(path.join(__dirname, 'gen', app + '.tags.json'))) {
      json(400, { ok: false, error: '程序不存在: ' + app });
      return;
    }
    runner.switchApp(app);
    json(200, { ok: true, app: APP_ID, appDisplay: APP_DISPLAY, points: TAGS.length, symbolCount: SYMBOLS.length });
    return;
  }
  /* /api/delete：删除已导入程序（生成产物 + 原始 XML 一并清理） */
  if (p === '/api/delete') {
    const app = String(qp.get('app') || '').trim();
    const genFile = path.join(__dirname, 'gen', app + '.tags.json');
    if (!/^\w+$/.test(app) || !fs.existsSync(genFile)) {
      json(400, { ok: false, error: '程序不存在: ' + app });
      return;
    }
    /* 唯一程序不可删：删了验证台就没有可加载的点表 */
    const genDir = path.join(__dirname, 'gen');
    let others = [];
    try {
      others = fs.readdirSync(genDir)
        .filter(f => f.endsWith('.tags.json'))
        .map(f => f.replace(/\.tags\.json$/, ''))
        .filter(a => a !== app);
    } catch (_) {}
    if (app === APP_ID && !others.length) {
      json(400, { ok: false, error: `「${app}」是唯一已导入程序，不能删除（验证台需要至少一个程序）` });
      return;
    }
    /* 删除前先读 generatedFrom（tags.json 马上要删） */
    let xmlSrc = '';
    try { xmlSrc = JSON.parse(fs.readFileSync(genFile, 'utf8')).generatedFrom || ''; } catch (_) {}

    const root = path.join(__dirname, '..');
    const removed = [];
    const rm = (f) => { try { fs.unlinkSync(f); removed.push(path.relative(root, f)); } catch (_) {} };
    for (const f of ['tags', 'symbols', 'types'])
      rm(path.join(__dirname, 'gen', `${app}.${f}.json`));
    rm(path.join(__dirname, 'profiles', `${app}.profile.json`));
    rm(path.join(__dirname, '..', 'firmware', 'gen', `hmi_tags_${app}.c`));
    rm(path.join(__dirname, '..', 'firmware', 'gen', `hmi_tags_${app}.h`));
    try {
      fs.rmSync(path.join(root, 'out', app), { recursive: true, force: true });
      removed.push(`out${path.sep}${app}${path.sep}（全量表+钻取布局缓存）`);
    } catch (_) {}
    if (xmlSrc) rm(xmlSrc);

    runner.log('sys', `── 删除程序 ${app}：已清理 ${removed.length} 项（${removed.join('、')}）──`);
    /* 删的是当前程序 → 自动切到剩余最新导入 */
    if (app === APP_ID) {
      let best = null, bestAt = '';
      for (const a of others) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(genDir, a + '.tags.json'), 'utf8'));
          if ((d.generatedAt || '') > bestAt) { bestAt = d.generatedAt || ''; best = a; }
        } catch (_) {}
      }
      if (best) {
        runner.switchApp(best);
        runner.log('sys', `── 当前程序被删除，已自动切换到 ${best} ──`);
      }
    }
    json(200, { ok: true, app, removed, current: APP_ID });
    return;
  }
  /* /api/import */
  let name = path.basename(String(qp.get('name') || 'imported.xml'));
  /* 落盘文件名转 ASCII：中文名在 Windows 下 spawn python + cp936 控制台会被截断/乱码，
     且不同中文名转写后可能撞名，故追加原名哈希。程序名（显示用）取自 XML 内 ProjectInfo，
     与文件名无关，所以这里改名不影响识别。 */
  const origName = name;
  name = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_');
  if (name !== origName) {
    const h = require('crypto').createHash('md5').update(origName).digest('hex').slice(0, 6);
    name = name.replace(/(\.xml)$/i, `_${h}$1`);
  }
  if (!/\.xml$/i.test(name)) name += '.xml';
  if (!body || body.length < 100) { json(400, { ok: false, error: 'XML 内容为空或过短' }); return; }
  const head = body.slice(0, 4000).toString('utf8');
  if (!/<\?xml|<Project|<TypeList|<NodeList/i.test(head)) {
    json(400, { ok: false, error: '文件头不像是 CODESYS 符号配置 XML' });
    return;
  }
  const testDir = path.join(__dirname, '..', 'Test');
  try { fs.mkdirSync(testDir, { recursive: true }); } catch (_) {}
  const file = path.join(testDir, name);
  const wasExisting = fs.existsSync(file);
  fs.writeFileSync(file, body);

  /* 先确认 python 真能跑：不能跑就别把 9009 这种天书丢给用户 */
  const pyInfo = probePython();
  if (!pyInfo.ok) {
    if (!wasExisting) { try { fs.unlinkSync(file); } catch (_) {} }
    runner.log('sys', `✗ 导入中止：本机没有可用的 Python ${PY_NEED}+（gen_tags.py 无法执行）`);
    pyInfo.tried.forEach(t => runner.log('sys', `    · ${t}`));
    json(500, { ok: false, error: pyInfo.error, output: '探测结果：\n' + pyInfo.tried.join('\n'),
      hint: 'python-missing', feature: 'import' });
    return;
  }

  runner.log('sys', `── 导入 XML：${name}（${body.length}B）→ 正在生成数据文件…（python ${pyInfo.version}） ──`);
  const py = spawn(pyInfo.cmd, [...pyInfo.args, 'tools/gen_tags.py', path.join('Test', name)],
    { cwd: path.join(__dirname, '..'), windowsHide: true });
  let out = '', errOut = '';
  py.stdout.on('data', (d) => { out += d; });
  py.stderr.on('data', (d) => { errOut += d; });
  py.on('error', (e) => json(500, { ok: false, error: '无法启动 python：' + e.message }));
  py.on('close', (code) => {
    const tail = (out + errOut).split(/\r?\n/).filter(Boolean).slice(-14).join('\n');
    if (code !== 0) {
      /* 探测通过但执行仍 9009：解释器被中途卸载/权限拦截，或 PATH 变了（服务没重启） */
      const msg = (code === 9009)
        ? 'Python 命令中断（退出码 9009 = 命令未找到）\n\n' + PY_HELP
        : 'gen_tags.py 退出码 ' + code;
      if (!wasExisting) { try { fs.unlinkSync(file); } catch (_) {} }
      json(500, { ok: false, error: msg, output: tail });
      return;
    }
    const m = out.match(/^APP=(\S+)$/m);
    if (!m) { json(500, { ok: false, error: '未解析到 APP= 程序名（生成器输出异常）', output: tail }); return; }
    const app = m[1];
    runner.switchApp(app);
    json(200, { ok: true, app, appDisplay: APP_DISPLAY, points: TAGS.length, symbolCount: SYMBOLS.length, output: tail });
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  let p = decodeURIComponent(u.pathname);
  const qp = u.searchParams;
  if (p === '/') p = '/index.html';
  if (p === '/full' || p === '/full/') p = '/full.html';

  /* ── 导入 / 切换 / PLC 配置（POST）：收完 body 再处理 ── */
  if (req.method === 'POST' && (p === '/api/import' || p === '/api/select'
      || p === '/api/delete' || p === '/api/config')) {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > 20 * 1024 * 1024) { res.writeHead(413); res.end('too large'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => handleApiPost(p, qp, Buffer.concat(chunks), res));
    return;
  }

  /* ── 运行环境自检（导入依赖 python；前端/脚本据此提前示警） ── */
  if (p === '/api/env') {
    const py = probePython();
    const body = {
      ok: py.ok,
      node: process.version,
      python: py.ok
        ? { ok: true, cmd: py.cmd, version: py.version, exe: py.exe }
        : { ok: false, need: PY_NEED, tried: py.tried, help: PY_HELP },
      plc: { host: HOST, port: PLC_PORT },
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
    return;
  }

  /* ── 已导入程序列表（新→旧） ── */
  if (p === '/api/apps') {
    const genDir = path.join(__dirname, 'gen');
    const list = [];
    try {
      for (const f of fs.readdirSync(genDir)) {
        if (!f.endsWith('.tags.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(genDir, f), 'utf8'));
          list.push({ app: d.app || f.replace(/\.tags\.json$/, ''),
            display: d.appDisplay || d.app || f.replace(/\.tags\.json$/, ''),
            points: d.tags ? d.tags.length : 0, generatedAt: d.generatedAt || '' });
        } catch (_) {}
      }
    } catch (_) {}
    list.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ current: APP_ID, currentDisplay: APP_DISPLAY, apps: list }));
    return;
  }

  if (p === '/api/meta') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ host: HOST, port: PLC_PORT, tags: TAGS, app: APP_ID,
      appDisplay: APP_DISPLAY,
      whitelist: WHITELIST, readonly: READONLY, period: runner.period,
      symbolCount: SYMBOLS.length, cfgSource: PLC_CFG.source }));
    return;
  }
  /* /api/config：读取当前 PLC 连接参数（界面「PLC 配置」弹窗初始化用） */
  if (p === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true, host: HOST, port: PLC_PORT, source: PLC_CFG.source,
      defaults: { host: DEFAULT_PLC_HOST, port: DEFAULT_PLC_PORT },
      readonly: READONLY,
    }));
    return;
  }
  if (p === '/api/symbols') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      total: SYMBOLS.length, scalar: SCALARS.length, composite: COMPOSITES.length,
      symbols: SYMBOLS.map(s => ({ gvl: s.gvl, name: s.name, type: s.type, bytes: s.bytes,
        full: s.full, access: s.access, comment: s.comment,
        /* struct=true：结构体符号（type 形如 T_XXX），前端渲染成「展开成员」入口 */
        struct: !s.elem && /^T_/.test(String(s.type || '')),
        /* 数组：给前端展开元素用（lo..hi 下标范围 + 元素基类型 + 步长）
           elem.writable=false 表示元素是结构体 —— 前端再点展开走 /api/members */
        elem: s.elem ? { lo: s.elem.lo, hi: s.elem.hi, base: s.elem.base, size: s.elem.size,
                         count: s.elem.hi - s.elem.lo + 1,
                         writable: WRITABLE_IEC.has(String(s.elem.base || '').toUpperCase()) } : null })),
    }));
    return;
  }
  /* /api/members?base=<符号名>&path=<路径后缀，如 [3] 或 [3].tState>
     展开结构体（或结构体数组元素）下所有可写标量成员，供写入弹窗选择。
     返回 rel = 相对该符号的路径后缀，前端拼成完整 key 即可读写。 */
  /* ── 大数组分页取值（全量页「分页」按钮用）──
     /api/arrayvals?key=GVL.CommValue&page=0&size=20
     返回该页 20 个元素的值 + 分页元信息；页大小夹在 1..200。 */
  if (p === '/api/arrayvals') {
    const key = String(qp.get('key') || '');
    const page = Number(qp.get('page') || 0);
    const size = Number(qp.get('size') || 20);
    runner.arrayPage(key, page, size).then(d => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(d));
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  if (p === '/api/members') {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const base = String(qp.get('base') || '');
    const suffix = String(qp.get('path') || '');
    const sym = SYMBOLS.find(x => x.full === 'Application.' + base);
    if (!sym) { send(404, { ok: false, error: '符号不存在：' + base }); return; }
    /* 先沿已有后缀走到子类型，再展开其叶子 */
    const head = parseSegs(suffix);
    let cur = sym.type;
    for (const seg of head) {
      const t = typeDef(cur);
      if (!t) { cur = null; break; }
      if (seg.idx !== undefined) {
        if (t.kind !== 'TypeArray' || seg.idx < t.lo || seg.idx > t.hi) { cur = null; break; }
        cur = t.basetype;
      } else {
        const mb = (t.members || []).find(x => x.name === seg.name);
        if (!mb) { cur = null; break; }
        cur = mb.type;
      }
    }
    if (!cur) { send(400, { ok: false, error: '路径无效：' + suffix }); return; }
    const tree = buildMemberTree(cur);
    send(200, {
      ok: true, base, path: suffix, typeName: cur,
      nodes: tree.nodes, truncated: tree.truncated,
    });
    return;
  }
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

/* ════════════════ WebSocket ════════════════ */
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  runner.wsSet.add(ws);
  /* 新客户端：先发快照 + 全量当前值 */
  ws.send(JSON.stringify(runner.snap()));
  if (Object.keys(runner.values).length) {
    ws.send(JSON.stringify({
      t: 'values', seq: runner.seq, ts: Date.now(), rtt: runner.rtt[runner.rtt.length - 1] || 0,
      items: TAGS.map(tag => ({ key: tag.key, value: runner.values[tag.key] ?? null, changed: false,
        hex: runner.rawValues[tag.key] ? runner.rawValues[tag.key].toString('hex') : null })),
    }));
  }
  if (Object.keys(runner.fullValues).length) {
    ws.send(JSON.stringify({
      t: 'full', seq: runner.seq, ts: Date.now(), mode: runner.mode, stats: runner.fullStats,
      items: SYMBOLS.filter(s => runner.fullValues[s.full])
        .map(s => ({ f: s.full, d: runner.fullValues[s.full].disp, c: false })),
    }));
  }
  if (Object.keys(runner.watchValues).length) {
    ws.send(JSON.stringify({ t: 'wvals', ts: Date.now(),
      items: Object.keys(runner.watchValues).map(key => {
        const tg = symTag(key);
        return { key, d: runner.watchValues[key], ty: tg ? tg.type : '' };
      }) }));
  }
  ws.on('message', async (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    try {
      if (m.cmd === 'connect') { runner.connect(); }
      else if (m.cmd === 'disconnect') {
        if (runner.timer) { clearTimeout(runner.timer); runner.timer = null; }
        if (runner.reconnectTimer) { clearTimeout(runner.reconnectTimer); runner.reconnectTimer = null; }
        runner.gen++;                       /* 作废旧连接回调 */
        runner.intentional = true;
        try { runner.client && runner.client.sock && runner.client.sock.destroy(); } catch (_) {}
        runner.client = null;
        runner.state = 'idle'; runner.handshake = []; runner.emitState();
        runner.log('sys', '── 已主动断开 ──');
      }
      else if (m.cmd === 'period') {
        runner.period = Math.max(100, Math.min(5000, Number(m.ms) || 500));
        runner.broadcast({ t: 'period', ms: runner.period });
        runner.emitState();
      }
      else if (m.cmd === 'resetStats') {
        runner.stats = { reads: 0, ok: 0, fail: 0, txFrames: 0, rxFrames: 0, txBytes: 0, rxBytes: 0 };
        runner.readWin = [];
        runner.rtt = []; runner.emitState();
      }
      else if (m.cmd === 'drill') {
        runner.drill(m.key).catch(e => {
          runner.log('err', '✗ 钻取失败：' + e.message);
          runner.broadcast({ t: 'drill', key: m.key, error: e.message });
        });
      }
      else if (m.cmd === 'drillWrite') {
        runner.drillWrite(m.key, m.value).catch(e => {
          runner.log('err', '✗ 成员写入失败：' + e.message);
          runner.broadcast({ t: 'wtest', ts: Date.now(), level: 'err', text: '✗ ' + e.message });
        });
      }
      else if (m.cmd === 'watchSet') {
        /* 前端监控列表变化：重新登记缺失项（数组元素 / 点表外标量） */
        runner.refreshWatch(m.keys || []).catch(e => {
          runner.log('err', '✗ 监控登记失败：' + e.message.slice(0, 80));
        });
      }
      else if (m.cmd === 'writeTest') {
        const mode = (m.mode === 'set' || m.mode === 'change') ? m.mode : 'noop';
        runner.broadcast({ t: 'wtest', ts: Date.now(), level: 'sys', text: '队列已提交，等待执行…' });
        runner.writeTest(m.key, mode, m.value)
          .catch(e => runner.log('err', '✗ 写入异常：' + e.message));
      }
    } catch (e) { runner.log('err', e.message); }
  });
  ws.on('close', () => runner.wsSet.delete(ws));
});

/* 心跳：30s 探测一次，半开连接（网络断/页面冻结）直接回收，避免"假在线" */
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30000);
wss.on('close', () => clearInterval(wsHeartbeat));

server.listen(WEB_PORT, () => {
  console.log('════════════════════════════════════════════════');
  console.log('  MYX 协议验证台');
  console.log('  界面  http://127.0.0.1:' + WEB_PORT);
  console.log('  PLC   ' + HOST + ':' + PLC_PORT + (READONLY ? '  [只读模式]' : ''));
  console.log('  点表  ' + TAGS.length + ' 点 · 白名单 ' + WHITELIST.length + ' 项');
  /* 导入 XML 需要 python：启动就把结论打出来，别等用户导入失败才发现 */
  const py = probePython();
  if (py.ok) {
    console.log('    导入  python ' + py.version + '  (' + py.cmd + ' → ' + py.exe + ')');
  } else {
    console.log('    导入  ✗ 找不到 Python ' + PY_NEED + '+，XML 导入会失败：');
    py.tried.forEach(t => console.log('          · ' + t));
    console.log('          装 Python 3.8+（勾 Add to PATH）或设 MYX_PYTHON=<python.exe 全路径>');
  }
  console.log('════════════════════════════════════════════════');
  /* 启动即自动连一次 */
  setTimeout(() => runner.connect(), 400);
});

/* 优雅退出：必须主动断开 PLC 侧的 TCP 会话。
   PLC 只接受单条连接，若进程被强制杀掉（taskkill /F、关窗口），
   旧 socket 会占住那唯一的名额，下一次握手直接"应答超时"——11:04 那次报警就是这么来的。 */
function shutdown(sig) {
  console.log(`\n[exit] 收到 ${sig}，释放 PLC 连接…`);
  try { if (runner.timer) clearTimeout(runner.timer); } catch (_) {}
  try { if (runner.reconnectTimer) clearTimeout(runner.reconnectTimer); } catch (_) {}
  runner.intentional = true;
  try {
    if (runner.client && runner.client.sock) {
      runner.client.sock.end();                    /* 先发 FIN，让对方尽快回收通道 */
      setTimeout(() => { try { runner.client.sock.destroy(); } catch (_) {} process.exit(0); }, 150);
      return;                                      /* 让上面的定时器负责退出 */
    }
  } catch (_) {}
  process.exit(0);
}
['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].forEach(s => process.on(s, () => shutdown(s)));
process.on('exit', () => {
  try { runner.client && runner.client.sock && runner.client.sock.destroy(); } catch (_) {}
});
