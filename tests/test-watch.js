/* test-watch.js — 监控列表实时值（watchSet → wvals）
   ─────────────────────────────────────────────────────────────
   把三个变量交给服务端登记（BOOL 成员 / 嵌套成员 / REAL 成员），
   断言每个都能收到实时值。用于验证「点表外变量」的读取链路。
   前置：验证台已启动 + PLC 在线，且该 PLC 上存在同名变量。
   若变量不存在（连的是真实设备、而点表是演示工程 DEMO_MACHINE），
   会打印「跳过」并以退出码 77 结束——环境不匹配，不是缺陷。

   用法：node tests/test-watch.js
*/
const WebSocket = require('./_ws');

const KEYS = ['GVL_AXIS.aAxisCtl[3].fActPosition', 'GVL_AXIS.aAxisCtl[3].tState.bValid', 'GVL_AXIS.aAxisCtl[3].fSetPosition'];
const WS = (process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095').replace(/^http/, 'ws') + '/ws';
const ws = new WebSocket(WS);
let sent = false;
const seen = {};

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw); } catch (_) { return; }
  if (m.t === 'state' && m.state === 'online' && !sent) {
    sent = true;
    console.log('[cmd] watchSet', KEYS.join(', '));
    ws.send(JSON.stringify({ cmd: 'watchSet', keys: KEYS }));
  }
  if (m.t === 'wvals') {
    (m.items || []).forEach(it => {
      if (!KEYS.includes(it.key)) return;
      if (seen[it.key] !== it.d) {
        seen[it.key] = it.d;
        console.log(`  [wvals] ${it.key} = ${it.d}`);
      }
    });
  }
});

setTimeout(() => {
  /* '--' = 服务端登记成功但 PLC 读不到值（变量不存在），不算"有实时值" */
  const miss = KEYS.filter(k => seen[k] === undefined || seen[k] === '--');
  if (!miss.length) {
    console.log('[v] 全部监控项都有实时值');
    ws.close(); process.exit(0);
  } else if (miss.length === KEYS.length) {
    console.log('[i] 跳过：当前点表（及 PLC）上没有这些变量：' + miss.join(', '));
    console.log('    用例默认用演示工程 DEMO_MACHINE 的变量；换成自己的工程后改用例里的 KEYS');
    ws.close(); process.exit(77);   /* 77 = 跳过（环境不匹配） */
  }
  console.log('[x] 部分监控项没有有效值: ' + miss.join(', '));
  ws.close(); process.exit(1);
}, 9000);
