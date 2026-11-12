#!/usr/bin/env node
/* embed-demo.js — 在自己的 Node 程序里使用协议客户端（最小可运行示例）
   ─────────────────────────────────────────────────────────────
   用法：
     node example/embed-demo.js                       读默认地址的示例变量
     node example/embed-demo.js 192.0.2.10          指定 PLC 地址
     node example/embed-demo.js 192.0.2.10 11740    指定地址与端口

   演示四件事：
     ① 七步握手（每步打印耗时）
     ② 按名登记 + 单轮读取（一次报文读回多个变量）
     ③ 数组元素 / 结构体成员按名直读
     ④ no-op 回写（把读到的原值写回去，不改变现场）
    注意：本示例默认只读；写入默认关闭，需显式打开且变量须在白名单内。
   ───────────────────────────────────────────────────────────── */
'use strict';

const path = require('path');
const CLIENT = path.join(__dirname, '..', 'server', 'codesys-v3-client.js');
const { CodesysV3Client } = require(CLIENT);

const HOST = process.argv[2] || '192.0.2.10';
const PORT = Number(process.argv[3] || 11740);

/* 要读的变量（换成自己程序的变量名即可）。
   三行分别是：标量 / 数组元素 / 结构体成员 —— 写法完全一致。 */
const NAMES = [
  'Application.GVL_MAIN.diTotalCount',
  'Application.GVL_MAIN.aAlarmCode[0]',
  'Application.GVL_AXIS.aAxisCtl[3].fActPosition',
];

/* 按 XML 类型解码一个 Buffer（示例只覆盖常见类型；完整版在 server/drill-core.js） */
function decode(iecType, buf) {
  if (!buf || !buf.length) return null;
  switch (String(iecType).toUpperCase()) {
    case 'BOOL':  return buf.readUInt8(0) ? true : false;
    case 'SINT':  return buf.readInt8(0);
    case 'USINT':
    case 'BYTE':  return buf.readUInt8(0);
    case 'INT':   return buf.readInt16LE(0);
    case 'UINT':
    case 'WORD':  return buf.readUInt16LE(0);
    case 'DINT':
    case 'TIME':  return buf.readInt32LE(0);
    case 'UDINT':
    case 'DWORD': return buf.readUInt32LE(0);
    case 'REAL':  return Number(buf.readFloatLE(0).toFixed(3));
    case 'LREAL': return Number(buf.readDoubleLE(0).toFixed(3));
    default:      return buf.length <= 8 ? buf.readUInt32LE(0) : buf.toString('hex').slice(0, 32) + '…';
  }
}
const TYPES = ['DINT', 'INT', 'REAL'];   // 与上面 NAMES 一一对应（示例写死；正式场景从 types.json 取）

(async () => {
  const t0 = Date.now();
  const c = new CodesysV3Client(HOST, PORT, { allowWrite: false });
  const step = (n, label, extra) => console.log(`  ${n} ${label.padEnd(12)} ${extra}`);

  try {
    console.log(`\n── 连接 ${HOST}:${PORT} ──`);

    /* ① 设备名（独立短连接，用完即关） */
    const name = await c.nsQuery();
    step('①', 'NS 查询', name);

    /* ② 主连接：首包必须是 NS 查询 */
    await c.connect();
    await c.nsQueryOnMain();
    step('②', '主连接 NS', 'ok');

    /* ③④⑤ 通道 / 会话 / 登录 */
    const chId = await c.openChannel();
    step('③', '开通道', 'chId=0x' + chId.toString(16));

    step('④', '会话创建', (await c.sessionCreate()) + 'B');

    const sid = await c.login();
    step('⑤', '登录', 'sessionId=0x' + sid.toString(16).padStart(8, '0'));

    /* ⑥ 根句柄 + 设备令牌 */
    const root = await c.getRoot();
    step('⑥', 'GetRoot', 'handle=0x' + root.toString(16) + ' · token=0x' +
      (c.deviceToken >>> 0).toString(16));

    /* ⑦ 按名登记 */
    const handle = await c.prepareRead(NAMES);
    step('⑦', 'PrepareRead', 'listHandle=0x' + handle.toString(16) +
      `（${NAMES.length} 个变量）`);

    /* 读三轮，看值是否稳定 */
    console.log('\n── 周期读取（3 轮 × 300ms）──');
    for (let r = 1; r <= 3; r++) {
      const t = Date.now();
      const bufs = await c.executeRead();
      console.log(`  第 ${r} 轮（${Date.now() - t}ms）`);
      NAMES.forEach((n, i) => {
        const v = decode(TYPES[i], bufs[i]);
        console.log('    ' + n.replace(/^Application\./, '').padEnd(46) +
          ' = ' + (v === null ? '--' : v));
      });
      if (r < 3) await new Promise(s => setTimeout(s, 300));
    }

    /* ⑧ no-op 回写：把刚读到的第 1 个值原样写回（零变化，不改变现场） */
    const bufs = await c.executeRead();
    const raw = bufs[0];
    if (raw && raw.length) {
      c.allowWrite = true;
      const w = await c.writeValue(NAMES[0], raw.subarray(0, 4));
      console.log(`\n── no-op 回写（原值写回）──`);
      console.log(`  ${NAMES[0].replace(/^Application\./, '')}`);
      console.log(`  写入状态 = ${w.status}（0 = 成功）· ok=${w.ok}`);
      const after = await c.executeRead();
      const same = Buffer.compare(after[0].subarray(0, 4), raw.subarray(0, 4)) === 0;
      console.log(`  回读比对 ${same ? '一致 ✓' : '不一致 ✗'}`);
    }

    console.log(`\n✅ 全部完成，耗时 ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`\n✗ 失败：${e.message}`);
    console.log('  排查顺序：');
    console.log('   1. 地址端口是否可达（telnet ' + HOST + ' ' + PORT + '）');
    console.log('   2. 是否已有别的客户端占用（PLC 11740 只接受一条连接）');
    console.log('   3. 多网卡机器：设置 MYX_SRC=<有线网卡IP> 固定走有线');
    process.exitCode = 1;
  } finally {
    try { c.sock && c.sock.end(); } catch (_) {}
    setTimeout(() => { try { c.sock && c.sock.destroy(); } catch (_) {} }, 150);
  }
})();
