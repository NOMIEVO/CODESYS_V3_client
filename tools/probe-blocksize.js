/* probe-blocksize.js — 分块尺寸探针：确认「448B/块」是协议上限还是客户端自选
   ══════════════════════════════════════════════════════════════════════════
   背景：CODESYS IDE 内部的变量监控读写很快，而我们的客户端慢。两者走同一条
         块驱动/通道路径，所以差异只可能在「分块参数」上。
         若 448B 只是**我们自己**在 OpenChannel / 数据报头里申报的接收窗口，
         那么把它调大就能让 PLC 一次回更多数据，块数成比例下降 —— 这是唯一
         能绕过「逐块 ACK」而不违反协议的路径。

   本脚本做三件事（全部只读）：
     ① dump   ：打印 PLC 回包的每个数据报长度 + 头 8 字节，找出「长度字段」在哪
     ② reqcap ：改动请求数据报里的候选字段，观察 PLC 回包块尺寸是否随之变化
     ③ txbig  ：把 11KB 的 PrepareRead 用一个超长帧一次发出，看 PLC 是否接受

   用法：
     node tools/probe-blocksize.js dump    [host] [app]
     node tools/probe-blocksize.js reqcap  [host] [app]
     node tools/probe-blocksize.js txbig   [host] [app]
     node tools/probe-blocksize.js all     [host] [app]

   ⚠ 只读：不使用任何写接口。跑前请停掉验证台（PLC 只服务一条连接）。
   ────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const { CodesysV3Client } = require('../server/codesys-v3-client');

/* 与客户端同算法的 CRC32（本脚本要手工组帧，拿不到内部函数） */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

const MODE = (process.argv[2] || 'all').toLowerCase();
const HOST = process.argv[3] || '192.168.1.92';
const PORT = Number(process.env.MYX_PLC_PORT || 11740);
const APP = process.argv[4] || 'DEMO_MACHINE';
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;

function bigArray() {
  const f = path.join(ROOT, 'out', APP, 'tag_table.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const list = (d.symbols || [])
    .filter(s => s.symbolPath && /^ARRAY/i.test(s.iecType || ''))
    .map(s => ({ full: s.symbolPath.startsWith('Application.') ? s.symbolPath : 'Application.' + s.symbolPath, bytes: s.bytes || 0 }))
    .sort((a, b) => b.bytes - a.bytes);
  return list[0];
}
function allNames() {
  const f = path.join(ROOT, 'out', APP, 'tag_table.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return (d.symbols || []).filter(s => s.symbolPath && s.iecType)
    .map(s => s.symbolPath.startsWith('Application.') ? s.symbolPath : 'Application.' + s.symbolPath);
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
const close = (c) => { try { c.sock && c.sock.end(); } catch (_) {} };

/* 打印一次读的所有块：长度 + 头字节 */
async function dumpBlocks(c, symbol) {
  const h = await c.prepareRead([symbol]);
  c.readListHandle = h;
  const seen = [];
  const orig = c.waitForFrame.bind(c);
  c.waitForFrame = async (t) => {
    const d = await orig(t);
    const pkt = d.slice(20, 22).toString('hex');
    if (pkt === '0101' || pkt === '0181' || pkt === '0100' || pkt === '0180') {
      seen.push({ len: d.length, head: d.slice(0, 8).toString('hex'), pkt });
    }
    return d;
  };
  const t0 = now();
  await c.executeRead();
  const ms = now() - t0;
  c.waitForFrame = orig;
  return { seen, ms, blocks: c.lastBlocks, bytes: c.lastReadPayload.length };
}

(async () => {
  const arr = bigArray();
  console.log('════════════════════════════════════════════════');
  console.log('  分块尺寸探针（只读）   ' + HOST + '  程序 ' + APP);
  console.log('  大数组 ' + arr.full + '  ' + (arr.bytes / 1024).toFixed(1) + 'KB');
  console.log('════════════════════════════════════════════════');

  if (MODE === 'dump' || MODE === 'all') {
    console.log('\n① dump：PLC 回包每块的「数据报总长」与「头 8 字节」');
    const c = await open();
    const r = await dumpBlocks(c, arr.full);
    close(c);
    console.log('   共 ' + r.seen.length + ' 块 · ' + Math.round(r.ms) + 'ms · 载荷 ' + r.bytes + 'B');
    const byLen = {};
    r.seen.forEach(x => { byLen[x.len] = (byLen[x.len] || 0) + 1; });
    console.log('   长度分布：' + Object.entries(byLen).map(([k, v]) => k + 'B×' + v).join('  '));
    console.log('\n   前 3 块 / 后 2 块明细：');
    [...r.seen.slice(0, 3), ...r.seen.slice(-2)].forEach((x, i) => {
      console.log('     ' + String(i).padStart(2) + '  len=' + String(x.len).padStart(4)
        + '  pkt=' + x.pkt + '  head=' + x.head);
    });
    console.log('\n   判读：若 header 里某个字节 ≈ len/8（如 508B → 0x40=64），');
    console.log('         该字节就是「本数据报长度 / 8」，改大它即可申请更大块。');
    await sleep(600);
  }

  if (MODE === 'reqcap' || MODE === 'all') {
    console.log('\n② reqcap：改请求数据报头的候选字节，看 PLC 回包块长是否变大');
    const orig = CodesysV3Client.prototype.chanPrefix;
    for (const [idx, val] of [[2, 0x40], [2, 0x80], [2, 0xff], [3, 0x40], [3, 0x80], [3, 0xff], [4, 0x01]]) {
      CodesysV3Client.prototype.chanPrefix = function () {
        const b = Buffer.from(orig.call(this));
        b[idx] = val;
        return b;
      };
      let line = `   byte[${idx}]=0x${val.toString(16)} → `;
      try {
        const c = await open();
        const r = await dumpBlocks(c, arr.full);
        close(c);
        const maxLen = Math.max(...r.seen.map(x => x.len));
        line += `${r.seen.length} 块 · 最大 ${maxLen}B · ${Math.round(r.ms)}ms`;
      } catch (e) {
        line += '✗ ' + e.message.slice(0, 46);
      }
      CodesysV3Client.prototype.chanPrefix = orig;
      console.log(line);
      await sleep(700);
    }
  }

  if (MODE === 'txbig' || MODE === 'all') {
    console.log('\n③ txbig：11KB 的 PrepareRead 用「一个超长帧」发出（不分块）');
    const names = allNames();
    /* 组一个约 11KB 的名字列表载荷 */
    const entry = (f) => { const n = Buffer.byteLength(f) + 1; return (n + 4 + 3) & ~3; };
    const pick = [];
    let sz = 24;
    for (const f of names) { const e = entry(f); if (sz + e > 11000) break; pick.push(f); sz += e; }
    console.log('   名单 ' + pick.length + ' 个 · 载荷 ' + sz + 'B（原实现需 26 个块）');

    for (const head3 of [0x40, 0x80, 0xff]) {
      const c = await open();
      const payload = c.buildNameListPayload(pick);
      const svc = c.serviceMsg(0x09, 0x01, payload);
      /* 手工组一个首块：把整段服务塞进单帧，头部第三字节按候选值申报 */
      const prefix = Buffer.from(c.chanPrefix());
      prefix[3] = head3;
      const frame = Buffer.concat([
        prefix, Buffer.from('0181', 'hex'), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(c.chId, 0); return b; })(),
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(++c.blkId, 0); return b; })(),
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(c.ackId, 0); return b; })(),
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(svc.length, 0); return b; })(),
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(crc32(svc), 0); return b; })(),
        svc,
      ]);
      const t0 = now();
      let res;
      try {
        c.sendFrame(frame);
        const svcResp = await c.recvService();
        const handle = svcResp.readUInt32LE(svcResp.indexOf(Buffer.from('10848000', 'hex')) + 4);
        res = '✓ 接受 · 句柄 0x' + handle.toString(16).toUpperCase() + ' · ' + Math.round(now() - t0) + 'ms（1 帧）';
      } catch (e) {
        res = '✗ ' + e.message.slice(0, 50);
      }
      close(c);
      console.log('   byte[3]=0x' + head3.toString(16) + '：' + res);
      await sleep(800);
    }
  }

  console.log('\n[ok] 探针结束（未写入任何变量）');
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error('✗ 失败：' + e.message); process.exit(1); });
