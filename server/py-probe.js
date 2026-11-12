/* py-probe.js — 探测本机是否有能跑的 Python 3（导入 XML 依赖 tools/gen_tags.py）
   ═══════════════════════════════════════════════════════════════
   为什么需要这层：Windows 上 `python` 这个名字有三种「看着能用、其实不能用」的形态——
     ① 根本没装 → 命令不存在；
     ② 装了但没勾 "Add python.exe to PATH" → 命令不存在；
     ③ %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe 只是应用商店的占位别名
        （0 字节重解析点），没有真 Python 时子进程直接以退出码 **9009**
        结束，且没有任何 stdout/stderr。
   Node 的 spawn 遇到 ① 会给 ENOENT（好识别），遇到 ③ 却像「脚本自己挂了」，
   用户只看到「gen_tags.py 退出码 9009」，无从下手。

   探测顺序：MYX_PYTHON（显式指定）→ python → py -3 → python3
   每个候选先用 where/command -v 定位，落点只有 WindowsApps 占位别名时直接跳过
   （执行它会弹出应用商店），再用 -c 打印版本确认真的能跑 Python 3.6+。

   用法：const { probePython, PY_NEED, PY_HELP } = require('./py-probe'); */

'use strict';
const { spawnSync } = require('child_process');

const PY_NEED = '3.6';
const PY_HELP = [
  '这不是 XML 的问题，也不是脚本的问题——是「本机 python 命令跑不起来」。',
  '（Windows 退出码 9009 = 命令未找到，说明 gen_tags.py 一行都没执行）',
  '',
  '常见原因：',
  '  ① 没装 Python；② 装了但安装时没勾 "Add python.exe to PATH"；',
  '  ③ 命令命中的是 Microsoft Store 的占位别名（在命令行敲 python 会弹出应用商店）。',
  '',
  '任选一种处理：',
  '  A. 装 Python 3.8+（python.org），安装首屏勾上 "Add python.exe to PATH"，然后重开验证台；',
  '  B. 已有 Python 但不在 PATH：设环境变量 MYX_PYTHON=你的 python.exe 全路径，重启验证台；',
  '  C. 自检：命令行执行 python -V，能打印 Python 3.x 且不弹商店即正常。',
].join('\n');

let CACHE = null;

function whichAll(cmd) {
  if (process.platform !== 'win32') {
    const r = spawnSync('sh', ['-c', `command -v ${cmd} 2>/dev/null || true`], { encoding: 'utf8' });
    return (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  const r = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [];
  return (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function probePython(force) {
  if (CACHE && !force) return CACHE;
  const candidates = [];
  const envPy = String(process.env.MYX_PYTHON || '').trim();
  if (envPy) candidates.push({ cmd: envPy, args: [], why: 'MYX_PYTHON' });
  candidates.push({ cmd: 'python', args: [], why: 'PATH' },
                  { cmd: 'py', args: ['-3'], why: 'py launcher' },
                  { cmd: 'python3', args: [], why: 'PATH' });

  const tried = [];
  for (const c of candidates) {
    const paths = whichAll(c.cmd);
    if (!paths.length) { tried.push(`${c.cmd}：不存在`); continue; }
    /* 只剩商店占位别名 → 不执行（执行会弹商店），直接判不可用 */
    const real = paths.filter(p => !/[\\/]WindowsApps[\\/]/i.test(p));
    if (!real.length) {
      tried.push(`${c.cmd}：只有 Microsoft Store 占位别名（${paths[0]}），未安装真 Python`);
      continue;
    }
    const r = spawnSync(c.cmd, [...c.args, '-c',
      'import sys;print("%d.%d"%sys.version_info[:2])'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (r.error) { tried.push(`${c.cmd}：${r.error.code || r.error.message}`); continue; }
    const ver = (r.stdout || '').trim();
    if (r.status !== 0) {
      tried.push(`${c.cmd}：退出码 ${r.status}${r.status === 9009 ? '（命令未找到 / 占位别名）' : ''}`);
      continue;
    }
    if (!/^\d+\.\d+$/.test(ver)) { tried.push(`${c.cmd}：版本输出异常「${ver}」`); continue; }
    if (Number(ver.split('.')[0]) < Number(PY_NEED.split('.')[0])) {
      tried.push(`${c.cmd}：Python ${ver}（需要 ${PY_NEED}+）`);
      continue;
    }
    CACHE = { ok: true, cmd: c.cmd, args: c.args, version: ver, exe: real[0], tried };
    return CACHE;
  }
  CACHE = { ok: false, tried, error: '找不到可用的 Python ' + PY_NEED + '+\n\n' + PY_HELP };
  return CACHE;
}

module.exports = { probePython, whichAll, PY_NEED, PY_HELP };
