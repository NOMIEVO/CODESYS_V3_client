/* probe-ackgate.js — PLC 回块到底受不受 ACK 门控？（只读）
   ══════════════════════════════════════════════════════════════════════════
   要回答的问题：那 8.9ms/块，是「PLC 等我们 ACK 才算下一块」，
                 还是「PLC 按自己的节拍往外发，ACK 只是信用计数」？

   为什么这决定怎么修：
     · 若 ACK 门控（一问一答）  → 客户端 ACK 已 6µs，问题在 PLC 处理节拍
     · 若自带发送信用（可连发）  → 也许能通过「少 ACK、多收块」提高吞吐

   做法（三种模式，各读一次 33KB 数组，全程只读）：
     A 正常：每块都 ACK（现状）
     B 不回 ACK：观察 PLC 最多连发几块、间隔多少、何时报错
     C 每 4 块才 ACK 一次：看能否维持、总耗时是否缩短

   用法：node tools/probe-ackgate.js [host] [app] [符号]
   ⚠ 只读。跑前请停掉验证台（PLC 只服务一条 TCP 连接）。
   ────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const { CodesysV3Client } = require('../server/codesys-v3-client');

const HOST = process.argv[2] || '192.168.1.92';
const PORT = Number(process.env.MYX_PLC_PORT || 11740);
const APP = process.argv[3] || 'DEMO_MACHINE';
const SYM = process.argv[4] || 'Application.GVL_AXIS.aAxisCtl';
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;

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
const close = (c) => { try { c.sock && c.sock.end(); } catch (_) {} };

/* ackMode: 'each' 每块都回；'none' 完全不回；'every4' 每 4 块回一次 */
async function run(ackMode) {
  const c = await open();
  const arrive = [];
  const r = { ackMode, blocks: 0, ms: 0, err: null, gaps: [] };
  try {
    const h = await c.prepareRead([SYM]);
    c.readListHandle = h;

    let n = 0, pending = 0;
    const origAck = c.sendChanAck.bind(c);
    c.sendChanAck = function (blkId) {
      n++;
      if (ackMode === 'each') return origAck(blkId);
      if (ackMode === 'none') return;                 /* 不回 */
      if (ackMode === 'every4') {                     /* 每 4 块回一次，回最后一个 id */
        pending = blkId;
        if (n % 4 === 0) return origAck(pending);
        return;
      }
    };
    const origWait = c.waitForFrame.bind(c);
    c.waitForFrame = async (t) => {
      const d = await origWait(t);
      const pkt = d.slice(20, 22).toString('hex');
      if (pkt === '0101' || pkt === '0181' || pkt === '0100' || pkt === '0180') arrive.push(now());
      return d;
    };

    const t0 = now();
    await c.executeRead();
    r.ms = Math.round(now() - t0);
    r.blocks = arrive.length;
    for (let i = 1; i < arrive.length; i++) r.gaps.push(arrive[i] - arrive[i - 1]);
    c.sendChanAck = origAck;
    c.waitForFrame = origWait;
  } catch (e) {
    r.err = e.message.slice(0, 60);
    r.blocks = arrive.length;
    for (let i = 1; i < arrive.length; i++) r.gaps.push(arrive[i] - arrive[i - 1]);
  } finally { close(c); }
  return r;
}

function brief(r) {
  if (!r.blocks) return '无块' + (r.err ? ' · ✗ ' + r.err : '');
  const g = [...r.gaps].sort((a, b) => a - b);
  const med = g.length ? g[Math.floor(g.length / 2)] : 0;
  const mn = g.length ? g[0] : 0;
  return `${r.blocks} 块 · ${r.ms}ms · 每块 ${(r.ms / r.blocks).toFixed(2)}ms`
    + ` · 间隔中位 ${med.toFixed(2)}ms · min ${mn.toFixed(2)}ms`
    + (r.err ? ' · ✗ ' + r.err : '');
}

(async () => {
  console.log('════════════════════════════════════════════════');
  console.log('  ACK 门控实验（只读）  ' + HOST);
  console.log('  符号 ' + SYM);
  console.log('════════════════════════════════════════════════\n');

  for (const mode of ['each', 'none', 'every4']) {
    const label = { each: 'A 每块都 ACK（现状）', none: 'B 完全不回 ACK', every4: 'C 每 4 块 ACK 一次' }[mode];
    const r = await run(mode);
    console.log('  ' + label.padEnd(20) + brief(r));
    if (mode !== 'each') await sleep(2500);       /* 异常后给 PLC 时间回收通道 */
    else await sleep(600);
  }

  console.log('\n判读');
  console.log('  · B/C 的「间隔中位」若仍 ≈8.9ms 且块数正常 → ACK 只是信用计数，');
  console.log('    8.9ms 是 PLC 自己的发送节拍，客户端无论怎么 ACK 都改不了；');
  console.log('  · 若 B 收到若干块后停在固定数量（如 16 块）→ 该数量就是 PLC 的发送信用窗口；');
  console.log('  · 若 C 能把总耗时压下来且结果正确 → 少 ACK 可作为提速手段（需谨慎，风险高）。');
  console.log('\n[ok] 结束（未写入任何变量）');
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error('✗ 失败：' + e.message); process.exit(1); });
