# CODESYS 符号配置审计报告

| 项 | 值 |
|---|---|
| 源文件 | `DEMO_MACHINE.Device.Application.xml` |
| 工程 / 设备 / 应用 | DEMO_MACHINE / Device / Application |
| SymbolConfig 版本 | 3.5.14.0 |
| CODESYS 编译器 profile | CODESYS V3.5 SP22 Patch 1+ |
| 运行时 ID | 3.5.17.40 |
| GVL 数 | 5 |
| 符号数 | 44 |
| 叶子点位数 | 968 |
| 总字节数 | 1839 |
| 只读符号 | 0 |
| 布局待验证符号 | 0 |
| 可写符号 | 44 |

## 1. 各 GVL 负载

| GVL | 符号 | 叶子点 | 字节 | 备注 |
|---|---:|---:|---:|---|
| `Application.GVL_MAIN` | 21 | 665 | 1087 | |
| `Application.GVL_AXIS` | 2 | 256 | 608 | |
| `Application.GVL_STATION` | 12 | 29 | 113 | |
| `Application.GVL_PANEL` | 2 | 11 | 20 | |
| `Application.GVL_IO` | 7 | 7 | 11 | |

## 2. 写权限越界（需在符号配置里逐个改为只读）

共 **44** 个符号为 ReadWrite，其中 0 个按命名判断应归 PLC 独占写。


## 3. 布局不可信（禁止按字节解码）

以下类型的声明 size 与成员推算矛盾（声明为 0，或差值超过对齐值），
说明该类型为优化布局、或类型定义不在本工程内，**不能按偏移解码**：

| 类型 | 声明字节 | 推算字节 | 结论 |
|---|---:|---:|---|
| `T_ST_CELL` | 1 | 12 | 禁止字节解码 |
| `T_U_CELL_RESULT` | 0 | 8 | 禁止字节解码 |

## 4. FB 实例数组（应排除出符号配置）


## 5. 体积 Top 8

| 符号 | 字节 | 叶子点 |
|---|---:|---:|
| `aAxisCtl` | 352 | 176 |
| `aAxisParam` | 256 | 80 |
| `aAlarmCode` | 202 | 101 |
| `aInfoCode` | 202 | 101 |
| `aErrCode` | 202 | 101 |
| `aAlarmFlag` | 101 | 101 |
| `aInfoFlag` | 101 | 101 |
| `aErrFlag` | 101 | 101 |

## 6. 命名检查

按规则自动检出的可疑命名（不是错误，只是提示）：

无。

> OPC UA 的 NodeId 直接由符号路径构成，运行中改名会让 HMI 侧变成 `BadNodeIdUnknown`。
> 因此**不建议对已投产的符号改名**，只在新建 GVL 时遵守命名规范。

