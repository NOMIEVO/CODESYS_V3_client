/* t-big-sym.js — 全量扫描「完整读」契约（默认必须一个都不漏）
   ══════════════════════════════════════════════════════════════════
   硬规则（2026-11-12 用户指定）：全量变量页必须完整刷新，
   任何符号都不能被排除在周期扫描之外。

   本用例锁两件事：
     ① 默认配置下 onDemand 必须为空 —— 每个符号都在周期扫描结果里
     ② 万一显式设了 MYX_BIG_SYM_BYTES>0（牺牲刷新换速度），被排除的符号
        仍必须能通过分页/展开按需读到，不能变成「看不到」

   用法: node tests/test-big-sym.js    （需验证台在 8095 运行） */
'use strict';
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';
const WS = BASE.replace(/^http/, 'ws');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('① /api/symbols：阈值与标记');
  const sym = await (await fetch(BASE + '/api/symbols')).json();
  const list = sym.symbols || [];
  const THR = Number(sym.bigSymBytes || 0);
  const od = list.filter(s => s.onDemand);
  ok(list.length > 0, `共 ${list.length} 个符号`);
  console.log('  当前阈值 MYX_BIG_SYM_BYTES = ' + THR + (THR ? '（已开启按需读）' : '（默认：完整读）'));

  console.log('② 完整读契约：默认配置下不能有任何符号被排除');
  if (THR === 0) {
    ok(od.length === 0, `onDemand = ${od.length}（默认必须为 0）`);
    const big = list.filter(s => s.bytes > 4096);
    console.log(`  大于 4KB 的符号 ${big.length} 个，全部参与轮询`
      + (big.length ? '：' + big.slice(0, 3).map(s => s.name + '(' + s.bytes + 'B)').join('、') : ''));
  } else {
    console.log('  [i] 已显式开启按需读，改为验证「被排除的仍可读」（见 ③）');
    ok(od.every(s => s.bytes > THR), `onDemand ${od.length} 个，字节数均 > 阈值 ${THR}`);
    ok(list.filter(s => s.bytes <= THR).every(s => !s.onDemand), '未超过阈值的符号一律不被排除');
  }

  console.log('③ 全量帧：统计与结果一致');
  const st = await new Promise((resolve, reject) => {
    const WebSocket = require('./_ws')   /* _ws.js 直接导出 ws 构造器 */;
    const ws = new WebSocket(WS + '/ws');
    const t = setTimeout(() => { try { ws.close(); } catch (_) {}; reject(new Error('12s 内没收到全量帧')); }, 12000);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch (_) { return; }
      if (m.t !== 'full') return;
      clearTimeout(t); ws.close(); resolve(m);
    });
    ws.on('error', () => {});
  });
  const scanned = (st.items || []);
  ok(scanned.length > 0, `本轮扫描 ${scanned.length} 个条目`);
  ok(typeof st.stats.onDemand === 'number', 'stats.onDemand 有值：' + st.stats.onDemand);
  if (THR === 0) {
    /* 容器节点（GVL 本身）不产生值，属正常；其余符号必须一个不缺 */
    const valued = list.filter(s => s.type && s.type !== 'CONTAINER');
    const missing = valued.filter(s => !scanned.some(i => i.f === s.full));
    ok(missing.length === 0, missing.length
      ? '有符号没被扫描：' + missing.slice(0, 3).map(s => s.name).join('、')
      : `每个符号都出现在本轮扫描结果里（${scanned.length}/${valued.length}，完整读成立）`);
    if (st.stats.blocks) {
      ok(st.stats.blocks >= 1, `本轮 ${st.stats.blocks} 块 / ${(st.stats.bytes / 1024).toFixed(1)}KB · `
        + `每块 ${(st.stats.ms / st.stats.blocks).toFixed(2)}ms`);
    }
  } else {
    const leaked = od.filter(s => scanned.some(i => i.f === s.full));
    ok(leaked.length === 0, '被排除的符号确实不在扫描结果里' + (leaked.length ? '：' + leaked.map(s => s.name).join('、') : ''));
    const target = od.find(s => s.elem && s.elem.writable) || od[0];
    const d = await (await fetch(`${BASE}/api/arrayvals?key=${encodeURIComponent(target.full)}&page=0&size=5`)).json();
    ok(d.ok === true, `被排除的符号仍可按需读取（${target.name}）`);
    if (target.elem) ok(d.total === target.elem.count, `元素总数 ${d.total} 与声明 ${target.elem.count} 一致`);
  }

  console.log('④ 最大符号也能取到值（完整读的核心目的）');
  const biggest = list.filter(s => s.bytes > 0).sort((a, b) => b.bytes - a.bytes)[0];
  if (biggest && scanned.some(i => i.f === biggest.full)) {
    const it = scanned.find(i => i.f === biggest.full);
    console.log('  ' + biggest.name + '（' + biggest.bytes + 'B）→ ' + it.d);
    /* '--' 表示 PLC 上没有这个变量（示例工程在真实 PLC 上就是如此），
       不算失败；关键是它确实参与了本轮扫描并回填了占位值。 */
    ok(typeof it.d === 'string' && it.d.length > 0, '最大符号在本轮扫描结果中：' + it.d);
  } else if (biggest && biggest.elem) {
    const d = await (await fetch(`${BASE}/api/arrayvals?key=${encodeURIComponent(biggest.full)}&page=0&size=1`)).json();
    ok(d.ok === true, '最大符号按需读可用（当前未参与轮询）');
  } else {
    console.log('  [i] 当前程序没有可比对的大符号');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await sleep(50);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  ✗ 异常：' + e.message); process.exit(1); });
