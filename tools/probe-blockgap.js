/* exp-blockgap.js — 逐块到达间隔：确认「每块等一个固定节拍」
   ══════════════════════════════════════════════════════════════════════
   做法：读一个大数组（几十块），在通道层记下每个数据块到达的时刻，
        打印相邻块的间隔分布。

   判读：
     · 间隔中位 ≈ 某个固定值（如 9~10ms），且分布很窄 → PLC 每块等一个调度节拍
     · 间隔≈0 且偶尔一次大跳跃               → PLC 连续发块，只是偶尔等节拍
     · 间隔忽大忽小                          → 重传 / 网卡节能 / 杀软拦截

   用法：node tools/probe-blockgap.js [host] [app] [符号名]
   只读，不写入。跑前请停掉验证台。
   ────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const { CodesysV3Client } = require('../server/codesys-v3-client');

const ROOT = path.join(__dirname, '..');
const HOST = process.argv[2] || '192.168.1.92';
const PORT = Number(process.env.MYX_PLC_PORT || 11740);
const APP = process.argv[3] || 'DEMO_MACHINE';
const SYM = process.argv[4] || 'Application.GVL_AXIS.aAxisCtl';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const r2 = (v) => Math.round(v * 100) / 100;

async function open() {
  const c = new CodesysV3Client(HOST, PORT, { allowWrite: false });
  await c.nsQuery();
  await c.connect();
  await c.nsQueryOnMain();
  await c.openChannel();
  try { await c.sessionCreate(); } catch (_) {}
  await c.login();
  await c.getRoot();
  return c;
}

(async () => {
  console.log('════════════════════════════════════════════════');
  console.log('  逐块到达间隔（只读）  ' + HOST);
  console.log('  符号 ' + SYM);
  console.log('════════════════════════════════════════════════');

  const c = await open();
  const h = await c.prepareRead([SYM]);
  c.readListHandle = h;

  /* 包一层 waitForFrame：记录每个通道数据块的到达时刻 */
  const arrivals = [];
  const orig = c.waitForFrame.bind(c);
  c.waitForFrame = async (t) => {
    const t0 = now();
    const d = await orig(t);
    const pkt = d.slice(20, 22).toString('hex');
    if (pkt === '0101' || pkt === '0181' || pkt === '0100' || pkt === '0180') {
      arrivals.push({ t: now(), dt: now() - t0, len: d.length, pkt });
    }
    return d;
  };

  const runs = [];
  for (let k = 0; k < 3; k++) {
    arrivals.length = 0;
    const t0 = now();
    const v = await c.executeRead();
    const total = now() - t0;
    const gaps = [];
    for (let i = 1; i < arrivals.length; i++) gaps.push(arrivals[i].t - arrivals[i - 1].t);
    runs.push({ total, blocks: arrivals.length, entries: v.length, gaps, bytes: c.lastReadPayload.length });
    await sleep(300);
  }

  const r = runs[0];
  console.log('\n① 概况');
  runs.forEach((x, i) => console.log('   第 ' + (i + 1) + ' 轮：' + x.blocks + ' 块 · '
    + r2(x.total) + 'ms · ' + (x.bytes / 1024).toFixed(1) + 'KB · ' + x.entries + ' 条'
    + ' · 平均每块 ' + r2(x.total / Math.max(1, x.blocks)) + 'ms'));

  const gaps = r.gaps.filter(x => x >= 0).sort((a, b) => a - b);
  if (gaps.length) {
    const q = (p) => r2(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]);
    console.log('\n② 相邻块间隔（' + gaps.length + ' 个样本）');
    console.log('   min ' + q(0) + ' · p25 ' + q(0.25) + ' · 中位 ' + q(0.5)
      + ' · p75 ' + q(0.75) + ' · p95 ' + q(0.95) + ' · max ' + q(0.999));
    const med = gaps[Math.floor(gaps.length / 2)];
    const narrow = gaps.filter(x => x > med * 0.6 && x < med * 1.6).length / gaps.length;
    console.log('   落在中位 ±60% 区间的比例 ' + Math.round(narrow * 100) + '%');

    console.log('\n③ 判读');
    if (med > 2 && narrow > 0.6) {
      console.log('   间隔集中在 ' + r2(med) + 'ms 且很窄 → 每块都在等同一个固定节拍。');
      console.log('   这是 PLC 侧 Runtime/通讯线程的调度周期，不是网络问题。');
      console.log('   量化证据：' + r.blocks + ' 块 × ' + r2(med) + 'ms ≈ ' + r2(r.blocks * med) + 'ms（实测 ' + r2(r.total) + 'ms）');
    } else if (med < 1) {
      console.log('   间隔很小（' + r2(med) + 'ms）→ PLC 连续发块，块数不是瓶颈；慢在请求数与单请求开销。');
    } else {
      console.log('   间隔不稳 → 存在排队/重传，检查网卡节能、中断节流、杀软网络过滤。');
    }
    /* 直方图（前 12 个分桶） */
    const max = gaps[gaps.length - 1];
    const nb = 12, bucket = Math.max(0.5, max / nb);
    const hist = new Array(nb).fill(0);
    gaps.forEach(x => { const i = Math.min(nb - 1, Math.floor(x / bucket)); hist[i]++; });
    console.log('\n④ 分布（桶宽 ' + r2(bucket) + 'ms）');
    hist.forEach((n, i) => {
      const bar = '█'.repeat(Math.min(50, Math.round(n / Math.max(1, gaps.length) * 50)));
      if (n) console.log('   ' + String(r2(i * bucket)).padStart(6) + '~' + String(r2((i + 1) * bucket)).padStart(6) + '  ' + bar + ' ' + n);
    });
  }

  try { c.sock.end(); } catch (_) {}
  console.log('\n[ok] 结束（未写入任何变量）');
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error('✗ 失败：' + e.message); process.exit(1); });
