/* test-py-probe.js — python 探测逻辑单测（纯离线，不需要验证台/PLC/Chrome）
   ─────────────────────────────────────────────────────────────
   为什么单独测它：XML 导入靠 tools/gen_tags.py，而 Windows 上 `python` 这个名字
   有「看着能用其实不能用」的三种形态（没装 / 没加 PATH / 只是应用商店占位别名）。
   最后一种的子进程退出码是 **9009**，且没有任何输出——用户只会看到
   「gen_tags.py 退出码 9009」，看不出是环境问题。本用例锁住探测逻辑与提示文案。

   用法: node tests/test-py-probe.js */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const PROBE = path.join(__dirname, '..', 'server', 'py-probe.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

/* 在指定 PATH 下跑探测（子进程隔离，避免污染本进程环境） */
function probeWith(env) {
  const code = `process.stdout.write(JSON.stringify(require(${JSON.stringify(PROBE)}).probePython(true)))`;
  const r = spawnSync(process.execPath, ['-e', code],
    { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  try { return JSON.parse(r.stdout); }
  catch (e) { return { parseError: e.message, raw: (r.stdout || '') + (r.stderr || '') }; }
}

/* 造一个只含 where.exe 的干净 PATH（用于"完全找不到 python"的场景） */
function makeCleanBin() {
  if (process.platform !== 'win32') return '/nonexistent-dir-for-py-probe';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pybin-'));
  const whereExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  try { fs.copyFileSync(whereExe, path.join(dir, 'where.exe')); } catch (_) { return null; }
  return dir;
}

(function () {
  console.log('① 当前环境：能探到一个 Python 3（本机若无 python，此项会失败——正是要提示的信息）');
  const a = probeWith({ MYX_PYTHON: '' });
  if (a.ok) {
    ok(true, `探测通过 → ${a.cmd} ${a.version}（${a.exe}）`);
    ok(/^\d+\.\d+$/.test(a.version), '版本号可解析 ' + a.version);
    ok(!/WindowsApps/i.test(a.exe), 'exe 不是 Microsoft Store 占位别名');
  } else {
    console.log('  [i] 本机未装 Python，跳过"通过"断言（导入功能不可用属预期）：');
    (a.tried || []).forEach(t => console.log('      · ' + t));
  }

  console.log('② MYX_PYTHON 指错：应回退到 PATH 里的解释器，而不是直接判失败');
  const b = probeWith({ MYX_PYTHON: path.join(os.tmpdir(), 'no-such-python.exe') });
  ok(Array.isArray(b.tried) && b.tried.some(t => /no-such-python\.exe/.test(t)),
    '探测痕迹记录了失败的 MYX_PYTHON：' + (b.tried || []).find(t => /no-such/.test(t)));

  console.log('③ 完全找不到 python：判失败并给出可操作文案');
  const cleanBin = makeCleanBin();
  const c = cleanBin ? probeWith({ MYX_PYTHON: '', PATH: cleanBin }) : { ok: true, cmd: '(skip)' };
  if (c.ok) {
    console.log('  [i] 无法构造干净 PATH，跳过该场景');
  } else {
    ok(c.ok === false, '判定为不可用');
    ok(/找不到可用的 Python 3\.6\+/.test(c.error || ''), '错误标题清晰');
    ok(/9009/.test(c.error || ''), '解释了 9009 = 命令未找到（用户看到的就是它）');
    ok(/Add python\.exe to PATH/i.test(c.error || ''), '给出安装时勾选 PATH 的指引');
    ok(/MYX_PYTHON/.test(c.error || ''), '给出 MYX_PYTHON 兜底办法');
    ok(Array.isArray(c.tried) && c.tried.length >= 2, '逐条记录候选失败原因：' + JSON.stringify(c.tried));
  }

  console.log('④ 只有 Microsoft Store 占位别名：识别出来、且不去执行（避免弹商店）');
  if (!cleanBin) {
    console.log('  [i] 跳过（无干净 PATH）');
  } else {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pyfake-'));
    const fakeAlias = path.join(fakeRoot, 'WindowsApps');
    fs.mkdirSync(fakeAlias, { recursive: true });
    fs.writeFileSync(path.join(fakeAlias, 'python.exe'), '');   /* 0 字节占位，同真实别名 */
    const d = probeWith({ MYX_PYTHON: '', PATH: fakeAlias + ';' + cleanBin });
    if (d.ok) {
      console.log('  [i] 该环境仍找到可用 python，跳过（' + d.cmd + '）');
    } else {
      const hit = (d.tried || []).find(t => /占位别名/.test(t));
      ok(!!hit, '识别为占位别名并跳过执行：' + hit);
      ok(/WindowsApps/.test(hit || ''), '指出占位路径，便于用户核对');
      ok(!(d.tried || []).some(t => /^python：退出码 9009/.test(t)), '没有真的执行占位别名');
    }
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(cleanBin, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('⑤ 文案可读性（前端原样展示给用户）');
  const help = require(PROBE).PY_HELP;
  ok(help.split('\n').length >= 6, '多行结构化提示 ' + help.split('\n').length + ' 行');
  ok(!/undefined|\[object Object\]|Error:/.test(help), '无原始堆栈 / undefined 泄漏');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
