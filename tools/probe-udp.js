/* probe-udp.js — 试 CODESYS 的 UDP 块驱动（1740），看能否绕开 TCP 的逐块 ACK
   ══════════════════════════════════════════════════════════════════════════
   动机：TCP 块驱动已确认「每块 512B 上限 + 每块必须 ACK」，一块 8.7ms。
         CODESYS 另有 UDP 块驱动（端口 1740），协议上**没有块驱动的 magic/长度头**，
         也不是面向连接的重传模型。若 UDP 侧可用，块与块之间可能不再被 ACK 门控，
         这是唯一可能突破「块数 × 8.7ms」的方向。

   本脚本只做「能不能通」的探测，不实现完整会话：
     ① UDP 1740 是否响应名称解析（AddressResolve）
     ② 若响应，打印回复内容与字节结构，判断是不是 CODESYS 设备
     ③ 对比同一请求走 UDP 与走 TCP 的往返耗时

   用法：node tools/probe-udp.js [host]
   ⚠ 只读，不写入。不改 PLC 任何配置。
   ────────────────────────────────────────────────────────────────────────── */
'use strict';
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { CodesysV3Client } = require('../server/codesys-v3-client');

const HOST = process.argv[2] || '192.168.1.92';
const TCP_PORT = 11740;
const UDP_PORTS = [1740, 1741, 1742, 1743];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const HEX = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

function localIp() {
  const p = HOST.split('.').map(Number);
  const l = Object.values(os.networkInterfaces()).flat()
    .find(i => i.family === 'IPv4' && !i.internal && i.address.startsWith(p.slice(0, 3).join('.')));
  return l ? Buffer.from(l.address.split('.').map(Number)) : Buffer.from([127, 0, 0, 1]);
}

/* UDP 下没有块驱动头，所以数据报从「数据报层」开始：magic c5 6b + ... */
function nsPayloads() {
  const lip = localIp();
  const rip = Buffer.from(HOST.split('.').map(Number));
  const sender = Buffer.concat([HEX('432ddc'), lip]);
  const receiver = Buffer.concat([HEX('0000'), rip]);
  return [
    /* ① 剥掉块驱动 8 字节头（推荐形态：UDP 无 magic/长度） */
    { name: '无块驱动头', buf: Buffer.concat([HEX('c56b400300'), sender, receiver, HEX('02f102c2000401000000')]) },
    /* ② 保守形态：仍带块驱动头 */
    {
      name: '带块驱动头',
      buf: (() => {
        const d = Buffer.concat([HEX('c56b400300'), sender, receiver, HEX('02f102c2000401000000')]);
        const h = Buffer.alloc(8);
        h.writeUInt32LE(0xE8170100, 0);
        h.writeUInt32LE(8 + d.length, 4);
        return Buffer.concat([h, d]);
      })(),
    },
  ];
}

async function udpProbe(port, payload, waitMs = 800) {
  const s = dgram.createSocket('udp4');
  const out = { port, replied: false, ms: null, hex: '', bytes: 0, err: null };
  await new Promise((resolve) => {
    const t0 = now();
    let done = false;
    const finish = () => { if (done) return; done = true; try { s.close(); } catch (_) {} resolve(); };
    s.on('message', (m) => {
      out.replied = true; out.ms = Math.round(now() - t0); out.bytes = m.length;
      out.hex = m.toString('hex');
      finish();
    });
    s.on('error', (e) => { out.err = e.message; finish(); });
    s.send(payload, port, HOST, (e) => { if (e) { out.err = e.message; finish(); } });
    setTimeout(finish, waitMs);
  });
  return out;
}

async function tcpProbe(payload) {
  const t0 = now();
  try {
    await new Promise((res, rej) => {
      const s = net.connect({ host: HOST, port: TCP_PORT }, () => res());
      s.on('error', rej);
      setTimeout(() => { try { s.destroy(); } catch (_) {}; rej(new Error('timeout')); }, 3000);
    });
  } catch (e) {
    return { err: e.message, ms: Math.round(now() - t0) };
  }
  return { ms: Math.round(now() - t0) };
}

(async () => {
  console.log('════════════════════════════════════════════════');
  console.log('  UDP 块驱动探测（只读）   ' + HOST);
  console.log('  本机出口 ' + localIp().join('.') + '   目标 UDP 端口 ' + UDP_PORTS.join('/'));
  console.log('════════════════════════════════════════════════');

  const forms = nsPayloads();
  let anyReply = false;

  for (const port of UDP_PORTS) {
    for (const f of forms) {
      const r = await udpProbe(port, f.buf);
      const line = `  UDP ${port} · ${f.name.padEnd(10)} → `
        + (r.replied ? `✓ 回包 ${r.bytes}B · ${r.ms}ms · ${r.hex.slice(0, 40)}…`
          : (r.err ? '✗ ' + r.err : '无响应'));
      console.log(line);
      if (r.replied) {
        anyReply = true;
        /* 把回包里的可读字符串抠出来，判断是不是 CODESYS 设备 */
        const asc = Buffer.from(r.hex, 'hex').toString('latin1').replace(/[^\x20-\x7E]/g, '.');
        const u16 = Buffer.from(r.hex, 'hex').toString('utf16le').replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, '.');
        const a = asc.match(/[ -~]{4,}/g); const b = u16.match(/[ -~\u4e00-\u9fa5]{3,}/g);
        if (a || b) console.log('    可读内容：' + [...(a || []), ...(b || [])].slice(0, 4).join(' | '));
      }
      await sleep(250);
    }
  }

  console.log('\n对照：TCP ' + TCP_PORT + ' 连接耗时');
  const t = await tcpProbe();
  console.log('  TCP 连接 ' + (t.err ? '✗ ' + t.err : t.ms + 'ms'));

  console.log('\n判读');
  if (anyReply) {
    console.log('  ✓ UDP 有响应 → 该 PLC 开了 UDP 块驱动，理论上可绕开 TCP 的逐块 ACK。');
    console.log('    下一步要做的是在 UDP 上重放 openChannel / login / PrepareRead，');
    console.log('    并测「一次请求后 PLC 连续回多块」是否还需要逐块 ACK。');
  } else {
    console.log('  ✗ UDP 1740~1743 全部无响应 → 该 PLC 只开放 TCP 块驱动。');
    console.log('    ⇒ 无法绕开「每块必须 ACK」，512B/块 与 8.7ms/块 都是硬约束。');
    console.log('    可提速的唯一途径是减少字节数（块数），或按 docs/06 修 PLC 侧节拍。');
  }
  console.log('\n[ok] 结束（未写入任何变量）');
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error('✗ 失败：' + e.message); process.exit(1); });
