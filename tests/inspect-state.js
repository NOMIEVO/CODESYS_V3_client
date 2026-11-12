/* inspect-state.js — 查看链路状态与最近事件（人工阅读，不做断言）
   ─────────────────────────────────────────────────────────────
   打印 state / lastError / 统计 / 最近 12 条事件时间线。
   用来回答「现在到底通不通、刚才断过没有」这类问题。
   前置：验证台已启动   用法：node tests/inspect-state.js
*/
const WebSocket = require('./_ws');
const WS = (process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095').replace(/^http/, 'ws') + '/ws';
const ws = new WebSocket(WS);

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw); } catch (_) { return; }
  if (m.t !== 'state') return;
  console.log('state      =', m.state);
  console.log('lastError  =', m.lastError);
  console.log('step       =', m.step);
  console.log('stats      = reads', m.stats.reads, 'ok', m.stats.ok, 'fail', m.stats.fail);
  console.log('events(最近12)：');
  (m.events || []).forEach(e => {
    console.log('  ', new Date(e.ts).toLocaleTimeString(), e.kind, e.text,
      e.from !== undefined ? `(${e.from}→${e.to})` : '');
  });
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('✗ 无 state 消息'); process.exit(1); }, 8000);
