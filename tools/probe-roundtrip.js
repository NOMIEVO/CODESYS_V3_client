/* probe-roundtrip.js — 拆开「一次往返」到底花在哪：网卡 / TCP 栈 / CODESYS Runtime
   ══════════════════════════════════════════════════════════════════════════
   用途：解释「同一个客户端，接 SA40 很快、接 Windows 工控机很慢」。
   它把一次往返拆成三段，并检查耗时是否被量化到某个固定步长：

     ① TCP 连接（SYN → SYN-ACK）      —— 纯网络 RTT，不含任何协议逻辑
     ② GetRoot（1 请求 / 1 块 / 无数据） —— Runtime 处理一次请求的开销
     ③ 分块阶梯（1→2→3→6→13 块）     —— 每多一块增加多少

   判读：
     · ①≈0 而 ②很大          → 网络没问题，慢在 Runtime / TCP 栈 / 过滤驱动
     · ③ 的增量恒定且接近某个整数（如 9~10ms）→ 说明 PLC 每块都在等自己的任务周期
     · ③ 增量忽大忽小、偶发上百 ms          → 丢包重传 / 网卡节能 / 杀软拦截

   用法：node tools/probe-roundtrip.js [host] [app]
   只读，不写入任何变量。跑之前请停掉验证台（PLC 只服务一条连接）。
   ────────────────────────────────────────────────────────────────────────── */
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { CodesysV3Client } = require('../server/codesys-v3-client');

const ROOT = path.join(__dirname, '..');
const HOST = process.argv[2] || '192.168.1.92';
const PORT = Number(process.env.MYX_PLC_PORT || 11740);
const APP = process.argv[3] || 'DEMO_MACHINE';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const now = () => Number(process.hrtime.bigint()) / 1e6;      /* ms，微秒精度 */
const r1 = (v) => Math.round(v * 10) / 10;

function stat(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { n: s.length, min: r1(s[0]), med: r1(s[Math.floor(s.length / 2)]),
    max: r1(s[s.length - 1]), avg: r1(s.reduce((a, b) => a + b, 0) / s.length) };
}

async function tcpConnect() {
  const t = now();
  await new Promise((res, rej) => {
    const s = net.connect({ host: HOST, port: PORT }, () => { s.destroy(); res(); });
    s.on('error', rej);
    setTimeout(() => { s.destroy(); rej(new Error('connect timeout')); }, 5000);
  });
  return now() - t;
}

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
function close(c) { try { c.sock && c.sock.end(); } catch (_) {} }

function catalogue(app) {
  const f = path.join(ROOT, 'out', app, 'tag_table.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const BS = { BOOL: 1, SINT: 1, USINT: 1, BYTE: 1, INT: 2, UINT: 2, WORD: 2,
    DINT: 4, UDINT: 4, DWORD: 4, REAL: 4, LINT: 8, ULINT: 8, LREAL: 8 };
  const rows = [];
  for (const s of d.symbols || []) {
    if (!s.symbolPath || !s.iecType) continue;
    const full = s.symbolPath.startsWith('Application.') ? s.symbolPath : 'Application.' + s.symbolPath;
    const m = String(s.iecType).match(/^ARRAY\s*\[\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\]\s*OF\s+(\w+)/i);
    const bytes = m ? ((+m[2] - +m[1] + 1) * (BS[m[3].toUpperCase()] || 4)) : (s.bytes || 4);
    rows.push({ full, bytes, isArray: !!m, scalars: !m });
  }
  return rows;
}

(async () => {
  console.log('════════════════════════════════════════════════');
  console.log('  往返拆解（只读）   ' + HOST + ':' + PORT);
  console.log('════════════════════════════════════════════════');

  /* ① 纯 TCP 连接 */
  const conns = [];
  for (let i = 0; i < 12; i++) {
    try { conns.push(await tcpConnect()); } catch (e) { console.log('  连接失败：' + e.message); break; }
    await sleep(60);
  }
  const s1 = conns.length ? stat(conns) : null;
  if (s1) console.log('① TCP 连接（SYN→SYN-ACK，纯网络）　中位 ' + s1.med + 'ms（' + s1.min + '~' + s1.max + '）');
  await sleep(300);

  /* ② GetRoot 往返（1 请求 1 块，无业务数据） */
  const c = await open();
  const roots = [];
  for (let i = 0; i < 20; i++) {
    const t = now(); await c.getRoot(); roots.push(now() - t);
    await sleep(30);
  }
  const s2 = stat(roots);
  console.log('② GetRoot 往返（1 请求）　　　　　中位 ' + s2.med + 'ms（' + s2.min + '~' + s2.max + '）');

  /* ③ 分块阶梯：按不同块数读同族符号 */
  const cat = catalogue(APP);
  const arrs = cat.filter(x => x.isArray).sort((a, b) => a.bytes - b.bytes);
  const targets = [];
  const want = [1, 2, 3, 6, 13, 26, 54];
  for (const nb of want) {
    const approx = nb * 448;
    const t = arrs.find(x => x.bytes >= approx * 0.85 && x.bytes <= approx * 1.25);
    if (t && !targets.some(u => u.full === t.full)) targets.push(t);
  }
  const scalar = cat.find(x => x.scalars);

  console.log('\n③ 分块阶梯（同一读取列表，改变响应块数）');
  console.log('   块数   数据量     耗时     每块增量');
  let prev = null;
  const rows = [];
  for (const t of (scalar ? [Object.assign({}, scalar, { label: '标量' })] : []).concat(targets)) {
    const list = [t.full];
    let res;
    try {
      const cc = await open();
      const h = await cc.prepareRead(list);
      cc.readListHandle = h;
      const ms = [];
      for (let i = 0; i < 6; i++) { const s = now(); await cc.executeRead(); ms.push(now() - s); await sleep(40); }
      res = { blocks: cc.lastBlocks || 1, bytes: (cc.lastReadPayload || { length: 0 }).length, ...stat(ms) };
      close(cc);
    } catch (e) {
      console.log('   ' + String('?').padStart(3) + '   ' + t.full.split('.').pop() + ' 读取失败：' + e.message.slice(0, 40));
      await sleep(400);
      continue;
    }
    let inc = '';
    if (prev && res.blocks > prev.blocks) {
      inc = r1((res.med - prev.med) / (res.blocks - prev.blocks)) + 'ms/块';
    }
    console.log('   ' + String(res.blocks).padStart(3) + '   ' + String((res.bytes / 1024).toFixed(1) + 'KB').padStart(8)
      + '   ' + String(res.med + 'ms').padStart(7) + '   ' + inc.padStart(9)
      + '   ' + t.full.split('.').pop().slice(0, 26));
    rows.push({ name: t.full, blocks: res.blocks, bytes: res.bytes, ...res });
    prev = res;
    await sleep(400);
  }
  close(c);

  /* ④ 结论 */
  console.log('\n④ 结论');
  if (s1) {
    console.log('   网络层（TCP 连接）' + s1.med + 'ms · 协议层单请求 ' + s2.med + 'ms'
      + ' → 协议往返比裸网络慢 ' + r1(s2.med - s1.med) + 'ms');
  }
  const perReq = s2.med;
  if (perReq > 4) {
    console.log('   单请求 ' + perReq + 'ms 明显高于裸网络 RTT（' + (s1 ? s1.med : '?') + 'ms）：');
    console.log('   说明瓶颈在 PLC 侧 Runtime / TCP 栈，不在交换机与线缆。');
  }
  const incs = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].blocks > rows[i - 1].blocks) {
      incs.push((rows[i].med - rows[i - 1].med) / (rows[i].blocks - rows[i - 1].blocks));
    }
  }
  if (incs.length) {
    const avg = incs.reduce((a, b) => a + b, 0) / incs.length;
    const spread = Math.max(...incs) - Math.min(...incs);
    console.log('   每块增量 ' + incs.map(v => r1(v)).join(' / ') + 'ms（均值 ' + r1(avg) + '，极差 ' + r1(spread) + '）');
    if (spread < avg * 0.5) {
      console.log('   增量稳定 → 每块都在等一个固定节拍：多为 Runtime 任务周期 / 通讯线程调度');
    } else {
      console.log('   增量不稳 → 存在排队或重传：查网卡节能、中断节流、杀软网络过滤');
    }
  }

  const outFile = path.join(ROOT, 'out', 'roundtrip-' + HOST.replace(/[^\w.-]/g, '_') + '.json');
  fs.writeFileSync(outFile, JSON.stringify({ host: HOST, app: APP, at: new Date().toISOString(),
    tcpConnect: s1, getRoot: s2, ladder: rows }, null, 1));
  console.log('\n[ok] 已保存 ' + path.relative(ROOT, outFile) + '（未写入任何变量）');
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error('✗ 失败：' + e.message); process.exit(1); });
