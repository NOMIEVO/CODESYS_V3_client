/* run-all.js — 一键自检（按可用环境自动选择能跑哪些用例）
   ─────────────────────────────────────────────────────────────
   用法：
     node tests/run-all.js              自动探测（推荐）
     node tests/run-all.js --offline    只跑纯离线用例（无需服务端）
     node tests/run-all.js --all        全跑（需服务端 + Chrome + PLC 在线）

   用例分级：
     [离线]  不需要任何外部依赖
     [服务]  需要验证台在 127.0.0.1:8095 运行
     [浏览器] 额外需要本机 Chrome（实测渲染几何）
     [真机]  额外需要 PLC 在线（会写 PLC，默认只做 no-op 回写）
   ───────────────────────────────────────────────────────────── */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';
const ARG = process.argv[2] || '';
const FORCE_OFFLINE = ARG === '--offline';
const FORCE_ALL = ARG === '--all';

/* 用例清单：level 决定运行条件 */
const CASES = [
  { file: 'test-union-learn.js', level: 'offline', desc: '类型导航 / UNION 布局学习（纯逻辑）' },
  { file: 'test-rate-window.js', level: 'server',  desc: '读成功率滑动窗口算法' },
  { file: 'test-key-parse.js',   level: 'server',  desc: '变量路径解析（数组元素 / 结构体成员）' },
  { file: 'test-member-tree.js', level: 'server',  desc: '结构体成员树接口（折叠结构）' },
  { file: 'test-full-write.js',  level: 'server',  desc: '全量页行内写入渲染与提交' },
  { file: 'test-app-switch.js',  level: 'server',  desc: '换程序/重导入后筛选重置、刷新指示、只看变化' },
  { file: 'test-elem-nav.js',    level: 'server',  desc: '结构体数组元素间切换（◀ ▶ / 下标）' },
  { file: 'test-array-page.js',  level: 'server',  desc: '大数组分页取值（一页 20 个 / 页码跳转）' },
  { file: 'test-index-smoke.js', level: 'server',  desc: '首页启动与广播无空引用' },
  { file: 'test-plc-config.js',  level: 'server',  desc: 'PLC 地址配置接口与校验' },
  { file: 'test-input-width.js', level: 'chrome',  desc: '输入框等长（无头 Chrome 实测几何）' },
  { file: 'inspect-state.js',    level: 'server',  desc: '链路状态与事件时间线（人工查看）' },
  { file: 'test-watch.js',       level: 'plc',     desc: '监控列表实时值（需 PLC 在线）' },
  { file: 'test-write.js',       level: 'plc',     desc: '写入闭环：no-op 回写 + 回读（需 PLC 在线）' },
];

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));

async function serverUp() {
  try {
    const r = await fetch(BASE + '/api/meta', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch (_) { return false; }
}

(async () => {
  const up = await serverUp();
  console.log('════════════════════════════════════════════════');
  console.log('  CODESYS V3 客户端 · 自检');
  console.log('  服务端 ' + (up ? '在线（' + BASE + '）' : '未启动'));
  console.log('  Chrome ' + (CHROME ? '可用' : '未找到'));
  console.log('════════════════════════════════════════════════\n');

  const can = (lv) => {
    if (FORCE_OFFLINE) return lv === 'offline';
    if (lv === 'offline') return true;
    if (lv === 'server') return up;
    if (lv === 'chrome') return up && !!CHROME;
    if (lv === 'plc') return FORCE_ALL && up;
    return false;
  };

  let pass = 0, fail = 0, skip = 0;
  const failed = [];

  for (const c of CASES) {
    const p = path.join(HERE, c.file);
    if (!fs.existsSync(p)) { console.log(`  – 跳过 ${c.file}（文件不存在）`); skip++; continue; }
    if (!can(c.level)) {
      console.log(`  – 跳过 ${c.file}（${c.level === 'plc' ? '需 --all 且 PLC 在线'
        : c.level === 'chrome' ? '需 Chrome + 服务端' : '需服务端'}）`);
      skip++;
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [p], { encoding: 'utf8', timeout: 180000 });
    const ms = Date.now() - t0;
    const out = (r.stdout || '') + (r.stderr || '');
    /* 77 = 用例主动跳过（变量不在当前 PLC / 工程与用例不匹配）——与「通过」区分开，
       否则"环境不匹配"会被误读成"这项功能已验证通过" */
    if (r.status === 77) {
      skip++;
      const why = out.split('\n').map(l => l.trim()).find(l => /跳过/.test(l)) || c.desc;
      console.log(`  – ${c.file.padEnd(22)} ${ms}ms  ${why.replace(/^\[i\]\s*/, '')}`);
      continue;
    }
    const okRun = r.status === 0;
    /* t-state / t-watch / t-writetest 是「查看型」：只要退出码 0 即算通过 */
    if (okRun) { pass++; console.log(`  ✓ ${c.file.padEnd(22)} ${ms}ms  ${c.desc}`); }
    else {
      fail++; failed.push(c.file);
      console.log(`  ✗ ${c.file.padEnd(22)} ${ms}ms  ${c.desc}`);
      const tail = out.trim().split('\n').filter(l => /✗|Error|错误|失败/.test(l)).slice(0, 3);
      tail.forEach(l => console.log('      ' + l.trim()));
    }
  }

  console.log('\n────────────────────────────────────────────────');
  console.log(`  通过 ${pass} · 失败 ${fail} · 跳过 ${skip}`);
  if (failed.length) console.log('  失败用例：' + failed.join(', '));
  process.exit(fail ? 1 : 0);
})();
