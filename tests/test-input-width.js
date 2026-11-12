/* test-input-width.js — 写入输入框严格等长（无头 Chrome 实测几何）
   ─────────────────────────────────────────────────────────────
   用 Chrome DevTools 协议量 getBoundingClientRect，不靠 CSS 推算：
     所有 .wnum（数字框 / BOOL 下拉）宽度唯一、高度唯一、左边缘唯一；
     写入按钮宽度唯一；控件不越出表格与容器；窗口缩到 900px 不变形（改出横向滚动）。
   前置：验证台已启动 + 本机 Chrome   用法：node tests/test-input-width.js
*/
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('./_ws');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const URL_PAGE = (process.env.MYX_TEST_BASE || 'http://127.0.0.1:8095') + '/full';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cdp(ws, method, params) {
  const id = cdp._id = (cdp._id || 0) + 1;
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw); } catch (_) { return; }
      if (m.id !== id) return;
      ws.off('message', onMsg);
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error(method + ' 超时')); }, 15000);
  });
}

(async () => {
  if (!fs.existsSync(CHROME)) { console.log('✗ 未找到 Chrome：' + CHROME); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'myx-cdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    /* 等 DevTools 端口就绪 */
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        targets = await r.json();
        if (targets.length) break;
      } catch (_) {}
      await sleep(250);
    }
    if (!targets || !targets.length) throw new Error('Chrome DevTools 未就绪');

    const page = targets.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    await cdp(ws, 'Page.enable');
    await cdp(ws, 'Runtime.enable');
    const nav = new Promise((res) => {
      const h = (raw) => {
        let m; try { m = JSON.parse(raw); } catch (_) { return; }
        if (m.method === 'Page.loadEventFired') { ws.off('message', h); res(); }
      };
      ws.on('message', h);
    });
    await cdp(ws, 'Page.navigate', { url: URL_PAGE });
    await nav;
    await sleep(1500);           /* 等符号表加载 + 表格渲染完成 */

    const expr = `(() => {
      const rows = [...document.querySelectorAll('#tbody tr[data-f]')];
      const ctl = rows.map(r => r.querySelector('.wnum')).filter(Boolean);
      const btn = rows.map(r => r.querySelector('.wgo')).filter(Boolean);
      const pick = el => {
        const b = el.getBoundingClientRect();
        return { w: Math.round(b.width * 100) / 100, h: Math.round(b.height * 100) / 100,
                 l: Math.round(b.left * 100) / 100, tag: el.tagName };
      };
      const uniq = (arr) => [...new Set(arr)];
      return {
        rows: rows.length,
        ctlCount: ctl.length, btnCount: btn.length,
        ctlWidths: uniq(ctl.map(e => pick(e).w)),
        ctlHeights: uniq(ctl.map(e => pick(e).h)),
        btnWidths: uniq(btn.map(e => pick(e).w)),
        btnHeights: uniq(btn.map(e => pick(e).h)),
        ctlLefts: uniq(ctl.map(e => pick(e).l)),
        selectCount: ctl.filter(e => e.tagName === 'SELECT').length,
        inputCount: ctl.filter(e => e.tagName === 'INPUT').length,
        tableW: Math.round(document.querySelector('.ftable').getBoundingClientRect().width),
      };
    })()`;
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const d = r.result.value;
    if (!d || !d.rows) throw new Error('页面未渲染出表格行（符号表可能未加载）');

    console.log(`① 渲染概况：${d.rows} 行 · 控件 ${d.ctlCount}（INPUT ${d.inputCount} / SELECT ${d.selectCount}）· 表格宽 ${d.tableW}px`);

    console.log('② 所有输入控件宽度必须一致（数字框 vs BOOL 下拉）');
    ok(d.ctlWidths.length === 1,
      `宽度唯一值 = [${d.ctlWidths.join(', ')}]px（共 ${d.ctlCount} 个控件）`);
    ok(d.ctlWidths[0] >= 100, `宽度 ${d.ctlWidths[0]}px ≥ 100px（不至于挤到看不全数字）`);

    console.log('③ 高度也一致（下拉与输入框对齐）');
    ok(d.ctlHeights.length === 1, `高度唯一值 = [${d.ctlHeights.join(', ')}]px`);

    console.log('④ 写入按钮宽度一致');
    ok(d.btnWidths.length === 1, `宽度唯一值 = [${d.btnWidths.join(', ')}]px（共 ${d.btnCount} 个）`);
    ok(d.btnHeights.length === 1, `高度唯一值 = [${d.btnHeights.join(', ')}]px`);

    console.log('⑤ 左边缘对齐（不会一行靠左一行靠右）');
    ok(d.ctlLefts.length === 1, `left 唯一值 = [${d.ctlLefts.join(', ')}]px`);

    console.log('⑥ 控件数量与行数匹配');
    ok(d.ctlCount === d.btnCount, `控件 ${d.ctlCount} 个 = 按钮 ${d.btnCount} 个`);
    ok(d.selectCount > 0 && d.inputCount > 0, `两种控件都出现了（BOOL ${d.selectCount} / 数字 ${d.inputCount}）`);

    console.log('⑦ 控件都在表格与可视区内（没被 columns 挤出/裁掉）');
    const box = await cdp(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const t = document.querySelector('.ftable').getBoundingClientRect();
        const wrap = document.querySelector('.ftable-wrap').getBoundingClientRect();
        const rows = [...document.querySelectorAll('#tbody tr[data-f]')];
        const go = rows.map(r => r.querySelector('.wgo')).filter(Boolean);
        const lastBtn = go[go.length - 1].getBoundingClientRect();
        return {
          tableLeft: Math.round(t.left), tableRight: Math.round(t.right),
          wrapLeft: Math.round(wrap.left), wrapRight: Math.round(wrap.right),
          lastBtnRight: Math.round(lastBtn.right),
          hScroll: document.querySelector('.ftable-wrap').scrollWidth > document.querySelector('.ftable-wrap').clientWidth,
        };
      })()`, returnByValue: true,
    });
    const b = box.result.value;
    console.log(`   表格 [${b.tableLeft}, ${b.tableRight}] · 容器 [${b.wrapLeft}, ${b.wrapRight}] · 末个按钮右缘 ${b.lastBtnRight}`);
    ok(b.lastBtnRight <= b.wrapRight + 1, '写入按钮未超出容器右边界');
    ok(b.lastBtnRight <= b.tableRight + 1, '写入按钮未超出表格右边界');
    console.log(b.hScroll ? '   （窗口较窄，出现横向滚动条——属预期保护）' : '   （无需横向滚动）');

    console.log('⑧ 窄窗口（900px）下宽度不变形，靠横向滚动保护');
    await cdp(ws, 'Emulation.setDeviceMetricsOverride',
      { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const narrow = await cdp(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const rows = [...document.querySelectorAll('#tbody tr[data-f]')];
        const ctl = rows.map(r => r.querySelector('.wnum')).filter(Boolean);
        const uniq = a => [...new Set(a)];
        const wrap = document.querySelector('.ftable-wrap');
        return {
          widths: uniq(ctl.map(e => Math.round(e.getBoundingClientRect().width))),
          hScroll: wrap.scrollWidth > wrap.clientWidth + 1,
        };
      })()`, returnByValue: true,
    });
    const n = narrow.result.value;
    ok(n.widths.length === 1 && n.widths[0] === 120,
      `窄窗口下宽度仍唯一 = [${n.widths.join(', ')}]px（未被挤压）`);
    ok(n.hScroll === true, '窄窗口出现横向滚动条（而不是压缩控件）');
  } catch (e) {
    console.log('  ✗ 检测失败：' + e.message);
    fail++;
  } finally {
    try { ws && ws.close(); } catch (_) {}
    try { chrome.kill(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
})();
