/* _ws.js — 统一的 ws 依赖入口（两种安装位置都能找到）
   ─────────────────────────────────────────────────────────────
   依赖可能出现在两处，取决于获取方式：
     拷贝交付   → server/node_modules/ws（随包附带，离线可用）
     git clone  → 根目录 npm install 后位于 node_modules/ws
   这里按顺序尝试，找不到时给出明确的修复命令，而不是抛裸 MODULE_NOT_FOUND。 */
'use strict';

function load() {
  const tries = ['../server/node_modules/ws', 'ws'];
  const errs = [];
  for (const spec of tries) {
    try { return require(spec); } catch (e) { errs.push(e.message.split('\n')[0]); }
  }
  console.error('[x] 找不到依赖 ws（WebSocket）。请执行安装：');
  console.error('      npm install                （在项目根目录，读取 package.json）');
  console.error('    已尝试过的路径：' + tries.join(' , '));
  console.error('    ' + errs.join('\n    '));
  process.exit(2);
}

module.exports = load();
