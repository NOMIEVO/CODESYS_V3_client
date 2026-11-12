#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────────
   test-union-learn.js —— UNION 两段式钻取 · 离线单测（PLC 无需上电）
   ────────────────────────────────────────────────────────────────────────────
   用合成 blob 模拟真机整读返回，逐名读基准由同一 blob 按"假想真实布局"切出，
   验证 learnUnionLayout 能否恢复真实布局 / 正确拒绝矛盾数据 / 标记弱验证。

   场景：
   A. 真实步长 12B、bUsed 在元素内偏移 8（值互异）→ 学习恢复且强验证
   B. 真实步长 8B、bUsed 在偏移 4 → 学习恢复
   C. blob 与逐名基准矛盾 → 必须失败（宁可回退不可错值）
   D. 全零数据 → 通过但弱验证（值恒同，偏移取 IEC 推算位）
   E. expandTree 推算：aCell 标记 learn、IEC 顺延偏移、UNION 成员叠 0
   ──────────────────────────────────────────────────────────────────────── */
'use strict';

const path = require('path');
const core = require(path.join(__dirname, '..', 'server', 'drill-core.js'));
const TYPES = require(path.join(__dirname, '..', 'server', 'gen', 'DEMO_MACHINE.types.json')).types;
const TABLE = require(path.join(__dirname, '..', 'out', 'DEMO_MACHINE', 'tag_table.json'));

core.init(TYPES);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ← ' + extra : '')); }
}

/* 与 drill() 相同的展开/收集方式 */
function buildLeaves(sym) {
  const counter = { n: 0 };
  const tree = core.expandTree(sym.symbolPath, core.xmlTypeName(sym.iecType), true, 4, counter);
  const leaves = [];
  const collect = (n) => {
    if (n.children) n.children.forEach(collect);
    else if (n.path && !n.note) leaves.push(n);
  };
  collect(tree);
  return { tree, leaves, counter };
}

/* 按假想真实布局生成 blob + 逐名基准（模拟 runtime 按名返回的原始缓冲） */
function synth(stride, useWithin, gen) {
  const N = 6, blob = Buffer.alloc(N * stride), gt = {};
  for (let e = 0; e < N; e++) {
    const base = e * stride;
    const { enumV, diV, useV } = gen(e);
    blob.writeInt16LE(enumV, base + 0);        /* UNION 成员 1：枚举 @0 */
    blob.writeInt32LE(diV, base + 0);          /* UNION 成员 2：DINT   @0（同一片字节） */
    blob.writeUInt8(useV, base + useWithin);   /* bUsed（重叠声明 → 偏移由布局定） */
    const k = e + 1;
    gt[`Application.GVL_STATION.aCell[${k}].uResult.eResult`] =
      Buffer.from(blob.subarray(base, base + 2));          /* 独立副本：真机逐名读返回独立缓冲 */
    gt[`Application.GVL_STATION.aCell[${k}].uResult.di`] =
      Buffer.from(blob.subarray(base, base + 4));
    gt[`Application.GVL_STATION.aCell[${k}].bUsed`] =
      Buffer.from(blob.subarray(base + useWithin, base + useWithin + 1));
  }
  return { blob, gt };
}

const SYM = TABLE.symbols.find(s => s.symbolPath === 'Application.GVL_STATION.aCell');
if (!SYM) { console.error('✗ 找不到 aCell，请先重跑生成器'); process.exit(1); }

/* ── E. expandTree 推算断言 ───────────────────────────────────────────── */
console.log('E. expandTree 推算（离线，无 PLC）');
{
  const { leaves, counter } = buildLeaves(SYM);
  ok(counter.learn === true, 'counter.learn 置位（含 UNION → 走学习流程）');
  const use1 = leaves.find(l => l.path.endsWith('[1].bUsed'));
  const enum1 = leaves.find(l => l.path.endsWith('[1].uResult.eResult'));
  const di1 = leaves.find(l => l.path.endsWith('[1].uResult.di'));
  ok(leaves.length === 18, '叶子数 18（6 元素 × 3 成员）', '实际 ' + leaves.length);
  ok(use1.flagged === true, 'bUsed 标记可疑（声明偏移 0 与 UNION 重叠）');
  ok(use1.off === 4, 'bUsed IEC 顺延偏移 = 4（union 4B 之后）', '实际 ' + use1.off);
  ok(enum1.flagged === true && enum1.off === 0, '枚举成员（UNION 内）叠在偏移 0 且标记可疑');
  ok(di1.flagged === true && di1.off === 0, 'DINT 成员（UNION 内）叠在偏移 0 且标记可疑');
  const allFlagged = leaves.every(l => l.flagged);
  ok(allFlagged, '全部 18 叶均标记可疑（XML 数组步长 6/6=1B 本身不可信）');
}

/* ── A. 步长 12B / bUsed@8，值互异 → 强验证恢复 ───────────────────── */
console.log('A. 真实布局 = 步长 12B、bUsed@8（值互异）');
{
  const { leaves } = buildLeaves(SYM);
  const { blob, gt } = synth(12, 8, (e) => ({ enumV: (e % 3) + 1, diV: (e + 11) * 7, useV: e % 2 }));
  const res = core.learnUnionLayout(SYM, leaves, gt, blob);
  ok(res.ok === true, '对账通过', res.reason);
  ok(res.stride === 12, '步长恢复 12B（XML 只给 1B）', '实际 ' + res.stride);
  ok(res.blobBytes === 72, '整读长度 72B');
  ok(res.weak.length === 0, '强验证（无恒同歧义）', 'weak=' + res.weak.length);
  ok(res.off['Application.GVL_STATION.aCell[2].bUsed'] === 12 + 8,
    '元素[2].bUsed 绝对偏移 20');
  ok(res.off['Application.GVL_STATION.aCell[6].uResult.di'] === 60,
    '元素[6].di 绝对偏移 60');
  /* 用学到的偏移直接整读解码 == 逐名基准 */
  let allEq = true;
  for (const l of leaves) {
    const o = res.off[l.path];
    const d = core.decodeLeaf(l, blob.subarray(o, o + l.size)).value;
    const g = core.decodeLeaf(l, gt[l.path]).value;
    if (d !== g) { allEq = false; break; }
  }
  ok(allEq, '整读 + 学习偏移 解码值与逐名基准全一致');
}

/* ── B. 步长 8B / bUsed@4 → 恢复 ─────────────────────────────────── */
console.log('B. 真实布局 = 步长 8B、bUsed@4（CODESYS nativesize 链）');
{
  const { leaves } = buildLeaves(SYM);
  const { blob, gt } = synth(8, 4, (e) => ({ enumV: e + 1, diV: e * 1000 + 5, useV: 1 }));
  const res = core.learnUnionLayout(SYM, leaves, gt, blob);
  ok(res.ok === true, '对账通过', res.reason);
  ok(res.stride === 8 && res.blobBytes === 48, '步长恢复 8B / 48B', `${res.stride}/${res.blobBytes}`);
  ok(res.off['Application.GVL_STATION.aCell[3].bUsed'] === 16 + 4,
    '元素[3].bUsed 绝对偏移 20');
}

/* ── C. blob 与基准矛盾 → 必须失败 ───────────────────────────────────── */
console.log('C. 整读 blob 与逐名基准矛盾');
{
  const { leaves } = buildLeaves(SYM);
  const { blob, gt } = synth(12, 8, (e) => ({ enumV: (e % 3) + 1, diV: (e + 11) * 7, useV: e % 2 }));
  /* 篡改基准：逐名读的 bUsed 全反（模拟布局猜错时的失配） */
  for (const k of [1, 2, 3, 4, 5, 6]) {
    const b = gt[`Application.GVL_STATION.aCell[${k}].bUsed`];
    b.writeUInt8(b[0] ? 0 : 1, 0);
  }
  const res = core.learnUnionLayout(SYM, leaves, gt, blob);
  ok(res.ok === false, '学习失败（拒绝错误布局）', '居然 ok');
  ok(/均与逐名读不符|整除/.test(res.reason || ''), '失败原因可读：' + res.reason);
}

/* ── D. 全零数据 → 弱验证 ─────────────────────────────────────────────── */
console.log('D. 全零数据（值恒同 → 弱验证，取 IEC 推算位）');
{
  const { leaves } = buildLeaves(SYM);
  const { blob, gt } = synth(12, 8, () => ({ enumV: 0, diV: 0, useV: 0 }));
  const res = core.learnUnionLayout(SYM, leaves, gt, blob);
  ok(res.ok === true, '对账通过（零值无法区分候选 → 全部匹配）');
  ok(res.weak.length >= 3, '弱验证标记：' + res.weak.length + ' 个成员族歧义（服务端命中缓存时逐名抽查兜底）');
  ok(res.off['Application.GVL_STATION.aCell[1].bUsed'] === 4,
    '歧义时取 IEC 推算位（bUsed within=4，注意非真值 8——上电后真值非零自动纠偏）');
}

/* ── F. 可信符号不受影响（回归） ──────────────────────────────────────── */
console.log('F. 可信符号回归（counter.learn 不置位）');
{
  const clean = TABLE.symbols.find(s => /AXIS_PARAM/.test(s.iecType || '') && s.layoutVerified);
  if (clean) {
    const { counter } = buildLeaves(clean);
    ok(counter.learn !== true, clean.name + '：不触发学习流程');
  } else {
    console.log('  - 未找到含 AXIS_PARAM 的可信符号，跳过');
  }
  const sx = TABLE.symbols.find(s => s.name === 'aAxisCtl');
  if (sx) {
    const { leaves, counter } = buildLeaves(sx);
    ok(counter.learn !== true, 'aAxisCtl：仍走可信整读路径（' + leaves.length + ' 叶子）');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
