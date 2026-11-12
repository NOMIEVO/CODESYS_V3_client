# CODESYS V3 标签通讯客户端

纯 Node.js 实现的 CODESYS V3 变量访问客户端（**不依赖任何厂商 DLL / OPC UA 中间件**），
配套一套可视化验证台，用于：

- 按**变量名**读写 PLC 变量（标量、数组元素、结构体成员、嵌套成员）
- 一次登记、单轮读取全部符号，周期刷新
- 把符号配置 XML 变成可直接消费的点表 / 类型库 / 布局表
- 用浏览器看清每一步握手、每一次读写、每一帧报文

> **关于示例数据**：仓库内的示例工程 `DEMO_MACHINE` 是**纯合成**的
> （由 `tools/make-demo-xml.py` 生成），不对应任何真实设备或产线，所有变量名都做了通用化处理。
> 默认 PLC 地址 `192.168.1.92:11740` 是开发时实际使用的设备地址，
> 用于说明默认配置；换到自己的设备上，点界面左上角改一下即可。

---

## 目录

1. [这是什么](#1-这是什么)
2. [三步跑起来](#2-三步跑起来)
3. [会看到什么结果](#3-会看到什么结果)
4. [目录结构](#4-目录结构)
5. [配置项](#5-配置项)
6. [能读写哪些变量](#6-能读写哪些变量)
7. [自带的自检](#7-自带的自检)
8. [命令行用法](#8-命令行用法)
9. [工作原理速览](#9-工作原理速览)
10. [常见问题](#10-常见问题)
11. [文档索引](#11-文档索引)

---

## 1. 这是什么

### 解决的问题

PLC（CODESYS 运行时）对外提供 `CmpIecVarAccess` 服务于 **TCP 11740**。官方做法是装 CODESYS 的
网关/DLL 或走 OPC UA。本包用纯 Node 直接实现这套二进制协议，因此：

- 可部署到任意有 Node.js 的机器（工控机、树莓派、服务器），无需安装 CODESYS
- 可跨平台（Windows / Linux / macOS）
- 可直接嵌到自己的 Node 服务里（`require('./server/codesys-v3-client.js')`）

### 能力边界

| 能力 | 状态 | 说明 |
|---|---|---|
| 握手（NS 查询 / 开通道 / 会话 / 登录 / GetRoot） | ✅ | 7 步全实现 |
| 按名批量登记 + 单轮读取全部变量 | ✅ | PrepareRead + ExecuteRead，值长度自动识别 |
| 单个变量写入 | ✅ | WriteValue 单条请求，带状态码与回读校验 |
| 数组元素（`GVL.ARR[3]`）读写 | ✅ | 按元素名直接寻址 |
| 结构体成员（`GVL.SX[3].tState.bValid`）读写 | ✅ | 按成员名直接寻址，任意深度 |
| 结构体整体读 + 本地按偏移解码 | ✅ | 一次读回整块，省报文；布局可疑类型自动对账 |
| UNION / 布局可疑类型的偏移校准 | ✅ | 整读 blob 与逐名读基准对账，学到的布局可缓存 |
| 枚举成员 | ✅ | 显示字面量名 |
| 字符串 / 指针类成员 | ⚠️ | 可读原始字节，不保证解码语义 |
| 写权限控制 | ✅ | 总开关（`allowWrite`）+ 服务端白名单双闸 |

### 组成

```
codesys-v3-client.js   ← 协议客户端（可单独 require，无 Web 依赖）
drill-core.js          ← 类型导航 / 结构展开 / 偏移解码（纯函数，可离线单测）
verify-server.js       ← HTTP + WebSocket 验证台（可选，用来可视化）
verify/                ← 验证台前端（原生 JS，无构建步骤）
tools/gen_tags.py      ← 符号配置 XML → 点表 / 类型库 / 全量表
tools/codesys_symconfig.py ← XML → 布局表（偏移 / 跨度 / 审计报告）
```

---

## 2. 三步跑起来

### 环境要求

| 项 | 要求 | 用途 |
|---|---|---|
| Node.js | **18 或更高** | 服务与客户端 |
| Python | **3.6 或更高**（导入 XML / 重新生成点表时需要；只用自带数据则不需要） | 解析 XML |
| 浏览器 | Chrome / Edge 新版 | 验证台界面 |
| 网络 | 能访问 PLC 的 TCP 11740 | 实际通讯 |

> **先跑 `0-check-env.bat`**：一次体检 Node、依赖 `ws`、Python 三件事，缺什么直接说清怎么补。
> 这是排查“我这边好好的，别人一导入就失败”的第一入口。

> **依赖说明**：整个项目只有一个第三方依赖 `ws`（WebSocket）。
> 以**拷贝目录**方式获取时它已附在 `server/node_modules/ws`，完全离线可用；
> 以 **git clone** 方式获取时该目录不入库，在**项目根目录**执行一次 `npm install` 即可
> （`package.json` 在根目录；`START-HERE.bat` 会自动检测并安装）。

### 第 1 步：生成点表（若用自带示例可跳过）

双击 **`1-gen-tags.bat`**（生成点表）

- 输入：`example\*.Device.Application.xml`（CODESYS「符号配置」导出的 XML）
- 产出：见 [第 3 节](#3-会看到什么结果)

本包已附带一套生成好的数据，**直接跳到第 2 步也能跑**。

### 第 2 步：启动验证台

双击 **`2-run-verify.bat`**（启动验证台）

```
════════════════════════════════════════════════
  MYX 协议验证台
  界面  http://127.0.0.1:8095
  PLC   192.168.1.92:11740
  点表  23 点 · 白名单 9 项
════════════════════════════════════════════════
```

浏览器会自动打开 `http://127.0.0.1:8095`。

> **第一次用，先改 PLC 地址**：界面左上角那串 `● 192.168.1.92:11740` 本身是按钮，点它弹出
> 「PLC 配置」，填自己的 IP / 端口，点「保存并重连」。地址会存到 `server/plc-config.json`，重启仍生效。

### 第 3 步：看结果

链路自动连接，7 步握手逐项点亮，随后开始周期读（默认 500 ms）。
如果连不上，顶栏状态变红，鼠标悬停可看最近一次失败原因。

---

## 3. 会看到什么结果

### 3.1 生成点表后

```
■ DEMO_MACHINE  ← example\DEMO_MACHINE.Device.Application.xml
  符号总数（含容器/数组元素展开）: 49，类型数: 32
  点表选择: 23 点（来源: 内置模板）
  [v] out\DEMO_MACHINE\tag_table.json（全量符号表）
  [v] server\gen\DEMO_MACHINE.tags.json（23 点）
  [v] server\gen\DEMO_MACHINE.symbols.json（49 符号）
  [v] server\gen\DEMO_MACHINE.types.json（32 类型）
  · 跳过固件点表（本包不含 firmware/ 工程）
  [v] server\profiles\DEMO_MACHINE.profile.json（首次生成，可手工微调）

✅ 生成完毕
APP=DEMO_MACHINE
```

五个产物各自的用途：

| 文件 | 内容 | 谁用 |
|---|---|---|
| `server/gen/<APP>.tags.json` | 精选 21 个点（标签/单位/分组/类型） | 验证台主点表、周期读 |
| `server/gen/<APP>.symbols.json` | 全部符号清单（演示工程 49 个） | 审计基线、人工核对 |
| `server/gen/<APP>.types.json` | 46 个类型定义（成员名/偏移/数组维度） | 结构体钻取、成员树 |
| `out/<APP>/tag_table.json` | 全量表（含跨度/对齐/置信度） | 全量变量页、批量登记 |
| `out/<APP>/*.csv` `*.h` `audit.md` | 人看的清单与布局头文件、审计报告 | PLC 工程师核对 |
| `server/profiles/<APP>.profile.json` | 选点档案（可手工改再重跑） | 决定哪 21 个点进主点表 |

### 3.2 握手成功（验证台左栏）

七步逐项打勾，每步给出耗时与关键标识：

```
① NS 查询        12ms   设备名发现
② 主连接 NS       8ms   seq=02 拓扑对齐
③ 开通道          6ms   chId 分配
④ 会话创建        5ms   service 01/01
⑤ 登录            7ms   session_id 下发
⑥ GetRoot         9ms   根句柄 + 设备令牌
⑦ PrepareRead    11ms   名单登记
```

任一环节失败，该步标红并给出中文原因（超时 / 端口拒绝 / 变量名无效 / 通道号耗尽）。

### 3.3 周期读运行中

- **RTT 曲线**：最近 80 次读的往返耗时，附最小/平均/最大
- **读成功率**：按**最近 80 次**计算（不是累计），近期抖动会立刻反映
- **TX / RX 帧数**、**读帧数**、**TOP 变量值卡片**实时刷新
- 底部控制台滚动报文流水：`→ 09/03 ExecuteRead` / `← 09/03 响应 #123 21 条目 RTT 9ms`

### 3.4 写入验证

首页「写入验证 · 全量」面板：

1. 点「选择变量…」→ 弹窗列出全部可写项
   - 标量：直接点行选中
   - 数组：展开成 `aAlarmFlag[0] [1] [2] …`
   - 结构体数组：展开成 `aAxisCtl[3]` → 再展开成 `fActPosition` / `tState.bValid` …（逐级折叠）
2. 选中后自动加入监控列表（能立刻看到实时值）
3. 点「写入并回读」，会依次显示：

```
┌ 写入开始：aAlarmCode[0]（GVL_MAIN.aAlarmCode[0]）
│ ① 写入前当前值 = 0
│ ② 目标值 = 12345（写入后保留）
[ok] ③ 09/04 写入 status=0x0 · 0ms
[ok] ④ 回读校验 = 12345　与目标一致 ✓
└ ✅ 写入成功　PLC 当前值 = 12345　耗时 4ms
```

### 3.5 全量变量页（点「全量变量」按钮）

全部符号一屏列出（演示工程 44 个），每个可写标量行**自带输入框 + 写入按钮**，
改完点写入（或回车）即写 PLC，结果以底部吐司提示；复合符号点「展开」进成员弹窗逐项读写。

---

## 4. 目录结构

```
CODESYS_V3_client/
├── README.md                  ← 本文件
├── package.json
├── 0-check-env.bat            ← 体检：Node / 依赖 ws / Python（导入报 9009 时先跑它）
├── START-HERE.bat             ← 一键：检查环境 → 生成数据 → 起服务 → 开浏览器
├── 1-gen-tags.bat             ← XML → 数据文件
├── 2-run-verify.bat           ← 启动服务（可带程序名参数）
├── 3-self-test.bat            ← 跑自检用例
│
├── server/
│   ├── codesys-v3-client.js   ← 【核心】协议客户端（535 行）
│   ├── drill-core.js          ← 【核心】类型导航 / 偏移解码（310 行）
│   ├── py-probe.js            ← 探测本机 Python（导入 XML 的前置条件，见 docs/02 §0.5）
│   ├── verify-server.js       ← 验证台服务：HTTP + WebSocket
│   ├── write-whitelist.json   ← 写入白名单（服务端强校验）
│   ├── plc-config.example.json ← PLC 地址配置样例
│   ├── gen/                   ← 生成的点表（开箱即用）
│   ├── profiles/              ← 选点档案
│   └── node_modules/ws/       ← 唯一依赖（拷贝交付时附带；Git 克隆后需根目录 npm install）
│
├── verify/                    ← 验证台前端（原生 JS，无构建）
│   ├── index.html  verify.css  verify.js    主界面
│   └── full.html   full.css    full.js      全量变量页
│
├── tools/
│   ├── gen_tags.py            ← XML → 点表/符号/类型库
│   ├── codesys_symconfig.py   ← XML → 布局表 + 审计报告
│   ├── make-demo-xml.py       ← 生成合成示例工程（脱敏用）
│   ├── probe-latency.js       ← 归因探针：扫描耗时是「块数多」还是「单块往返慢」
│   └── points_template.csv    ← 点表模板（批量选点用）
│
├── tests/                     ← 自检用例（见第 7 节）
│   ├── run-all.js             ← 一键运行器
│   └── test-*.js  inspect-state.js
│
├── example/
│   ├── DEMO_MACHINE.Device.Application.xml  ← 合成示例工程（复现起点，非真实设备）
│   └── embed-demo.js          ← 可直接运行的接入示例（7 步握手 + 读 + no-op 写）
│
├── out/<APP>/                 ← 全量表 / CSV / 布局头文件 / 审计报告
└── docs/
    ├── 01-协议手册.md          ← 帧格式与命令逐字段说明
    ├── 02-源码手册.md          ← 逐文件、逐函数导读
    ├── 03-复现流程.md          ← 从零到跑通的完整步骤
    └── 04-示例数据与脱敏说明.md ← 示例工程怎么来的、换自己工程该改哪里
```

> **脚本名为什么是英文**：`.bat` 里只要出现中文，Windows 的 cmd 在切换代码页时会错位解析
> （表现为 `'xxx' is not recognized` 或 `unexpected at this time`）。所以脚本内容与文件名一律用 ASCII，
> 中文提示放在本文档；脚本内部用 `chcp 65001` 保证 Node 输出的中文正常显示。

---

## 5. 配置项

### 5.1 PLC 地址（推荐用界面改）

优先级：`server/plc-config.json` > 环境变量 > 内置默认 `192.168.1.92:11740`

```json
{
  "host": "192.168.1.92",
  "port": 11740,
  "savedAt": "2026-11-12T03:43:48.578Z"
}
```

界面改一次就会写这个文件；想恢复默认就删掉它。

### 5.2 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MYX_HOST` | `192.168.1.92` | PLC 地址（被 plc-config.json 覆盖） |
| `MYX_PLC_PORT` | `11740` | PLC 端口 |
| `MYX_VERIFY_PORT` | `8095` | 验证台 Web 端口 |
| `MYX_APP` | 自动选最新 | 用哪套点表（`server/gen/<APP>.tags.json`） |
| `MYX_SRC` | 系统默认路由 | **强制绑定源网卡**：多网卡机器上固定走有线，避免 Wi-Fi 抢占路由 |
| `MYX_READONLY` | 未设 | `=1` 时禁用一切写入（读仍可用） |
| `MYX_BIG_SYM_BYTES` | `0` | **默认完整读**：全部符号每轮都刷新。只有设成非 0 值才会把超过该字节数的复合符号改为「点开时按需读」（牺牲这些行的自动刷新，不建议改） |
| `MYX_PYTHON` | 未设 | 指定 python.exe 全路径（PATH 里没有 python 时用，见第 10 节 9009 那条） |

### 5.3 写入白名单

`server/write-whitelist.json` 是服务端强校验：不在名单内的变量**一律拒绝写入**，
即使调用方绕过前端也写不进去。默认名单只含设计上就该由人写的设定值/命令。

```json
{
  "allow": [
    { "name": "GVL_STATION.diTarget", "type": "DINT" },
    { "name": "GVL_MAIN.diTotalCount", "type": "DINT" }
  ]
}
```

`MYX_READONLY=1` 与白名单是两道独立闸门，任一关闭即不可写。

---

## 6. 能读写哪些变量

### 6.1 变量写法

| 形态 | 示例 | 说明 |
|---|---|---|
| 标量 | `GVL_MAIN.diTotalCount` | 直接读写 |
| 数组元素 | `GVL_MAIN.aAlarmCode[3]` | 下标从 XML 声明的 `minrange` 起 |
| 结构体成员 | `GVL_AXIS.aAxisCtl[3].fActPosition` | 数组元素 + 成员 |
| 嵌套成员 | `GVL_AXIS.aAxisCtl[3].tState.bValid` | 任意深度 |
| 结构体符号 | `GVL_STATION.aCell[1].uResult.di` | UNION 内成员也可 |

> **注意**：GVL 名本身可能含点（`GVL_AXIS.aAxisCtl`），
> 因此路径拆分必须按**符号表最长前缀匹配**，不能按第一个 `.` 切。客户端与服务端都已按此实现。

### 6.2 支持的可写类型

`BOOL` `BYTE` `SINT` `USINT` `INT` `UINT` `WORD` `DINT` `UDINT` `DWORD` `TIME` `REAL` `LREAL` `LINT`

BOOL 必须按 **1 字节**写入（4 字节会被 PLC 以 `0x0F` 拒绝）。

### 6.3 整体写入的限制

数组 / 结构体 / 功能块**没有整体单值写入语义**，只能展开后逐成员写。
验证台对此的处理：复合符号只给「展开」，标量符号才给输入框。

---

## 7. 自带的自检

双击 **`3-self-test.bat`**（自检），或 `node tests/run-all.js`。运行器按当前可用环境自动选择用例：

| 用例 | 级别 | 验证什么 |
|---|---|---|
| `test-union-learn.js` | 离线 | 类型导航、结构展开、UNION 布局对账（合成数据，无需 PLC） |
| `test-py-probe.js` | 离线 | 导入前置的 python 探测（9009 / Store 占位别名 / MYX_PYTHON 回退） |
| `test-rate-window.js` | 服务 | 读成功率「最近 80 次」滑动窗口 |
| `test-key-parse.js` | 服务 | 四类变量写法解析（标量/数组/成员/嵌套） |
| `test-member-tree.js` | 服务 | 成员树接口返回折叠结构而非平铺 |
| `test-full-write.js` | 服务 | 全量页行内写入渲染与提交 |
| `test-index-smoke.js` | 服务 | 首页启动与广播无空引用 |
| `test-plc-config.js` | 服务 | 地址配置接口 + 10 类非法输入拒绝 |
| `test-big-sym.js` | 服务 | 完整读契约：默认每个符号都在周期扫描里（含 32KB 大数组） |
| `test-input-width.js` | 浏览器 | 无头 Chrome 实测输入框等长几何 |
| `inspect-state.js` | 服务 | 打印状态与最近事件（人工阅读） |
| `test-watch.js` | 真机 | 监控列表实时值 |
| `test-write.js` | 真机 | 写入闭环（默认 no-op 回写，不改现场） |

**典型输出**

```
════════════════════════════════════════════════
  CODESYS V3 客户端 · 自检
  服务端 在线（http://127.0.0.1:8095）
  Chrome 可用
════════════════════════════════════════════════

  ✓ test-union-learn.js    133ms  类型导航 / UNION 布局学习（纯逻辑）
  ✓ test-py-probe.js        88ms  导入前置：python 探测（9009 / 占位别名 / MYX_PYTHON）
  ✓ test-rate-window.js    109ms  读成功率滑动窗口算法
  ✓ test-key-parse.js      153ms  变量路径解析（数组元素 / 结构体成员）
  ✓ test-member-tree.js    197ms  结构体成员树接口（折叠结构）
  ✓ test-full-write.js     301ms  全量页行内写入渲染与提交
  ✓ test-index-smoke.js    220ms  首页启动与广播无空引用
  ✓ test-plc-config.js     200ms  PLC 地址配置接口与校验
  ✓ test-big-sym.js        150ms  完整读契约（全部符号每轮都刷新）
  ✓ test-input-width.js   3588ms  输入框等长（无头 Chrome 实测几何）
  ✓ inspect-state.js       159ms  链路状态与事件时间线（人工查看）

────────────────────────────────────────────────
  通过 11 · 失败 0 · 跳过 2
```

三种用法：

```bash
node tests/run-all.js            # 自动探测环境
node tests/run-all.js --offline  # 只跑纯离线用例（无服务端、无 PLC）
node tests/run-all.js --all      # 全跑（需服务端 + Chrome + PLC 在线）
```

服务不在默认端口时，设 `MYX_TEST_BASE`：

```bash
set MYX_TEST_BASE=http://127.0.0.1:8090
node tests/run-all.js
```

---

## 8. 命令行用法

### 8.1 独立客户端演示（不经 Web）

```bash
node server/codesys-v3-client.js 192.168.1.92
```

按 7 步握手后读 18 个示例变量 6 轮：

```
── 192.168.1.92:11740 直连测试（纯 Node 协议栈，无 dll，只读） ──
① NS 查询      : 3S CODESYS PLC
   主连接 NS 查询 OK
② 开通道        : chId = 0x1
③ 会话创建      : 响应 28B
④ 登录          : sessionId = 0x00000001
⑤ GetRoot       : Application 句柄 = 0x00000001
⑥ PrepareRead   : 读取列表句柄 = 0x00000002
⑦ ExecuteRead   : 周期读取 6 轮（500ms）

── 第 1 轮 ──
  GVL_MAIN.diTotalCount               = <当前值>
  GVL_MAIN.lrSpeed                    = <当前值>
  ...
```

### 8.2 嵌入自己的代码

```js
const { CodesysV3Client } = require('./server/codesys-v3-client');

const c = new CodesysV3Client('192.168.1.92', 11740, { allowWrite: false });

await c.nsQuery();                 // ① 设备名（独立短连接，用完即关）
await c.connect();                 // 建立主连接
await c.nsQueryOnMain();           // ② 主连接首包必须是 NS 查询
await c.openChannel();             // ③ 开通道
await c.sessionCreate();           // ④ 会话
await c.login();                   // ⑤ 登录
await c.getRoot();                 // ⑥ 根句柄 + 设备令牌

// ⑦ 按名登记 → 周期读
await c.prepareRead(['Application.GVL_MAIN.diTotalCount',
                     'Application.GVL_MAIN.bEStop']);
const bufs = await c.executeRead();      // Buffer[]，与登记顺序一致
console.log(bufs[0].readInt32LE(0));     // DINT

// 写入（需 allowWrite:true，且是单条请求，无需 PrepareWrite）
c.allowWrite = true;
const r = await c.writeValue('Application.GVL_MAIN.diTotalCount', Buffer.from([0x39, 0x30, 0, 0]));
console.log(r.ok, r.status);             // ok=true, status=0

c.sock.destroy();
```

> 单连接约束：PLC 11740 **一次只服务一个 TCP 连接**，读写必须串行。
> 验证台内部用单连接串行队列实现；自己嵌代码时同样要保证不并发。

### 8.3 只改点表（换程序）

```bash
python tools/gen_tags.py example/新程序.Device.Application.xml
python tools/gen_tags.py --all            # 扫描 example/ 与 Test/ 全部 XML
python tools/gen_tags.py <xml> --check    # 只校验不落盘（CI 用）
python tools/gen_tags.py --list           # 列出已导入程序
```

---

## 9. 工作原理速览

```
① NS 查询 (UDP 风格短连接)   → 拿设备名，随后立刻关闭
② 主连接 NS 查询 (seq=02)    → 与厂商拓扑对齐
③ 开通道                     → chId
④ 会话创建  service 01/01    → 通道就绪
⑤ 登录      service 01/02    → session_id
⑥ GetRoot   service 09/07    → Application 句柄 + 设备令牌（后续登记必须带回）
⑦ PrepareRead  service 09/01 → 按 "Application.xxx" 全名登记，拿列表句柄
   周期 ExecuteRead 09/03    → 一次请求读回全部登记变量
   写入 WriteValue 09/04     → 单条请求，响应状态码 0 即成功
```

**帧结构与关键约束**（详见 `docs/01-协议手册.md`）：

- 帧上限 **516 字节**；首块服务载荷 ≤468B，续块 ≤448B（续块通道头只有 12B）
- 块校验 = `CRC32(service 载荷)`
- 值域长度是**双字节变长编码**：`(w1-0x80) + ((w2-0x80) << 7)`，单条上限 16383B
- PrepareRead 载荷按 **460B** 预算分批（超 1 块会触发 PLC 缓冲配额错误）

**结构体偏移的两条路径**：

| 布局可信（XML 给了 size 与成员偏移） | 布局可疑（UNION / size=0 / 成员重叠） |
|---|---|
| 整符号一次读回，本地按偏移解码 | 先逐名读做基准，再与整读 blob **对账** |
| 一次报文取回全部成员，快 | 推导真实元素步长与成员偏移，全叶一致才缓存 |
| — | 对不上就回退逐名读，绝不用错布局出值 |

---

## 10. 常见问题

**Q：全量页「扫描耗时」特别长（几百毫秒），但变量其实没几个**
A：**先看「数据量」而不是「变量」**——耗时模型是

```
扫描耗时 ≈ 响应块数 × 单块往返        （块数 = 数据量 ÷ 448B）
```

PLC 把响应按 ≤448B 一块切分，且**每个数据块都必须单独 ACK**（不回 ACK 会被判通道错误 8400）。
所以 31.3KB 的数据 = 约 72 块 = 72 次「收块→回 ACK」往返。1 个 `ARRAY[0..7999] OF REAL`
就是一个 32KB 的变量，它比 200 个标量还贵。

两个乘数分别怎么查：

| 现象 | 结论 | 处理 |
|---|---|---|
| 每块 0.5~1ms（有线同网段） | 正常，就是块数的算术结果 | 无需处理；把不必要的大数组从符号配置里去掉 |
| 每块 4~10ms，扫描 500ms+ | **链路单块往返慢**：Wi-Fi / 跨网段 / VPN / 网卡节能 | 网线直连同一交换机；多网卡机设 `MYX_SRC=<有线网卡IP>`；关 VPN；网卡属性关节能/中断节流 |

现场查证一条命令（只读，不写任何变量）：

```bash
node tools/probe-latency.js              # 自动挑最大的符号
node tools/probe-latency.js 192.168.1.92 "GVL.CommValue"
```

它会给出「单块往返基准」和「大块每块耗时」，两者一比就知道是链路问题还是块数问题。

> **默认行为：完整读。** 全部符号（含大数组/结构体）每轮都参与扫描，
> 不会为了提速把任何变量排除在刷新之外。`MYX_BIG_SYM_BYTES` 默认为 `0`；
> 只有你显式设成非 0 值时才会把超过该字节数的复合符号改成「点开时按需读」
> （代价是那些行不再自动刷新）。这是唯一会牺牲刷新完整性的开关，正常情况下不要动它。

**Q：导入 XML 报「gen_tags.py 退出码 9009」，但我这边同一份 XML 是好的**
A：与 XML 无关，是**那台机器的 `python` 命令跑不起来**。`9009` 是 Windows 的
「命令未找到」，含义是 `gen_tags.py` **一行都没执行**（没有任何 Python 报错输出就是证据）。
三种典型原因：
① 没装 Python；② 装了但安装时没勾 **Add python.exe to PATH**；
③ `python` 这个名字命中了 `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` ——
那是应用商店的 0 字节**占位别名**，没有真 Python 时执行它直接返回 9009。
处理：
- 让对方先跑 **`0-check-env.bat`**，它会逐项检查并指出是哪种情况；
- 装 Python 3.8+ 并勾上 Add to PATH，**重开**命令行/验证台（已开的进程继承的是旧 PATH）；
- 已有 Python 但不在 PATH：设 `MYX_PYTHON=C:\Python312\python.exe` 再启动，服务、脚本、
  `.bat` 都会优先用它；
- 自检：`python -V` 要能打印 `Python 3.x`，且**不能弹出应用商店**。

> 现在服务端在导入前会先探测解释器（`python` → `py -3` → `python3` → `MYX_PYTHON`），
> 探测不到时界面顶部会直接给出原因和处置办法，不再只回一个裸退出码；
> 启动日志也会打印 `导入 python 3.x (…)` 或明确的失败原因。

**Q：握手卡在「NS 查询 · 读帧超时」**
A：① 确认 IP 端口可达（`telnet 192.168.1.92 11740`）；② 确认没有别的客户端占用——PLC 只接受一条连接，
上一个进程被强杀后 socket 可能还被占着，等 PLC 自己回收（约数秒）或重启 PLC 侧服务；
③ 多网卡机器加 `set MYX_SRC=<有线网卡IP>` 固定走有线。

**Q：报「应答超时（网络抖动 / PLC 忙 / 通道号耗尽）」**
A：绝大多数是上一条的第二种情况（连接名额被占）。正常停服务请用 `Ctrl+C` 或关窗口，
不要用任务管理器强杀——服务本身已带优雅退出处理。

**Q：写入返回 status=0 但值没变**
A：写的是 PLC 输入映射点（如某些 `*_IN` 变量）。写入本身成功，但 PLC 扫描周期会立即用实际输入覆盖。
这类点设计上不可改写，验证台会给出专门提示。

**Q：报「未知变量」**
A：① 名字必须与 XML 符号配置一致（含大小写）；② 数组下标要在声明范围内；
③ 复合符号不能整体写，要写到成员级。

**Q：结构体成员值看起来不对**
A：多半是 UNION 或布局可疑类型。这类类型第一次访问会走「对账」流程（稍慢），
通过后布局会缓存到 `out/<APP>/drill-layout.json`，之后是快路径。
如果对账不通过，客户端会**拒绝使用整读**，回退逐名读（慢但正确）。

**Q：换了一台 PLC 怎么用**
A：同一个程序的符号表可以复用；只在界面左上角改 IP 即可。换了 PLC 程序则需重新导入 XML 生成点表。

**Q：服务起不来，提示端口占用**
A：`MYX_VERIFY_PORT` 换端口，或先关掉占 8095 的进程。

---

## 11. 文档索引

| 文档 | 内容 |
|---|---|
| `docs/01-协议手册.md` | 帧格式、命令字段、值编码、错误码、交互时序 |
| `docs/02-源码手册.md` | 逐文件、逐函数：职责、入参、返回、关键实现 |
| `docs/03-复现流程.md` | 从空目录到跑通的完整步骤，每步的预期输出 |
| `docs/04-示例数据与脱敏说明.md` | 示例工程是合成的、哪些信息被替换、换成自己工程怎么改 |

---

## 许可与使用边界

内部工程用途。写入功能会真实改变 PLC 现场值：

- 默认 `allowWrite=false`（客户端层）且白名单过滤（服务端层）
- 自检用例默认只做 **no-op 回写**（写回刚读到的原值），不改变现场
- 对安全相关变量（急停、安全门、轴使能等）请勿用本工具写入，除非已确认工艺安全
