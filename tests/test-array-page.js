/* 单测：大数组分页取值 /api/arrayvals（全量页「分页」按钮的数据来源）
   用法: node tools/t-array-page.js     （需验证台在 8095 运行）
   覆盖：分页元信息、from/to 边界、页大小夹取、越界页夹到末页、元素解码、错误路径。
   说明：不依赖浏览器。要求当前程序里至少有一个标量元素数组。 */
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const get = async (qs) => {
  const r = await fetch(BASE + '/api/arrayvals?' + qs);
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const syms = (await (await fetch(BASE + '/api/symbols')).json()).symbols || [];
  const arrs = syms.filter(s => s.elem && s.elem.writable);
  const arr = arrs.sort((a, b) => b.elem.count - a.elem.count)[0];
  ok(!!arr, `找到标量元素数组：${arr && arr.name}（${arr && arr.elem.count} 个元素）`);
  if (!arr) { console.log('\n（当前程序没有可测数组，跳过）'); process.exit(0); }

  const key = arr.full.replace(/^Application\./, '');
  const total = arr.elem.count;
  const wantPages = Math.ceil(total / 20);

  console.log('\n① 分页元信息（每页 20）');
  const p0 = await get(`key=${encodeURIComponent(key)}&page=0&size=20`);
  ok(p0.status === 200 && p0.body.ok === true, 'HTTP 200 / ok=true');
  ok(p0.body.total === total, `total=${p0.body.total} = 元素数 ${total}`);
  ok(p0.body.pages === wantPages, `pages=${p0.body.pages} = ceil(${total}/20)=${wantPages}`);
  ok(p0.body.size === 20, 'size=20');
  ok(p0.body.from === 0 && p0.body.to === 19, `首页范围 0..19（实际 ${p0.body.from}..${p0.body.to}）`);
  ok(p0.body.values.length === 20, `返回 20 个值（实际 ${p0.body.values.length}）`);
  ok(p0.body.values[0].i === 0, '首个元素下标 = 0');

  console.log('\n② 末页（可能不满 20）');
  const plast = await get(`key=${encodeURIComponent(key)}&page=${wantPages - 1}&size=20`);
  const rest = total - (wantPages - 1) * 20;
  ok(plast.body.page === wantPages - 1, `page=${plast.body.page}`);
  ok(plast.body.from === (wantPages - 1) * 20, `from=${plast.body.from}`);
  ok(plast.body.to === total - 1, `to=${plast.body.to}（末元素）`);
  ok(plast.body.values.length === rest,
    `末页 ${plast.body.values.length} 个 = ${rest}（${total} - ${(wantPages - 1) * 20}）`);

  console.log('\n③ 越界页夹取（不报错，落到最近的有效页）');
  const hi = await get(`key=${encodeURIComponent(key)}&page=99999&size=20`);
  ok(hi.body.page === wantPages - 1, `超大页码 → 末页 ${hi.body.page}`);
  const neg = await get(`key=${encodeURIComponent(key)}&page=-5&size=20`);
  ok(neg.body.page === 0, `负页码 → 首页 ${neg.body.page}`);

  console.log('\n④ 页大小夹取（1..200）');
  const s1 = await get(`key=${encodeURIComponent(key)}&page=0&size=1`);
  ok(s1.body.size === 1 && s1.body.values.length === 1, 'size=1 → 1 个值');
  ok(s1.body.pages === total, `size=1 时页数 = ${s1.body.pages} = 元素数`);
  const s200 = await get(`key=${encodeURIComponent(key)}&page=0&size=200`);
  ok(s200.body.size === 200, 'size=200 允许');
  const s999 = await get(`key=${encodeURIComponent(key)}&page=0&size=999`);
  ok(s999.body.size === 200, `size=999 被夹到 200（实际 ${s999.body.size}）`);

  console.log('\n⑤ 元素解码');
  const vals = p0.body.values;
  ok(vals.every(v => typeof v.d === 'string' && v.d.length), '每个值都是非空字符串');
  const base = arr.elem.base;
  if (base === 'BOOL') {
    ok(vals.every(v => v.d === 'TRUE' || v.d === 'FALSE' || v.d === '--'),
      'BOOL 元素解码为 TRUE/FALSE');
  } else if (['REAL', 'LREAL', 'INT', 'DINT', 'UINT', 'UDINT'].includes(base)) {
    ok(vals.every(v => v.d === '--' || /^-?\d+(\.\d+)?$/.test(v.d)),
      `${base} 元素解码为数字`);
  } else {
    console.log(`  – 基类型 ${base}：跳过数值格式断言`);
  }

  console.log('\n⑥ 错误路径');
  const scalar = syms.find(s => !s.elem && !/^(ARRAY|D_|T_)/.test(s.type));
  if (scalar) {
    const r = await get(`key=${encodeURIComponent(scalar.full.replace(/^Application\./, ''))}&page=0`);
    ok(r.status === 400 && r.body.ok === false, `标量符号被拒：${r.body && r.body.error}`);
  }
  const bad = await get('key=NO_SUCH_VAR_XYZ&page=0');
  ok(bad.status === 400 && bad.body.ok === false, `不存在的符号被拒：${bad.body && bad.body.error}`);
  const noKey = await get('page=0');
  ok(noKey.status === 400, '缺 key 被拒');

  console.log('\n⑦ writable 标记（决定弹窗是否给写入控件）');
  ok(p0.body.writable === true, `可写数组 writable=true（${arr.name}）`);
  const ro = syms.find(x => x.elem && x.elem.writable === false);
  if (ro) {
    const r = await get(`key=${encodeURIComponent(ro.full.replace(/^Application\./, ''))}&page=0`);
    ok(r.body.writable === false, `结构体元素数组 writable=false（${ro.name}）`);
  } else {
    console.log('  – 跳过：没有结构体元素数组可对照');
  }

  console.log('\n⑧ 连续翻页不额外读 PLC（缓存命中）');
  const t0 = Date.now();
  for (let p = 0; p < 5; p++) await get(`key=${encodeURIComponent(key)}&page=${p}&size=20`);
  const ms = Date.now() - t0;
  ok(ms < 2000, `连翻 5 页耗时 ${ms}ms（缓存命中应远低于逐次读 PLC）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
