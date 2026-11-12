/* test-write.js — 写入闭环（no-op 回写 + 回读校验）
   ─────────────────────────────────────────────────────────────
   不给 value：把刚读到的原值写回去（零变化），再回读比对 —— 不改变现场。
   给 value  ：写入指定值（会改变现场，仅在明确需要时使用，用完请复原）。

   前置：验证台已启动 + PLC 在线，且该 PLC 上存在同名变量。
   若变量不存在（例如连的是真实设备、而当前点表是演示工程 DEMO_MACHINE），
   会打印「跳过」并以退出码 77 结束——这是环境不匹配，不是缺陷。

   用法：node tests/test-write.js [变量名] [值]
   例：  node tests/test-write.js GVL_MAIN.diTotalCount       ← 安全，只回写原值
         node tests/test-write.js GVL_MAIN.diTotalCount 123   ← 真改值
*/
const WebSocket = require('./_ws');

const KEY = process.argv[2] || 'GVL_MAIN.diTotalCount';
const VAL = process.argv[3] !== undefined ? Number(process.argv[3]) : null;
const URL = (process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095').replace(/^http/, 'ws') + '/ws';

const ws = new WebSocket(URL);
let st = null;
let sent = false;
let skipped = false, writeOk = false;
let concluded = false;

ws.on('open', () => console.log('[ws] 已连接'));
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw); } catch (_) { return; }

  if (m.t === 'state') {
    st = m.state;
    console.log('[state]', m.state, m.error ? '· ' + m.error : '');
    if (m.state === 'online' && !sent) {
      sent = true;
      const v = VAL === null ? undefined : VAL;
      console.log('[cmd] writeTest', KEY, 'mode=' + (v === undefined ? 'noop' : 'set') + ' value=' + v);
      ws.send(JSON.stringify({ cmd: 'writeTest', key: KEY, mode: v === undefined ? 'noop' : 'set', value: v }));
    }
  }

  if (m.t === 'wtest') {
    console.log('  [' + (m.level || 'sys') + '] ' + m.text);
    /* 变量不在该 PLC 上：明确跳过，避免把「换了工程」误报成失败。
       两种表现：服务端预检「未知变量」，或 PLC 层 status=0x14（名字无效）。 */
    if (/未知变量|不存在|status=0x14|写入被拒/.test(m.text || '')) skipped = true;
    if (/^└/.test(m.text || '')) concluded = true;
    if (/^└/.test(m.text || '') && /成功/.test(m.text || '')) writeOk = true;
  }

  /* 服务端把「未知变量」作为 log 广播（不是 wtest），这里一并识别为"跳过" */
  if (m.t === 'log' && /未知变量|status=0x14/.test(m.text || '')) skipped = true;
  if (m.t === 'log' && /8400|超时|异常/.test(m.text || '')) console.log('  !! ' + m.text);
});

setTimeout(() => {
  if (skipped) {
    console.log(`\n[i] 跳过：当前点表（及 PLC）上没有 ${KEY}`);
    console.log('    用例默认用演示工程 DEMO_MACHINE 的变量；换成自己的工程后按 README 第 5 节改用例里的变量名');
    console.log('    真机验证请改用自己工程的变量名：node tests/test-write.js <变量名>');
  } else if (st !== 'online') {
    console.log('✗ 链路未在线，state=' + st + '（先启动验证台并确认能连上 PLC）');
  } else if (!concluded) {
    console.log('✗ 未收到写入结论行（超时）');
  }
  ws.close();
  if (skipped) process.exit(77);                       /* 77 = 跳过（环境不匹配） */
  if (st !== 'online' || !concluded || !writeOk) process.exit(1);
  process.exit(0);
}, Number(process.env.WAIT || 22000));
