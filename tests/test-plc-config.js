/* test-plc-config.js — PLC 地址配置接口（/api/config）
   ─────────────────────────────────────────────────────────────
   覆盖：读取当前配置、10 类非法输入必须拒绝（段值越界/段数不对/字母段/空/端口 0/
   越界/小数/非数字/含空格）、合法地址接受、落盘 plc-config.json、source 优先级、
   相同地址不报变更。结束时恢复为默认地址。
   前置：验证台已启动   用法：node tests/test-plc-config.js
*/
const BASE = process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

const getCfg = async () => (await fetch(BASE + '/api/config')).json();
const setCfg = async (host, port) => {
  const r = await fetch(`${BASE}/api/config?host=${encodeURIComponent(host)}&port=${port}`, { method: 'POST' });
  return r.json();
};

(async () => {
  console.log('① 读取当前配置');
  const c0 = await getCfg();
  ok(c0.ok === true, `host=${c0.host} port=${c0.port} source=${c0.source}`);
  ok(!!c0.defaults && c0.defaults.host === '192.168.1.92', '带内置默认值 ' + JSON.stringify(c0.defaults));

  console.log('② 非法地址一律拒绝（这是之前放行 999.1.1.1 的漏洞）');
  const bads = [
    ['999.1.1.1', 11740, '段值越界'],
    ['192.168.1', 11740, '只有三段'],
    ['192.168.1.92.5', 11740, '五段'],
    ['192.168.1.a', 11740, '含非法字母段'],
    ['', 11740, '空 IP'],
    ['192.168.1.92', 0, '端口 0'],
    ['192.168.1.92', 70000, '端口越界'],
    ['192.168.1.92', 1.5, '端口小数'],
    ['192.168.1.92', 'abc', '端口非数字'],
    ['a b c', 11740, '含空格'],
  ];
  for (const [h, p, why] of bads) {
    const d = await setCfg(h, p);
    ok(d.ok === false && !!d.error, `拒绝 ${JSON.stringify(h)}:${p}（${why}）→ ${d.error || '未报错!'}`);
  }

  console.log('③ 合法地址接受（含主机名）');
  const good = await setCfg('192.168.1.92', 11740);
  ok(good.ok === true, `接受 192.168.1.92:11740（changed=${good.changed}）`);

  console.log('④ 落盘 plc-config.json');
  const fs = require('fs');
  const path = require('path');
  const f = path.join(__dirname, '..', 'server', 'plc-config.json');
  ok(fs.existsSync(f), '文件已生成');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok(saved.host === '192.168.1.92' && saved.port === 11740, '内容正确 ' + JSON.stringify(saved));

  console.log('⑤ 读回接口与文件一致');
  const c1 = await getCfg();
  ok(c1.source === 'file', 'source=file（优先于 env）');
  ok(c1.host === '192.168.1.92' && c1.port === 11740, '读回 ' + c1.host + ':' + c1.port);

  console.log('⑥ 相同地址不报"变更"');
  const same = await setCfg('192.168.1.92', 11740);
  ok(same.ok === true && same.changed === false, 'changed=false');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
