/* ────────────────────────────────────────────────────────────────────────────
   drill-core.js —— 结构体钻取纯逻辑（无网络、无副作用，可离线单测）
   ────────────────────────────────────────────────────────────────────────────
   职责：
   ① 类型库导航：xmlTypeName / typeDef / typeSize / infSize / taintedType
   ② 结构展开：expandTree（层级树，叶子带推算偏移 off + 可信标记 flagged）
   ③ 树扁平化 / 叶子解码编码 / 逐名读分批（packPaths，460B 预算）
   ④ UNION 布局学习：learnUnionLayout —— 整读 blob 与逐名读基准对账，
      推导真实元素步长与成员偏移，全叶一致才算通过

   布局可信度约定（真机教训）：
   - XML 对 UNION 不签成员偏移（byteoffset=-1）且类型 size=0 → 本地只能按 IEC 定义推定
     （成员全在偏移 0，尺寸取成员最大）——推定必须经真机对账才能用于整读解码；
   - 个别 STRUCT 还有成员重叠 / 声明 size 与成员矛盾（如 T_STATION_DATA size=1 却含 4B
     UNION）→ 同样进"待学"名单；
   - 数组步长 = 数组 size ÷ 元素数；元素类型可疑时该步长不可信（演示工程 aCell 的 XML
     数组 size=6 → 1B/元素，真机实际 8 或 12B），真值由 learnUnionLayout 从整读长度导出。
   ──────────────────────────────────────────────────────────────────────── */
'use strict';

const DRILL_MAX = 4096;  /* 单次钻取节点上限（含中间节点；整读模式下偏移必须完整） */
const DRILL_ARR = 16;    /* 数组单维最多展开元素数（超过截断并提示） */

let TYPES = {};
let IEC2TYPE = {};

/* 由 server 注入类型库（gen_tags.py 产出，XML 为唯一准则） */
function init(types) {
  TYPES = types || {};
  IEC2TYPE = {};
  for (const [name, t] of Object.entries(TYPES)) if (t.iec) IEC2TYPE[t.iec] = name;
}

/* IEC 文本类型 → XML 类型名（两通道：数组构造命名；iecname→定义名索引，如 T_S1_INPUT→T_T_S1_INPUT） */
function xmlTypeName(iecType) {
  const s = String(iecType || '').trim();
  const m = s.match(/^ARRAY\s*\[\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\]\s*OF\s*([\w.]+)$/i);
  if (m) {
    const cand = 'T_ARRAY__' + m[1] + '__' + m[2] + '__OF_' + m[3];
    if (TYPES[cand]) return cand;
  }
  if (TYPES[s]) return s;
  if (IEC2TYPE[s]) return IEC2TYPE[s];
  return s;
}

function typeDef(typeName) { return TYPES[typeName] || TYPES[IEC2TYPE[typeName]]; }
function typeSize(typeName) { const t = typeDef(typeName); return t && t.size ? t.size : 0; }

/* 推算类型尺寸：XML size 优先；UNION（size=0）按 IEC 定义取成员最大 */
function infSize(typeName, depth) {
  const t = typeDef(typeName);
  if (!t) return 0;
  if (t.size) return t.size;
  if ((depth || 0) > 8 || !Array.isArray(t.members) || !t.members.length) return 0;
  let mx = 0;
  for (const m of t.members) mx = Math.max(mx, infSize(m.type, (depth || 0) + 1));
  return mx;
}

/* 布局可疑类型识别（不可整读直接解码，须经 learnUnionLayout 真机对账）：
   ① UNION：类型 size=0（XML 不给成员偏移）；
   ② 成员偏移缺失（byteoffset<0）；
   ③ 递归：任一成员类型可疑 → 本类型整体可疑。 */
function taintedType(typeName, seen) {
  const t = typeDef(typeName);
  if (!t || !Array.isArray(t.members) || !t.members.length) return false;
  if (!t.size) return true;
  seen = seen || new Set();
  if (seen.has(typeName)) return false;
  seen.add(typeName);
  for (const m of t.members) {
    if (m.byteoffset == null || m.byteoffset < 0) return true;
    if (taintedType(m.type, seen)) return true;
  }
  return false;
}

/* 递归展开为树：前缀路径 + XML 类型名 → 节点（node）或叶子（leaf）
   结构体/数组的中间层保留为 node（前端逐级展开），简单类型为 leaf
   off   = 该成员在整符号 blob 内的推算字节偏移（可信时直接用；可疑时仅作学习候选）
   flagged = 偏移推导链经过可疑节点（UNION / 重叠 / 可疑元素类型）——须经真机对账
   counter.learn = 任一节点可疑 → drill 走「学习→缓存→快路径」流程 */
function expandTree(prefix, typeName, writable, depth, counter, off, taint) {
  counter.n++;
  const t = typeDef(typeName);
  const o = off || 0;
  const tk = !!taint;
  if (!t) return { path: prefix, type: String(typeName), writable, leaf: true, off: o, size: 0, flagged: tk };
  if (t.kind === 'TypeSimple')
    return { path: prefix, type: t.iec || typeName, writable, leaf: true, off: o, size: t.size || 0, flagged: tk };
  if (t.kind === 'TypeArray') {
    const n = t.hi - t.lo + 1;
    const lim = Math.min(n, DRILL_ARR);
    /* 元素步长 = 数组总尺寸 / 元素数（CODESYS 元素边界按对齐补位：261→264、93→96，
       不能用元素类型自身尺寸）。元素类型布局可疑时此步长不可信（如 aCell：
       XML 数组 size=6 → 1B/元素），只作推算候选，真值由 learnUnionLayout 整读对账导出。 */
    const es = (t.size && n > 0) ? t.size / n : typeSize(t.basetype);
    const subTaint = tk || taintedType(t.basetype);
    if (subTaint) counter.learn = true;
    const children = [];
    for (let i = 0; i < lim && counter.n < DRILL_MAX; i++)
      children.push(expandTree(`${prefix}[${t.lo + i}]`, t.basetype, writable, depth, counter, o + i * es, subTaint));
    if (n > lim) children.push({ note: `数组共 ${n} 个元素，已展开前 ${lim} 个（下标 ${t.lo}..${t.lo + lim - 1}）` });
    if (counter.n >= DRILL_MAX) children.push({ note: `叶子上限 ${DRILL_MAX}，后续元素未展开` });
    return { path: prefix, type: typeName, writable, children, off: o, size: t.size || 0, stride: es, tainted: subTaint };
  }
  /* 枚举：叶子 + 字面量映射 */
  if (t.enums && Object.keys(t.enums).length) {
    const base = t.basetype && typeDef(t.basetype);
    return { path: prefix, type: (base && base.iec) || 'INT', enumMap: t.enums, writable, leaf: true, off: o, size: (base && base.size) || 2, flagged: tk };
  }
  /* 结构体 / UNION：成员逐个挂到 children（中间层，前端逐级展开）
     UNION（size=0）：成员按 IEC 定义全叠在偏移 0；
     STRUCT：偏移声明与前方成员矛盾（重叠/越界）时按 IEC 规则顺延，并从该成员起全部标记可疑。 */
  if (Array.isArray(t.members) && t.members.length && depth > 0) {
    const isUnion = !t.size;
    let end = 0, bad = tk || isUnion;
    const children = [];
    if (isUnion) counter.learn = true;
    for (const m of t.members) {
      if (counter.n >= DRILL_MAX) { children.push({ note: `成员数达到上限 ${DRILL_MAX}，更深未展开` }); break; }
      const declared = (m.byteoffset == null || m.byteoffset < 0) ? null : m.byteoffset;
      let mo;
      if (isUnion) mo = 0;                                    /* IEC 联合体：成员全在 0 */
      else if (declared == null) mo = end;                     /* 无声明偏移 → IEC 顺延 */
      else if (bad || declared < end) { mo = end; bad = true; } /* 声明与前方矛盾 → 顺延并标记可疑 */
      else mo = declared;
      const mTaint = bad || isUnion || taintedType(m.type);
      if (mTaint) counter.learn = true;
      end = Math.max(end, mo + infSize(m.type));
      children.push(expandTree(prefix + '.' + m.name, m.type,
        writable && (!m.access || /Write/i.test(m.access)), depth - 1, counter, o + mo, mTaint));
    }
    return { path: prefix, type: t.iec || typeName, writable, children, off: o, size: t.size || 0, tainted: bad };
  }
  return { path: prefix, type: t.iec || typeName, writable, leaf: true, off: o, size: t.size || 0, flagged: tk };
}

/* 树 → 扁平行（带 depth / 祖先链，前端据此做逐级折叠） */
function flattenTree(tree) {
  const rows = [];
  const walk = (n, depth, anc) => {
    if (n.note && !n.path) { rows.push({ depth, anc: anc.join('|'), note: n.note }); return; }
    rows.push({
      depth, path: n.path || '', type: n.type || '',
      node: !n.leaf && !n.note, childCount: n.children ? n.children.length : 0,
      enumMap: n.enumMap || null, writable: !!n.writable,
      value: n.value ?? null, enumName: n.enumName || null, hex: n.hex || '',
      anc: anc.join('|'),
    });
    if (n.children) n.children.forEach((c) => walk(c, depth + 1, anc.concat(n.path || '')));
  };
  (tree.children || []).forEach((c) => walk(c, 0, []));
  return rows;
}

/* 基础类型读取（按字节宽度，LE） */
function readBase(base, buf, off) {
  switch (base) {
    case 'BOOL': return buf.readUInt8(off) ? 1 : 0;
    case 'BYTE':
    case 'USINT': return buf.readUInt8(off);
    case 'SINT': return buf.readInt8(off);
    case 'INT': return buf.readInt16LE(off);
    case 'UINT':
    case 'WORD': return buf.readUInt16LE(off);
    case 'DINT':
    case 'TIME': return buf.readInt32LE(off);
    case 'UDINT':
    case 'DWORD': return buf.readUInt32LE(off);
    case 'REAL': return Number(buf.readFloatLE(off).toFixed(3));
    case 'LREAL': return Number(buf.readDoubleLE(off).toFixed(3));
    case 'LINT': return Number(buf.readBigInt64LE(off));
    default: return null;
  }
}

/* 叶子解码（钻取表）：字符串按实际编码截断，枚举附字面量名 */
function decodeLeaf(leaf, buf) {
  const ty = String(leaf.type || '').toUpperCase();
  try {
    if (/^STRING/.test(ty)) { const z = buf.indexOf(0); return { value: buf.slice(0, z < 0 ? buf.length : z).toString('binary') }; }
    if (/^WSTRING/.test(ty)) {
      let s = '';
      for (let i = 0; i + 1 < buf.length; i += 2) { const c = buf.readUInt16LE(i); if (!c) break; s += String.fromCharCode(c); }
      return { value: s };
    }
    const v = readBase(ty, buf, 0);
    if (v === null || v === undefined) return { value: buf.toString('hex') };
    if (leaf.enumMap) {
      const ent = Object.entries(leaf.enumMap).find(([, n]) => n === v);
      return { value: v, enumName: ent ? ent[0] : null };
    }
    return { value: v };
  } catch (_) { return { value: buf.toString('hex') }; }
}

/* 叶子编码（钻取写入）：按 XML 类型宽度精确编码 */
function encodeLeaf(type, value) {
  const t = String(type || '').toUpperCase();
  const num = Number(value);
  switch (t) {
    case 'BOOL':  return Buffer.from([num ? 1 : 0]);
    case 'BYTE': case 'USINT': { const b = Buffer.alloc(1); b.writeUInt8(num & 0xFF); return b; }
    case 'SINT':  { const b = Buffer.alloc(1); b.writeInt8(num | 0); return b; }
    case 'INT':   { const b = Buffer.alloc(2); b.writeInt16LE(num | 0); return b; }
    case 'UINT': case 'WORD': { const b = Buffer.alloc(2); b.writeUInt16LE(num & 0xFFFF); return b; }
    case 'DINT': case 'TIME': { const b = Buffer.alloc(4); b.writeInt32LE(num | 0); return b; }
    case 'UDINT': case 'DWORD': { const b = Buffer.alloc(4); b.writeUInt32LE(num >>> 0); return b; }
    case 'REAL':  { const b = Buffer.alloc(4); b.writeFloatLE(num); return b; }
    case 'LREAL': { const b = Buffer.alloc(8); b.writeDoubleLE(num); return b; }
    default: throw new Error('钻取写入暂不支持类型：' + type);
  }
}

/* PrepareRead 载荷按 460B 预算分批（协议实测约束：>1 块会触发 PLC 缓冲配额错误） */
function packPaths(paths) {
  const BUDGET = 460, HEAD = 24;
  const entrySize = (f) => { const n = Buffer.byteLength(f) + 1; return (n + 4 + 3) & ~3; };
  const out = []; let cur = [], sz = HEAD;
  for (const f of paths) {
    const e = entrySize(f);
    if (sz + e > BUDGET && cur.length) { out.push(cur); cur = []; sz = HEAD; }
    cur.push(f); sz += e;
  }
  if (cur.length) out.push(cur);
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
   UNION 布局学习：整读 blob ↔ 逐名读基准 对账
   ────────────────────────────────────────────────────────────────────────────
   输入：sym（SYMBOLS 行，含 iecType）、leaves（expandTree 产物，含推算 off/flagged）、
         readMap（逐名读原始缓冲，真值基准）、blob（整读返回）
   输出：{ ok, reason?, blobBytes, stride, off:{leafPath→绝对偏移}, weakFams, famCount }
   规则：
   - 顶层为数组 → 真实步长 = blob.length ÷ 元素数（不整除即失败）；
   - 可疑（flagged）叶子按类型对齐度枚举候选偏移（IEC 推算位优先），
     要求该成员族在所有数组元素上与逐名基准一致；多解（值恒同）取首个并记 weak；
   - 可信叶子的推算偏移也要过一遍校验——任何一个不符即整体失败（宁可回退，不可错值）。 */
function learnUnionLayout(sym, leaves, readMap, blob) {
  const t0 = Date.now();
  const top = typeDef(xmlTypeName(sym.type));
  const isArr = !!(top && top.kind === 'TypeArray' && top.hi >= top.lo);
  const arrN = isArr ? (top.hi - top.lo + 1) : 1;
  const arrLo = isArr ? top.lo : 0;
  const esInf = isArr && top.size ? top.size / arrN : 0;
  if (isArr && blob.length % arrN !== 0)
    return { ok: false, reason: `整读 ${blob.length}B 不能被元素数 ${arrN} 整除（XML 推算 ${top.size}B）` };
  const stride = isArr ? blob.length / arrN : 0;

  /* 基准值：逐名读原始缓冲 → 解码值 */
  const gt = {};
  for (const l of leaves) {
    const raw = readMap[l.path];
    if (!raw || !raw.length) return { ok: false, reason: `成员 ${l.path} 逐名读无返回` };
    gt[l.path] = decodeLeaf(l, raw).value;
  }
  /* 字符串类可疑成员不做偏移搜索（截断语义不稳定），保守回退 */
  for (const l of leaves) {
    if (l.flagged && /^W?STRING/i.test(String(l.type || '')))
      return { ok: false, reason: `可疑成员 ${l.path} 为 ${l.type}，不做偏移对账` };
  }

  const famKey = (p) => p.replace(/\[\d+\]/g, '[*]');
  const idxOf = (p) => { const m = p.match(/\[(\d+)\]/); return m ? ((+m[1]) - arrLo) : 0; };
  const alignOf = { BOOL: 1, BYTE: 1, SINT: 1, USINT: 1, INT: 2, UINT: 2, WORD: 2,
                    DINT: 4, TIME: 4, UDINT: 4, DWORD: 4, REAL: 4,
                    LINT: 8, ULINT: 8, LWORD: 8, LREAL: 8 };
  const fams = {};
  for (const l of leaves) (fams[famKey(l.path)] = fams[famKey(l.path)] || []).push(l);

  const hitAt = (l, within) => {
    const abs = idxOf(l.path) * stride + within;
    const n = l.size || 0;
    if (n <= 0 || abs < 0 || abs + n > blob.length) return null;
    const a = decodeLeaf(l, blob.subarray(abs, abs + n)).value;
    const b = gt[l.path];
    return (a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6)) ? abs : null;
  };

  const off = {};
  const weak = [];
  for (const [fam, members] of Object.entries(fams)) {
    const rep = members[0];
    const withinInf = (rep.off || 0) - idxOf(rep.path) * esInf;
    let cands;
    if (rep.flagged) {
      const a = alignOf[String(rep.type).toUpperCase()] || 1;
      const hi = Math.floor(((stride || blob.length) - (rep.size || 1)) / Math.max(1, a)) * a;
      cands = [];
      const push = (v) => { if (v >= 0 && v <= hi && !cands.includes(v)) cands.push(v); };
      push(withinInf);                                  /* IEC 推算位优先 */
      for (let w = 0; w <= hi; w += a) push(w);
    } else cands = [withinInf];
    const matches = cands.filter((w) => members.every((m) => hitAt(m, w) !== null));
    if (!matches.length)
      return { ok: false, reason: `成员族 ${fam}：候选偏移 [${cands.join(',')}] 均与逐名读不符（IEC 推算 ${withinInf}）` };
    if (matches.length > 1) weak.push(fam);             /* 值恒同歧义：弱验证，缓存命中时须抽查 */
    const w = matches[0];
    for (const m of members) off[m.path] = idxOf(m.path) * stride + w;
  }
  return { ok: true, blobBytes: blob.length, stride, off, weak, famCount: Object.keys(fams).length, ms: Date.now() - t0 };
}

module.exports = {
  DRILL_MAX, DRILL_ARR, init, xmlTypeName, typeDef, typeSize, infSize, taintedType,
  expandTree, flattenTree, readBase, decodeLeaf, encodeLeaf, packPaths, learnUnionLayout,
};
