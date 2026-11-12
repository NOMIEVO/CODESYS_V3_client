/* codesys-v3-client.js — CODESYS V3 标签通讯最小客户端（Node 独立实现）
   ─────────────────────────────────────────────────────────────
   不依赖 vendor dll：基于抓包样本（capture/session_*.txt），
   服务层报文逐字节复刻，仅修补通道号 / 块号 / ack / session_id / CRC。

   已实现（里程碑 A）：NS 查询 → 开通道 → 创建会话 → 登录 → GetRoot
   已实现（里程碑 B）：PrepareRead 按名登记 → 周期 ExecuteRead → 值解码
                      （标量 + ≤16383B 数组/结构体 blob，双字节长度通式）
   已实现（里程碑 C）：写入链路 —— CmpIecVarAccess 09/04 单发写入
                      writeValue()/writeValues()，2026-11-11 真机验证通过
                      （计数器改值+还原闭环、REAL/LREAL 类型覆盖）

   关键协议结论（真机验证）：
   · BLK 校验字段 = CRC32(整个 service 载荷)
   · 多块传输：帧上限 516B；首块通道头 20B（含 remaining+check），
     续块通道头 12B（仅 pktType+chId+blkId+ackId，无 remaining/check）
   · PrepareRead(09/01)：按 "Application.xxx" 全名登记，响应 tag 0x10 给读取列表句柄
   · ExecuteRead(09/03)：请求仅 8B（tag 0x10 + 句柄）；响应条目
     "1d w1 w2 00 + 4B保留 + 值"，值域字节数 = (w1-0x80)+((w2-0x80)<<7)
   · WriteValue(09/04)：单发写，tag 13(标志 0)/21(名)/1e([u16长][u16 0][8B值])，
     响应 tag 0x20 状态 0 = 成功（无 PrepareWrite，写即单条请求）
   · 浏览类命令：09/08 按父句柄+名浏览子节点；09/09 按句柄查节点

   ⚠️ 读写路径均已真机验证。写操作必须走 allowWrite + 白名单双闸。 */
'use strict';
const net = require('net');
const os = require('os');

/* ────────── 十六进制工具 ────────── */
const H = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');
const u32le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u16le = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };

/* CRC32（IEEE 802.3 反射实现）——BLK 块校验 = CRC32(service)，抓包 20/20 验证 */
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* 登录 32B 授权块（实测跨会话常量） */
const LOGIN_TAGS = Buffer.concat([
  H('22848000 01000000'),              /* tag 0x22 用户名（空）  */
  H('23848000 cd0fda5e'),              /* tag 0x23 密码（空）    */
  H('8101a800 10020000'),              /* 父 tag（授权块组）     */
  H('11a08000'),                        /* tag 0x11 len=32        */
  H('4765445206364566 2223323743757068' +
    '045468752f3f7068 2e44722a3f556252'),
]);

/* 独立运行（node codesys-v3-client.js <ip>）时的示例变量表。
   演示工程 DEMO_MACHINE 的变量；换成自己的工程时改这里即可。
   正式使用时不必依赖它——类型从 gen/<APP>.types.json 取（见 drill-core.js）。 */
const TAG_TYPES = {
  'GVL_MAIN.diTotalCount': 'DINT',
  'GVL_MAIN.diPartCount': 'DINT',
  'GVL_MAIN.lrSpeed': 'LREAL',
  'GVL_MAIN.bEStop': 'BOOL',
  'GVL_MAIN.bEtherCAT': 'BOOL',
  'GVL_MAIN.bIoOk': 'BOOL',
  'GVL_MAIN.bAutoMode': 'BOOL',
  'GVL_MAIN.bRunning': 'BOOL',
  'GVL_STATION.diOkCount': 'DINT',
  'GVL_STATION.diNgCount': 'DINT',
  'GVL_STATION.diTarget': 'DINT',
  'GVL_STATION.rActual': 'REAL',
  'GVL_STATION.rTarget': 'REAL',
  'GVL_STATION.rUpperLimit': 'REAL',
  'GVL_STATION.rLowerLimit': 'REAL',
  'GVL_STATION.rReference': 'REAL',
  'GVL_STATION.bVisionEnable': 'BOOL',
  'GVL_IO.bSafetyDoor': 'BOOL',
  'GVL_IO.bSafetyOk': 'BOOL',
  'GVL_IO.bAirPressure': 'BOOL',
};

class CodesysV3Client {
  constructor(host, port = 11740, opts = {}) {
    this.host = host; this.port = port;
    this.allowWrite = !!opts.allowWrite;             /* 写总开关：默认关 */
    this.sock = null; this.rxBuf = Buffer.alloc(0);
    this.chId = null;                 /* 通道号 u16 */
    this.sessionId = null;            /* 会话号 u32 */
    this.readListHandle = null;       /* PrepareRead 登记的读取列表句柄 */
    this.blkId = 0; this.ackId = 0;
    this.preBuffer = [];          /* waitChanAck 期间收到的非回执帧，待 recvService 消费 */
    this.flowControl = !!opts.flowControl;   /* 逐块等 0280 回执（多块必需：PLC 接收窗口=2 块） */
    /* 数据报收发地址（发送者 = 43 + 端口2ddc + 本机IP；接收者 = 端口0000 + 目标IP） */
    const p = host.split('.').map(Number);
    const remoteIp = Buffer.from(p);
    const local = Object.values(os.networkInterfaces()).flat()
      .find(i => i.family === 'IPv4' && !i.internal &&
             i.address.startsWith(p.slice(0, 3).join('.')));
    const localIp = local ? Buffer.from(local.address.split('.').map(Number))
                          : Buffer.from([127, 0, 0, 1]);
    this.senderAddr = Buffer.concat([H('432ddc'), localIp]);
    this.receiverAddr = Buffer.concat([H('0000'), remoteIp]);
  }

  /* ── 块驱动层 ── */
  sendFrame(dgram) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(0xE8170100, 0);
    head.writeUInt32LE(8 + dgram.length, 4);
    if (this.trace) this.trace.push(['>', (8 + dgram.length) + 'B', head.toString('hex') + dgram.toString('hex')]);
    this.sock.write(Buffer.concat([head, dgram]));
  }

  waitForFrame(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.sock.removeListener('data', on); reject(new Error('读帧超时')); }, timeoutMs);
      const on = () => {
        if (this.rxBuf.length < 8) return;
        const total = this.rxBuf.readUInt32LE(4);
        if (this.rxBuf.length < total) return;
        clearTimeout(t);
        this.sock.removeListener('data', on);
        const dgram = this.rxBuf.slice(8, total);
        this.rxBuf = this.rxBuf.slice(total);
        if (this.trace) this.trace.push(['<', total + 'B', this.rxBuf.length >= 0 ? dgram.toString('hex') : '']);
        resolve(dgram);
      };
      this.sock.on('data', on);
      on();
    });
  }

  /* ── 通道层：发送服务（自动多块拆分）
     帧上限 516B：首块服务载荷 ≤468B（通道头20B），
     续块载荷 ≤448B（通道头12B：pktType+chId+blkId+ackId，无 remaining/check）── */
  async sendService(serviceMsg) {
    const MAX_FIRST = this.maxFirst || 468, MAX_CONT = this.maxCont || 448;
    if (serviceMsg.length <= MAX_FIRST) {
      this.sendFrame(this.chanBlk(serviceMsg));
      return;                                        /* 单块无流控：PLC 直接回服务响应 */
    }
    const gap = this.blkGapMs || 0;                    /* 块间延迟（流控实验用） */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const firstBlk = ++this.blkId;
    this.sendFrame(Buffer.concat([
      this.chanPrefix(), H('0181'), u16le(this.chId),
      u32le(firstBlk), u32le(this.ackId),
      u32le(serviceMsg.length), u32le(crc32(serviceMsg)),
      serviceMsg.slice(0, MAX_FIRST),
    ]));
    if (this.flowControl) await this.waitChanAck(firstBlk);
    let off = MAX_FIRST;
    while (off < serviceMsg.length) {
      if (gap) await sleep(gap);
      const part = serviceMsg.slice(off, off + MAX_CONT);
      const blkId = ++this.blkId;
      this.sendFrame(Buffer.concat([
        this.chanPrefix(), H('0180'), u16le(this.chId),
        u32le(blkId), u32le(this.ackId),
        part,
      ]));
      off += part.length;
      if (this.flowControl && off < serviceMsg.length) await this.waitChanAck(blkId);
    }
  }

  /* 等待 PLC 对指定数据块的通道回执（0280）。
     03xx = 通道层 NAK（要求重传），返回 false。
     期间收到的非回执帧暂存 preBuffer，交由 recvService 消费。 */
  async waitChanAck(blkId, timeoutMs = 1200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let dgram;
      try { dgram = await this.waitForFrame(Math.max(200, timeoutMs - (Date.now() - t0))); }
      catch (_) { return false; }
      const pkt = dgram.slice(20, 22).toString('hex');
      if (pkt === '0280') {
        if (dgram.length >= 28 && dgram.readUInt32LE(24) === blkId) return true;
        continue;
      }
      if (pkt === '0300') return true;                  /* 通道层"可继续发下一块" */
      if (pkt === '8400' || pkt === '8500') return false;
      this.preBuffer.push(dgram);
    }
    return false;
  }

  chanPrefix() {
    return Buffer.concat([H('c56b404000'), this.senderAddr, this.receiverAddr, H('02f1')]);
  }

  /* 单块组装（小服务） */
  chanBlk(serviceMsg) {
    return Buffer.concat([
      this.chanPrefix(), H('0181'), u16le(this.chId),
      u32le(++this.blkId), u32le(this.ackId),
      u32le(serviceMsg.length), u32le(crc32(serviceMsg)),
      serviceMsg,
    ]);
  }

  /* 通道 ACK（对每个收到的数据块回执，36B） */
  sendChanAck(blockId) {
    this.sendFrame(Buffer.concat([
      this.chanPrefix(), H('0280'), u16le(this.chId), u32le(blockId),
    ]));
  }

  /* ── 接收并重组服务（跳过控制包，ACK 每个数据块） ── */
  async recvService(timeoutMs = 6000) {
    let buf = null, need = 0;
    for (;;) {
      const dgram = this.preBuffer.length ? this.preBuffer.shift() : await this.waitForFrame(timeoutMs);
      const pkt = dgram.slice(20, 22).toString('hex');
      if (pkt === '8400' || pkt === '8500') throw new Error('通道错误 ' + pkt + ': ' + dgram.toString('hex').slice(0, 120));
      if (pkt === '0101' || pkt === '0181') {          /* S→C 首块 */
        const blkId = dgram.readUInt32LE(24);
        this.ackId = blkId;
        this.sendChanAck(blkId);
        const remaining = dgram.readUInt32LE(32);
        const svc = dgram.slice(40);
        if (svc.length >= remaining) return svc.slice(0, remaining);
        buf = svc; need = remaining - svc.length;
      } else if ((pkt === '0100' || pkt === '0180') && buf) {   /* S→C 续块 */
        const blkId = dgram.readUInt32LE(24);
        this.ackId = blkId;
        this.sendChanAck(blkId);
        const part = dgram.slice(32);
        buf = Buffer.concat([buf, part]);
        need -= part.length;
        if (need <= 0) return buf.slice(0, buf.length + need);
      }
      /* 其余（0280 ACK 等控制包）跳过 */
    }
  }

  /* 服务层组装：magic + 组 + 命令 + session + size(载荷长) + corr + 载荷 */
  serviceMsg(grp, cmd, payload) {
    return Buffer.concat([
      H('55cd1000'), u16le(grp), u16le(cmd),
      u32le(this.sessionId || 0), u32le(payload.length), u32le(0),
      payload,
    ]);
  }

  /* 发送并等待响应；校验：响应组 = 请求组|0x80，命令一致 */
  async request(serviceMsg) {
    await this.sendService(serviceMsg);
    const svc = await this.recvService();
    const rGrp = svc[4], rCmd = svc.readUInt16LE(6);
    const eGrp = serviceMsg[4] | 0x80, eCmd = serviceMsg.readUInt16LE(6);
    if (rGrp !== eGrp || rCmd !== eCmd)
      throw new Error(`服务响应不符: 期望组0x${eGrp.toString(16)}/命令0x${eCmd.toString(16)} ` +
        `实得组0x${rGrp.toString(16)}/命令0x${rCmd.toString(16)} · ${svc.slice(0, 20).toString('hex')}`);
    return { svc, payload: svc.slice(20) };
  }

  /* ══════════ 里程碑 A：握手链路 ══════════ */

  async connect() {
    await new Promise((resolve, reject) => {
      /* MYX_SRC：强制绑定源网卡（工业场景固定走有线网卡，避免 Wi-Fi 路由抢占） */
      const opts = { host: this.host, port: this.port };
      if (process.env.MYX_SRC) opts.localAddress = process.env.MYX_SRC;
      this.sock = net.connect(opts, resolve);
      this.sock.on('error', reject);
    });
    this.sock.on('data', (d) => { this.rxBuf = Buffer.concat([this.rxBuf, d]); });
    this.sock.setNoDelay(true);        /* 关闭 Nagle：小包请求否则被延迟 ~40ms */
    return this;
  }

  /* ① NS 查询（独立短连接） */
  async nsQuery() {
    const ns = new CodesysV3Client(this.host, this.port);
    let dgram;
    try {
      await ns.connect();
      ns.sendFrame(Buffer.concat([
        H('c56b400300'), ns.senderAddr, ns.receiverAddr,
        H('02f102c2000401000000'),
      ]));
      dgram = await ns.waitForFrame();
    } finally {
      /* 关键：超时/异常也必须关掉这条短连接。
         PLC 11740 一次只服务一个 TCP 连接，僵尸 socket 会占死名额，
         导致后续每次握手都卡在"NS 查询 → 读帧超时"，直到 PLC 自己回收。 */
      try { ns.sock && ns.sock.destroy(); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 150));   /* PLC 释放 NS 会话需片刻 */
    const m = dgram.toString('latin1').indexOf('K\0');
    this.deviceName = m >= 0
      ? dgram.slice(m, m + 16).toString('utf16le').replace(/\0/g, '') : '?';
    return this.deviceName;
  }

  /* ② 主连接 NS 查询（vendor 拓扑：主连接首包必须是 NS 查询 seq02） */
  async nsQueryOnMain() {
    this.sendFrame(Buffer.concat([
      H('c56b400300'), this.senderAddr, this.receiverAddr,
      H('02f102c2000402000000'),
    ]));
    await this.waitForFrame();          /* 消费 221B NS 响应 */
    return true;
  }

  /* ③ 开通道（chanPrefix 已含 02f1，此处只拼通道载荷） */
  async openChannel() {
    this.sendFrame(Buffer.concat([
      this.chanPrefix(),
      H('c30001011fbc505e81d4218300d0070008000000'),
    ]));
    const dgram = await this.waitForFrame();
    const i = dgram.indexOf(H('8300'));
    if (i < 0) throw new Error('开通道响应异常: ' + dgram.toString('hex'));
    this.chId = dgram.readUInt16LE(i + 14);
    return this.chId;
  }

  /* ③ 会话创建（模板 20B：session=0, size=0, corr=0） */
  async sessionCreate() {
    const r = await this.request(this.serviceMsg(0x01, 0x01, Buffer.alloc(0)));
    return r.svc.length;
  }

  /* ④ 登录（响应 tag 0x21 给出 session_id） */
  async login() {
    const svc = Buffer.concat([
      H('55cd1000'), u16le(0x01), u16le(0x02), u32le(0), u32le(0x3c), u32le(0),
      LOGIN_TAGS,
    ]);
    const r = await this.request(svc);
    const m = r.payload.indexOf(H('21848000'));
    if (m < 0) throw new Error('登录响应未含 session_id: ' + r.payload.toString('hex'));
    this.sessionId = r.payload.readUInt32LE(m + 4);
    return this.sessionId;
  }

  /* ⑤ GetRoot（响应 tag 0x38 给出 Application 句柄；
     tag 0x3a 为 PLC 下发的设备令牌，PrepareRead 必须原样带回） */
  async getRoot() {
    const r = await this.request(this.serviceMsg(0x09, 0x07, Buffer.alloc(0)));
    const m = r.payload.indexOf(H('38948000'));
    if (m < 0) throw new Error('GetRoot 未命中 0x38: ' + r.payload.toString('hex'));
    const t = r.payload.indexOf(H('3a848000'));
    if (t >= 0) this.deviceToken = r.payload.readUInt32LE(t + 4);   /* 设备令牌 */
    else console.error('[getRoot] 本轮响应未含 3a848000 令牌标签，原始报文:\n'
      + r.payload.toString('hex'));                                  /* 瞬态差异取证 */
    return r.payload.readUInt32LE(m + 4);
  }

  /* ══════════ 里程碑 B：读取链路 ══════════ */

  /* 按名登记列表的条目/载荷组装（读/写共用）
     条目格式：19 | 总长(=align4(名长含\0+4)-2) | 名长含\0 u16 | 名 | \0 | 补零
     头部常量 tag 0x13 / 0x3a 来自抓包复刻，tag 0x18 = 条目数            */
  buildNameListPayload(fullNames, opts = {}) {
    if (this.deviceToken == null && !opts.dryRun)
      throw new Error('设备令牌未捕获（GetRoot 响应未含 tag 0x3a）——重连即可恢复，'
        + '禁止以令牌 0 发起列表登记（PLC 将回错误 14 02 02 09）');
    const entries = fullNames.map((n) => {
      const name = Buffer.from(n + '\0', 'latin1');
      const total = (name.length + 4 + 3) & ~3;        /* align4(名长+4) */
      const pad = total - 4 - name.length;
      return Buffer.concat([
        Buffer.from([0x19, total - 2]), u16le(name.length), name, Buffer.alloc(pad),
      ]);
    });
    return Buffer.concat([
      H('13848000 48000100'),                          /* tag 0x13（复刻） */
      H('3a848000'), u32le(this.deviceToken || 0),    /* tag 0x3a 设备令牌（GetRoot 下发） */
      H('18848000'), u32le(fullNames.length),          /* tag 0x18 条目数  */
      ...entries,
    ]);
  }

  /* ⑥ PrepareRead：按全名登记读取列表 */
  async prepareRead(fullNames) {
    const payload = this.buildNameListPayload(fullNames);
    const r = await this.request(this.serviceMsg(0x09, 0x01, payload));
    const i = r.payload.indexOf(H('10848000'));
    if (i < 0) throw new Error('PrepareRead 响应无读取列表句柄: ' + r.payload.toString('hex').slice(0, 160));
    this.readListHandle = r.payload.readUInt32LE(i + 4);
    return this.readListHandle;
  }

  /* ══════════ 里程碑 C：写入链路（CmpIecVarAccess 09/04 单发写入）══════════
     依据 CodeSysCommDriver 实现（gitee.com/lircy/CodesysV3Driver，CSDN 文章公开）：
     写入不分 Prepare/Execute，一条 SubCmd 0x04 请求即完成：
       Tag 0x13 = 00 00 00 00        （标志，注意与读的 48 00 01 00 不同）
       Tag 0x21 = 变量名 + \0 + 补齐 4 字节
       Tag 0x1e = [u16 数据长度][u16 0][值本体 8 字节缓冲]
     响应 Tag 0x20 = 状态码（0 成功）。
     ⚠️ 仍以真机 no-op 回写验证为准（test-write-counters.js 流程）。 */
  encodeVarint(v) {
    const out = [];
    for (;;) { out.push((v & 0x7F) | (v > 0x7F ? 0x80 : 0)); v >>>= 7; if (!v) break; }
    return Buffer.from(out);
  }

  /* 单变量写 tag 组装 */
  encodeWriteTags(fullName, data) {
    const name = Buffer.from(fullName + '\0', 'latin1');
    const namePad = Buffer.concat([name, Buffer.alloc((4 - (name.length % 4)) % 4)]);
    const vbuf = Buffer.alloc(8);                      /* 8B 值缓冲（≤8B 类型） */
    data.copy(vbuf, 0, 0, Math.min(data.length, 8));
    const valuePayload = Buffer.concat([
      u16le(data.length), u16le(0), vbuf,              /* [len][0][8B 值] = 12B */
    ]);
    return Buffer.concat([
      Buffer.from([0x13]), this.encodeVarint(4), Buffer.alloc(4),          /* 标志 */
      Buffer.from([0x21]), this.encodeVarint(namePad.length), namePad,     /* 名字 */
      Buffer.from([0x1e]), this.encodeVarint(valuePayload.length), valuePayload,
    ]);
  }

  /* 单变量写入：返回 { ok, status, raw }
     响应为 tag 序列（ID + 7bit 变长长度 + 值），状态在 tag 0x20：
     实测成功响应 = 20 02 00 00（tag 0x20 · 长度 2 · 状态 0x0000 = 成功） */
  async writeValue(fullName, data) {
    if (!this.allowWrite) throw new Error('写入未授权：需 new CodesysV3Client(host, port, { allowWrite: true })');
    const r = await this.request(this.serviceMsg(0x09, 0x04, this.encodeWriteTags(fullName, data)));
    this.lastWritePayload = r.payload;
    const tags = this.parseTags(r.payload);
    const st = tags.find(t => t.id === 0x20);
    if (!st)
      throw new Error('写响应无 0x20 状态码: ' + r.payload.toString('hex').slice(0, 160));
    const status = st.value.length >= 4 ? st.value.readUInt32LE(0)
                 : st.value.length >= 2 ? st.value.readUInt16LE(0) : st.value[0] || 0;
    return { ok: status === 0, status, raw: r.payload };
  }

  /* tag 序列解析（ID 单字节 + 7bit 变长长度 + 值），返回 [{id, value}] */
  parseTags(buf) {
    const out = [];
    let pos = 0;
    while (pos < buf.length) {
      const id = buf[pos++];
      let len = 0, shift = 0, b;
      do { b = buf[pos++]; len |= (b & 0x7F) << shift; shift += 7; } while ((b & 0x80) && pos < buf.length);
      out.push({ id, value: buf.slice(pos, pos + len) });
      pos += len;
    }
    return out;
  }

  /* 批量写入（多条变量各自一条 09/04 请求，串行） */
  async writeValues(items) {
    const out = [];
    for (const it of items) out.push({ name: it.name, ...(await this.writeValue(it.name, it.data)) });
    return out;
  }

  /* ⑦ ExecuteRead：请求仅 tag 0x10 + 句柄；
     响应 = tag 0x22(头) + N 个 "1d <w1> <w2> 00 + 4B保留 + 值" 条目。
     值域长度双字节编码（多尺寸实测 9/9 验证，含 1056/2904/6232B 大块）：
       值域字节数 = (w1-0x80) + ((w2-0x80) << 7)    （值域 = 4B保留+数据，4对齐）
       例：4B值→88 80，24B→9c 80，96B元素→e4 80，1056B→a4 88，6232B→dc b0
       单条上限 0x7F + 0x7F<<7 = 16383B
     条目步进 = 4 + 值域；原始响应存 lastReadPayload。
     注意：含指针/字符串成员的类型（如 D_VisualData，布局可信=N）整符号
     被拒，响应错误 tag 20 02 02 00——与尺寸无关，与类型可读性有关。 */
  async executeRead() {
    if (this.readListHandle == null) throw new Error('尚未 PrepareRead');
    const payload = Buffer.concat([H('10848000'), u32le(this.readListHandle)]);
    const r = await this.request(this.serviceMsg(0x09, 0x03, payload));
    this.lastReadPayload = r.payload;                   /* 探针/调试用原始报文 */
    const vals = [];
    let pos = 0;
    const p = r.payload;
    while (pos + 8 <= p.length) {
      const tag = p[pos], w1 = p[pos + 1], w2 = p[pos + 2];
      if (w1 >= 0x80 && w2 >= 0x80) {                   /* 值条目 */
        const vlen = (w1 - 0x80) + ((w2 - 0x80) << 7); /* 值域总字节数（含4B保留） */
        if (tag === 0x1d) vals.push(p.slice(pos + 8, pos + 4 + vlen));
        pos += 4 + vlen;
      } else break;
    }
    return vals;
  }
}

/* 按类型表解码原始值 Buffer */
function decodeValue(key, buf) {
  if (!buf || buf.length === 0) return null;
  if (buf.length === 8) return buf.readDoubleLE(0);
  const t = TAG_TYPES[key] || 'DINT';
  if (buf.length === 2) return t === 'UINT' || t === 'INT' ? buf.readInt16LE(0) : buf.readUInt16LE(0);
  const u = buf.readUInt32LE(0);
  if (t === 'BOOL') return u ? 1 : 0;
  if (t === 'REAL') return buf.readFloatLE(0);
  return u | 0;
}

/* ════════════════ main：里程碑 A+B 演示 ════════════════ */
if (require.main === module) {
  const host = process.argv[2] || '192.168.1.92';
  const NAMES = Object.keys(TAG_TYPES);   /* 与上面的示例变量表保持一致 */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  (async () => {
    const c = new CodesysV3Client(host);
    console.log(`── ${host}:11740 直连测试（纯 Node 协议栈，无 dll，只读） ──`);

    console.log('① NS 查询      :', await c.nsQuery());
    await c.connect();
    await c.nsQueryOnMain();
    console.log('   主连接 NS 查询 OK');
    console.log('② 开通道        : chId = 0x' + (await c.openChannel()).toString(16));
    console.log('③ 会话创建      : 响应 ' + (await c.sessionCreate()) + 'B');
    console.log('④ 登录          : sessionId = 0x' + (await c.login()).toString(16).padStart(8, '0'));
    console.log('⑤ GetRoot       : Application 句柄 = 0x' + (await c.getRoot()).toString(16).padStart(8, '0'));

    console.log('⑥ PrepareRead   : 读取列表句柄 = 0x' +
      (await c.prepareRead(NAMES.map(n => 'Application.' + n))).toString(16).padStart(8, '0'));

    console.log('⑦ ExecuteRead   : 周期读取 6 轮（500ms）\n');
    for (let round = 1; round <= 6; round++) {
      const vals = await c.executeRead();
      console.log(`── 第 ${round} 轮 ──`);
      for (let i = 0; i < NAMES.length; i++) {
        console.log('  ' + NAMES[i].padEnd(46) + ' = ' + decodeValue(NAMES[i], vals[i]));
      }
      if (round < 6) await sleep(500);
    }
    console.log('\n✅ 里程碑 B 完成：纯 Node 协议栈完成 PrepareRead + 周期 ExecuteRead');
    c.sock.destroy();
    process.exit(0);
  })().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}

module.exports = { CodesysV3Client, decodeValue, TAG_TYPES };
