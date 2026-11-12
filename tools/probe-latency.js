/* probe-latency.js — 测「扫描耗时」到底慢在哪：块数 × 单块往返
   ══════════════════════════════════════════════════════════════════════
   背景：全量页的「扫描耗时」跟变量个数关系不大，真正的模型是

        扫描耗时 ≈ 响应块数 × 单块往返时间

   因为 CODESYS 把响应按 ≤448B 一块切分，而**每个数据块都必须单独 ACK**
   （实测不可省：不回 ACK，PLC 会直接判「通道错误 8400」并把整次读取作废）。
   于是：
        · 230 个标量 → 46 个读取列表 × 每表 1 块 ≈ 46 次往返 → 有线约 74ms
        · 1 个 ARRAY[0..7999] OF REAL → 32KB ÷ 448B ≈ 72 块 → 72 次往返
          单块 0.8ms（有线同网段）≈ 60ms；单块 8ms（Wi-Fi / 跨网段）≈ 580ms

   这就是「数据量才 31KB，扫描却要 580ms」的原因：块数由字节数决定，
   而每块都要等一个往返，网络越差放大越明显。数据量小 ≠ 往返次数少。

   用法：
     node tools/probe-latency.js                             # 自动挑几个大符号试
     node tools/probe-latency.js 192.168.1.92                # 指定 PLC
     node tools/probe-latency.js 192.168.1.92 GVL.CommValue  # 指定符号
     node tools/probe-latency.js --raw                       # 打印逐次耗时

   只读，不写入任何变量。可安全在现场机器上跑。
   注：单个大符号整读被 PLC 拒绝或超时很常见（6000+ 字节的类型），
       探针会自动跳过并换下一个，不影响结论。
   ────────────────────────────────────────────────────────────────────── */
'use strict';
const path = require('path');
const fs = require('fs');
const { CodesysV3Client } = require('../server/codesys-v3-client');

const argv = process.argv.slice(2);
const RAW = argv.includes('--raw');
const pos = argv.filter(a => !a.startsWith('-'));
const HOST = pos[0] || process.env.MYX_HOST || '192.168.1.92';
const PORT = Number(process.env.MYX_PLC_PORT || 11740);
const WANT = (pos[1] || '').replace(/^Application\./, '');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ms = (t) => Date.now() - t;
const GEN = path.join(__dirname, '..', 'server', 'gen');

const BASE_BYTES = { BOOL: 1, SINT: 1, USINT: 1, BYTE: 1, INT: 2, UINT: 2, WORD: 2,
  DINT: 4, UDINT: 4, DWORD: 4, REAL: 4, LINT: 8, ULINT: 8, LREAL: 8 };

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

/* 候选符号：按字节数从大到小（数组按 元素数 × 基类型字节 估） */
function candidates() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(GEN).filter(f => f.endsWith('.symbols.json')); } catch (_) {}
  for (const f of files) {
    const d = readJson(path.join(GEN, f));
    const list = Array.isArray(d) ? d : (d && d.symbols) || [];
    for (const s of list) {
      const full = String(s.full || s.key || s.name || '');
      if (!full) continue;
      const bytes = s.elem
        ? (Number(s.elem.count) || 0) * (BASE_BYTES[s.elem.base] || 4)
        : (Number(s.size) || 0);
      if (bytes >= 512) out.push({ name: full.replace(/^Application\./, ''), bytes });
    }
  }
  out.sort((a, b) => b.bytes - a.bytes);
  const seen = new Set();
  return out.filter(c => (seen.has(c.name) ? false : seen.add(c.name)));
}

function scalarName() {
  try {
    const f = fs.readdirSync(GEN).find(x => x.endsWith('.tags.json'));
    const d = readJson(path.join(GEN, f));
    const t = (d.tags || d.points || [])[0];
    if (t && t.key) return t.key.replace(/^Application\./, '');
  } catch (_) {}
  return null;
}

/* 每次测量都用新会话：一次超时/被拒会把旧通道搞脏，重连最干净 */
async function openClient() {
  const c = new CodesysV3Client(HOST, PORT, { allowWrite: false });
  await c.nsQuery();
  await c.connect();
  await c.nsQueryOnMain();
  await c.openChannel();
  await c.sessionCreate();
  await c.login();
  await c.getRoot();
  return c;
}
function closeClient(c) { try { c.sock && c.sock.end(); } catch (_) {} }

(async () => {
  console.log('════════════════════════════════════════════════');
  console.log('  扫描耗时归因探针（只读）');
  console.log('  PLC  ' + HOST + ':' + PORT);
  console.log('════════════════════════════════════════════════');

  /* ① 基准：最小标量，一问一答 = 恰好 1 块往返 */
  const sn = scalarName();
  let med = 0, min = 0, max = 0;
  if (sn) {
    const c = await openClient();
    console.log('  握手完成  ' + ms(performance.now ? Date.now() : Date.now()) + 'ms（含重连）');
    try {
      const h = await c.prepareRead(['Application.' + sn]);
      c.readListHandle = h;
      const rtts = [];
      for (let i = 0; i < 15; i++) {
        const t = Date.now();
        await c.executeRead();
        rtts.push(ms(t));
        await sleep(20);
      }
      rtts.sort((a, b) => a - b);
      med = rtts[Math.floor(rtts.length / 2)]; min = rtts[0]; max = rtts[rtts.length - 1];
      console.log('① 单块往返基准（' + sn + '，8B 量级，15 次）');
      console.log('   min ' + min + 'ms · 中位 ' + med + 'ms · max ' + max + 'ms · 抖动 ' + (max - min) + 'ms');
      if (RAW) console.log('   逐次：' + rtts.join(', '));
    } catch (e) {
      console.log('① 基准测量失败：' + e.message);
    }
    closeClient(c);
    await sleep(300);
  } else {
    console.log('① 跳过基准：找不到点表（server/gen/*.tags.json）');
  }
  console.log('');

  /* ② 大符号：块数 = 载荷 / 448 */
  const list = WANT ? [{ name: WANT, bytes: 0 }] : candidates().slice(0, 6);
  let picked = null, best = null;
  for (const cand of list) {
    let c = null;
    try {
      c = await openClient();
      const h = await c.prepareRead(['Application.' + cand.name]);
      c.readListHandle = h;
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const t = Date.now();
        await c.executeRead();
        runs.push({ ms: ms(t), blocks: c.lastBlocks || 1, bytes: (c.lastReadPayload || { length: 0 }).length });
        await sleep(40);
      }
      picked = cand; best = runs[0]; best.runs = runs;
      break;
    } catch (e) {
      console.log('   · ' + cand.name + (cand.bytes ? '（约 ' + (cand.bytes / 1024).toFixed(1) + 'KB）' : '')
        + ' 跳过：' + e.message.slice(0, 44));
    } finally { if (c) closeClient(c); }
    await sleep(300);
  }

  if (!picked) {
    console.log('\n② 没有可整读的大符号（PLC 侧拒绝或超时）——');
    console.log('   这不影响结论：慢不慢只取决于「块数 × 单块往返」，上面①的基准就是单块往返。');
  } else {
    const per = best.ms / Math.max(1, best.blocks);
    console.log('② 大块整读（' + picked.name + (picked.bytes ? '，约 ' + (picked.bytes / 1024).toFixed(1) + 'KB' : '') + '）');
    console.log('   载荷 ' + best.bytes + 'B → 块数 ' + best.blocks
      + '（' + best.runs.map(r => r.ms + 'ms').join(' / ') + '）');
    console.log('   每块 ' + per.toFixed(2) + 'ms'
      + (med ? '（基准 ' + med + 'ms/块，' + (per / Math.max(med, 0.1)).toFixed(1) + ' 倍）' : ''));
    console.log('');

    console.log('③ 判定');
    if (med && per <= med * 1.8) {
      console.log('   ✓ 每块耗时 ≈ 标量往返 → 通讯正常，慢就是「块数多」的算术结果。');
    } else if (med) {
      console.log('   ! 每块 ' + per.toFixed(2) + 'ms 远高于标量往返 ' + med + 'ms：');
      console.log('     PLC 处理大响应慢，或链路上有丢包重传（抖动 ' + (max - min) + 'ms）。');
    }
    console.log('   同一份数据的链路参照：');
    console.log('     单块 0.8ms（有线同网段）→ 约 ' + Math.round(best.blocks * 0.8) + 'ms');
    console.log('     单块 3ms  （百兆 / 小路由）→ 约 ' + Math.round(best.blocks * 3) + 'ms');
    console.log('     单块 8ms  （Wi-Fi / 跨网段）→ 约 ' + Math.round(best.blocks * 8) + 'ms');
  }

  if (med > 3 || (best && best.ms / Math.max(1, best.blocks) > 3)) {
    console.log('');
    console.log('   ⚠ 这条链路的单块往返偏高，这正是「数据量不大但扫描很慢」的直接原因。');
    console.log('     处理顺序（从省事到彻底）：');
    console.log('     ① 网线直连 PLC 或同一台交换机，别经 Wi-Fi / 路由器 / VPN；');
    console.log('     ② 多网卡机器设 MYX_SRC=<有线网卡 IP>，强制走有线；');
    console.log('     ③ 网卡属性关掉「节能 / 绿色以太网 / 中断节流」，关掉抓包类杀软；');
    console.log('     ④ PLC 侧把不必要的大数组从符号配置里去掉（1 个 32KB 数组 = 72 次往返）；');
    console.log('     ⑤ 只想看少量元素时，用「监控列表」登记元素，别整符号扫描。');
  }

  console.log('\n[ok] 探针结束（未写入任何变量）');
  setTimeout(() => process.exit(0), 200);
})().catch(e => {
  console.error('✗ 探针失败：' + e.message);
  process.exit(1);
});
