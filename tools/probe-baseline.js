/* probe-baseline.js — 通讯成本基准：把「慢」拆成【每次请求的固定开销】与【每个数据块的开销】
   ═══════════════════════════════════════════════════════════════════════════
   为什么需要它：同一套客户端，接 KSC-SA40 硬件 PLC 一轮扫描几十毫秒，
   接 Windows 上的 CODESYS Control RTE 却要几百毫秒。差别不在业务代码里，
   而在这两个成本系数上：

       单轮耗时 ≈ 请求次数 × R  +  响应块数 × B

     R = 一次「请求→响应」往返的固定开销（含协议栈、Runtime 调度、解析）
     B = 响应被按 448B 切块后，每多一块的额外开销（传输 + ACK 往返）

   而本协议是**同步逐块 ACK**（不回 ACK 会被判通道错误 8400），
   所以 B 直接等于一次网络往返的代价。R 与 B 一旦测出，任何数据量下的
   耗时都能算出来，两台机器一对比就知道差在哪一项。

   测量设计（三组已知量，解两个未知数 + 一组校验）：
     ① 1 个列表 / 1 块左右   ≈ R + 1B
     ② 1 个列表 / 3 块       ≈ R + 3B
     ③ 3 个列表 / 各 1 块    ≈ 3R + 3B      ← 单独验证 R 是否随请求数线性增长
   由 ①② 解出 R、B；用 ③ 做交叉校验（偏差大说明 PLC 在排队或有抖动）。

   用法：
     node tools/probe-baseline.js                       # 自动选程序
     node tools/probe-baseline.js 192.168.1.92          # 指定 PLC
     node tools/probe-baseline.js 10.0.0.5 MYX_TBJ_XS
     node tools/probe-baseline.js --json                # 只打 JSON（便于两台机器对比）

   产出：
     屏幕：人读表格 + 判定
     out/baseline-<host>.json：机器读，两台机器各存一份后并排看

   只读，不写入任何变量。跑之前请停掉验证台（PLC 只服务单条连接）。
   ─────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const { CodesysV3Client } = require('../server/codesys-v3-client');

const argv = process.argv.slice(2);
const JSON_ONLY = argv.includes('--json');
const pos = argv.filter(a => !a.startsWith('-'));

const ROOT = path.join(__dirname, '..');
const HOST = pos[0] || process.env.MYX_HOST || '192.168.1.92';
const PORT = Number(process.env.MYX_PLC_PORT || 11740);
const APP = pos[1] || process.env.MYX_APP || autoApp();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function autoApp() {
  try {
    const dir = path.join(ROOT, 'out');
    const files = fs.readdirSync(dir)
      .filter(f => fs.existsSync(path.join(dir, f, 'tag_table.json')));
    if (!files.length) return null;
    files.sort((a, b) => fs.statSync(path.join(dir, b, 'tag_table.json')).mtimeMs
      - fs.statSync(path.join(dir, a, 'tag_table.json')).mtimeMs);
    return files[0];
  } catch (_) { return null; }
}

function stat(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length, min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1],
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length * 10) / 10,
  };
}

function open0() {
  const c = new CodesysV3Client(HOST, PORT, { allowWrite: false });
  return c;
}
async function handshake(c) {
  await c.nsQuery();
  await c.connect();
  await c.nsQueryOnMain();                     /* vendor 拓扑：主连接首包必须 NS */
  await c.openChannel();
  try { await c.sessionCreate(); } catch (_) { /* 老固件无会话创建 */ }
  await c.login();
  await c.getRoot();
  return c;
}
function close(c) { try { c.sock && c.sock.end(); } catch (_) {} }

/* 读表：从 tag_table.json 里挑可用符号（避开 PLC 上不存在/不可整读的） */
function catalogue(app) {
  const f = path.join(ROOT, 'out', app, 'tag_table.json');
  if (!fs.existsSync(f)) return null;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const BS = { BOOL: 1, SINT: 1, USINT: 1, BYTE: 1, INT: 2, UINT: 2, WORD: 2,
    DINT: 4, UDINT: 4, DWORD: 4, REAL: 4, LINT: 8, ULINT: 8, LREAL: 8 };
  const rows = [];
  for (const s of d.symbols || []) {
    if (!s.symbolPath || !s.iecType) continue;   /* 容器节点没有值 */
    const full = s.symbolPath.startsWith('Application.') ? s.symbolPath : 'Application.' + s.symbolPath;
    const arr = String(s.iecType).match(/^ARRAY\s*\[\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\]\s*OF\s+(\w+)/i);
    const bytes = arr ? ((+arr[2] - +arr[1] + 1) * (BS[arr[3].toUpperCase()] || 4)) : (s.bytes || 4);
    rows.push({ full, bytes, isArray: !!arr });
  }
  return rows;
}

/* 单次测量：登记 names 成 1 个列表，重复 times 次 ExecuteRead */
async function measure(names, times) {
  const c = await handshake(open0());
  const r = { ms: [], blocks: 0, bytes: 0, err: null };
  try {
    const h = await c.prepareRead(names);
    c.readListHandle = h;
    for (let i = 0; i < times; i++) {
      const t = Date.now();
      await c.executeRead();
      r.ms.push(Date.now() - t);
      r.blocks = c.lastBlocks || 1;
      r.bytes = (c.lastReadPayload || { length: 0 }).length;
    }
  } catch (e) { r.err = e.message.slice(0, 90); }
  finally { close(c); }
  return r;
}

/* 多次请求：登记 K 个列表，各读一次，统计「一轮」耗时与总块数 */
async function measureMulti(groups, rounds) {
  const c = await handshake(open0());
  const r = { rounds: [], blocks: 0, bytes: 0, lists: 0, err: null };
  try {
    const hs = [];
    for (const g of groups) {
      hs.push(await c.prepareRead(g));
      r.lists++;
      await sleep(30);                            /* 批量登记过快会触发 8400 配额 */
    }
    for (let k = 0; k < rounds; k++) {
      const t = Date.now();
      let blocks = 0, bytes = 0;
      for (const h of hs) {
        c.readListHandle = h;
        await c.executeRead();
        blocks += c.lastBlocks || 1;
        bytes += (c.lastReadPayload || { length: 0 }).length;
      }
      r.rounds.push(Date.now() - t);
      r.blocks = blocks; r.bytes = bytes;
    }
  } catch (e) { r.err = e.message.slice(0, 90); }
  finally { close(c); }
  return r;
}

(async () => {
  const R = { host: HOST, port: PORT, app: APP, at: new Date().toISOString(),
    platform: process.platform, node: process.version, os: process.title };

  if (!JSON_ONLY) {
    console.log('════════════════════════════════════════════════');
    console.log('  通讯成本基准（只读）');
    console.log('  PLC  ' + HOST + ':' + PORT + '   程序 ' + (APP || '(未指定)'));
    console.log('════════════════════════════════════════════════');
  }

  const cat = APP ? catalogue(APP) : null;
  if (!cat) { console.error('找不到 out/' + APP + '/tag_table.json'); process.exit(1); }

  /* 候选：小块（3 块量级）、1 块量级（标量）、大块 */
  const arrays = cat.filter(x => x.isArray).sort((a, b) => a.bytes - b.bytes);
  const scalars = cat.filter(x => !x.isArray);
  const pick3 = arrays.find(x => x.bytes >= 900 && x.bytes <= 2200) || arrays[0];
  const pick1 = scalars[0];
  const pickBig = arrays.filter(x => x.bytes >= 6000).pop() || null;

  if (!pick3 || !pick1) { console.error('点表里没有可用的数组/标量，无法测量'); process.exit(1); }

  /* ① 1 列表 1 块（标量） */
  let one = { ms: [], blocks: 1 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const m = await measure([pick1.full], 12);
    await sleep(600);
    if (!m.err && m.blocks <= 1) { one = m; break; }
    if (!m.err) { one = m; break; }               /* 允许标量占 1 块以上 */
    if (!JSON_ONLY) console.log('   · 1 块基准重试（' + m.err + '）');
  }
  if (!one.ms.length) { console.error('① 基准读失败，PLC 可能离线或被占用'); process.exit(1); }
  R.oneBlock = { name: pick1.full, blocks: one.blocks, bytes: one.bytes, ...stat(one.ms) };
  if (!JSON_ONLY) {
    console.log('① 1 个列表 / ' + one.blocks + ' 块（' + pick1.full.split('.').pop() + '）　'
      + R.oneBlock.med + 'ms（' + R.oneBlock.min + '~' + R.oneBlock.max + '，n=' + R.oneBlock.n + '）');
  }

  /* ② 1 列表 3 块（小数组） */
  const two = await measure([pick3.full], 12);
  await sleep(600);
  R.threeBlock = two.err ? { err: two.err }
    : { name: pick3.full, blocks: two.blocks, bytes: two.bytes, ...stat(two.ms) };
  if (!JSON_ONLY) {
    console.log('② 1 个列表 / ' + (two.blocks || '?') + ' 块（' + pick3.full.split('.').pop()
      + '，' + (two.bytes / 1024).toFixed(1) + 'KB）　'
      + (two.err ? '✗ ' + two.err : R.threeBlock.med + 'ms'));
  }

  /* ③ 3 个列表 / 各 1 块 —— 单独验证「每次请求的固定开销」 */
  const three1 = await measureMulti([[pick1.full], [pick1.full], [pick1.full]], 8);
  await sleep(600);
  R.threeLists = three1.err ? { err: three1.err }
    : { lists: three1.lists, blocks: three1.blocks, ...stat(three1.rounds) };
  if (!JSON_ONLY) {
    console.log('③ 3 个列表 / 共 ' + (three1.blocks || '?') + ' 块（同一标量登记 3 次）　'
      + (three1.err ? '✗ ' + three1.err : R.threeLists.med + 'ms'));
  }

  /* ④ 全部符号一轮（贴近真实使用） */
  let full = null;
  if (cat.length) {
    const budget = 460;
    const entry = (f) => { const n = Buffer.byteLength(f) + 1; return (n + 4 + 3) & ~3; };
    const groups = []; let cur = [], sz = 24;
    for (const x of cat) {
      const e = entry(x.full);
      if (sz + e > budget && cur.length) { groups.push(cur); cur = []; sz = 24; }
      cur.push(x.full); sz += e;
    }
    if (cur.length) groups.push(cur);
    const f = await measureMulti(groups, 3);
    await sleep(600);
    full = f.err ? { lists: groups.length, err: f.err }
      : { lists: f.lists, blocks: f.blocks, bytes: f.bytes, ...stat(f.rounds) };
    R.full = full;
    if (!JSON_ONLY) {
      console.log('④ 全量一轮（' + (full.lists || '?') + ' 列表 / ' + (full.blocks || '?')
        + ' 块 / ' + ((full.bytes || 0) / 1024).toFixed(1) + 'KB）　'
        + (full.err ? '✗ ' + full.err : full.med + 'ms'));
    }
  }

  /* ⑤ 拟合 R 与 B： (1块) → R+1B ，(3块) → R+3B */
  const s1 = R.oneBlock, s2 = R.threeBlock;
  if (!s2 || s2.err || !s1) {
    if (!JSON_ONLY) console.log('\n⑤ 无法拟合：缺少 3 块量级的样本');
  } else if (s2.blocks <= s1.blocks) {
    if (!JSON_ONLY) console.log('\n⑤ 无法拟合：两个样本块数相同（' + s1.blocks + '/' + s2.blocks + '）');
  } else {
    const db = s2.blocks - s1.blocks;
    const B = (s2.med - s1.med) / db;
    const Rfix = s1.med - B * s1.blocks;
    R.fit = {
      requestMs: Math.round(Rfix * 100) / 100,
      blockMs: Math.round(B * 100) / 100,
    };
    /* 交叉校验：3 个列表各 1 块应为 3R + 3B */
    if (R.threeLists && !R.threeLists.err) {
      const pred = 3 * Rfix + R.threeLists.blocks * B;
      R.fit.crossCheck = {
        predicted: Math.round(pred), actual: R.threeLists.med,
        delta: Math.round(R.threeLists.med - pred),
      };
    }
    if (R.full && !R.full.err) {
      R.fit.predictFull = Math.round(Rfix * R.full.lists + B * R.full.blocks);
      R.fit.predictVsActual = R.full.med - R.fit.predictFull;
    }
    if (!JSON_ONLY) {
      console.log('\n⑤ 拟合　耗时 ≈ ' + R.fit.requestMs + 'ms × 请求数 + ' + R.fit.blockMs + 'ms × 块数');
      if (R.fit.crossCheck) {
        const c = R.fit.crossCheck;
        console.log('   交叉校验（3 列表各 1 块）：预测 ' + c.predicted + 'ms，实测 ' + c.actual + 'ms，差 ' + c.delta + 'ms');
      }
      if (R.fit.predictFull != null) {
        console.log('   全量预测 ' + R.fit.predictFull + 'ms，实测 ' + R.full.med + 'ms，差 ' + R.fit.predictVsActual + 'ms');
      }
    }
  }

  /* ⑥ 判定：给出可执行的下一步 */
  if (R.fit) {
    const req = R.fit.requestMs, blk = R.fit.blockMs;
    R.verdict = [];
    if (req > 3) R.verdict.push({ key: 'request', msg: '每次请求固定开销 ' + req + 'ms 偏高 → 瓶颈在「请求-响应」次数（Runtime 调度 / TCP 栈延迟 / 过滤驱动），减少列表数收益最大' });
    if (blk > 3) R.verdict.push({ key: 'block', msg: '每块 ' + blk + 'ms 偏高 → 瓶颈在「每块往返」（网卡中断节流 / 节能 / 大包处理），换直连与关节能收益最大' });
    if (!R.verdict.length) R.verdict.push({ key: 'ok', msg: '两项均 <3ms，属正常；耗时应仅由 请求数 与 块数 决定' });
    if (!JSON_ONLY) {
      console.log('\n⑥ 判定');
      R.verdict.forEach((v, i) => console.log('   ' + (i + 1) + '. ' + v.msg));
      console.log('\n   对比方式：SA40 与工控机各跑一次，把 out/baseline-<ip>.json 并排看 fit 两项；'
        + '\n   requestMs 差 → Runtime 调度；blockMs 差 → 网络栈/网卡。');
    }
  }

  const outFile = path.join(ROOT, 'out', 'baseline-' + HOST.replace(/[^\w.-]/g, '_') + '.json');
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(R, null, 1));
    if (JSON_ONLY) console.log(JSON.stringify(R, null, 1));
    else console.log('\n[ok] 已保存 ' + path.relative(ROOT, outFile));
  } catch (e) { console.error('保存失败：' + e.message); }

  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error('✗ 基准失败：' + e.message); process.exit(1); });
