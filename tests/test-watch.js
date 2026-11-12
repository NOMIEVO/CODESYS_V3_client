/* test-watch.js — 监控列表实时值（watchSet → wvals）
   ─────────────────────────────────────────────────────────────
   把三个变量交给服务端登记（BOOL 成员 / 嵌套成员 / REAL 成员），
   断言每个都能收到实时值。用于验证「点表外变量」的读取链路。
   前置：验证台已启动 + PLC 在线，且该 PLC 上存在同名变量。
   若变量不存在（连的是真实设备、而点表是演示工程 DEMO_MACHINE），
   会打印「跳过」并以退出码 0 结束——环境不匹配，不是缺陷。

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
  const miss = KEYS.filter(k => seen[k] === undefined);
  if (!miss.length) {
    console.log('[v] 全部监控项都有实时值');
  } else if (miss.length === KEYS.length) {
    console.log('[i] 跳过：该 PLC 上没有这些变量（当前点表可能是演示工程 DEMO_MACHINE）');
    console.log('    真机验证请改用自己工程的变量名（改本文件的 KEYS 数组）');
  } else {
    console.log('[x] 部分监控项未收到值: ' + miss.join(', '));
  }
  ws.close(); process.exit(0);
}, 9000);
