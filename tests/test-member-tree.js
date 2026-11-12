/* test-member-tree.js — 结构体成员树接口（/api/members）
   ─────────────────────────────────────────────────────────────
   断言返回的是「可折叠树」而非平铺列表：
     叶子 { rel, name, type, leaf:true } / 组 { kind:'struct'|'array', count, children }
     rel 为相对根节点的完整后缀，前端拼根 key 得到完整可写路径（不得出现重复前缀）
   前置：验证台已启动   用法：node tests/test-member-tree.js
*/
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

const get = async (u) => (await fetch(BASE + u)).json();

/* 遍历树收集统计 */
function walk(nodes, fn, depth = 0) {
  (nodes || []).forEach(n => {
    fn(n, depth);
    if (!n.leaf) walk(n.children, fn, depth + 1);
  });
}

(async () => {
  /* 前置：本用例围绕演示工程 DEMO_MACHINE 的类型结构。当前程序若已换成
     自己的工程（变量名不同），打印「跳过」并正常退出——环境不匹配不是缺陷。 */
  {
    const need = ['GVL_AXIS.aAxisCtl'];
    const meta = await (await fetch(BASE + '/api/meta')).json();
    const ss = (await (await fetch(BASE + '/api/symbols')).json()).symbols || [];
    const have = new Set(ss.map(s => s.full.replace(/^Application\./, '').split('[')[0]));
    const miss = need.filter(n => !have.has(n));
    if (miss.length) {
      console.log('[i] 跳过：当前程序 ' + (meta.app || '?') + ' 不含 ' + miss.join(', '));
      console.log('    本用例基于演示工程 DEMO_MACHINE；换自己的工程后按 README 第 5 节改用例里的变量名');
      process.exit(77);   /* 77 = 跳过（环境不匹配） */
    }
  }

  console.log('① aAxisCtl[3] 成员树');
  const d = await get('/api/members?base=GVL_AXIS.aAxisCtl&path=%5B3%5D');
  ok(d.ok === true, 'ok=true');
  ok(Array.isArray(d.nodes), '返回 nodes 数组（不是 members 平铺）');
  ok(d.members === undefined, '不再返回 members 平铺字段');

  const top = d.nodes.length;
  let leaves = 0, groups = 0, maxDepth = 0;
  walk(d.nodes, (n, dep) => {
    maxDepth = Math.max(maxDepth, dep);
    if (n.leaf) leaves++; else groups++;
  });
  console.log(`   顶层 ${top} 节点 · 总节点 ${leaves + groups}（组 ${groups} / 叶 ${leafs(leaves)}）· 最大深度 ${maxDepth}`);
  ok(top < leaves, `顶层 ${top} < 全部叶子 ${leaves} → 确实是折叠结构`);
  ok(groups >= 2, `存在 ${groups} 个可折叠组（演示工程：tState 子结构 + aAbsSel 子数组）`);

  console.log('② 组节点结构');
  const tState = d.nodes.find(n => n.name === 'tState');
  ok(!!tState, 'tState 组存在');
  ok(tState && tState.leaf === false && tState.kind === 'struct', 'tState 是 struct 组');
  ok(tState && tState.children.length >= 8,
    `tState 展开出 ${tState && tState.children.length} 个子节点（演示工程 ST_AXIS_STATE 共 9 项）`);
  ok(tState && tState.children.every(c => c.leaf && typeof c.rel === 'string'), '子节点都是带 rel 的叶子');

  console.log('③ 组内数组（aAbsSel）');
  const arr = d.nodes.find(n => n.name === 'aAbsSel');
  ok(!!arr && arr.kind === 'array', 'aAbsSel 是 array 组');
  ok(arr && arr.children.length === 3, `含 3 个元素（实际 ${arr && arr.children.length}）`);
  ok(arr && arr.children[0].rel === 'aAbsSel[0]', 'rel 相对根节点：' + (arr && arr.children[0].rel));

  console.log('④ rel 拼根 key → 可写路径（且不重复前缀）');
  const join = (root, rel) => (!rel ? root : (rel.startsWith('[') ? root + rel : root + '.' + rel));
  const root = 'GVL_AXIS.aAxisCtl[3]';
  const k1 = join(root, tState.children[0].rel);
  ok(k1 === 'GVL_AXIS.aAxisCtl[3].tState.bValid', '拼出：' + k1);
  ok(!/tState\.tState/.test(k1), '没有重复前缀');
  const k2 = join(root, arr.children[1].rel);
  ok(k2 === 'GVL_AXIS.aAxisCtl[3].aAbsSel[1]', '拼出：' + k2);

  console.log('⑤ UNION 结构体（aCell 内 uResult）');
  const s = await get('/api/members?base=GVL_STATION.aCell&path=%5B1%5D');
  ok(s.ok === true, 'ok=true');
  const ur = (s.nodes || []).find(n => n.name === 'uResult');
  ok(!!ur && ur.leaf === false, 'uResult 折叠成组（UNION 内层不再平铺）');
  ok(ur && ur.children.length === 2, `UNION 两个成员并列（${ur && ur.children.length} 项）`);
  const k3 = join('GVL_STATION.aCell[1]', ur.children[1].rel);
  ok(k3 === 'GVL_STATION.aCell[1].uResult.di', '拼出：' + k3);
  ok(!/uResult\.uResult/.test(k3), '没有重复前缀');

  console.log('⑥ 节点数上限保护（取最大的结构体数组元素）');
  const big = await get('/api/members?base=GVL_AXIS.aAxisCtl&path=%5B0%5D');
  let cnt = 0; walk(big.nodes, () => cnt++);
  ok(cnt > 0 && cnt <= 600, `aAxisCtl[0] 节点数 ${cnt} ≤ 600（不会撑爆弹窗）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

function leafs(n) { return n; }
