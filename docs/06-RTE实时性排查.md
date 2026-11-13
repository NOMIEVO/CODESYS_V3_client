# 06 · RTE / 软 PLC 实时性排查

> 现象：同一客户端、同一交换机，接硬件 PLC 每操作 ≈0.4ms，接 Win10 工控机 ≈8.9ms
> （96% 落在 8.5~9.0ms 的窄区间，8.5/9.0 交替）→ 几百次操作就是几秒。
> 本文回答：**这是不是 CODESYS 侧的问题、官方怎么要求、该动哪些开关**

---

## 0. 先确认对端到底是什么（这一步不能跳）

NS 查询能直接读出对端身份（`/api/meta` 的 `device` 字段，或启动日志「对端 …」）：

```
deviceName : <厂商设备名，如 xxx_IPC30E_64b>
vendor     : <厂商名>
nodeName   : <节点名>
```

它决定了后面所有动作的方向：

| 对端类型 | 有没有实时核 | 节拍来源 | 优先动作 |
|---|---|---|---|
| **CODESYS Control RTE**（设备名/服务带 RTE） | 有（独占物理核） | 实时核没拿到 / 任务周期 / 虚拟化冲突 | 第 2、3 节 |
| **CODESYS Control Win / SL**（无 RTE 字样） | **没有**，普通 Windows 进程 | Windows 线程调度 + 运行时任务周期 | 第 1 节 |
| 硬件 PLC | 固件级 | 出厂即 0.4ms | 无需处理 |

**怎么确认**（在工控机上跑）：

```powershell
Get-Service | Where-Object { $_.Name -match '^CmpDrvScheduler|^CODESYSControl' } |
  Select-Object Name, Status, StartType
```

- 出现 `CmpDrvSchedulerAMP`（或 `...APIC`）→ **RTE**，有实时核
- 只有 `CODESYSControlService` / `CODESYSControlWinV3x64` → **Control Win**，无实时核

> 厂商会改设备名，字样可能被盖掉，所以以**服务名**为准最可靠。

---

## 1. 如果对端是 Control Win（无实时核）

**毫秒级是它的正常水平，不是故障。** 它作为普通 Windows 进程被调度，
每个请求都要等线程调度 + 运行时任务周期。

能做的三件（收益有限但真实）：

1. 电源计划「卓越性能/高性能」、最小处理器状态 100%
2. 关网卡中断节流与节能（见 `docs/05-工控机参数体检.md`），拿回 0.5~1.5ms
3. **减少操作数**：符号配置只勾要看的变量，大数组只勾需要的元素

要拿到 0.4ms 级别，只能换硬件 PLC 或改用 RTE。这是产品形态差异。

---

## 2. 如果对端是 RTE：官方硬性要求

来源（CODESYS 官方帮助）：
- 《Configuring Real-Time Behavior on Special Platforms》
  https://content.helpme-codesys.com/en/CODESYS%20Control/_rtsl_windows_rte_v3_configure_realtime.html
- 《Hardware Configuration – Recommendations》
  https://content.helpme-codesys.com/en/CODESYS%20Control/_rtsl_windows_rte_v3_examples_hints.html

### 2.1 BIOS 必须关闭

| 项 | 原文要点 |
|---|---|
| **VT / AMD-V** | Win10+ 下 VT 会让 **Windows 自身跑在虚拟化环境里，RTE 因此无法启动 CPU 核** |
| **HT / SMT** | 独占核会被兄弟线程干扰 |
| **C-States** | 睡眠态会降电压/频率，并关缓存与服务区域 |
| **EIST / SpeedStep / Cool'n'Quiet** | 频率变化让微秒级计时失准 |
| **Legacy USB 等引起周期性 SMI 的功能** | SMI 会让整机停几十到几百微秒 |
| **周期性自检 / 内存测试** | 同上 |
| **E-Core（Intel 12 代及以后）** | 能效核参与调度会破坏实时性 |

> VT 不能关时的**替代方案**：禁用 Windows「虚拟机平台」或「Windows 虚拟机管理程序平台」功能。
> 官方明确说：关 BIOS 的 VT 更好。

### 2.2 Windows 侧

| 项 | 要求 |
|---|---|
| 电源方案 | **Always on**（高性能 / 卓越性能） |
| 快速启动、休眠 | **必须禁用**（会改变 CPU 频率） |
| RTE 用的网卡 | **不得设置睡眠模式** |
| 自动更新 | 工业控制器应**手动**更新 |

### 2.3 时钟校准值（容易踩）

RTE 首次启动会把时钟缩放到微秒，结果写进注册表：

```
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\CmpDrvSchedulerAMP\Params
  值：SetClocksPerUS 、 SetCountsPerMS
```

**若系统改动（例如 BIOS 节能设置）导致 CPU 频率与测量时不同，必须删除这两个值**，
RTE 下次启动才会重新测量。否则实时计时整体偏斜，表现是「时间尺度不对」，
很难从现象反推。

### 2.4 RTE 控制面板

`CODESYS Control RTE` 工具的 **Real-Time** 页：

- 指定 RTE 独占哪几个**物理核**
- 用 **Core Isolation** 把 Windows 调度器排除在这些核外
- 改完**整机断电冷启**（软重启不重置固件级电源状态）

---

## 3. 判定：优先查虚拟化，再查任务周期

匹配这种形态的组合：

| 观察 | 含义 |
|---|---|
| 每操作 8.9ms，96% 落窄峰 | 固定节拍，不是抖动、不是丢包 |
| TCP 握手 1.1ms（同一块网卡） | 网卡与网络路径健康 |
| 客户端回 ACK 6µs | 客户端无责任 |
| 机器装了 VMware（有 VMnet 虚拟网卡） | **VT 极可能开着 → 撞官方第 1 条** |

> 取舍要说清：**VMware 需要 VT，RTE 需要 VT 关，二者只能选一。**
> 生产机必须保留 VMware 时，RTE 实时性保不住，只能退回第 1 节的做法，
> 或把 RTE 挪到不跑虚拟化的机器。

**另一个不用改 BIOS 的可疑项：任务周期。** 先在 CODESYS 工程 →
Task Configuration 看主任务 Interval（默认 10ms 很常见），改小后重新下载，
用 `probe-blockgap` 复测：间隔中位跟着变 → 节拍就是它。

---

## 4. 执行顺序（成本从低到高）

```
① 确认对端类型（服务名有无 CmpDrvScheduler）          5 分钟
② 跑 win-rte-check.ps1 看虚拟化与电源项               2 分钟
③ 看 Task Configuration 主任务周期，改小后复测         10 分钟，不改系统
④ 若 ③ 无效且是 RTE：
     BIOS 关 VT（或关「虚拟机平台」+ 关内核隔离内存完整性）
     BIOS 关 HT / C-States / EIST / Legacy USB / E-Core
     电源方案 Always on、关快速启动与休眠
     删 CmpDrvSchedulerAMP\Params 下 SetClocksPerUS / SetCountsPerMS
     RTE 面板指定专用核 + Core Isolation
     整机断电冷启
⑤ 每步都用 probe-blockgap 复测，记录中位
⑥ 全做完仍 ~9ms → 对端形态限制（Control Win），转「减少操作数」
```

---

## 4.5 验收标准（每一步的通过线，别只看"好像快了"）

所有判断都收敛到**同一个数字**：`probe-blockgap` 输出的「相邻块间隔中位」。

```bash
node tools/probe-blockgap.js <PLC_IP> <APP> <大数组符号>
```

当前基线（现场实测，工控机 192.168.1.92 / Q&C_IPC30E_64b）：

```
92 块 · 835ms/781ms/817ms（三轮）· 平均每块 8.5~9.1ms
相邻块间隔：min 1.57 · p25 8.49 · 中位 8.89 · p75 8.99 · max 16.02
91 个样本中 84 个落在 8.01~9.34ms 一个桶里（96%）
→ 单峰、极窄 = 固定节拍，不是抖动
```

| 步骤 | 通过线 | 不通过说明什么 |
|---|---|---|
| ① 确认形态 | 出现 `CmpDrvScheduler*` 服务 | 没有 → 是 Control Win，第 2、3 节全部不适用，直接转第 1 节 |
| ② 虚拟化 | `HypervisorPresent=False`、`hypervisorlaunchtype=off`、VBS=0、HVCI 关 | 仍为 True → RTE 拿不到核，后面的 BIOS 项都不用试，先解决这个 |
| ③ 任务周期 | 改小 Interval 后**间隔中位跟着变**（如 10ms→2ms，中位应从 ~8.9 掉到 ~2 附近） | 跟着变 → **节拍就是任务周期，收工**，不必碰 BIOS<br>不变 → 节拍来自别处，继续 ④ |
| ④ BIOS 全套 | 间隔中位重新贴近 Interval，且 p95 与中位差距 < 30% | 中位不动 → 多半还是虚拟化没彻底关（②没真通过）<br>中位降了但 p95 很大 → 抖动/干扰源未清干净 |
| ⑤ 时钟校准 | 仅"改过 BIOS 频率设置"后才需要；删完冷启，间隔应更稳（p95 收窄） | 删了没变化 → 说明频率没变，属正常 |

**最终目标**：间隔中位 ≤ 2ms。此时 596 符号（约 320 块）一轮从 2.8s 降到 ~0.6s。

> 全过程只改 PLC 无响应性的环境参数，不碰程序逻辑、不碰符号配置。

### 四条常见"白改"情形（提前避坑）

| 情形 | 症状 | 原因 |
|---|---|---|
| 只改了网卡参数 | 中位从 8.9 变 8.2 | 网卡只占往返的一部分，物理上限在 PLC 节拍 |
| 关了 HT 但 VT 还开着 | 中位不变 | 虚拟化冲突优先级最高，HT 是二级因素 |
| 改完不冷启 | 一切照旧 | RTE 独占核与频率状态在冷启时才重新确定 |
| 改完任务周期没重新下载 | 中位不变 | Interval 是下载进 PLC 的工程参数，不是运行时设置 |

---

## 5. 工具

```powershell
# 只读体检：虚拟化 / 电源 / RTE 组件 / 时钟校准值 / 干扰源
powershell -ExecutionPolicy Bypass -File tools\win-rte-check.ps1

# 只改 Windows 侧安全项（电源计划、最小处理器状态、关快速启动与休眠）
powershell -ExecutionPolicy Bypass -File tools\win-rte-check.ps1 -Apply -DryRun
powershell -ExecutionPolicy Bypass -File tools\win-rte-check.ps1 -Apply

# 删除 RTE 时钟校准值（官方做法，下次启动自动重测；改完整机断电）
powershell -ExecutionPolicy Bypass -File tools\win-rte-check.ps1 -ResetClockCalibration
```

工具不改 BIOS（做不到），但会把「该去 BIOS 改哪几项、为什么」逐条列出，
必须改的标 `[!!!]`。

---

## 6. 一句话总结

是 CODESYS 侧的约束，且是官方文档写明的：**RTE 必须拿到独占物理核才有微秒级实时性**；
VT/Hyper-V/VBS 开着必然退化；HT/C-States/EIST 引入抖动；任务周期决定节拍长度。
网络已被实测排除——150KB/4.5s 只有 33KB/s，连千兆口的 0.03% 都不到。

要既快又稳，只有两条路：**把 RTE 的实时条件配齐**，或**换回硬件 PLC**。
在 Control Win 或虚拟化冲突未解决前，网卡调参只能拿回 10~15%。
