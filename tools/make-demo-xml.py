#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make-demo-xml.py —— 生成一份**纯合成**的 CODESYS 符号配置 XML（用于示例与自检）

为什么需要它：
    仓库不能带真实产线的符号配置（变量名、结构、注释都属于现场信息）。
    但示例又必须真的能被解析、能覆盖全部代码路径，所以这里按 CODESYS
    「符号配置」导出格式合成一份演示工程 DEMO_MACHINE。

它覆盖的类型/结构（与真实工程等价，只是名字通用）：
    · IEC 标量：BOOL DINT REAL LREAL INT UINT WORD TIME STRING …
    · 一维数组：BOOL / INT / DINT / REAL，含非 0 起始下标（ARRAY[1..6]）
    · 结构体：含嵌套结构体、结构体内数组
    · 结构体数组：ARRAY[0..7] OF 结构体（元素内有嵌套结构体 + 内部数组）
    · 枚举：E_MODE / E_PRODUCT_RESULT
    · UNION 及「布局可疑」结构：声明尺寸与成员矛盾的 ST_CELL
      （刻意复现真实工程里那种 size 不可信的情形，用于验证布局对账逻辑）

用法：
    python tools/make-demo-xml.py                  写入 example/DEMO_MACHINE.Device.Application.xml
    python tools/make-demo-xml.py -o 其他路径.xml
"""

import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ─────────────────────────────────────────────────────────────
# 类型定义：名字 → (size, nativesize, typeclass, iecname, basetype, members)
#   members 项： (iecname, type, byteoffset, access)
# ─────────────────────────────────────────────────────────────
SIMPLE = [
    # name,        size, iecname,  typeclass
    ('T_BOOL',     1, 'BOOL',    'Bool'),
    ('T_SINT',     1, 'SINT',    'SInt'),
    ('T_USINT',    1, 'USINT',   'USInt'),
    ('T_BYTE',     1, 'BYTE',    'Byte'),
    ('T_INT',      2, 'INT',     'Int'),
    ('T_UINT',     2, 'UINT',    'UInt'),
    ('T_WORD',     2, 'WORD',    'Word'),
    ('T_DINT',     4, 'DINT',    'DInt'),
    ('T_UDINT',    4, 'UDINT',   'UDInt'),
    ('T_DWORD',    4, 'DWORD',   'DWord'),
    ('T_REAL',     4, 'REAL',    'Real'),
    ('T_LREAL',    8, 'LREAL',   'LReal'),
    ('T_TIME',     4, 'TIME',    'Time'),
    ('T_STRING',  81, 'STRING',  'String'),
]

# 枚举（basetype 必须是已声明的简单类型）
ENUMS = [
    ('T_E_MODE', 'E_MODE', 'T_INT', [
        ('IDLE', 0), ('MANUAL', 1), ('AUTO', 2), ('FAULT', 3), ('MAINT', 4),
    ]),
    ('T_E_PRODUCT_RESULT', 'E_PRODUCT_RESULT', 'T_INT', [
        ('NONE', 0), ('OK', 1), ('NG', 2),
    ]),
]

# 结构体：name, iecname, size, nativesize, members
STRUCTS = [
    # 嵌套用：轴状态（16B）
    ('T_ST_AXIS_STATE', 'ST_AXIS_STATE', 16, 16, [
        ('bValid',    'T_BOOL',  0, 'ReadWrite'),
        ('bBusy',     'T_BOOL',  1, 'ReadWrite'),
        ('bError',    'T_BOOL',  2, 'ReadWrite'),
        ('diErrorID', 'T_INT',   4, 'ReadWrite'),
        ('bDisabled', 'T_BOOL',  6, 'ReadWrite'),
        ('bStopped',  'T_BOOL',  7, 'ReadWrite'),
        ('bMoving',   'T_BOOL',  8, 'ReadWrite'),
        ('bHomed',    'T_BOOL',  9, 'ReadWrite'),
        ('tElapsed',  'T_TIME', 12, 'ReadWrite'),
    ]),
    # 结构体数组的元素类型（44B，内含嵌套结构体 + 内部数组）
    ('T_ST_AXIS_CONTROL', 'ST_AXIS_CONTROL', 44, 44, [
        ('fSetPosition', 'T_REAL',            0, 'ReadWrite'),
        ('fActPosition', 'T_REAL',            4, 'ReadWrite'),
        ('tState',       'T_ST_AXIS_STATE',   8, 'ReadWrite'),
        ('bEnable',      'T_BOOL',           24, 'ReadWrite'),
        ('bEnabled',     'T_BOOL',           25, 'ReadWrite'),
        ('bLimitPos',    'T_BOOL',           26, 'ReadWrite'),
        ('bLimitNeg',    'T_BOOL',           27, 'ReadWrite'),
        ('bJogFwd',      'T_BOOL',           28, 'ReadWrite'),
        ('bJogBwd',      'T_BOOL',           29, 'ReadWrite'),
        ('aAbsSel',      'T_ARRAY__0__2__OF_BOOL', 30, 'ReadWrite'),
        ('fTargetVel',   'T_REAL',           36, 'ReadWrite'),
        ('diErrorCode',  'T_DINT',           40, 'ReadWrite'),
    ]),
    # 参数结构体（32B）
    ('T_ST_AXIS_PARAM', 'ST_AXIS_PARAM', 32, 32, [
        ('fUpperLimit', 'T_REAL',  0, 'ReadWrite'),
        ('fLowerLimit', 'T_REAL',  4, 'ReadWrite'),
        ('fAcc',        'T_REAL',  8, 'ReadWrite'),
        ('fDec',        'T_REAL', 12, 'ReadWrite'),
        ('fJerk',       'T_REAL', 16, 'ReadWrite'),
        ('fJogVel',     'T_REAL', 20, 'ReadWrite'),
        ('diHomeOffset','T_DINT', 24, 'ReadWrite'),
        ('bInvertDir',  'T_BOOL', 28, 'ReadWrite'),
        ('bSoftLimitEn','T_BOOL', 29, 'ReadWrite'),
        ('iMode',       'T_INT',  30, 'ReadWrite'),
    ]),
    # UNION：成员全部叠在偏移 0（size=0 表示联合体）
    ('T_U_CELL_RESULT', 'U_CELL_RESULT', 0, 4, [
        ('eResult', 'T_E_PRODUCT_RESULT', 0, 'ReadWrite'),
        ('di',      'T_DINT',             0, 'ReadWrite'),
    ]),
    # 布局可疑：声明 size=1 却含 4B 联合体，成员 bUsed 与 uResult 重叠 —— 故意为之，
    # 用于验证「整读 blob 与逐名读对账」这条路径能在不可信布局上正确工作。
    ('T_ST_CELL', 'ST_CELL', 1, 8, [
        ('uResult', 'T_U_CELL_RESULT', 0, 'ReadWrite'),
        ('bUsed',   'T_BOOL',          0, 'ReadWrite'),
    ]),
    # 面板输入/输出（普通结构体实例）
    ('T_ST_PANEL_IN', 'ST_PANEL_IN', 12, 12, [
        ('bStart',   'T_BOOL', 0, 'ReadWrite'),
        ('bStop',    'T_BOOL', 1, 'ReadWrite'),
        ('bReset',   'T_BOOL', 2, 'ReadWrite'),
        ('bEStop',   'T_BOOL', 3, 'ReadWrite'),
        ('iModeSel', 'T_INT',  4, 'ReadWrite'),
        ('diCoded',  'T_DINT', 8, 'ReadWrite'),
    ]),
    ('T_ST_PANEL_OUT', 'ST_PANEL_OUT', 8, 8, [
        ('bRunning', 'T_BOOL', 0, 'ReadWrite'),
        ('bAlarm',   'T_BOOL', 1, 'ReadWrite'),
        ('bReady',   'T_BOOL', 2, 'ReadWrite'),
        ('bFault',   'T_BOOL', 3, 'ReadWrite'),
        ('diCode',   'T_DINT', 4, 'ReadWrite'),
    ]),
]

# 数组：name, iecname, size, nativesize, basetype, lo, hi
ARRAYS = [
    ('T_ARRAY__0__2__OF_BOOL',   'ARRAY [0..2] OF BOOL',    3,   3, 'T_BOOL', 0, 2),
    ('T_ARRAY__0__20__OF_INT',   'ARRAY [0..20] OF INT',   42,  42, 'T_INT',  0, 20),
    ('T_ARRAY__0__100__OF_INT',  'ARRAY [0..100] OF INT', 202, 202, 'T_INT',  0, 100),
    ('T_ARRAY__0__100__OF_BOOL', 'ARRAY [0..100] OF BOOL', 101, 101, 'T_BOOL', 0, 100),
    ('T_ARRAY__0__9__OF_REAL',   'ARRAY [0..9] OF REAL',   40,  40, 'T_REAL', 0, 9),
    ('T_ARRAY__1__6__OF_DINT',   'ARRAY [1..6] OF DINT',   24,  24, 'T_DINT', 1, 6),
    ('T_ARRAY__0__7__OF_T_ST_AXIS_CONTROL', 'ARRAY [0..7] OF ST_AXIS_CONTROL',
     352, 352, 'T_ST_AXIS_CONTROL', 0, 7),
    ('T_ARRAY__0__7__OF_T_ST_AXIS_PARAM', 'ARRAY [0..7] OF ST_AXIS_PARAM',
     256, 256, 'T_ST_AXIS_PARAM', 0, 7),
    # 刻意把 size 写成 6（真实应为 6×8=48），复现「XML 数组步长不可信」的情形
    ('T_ARRAY__1__6__OF_T_ST_CELL', 'ARRAY [1..6] OF ST_CELL',
     6, 48, 'T_ST_CELL', 1, 6),
]

# ─────────────────────────────────────────────────────────────
# 符号树：GVL → [(name, type, comment)]
# ─────────────────────────────────────────────────────────────
NODES = [
    ('GVL_MAIN', [
        ('diTotalCount',  'T_DINT',     '总计数'),
        ('diPartCount',   'T_DINT',     '循环计数'),
        ('bResetCount',   'T_BOOL',     '计数清零'),
        ('bAutoMode',     'T_BOOL',     '自动模式'),
        ('bRunning',      'T_BOOL',     '运行中'),
        ('lrSpeed',       'T_LREAL',    '实际速度'),
        ('bEStop',        'T_BOOL',     '急停回路'),
        ('bEtherCAT',     'T_BOOL',     '总线就绪'),
        ('bIoOk',         'T_BOOL',     'IO 模块就绪'),
        ('eMode',         'T_E_MODE',   '控制模式'),
        ('aiStatus',      'T_ARRAY__0__20__OF_INT',  '流程字'),
        ('aAlarmFlag',    'T_ARRAY__0__100__OF_BOOL', '报警状态'),
        ('aAlarmCode',    'T_ARRAY__0__100__OF_INT',  '报警代码'),
        ('aInfoFlag',     'T_ARRAY__0__100__OF_BOOL', '提示状态'),
        ('aInfoCode',     'T_ARRAY__0__100__OF_INT',  '提示代码'),
        ('aErrFlag',      'T_ARRAY__0__100__OF_BOOL', '故障状态'),
        ('aErrCode',      'T_ARRAY__0__100__OF_INT',  '故障代码'),
        ('aStationNo',    'T_ARRAY__1__6__OF_DINT',   '工位号表'),
        ('aAngleMax',     'T_ARRAY__1__6__OF_DINT',   '角度上限表'),
        ('aAngleMin',     'T_ARRAY__1__6__OF_DINT',   '角度下限表'),
        ('aAxisVel',      'T_ARRAY__0__9__OF_REAL',   '轴速度表'),
    ]),
    ('GVL_AXIS', [
        ('aAxisCtl',   'T_ARRAY__0__7__OF_T_ST_AXIS_CONTROL', '轴控制数据'),
        ('aAxisParam', 'T_ARRAY__0__7__OF_T_ST_AXIS_PARAM',   '轴参数'),
    ]),
    ('GVL_STATION', [
        ('rActual',     'T_REAL',  '当前实测值'),
        ('rTarget',     'T_REAL',  '目标值'),
        ('rUpperLimit', 'T_REAL',  '上限设定'),
        ('rLowerLimit', 'T_REAL',  '下限设定'),
        ('rReference',  'T_REAL',  '基准值'),
        ('bVisionEnable', 'T_BOOL', '视觉启用'),
        ('diOkCount',   'T_DINT',  '合格数'),
        ('diNgCount',   'T_DINT',  '不良数'),
        ('diTarget',    'T_DINT',  '设定产量'),
        ('diStationNo', 'T_DINT',  '当前工位号'),
        ('diCycleCount','T_DINT',  '循环计数'),
        ('aCell',       'T_ARRAY__1__6__OF_T_ST_CELL', '工位数据（联合体）'),
    ]),
    ('GVL_IO', [
        ('bSafetyDoor',   'T_BOOL', '安全门到位'),
        ('bSafetyOk',     'T_BOOL', '安全允许'),
        ('bAirPressure',  'T_BOOL', '气压正常'),
        ('bFeedMaterial', 'T_BOOL', '上料检测'),
        ('bPartDetect',   'T_BOOL', '物料检测'),
        ('diPowerOnCount','T_DINT', '开机次数'),
        ('diStopReason',  'T_INT',  '停机原因'),
    ]),
    ('GVL_PANEL', [
        ('stInput',  'T_ST_PANEL_IN',  '面板输入'),
        ('stOutput', 'T_ST_PANEL_OUT', '面板输出'),
    ]),
]

HEADER = '''\ufeff<?xml version="1.0" encoding="utf-8"?>
<Symbolconfiguration xmlns="http://www.3s-software.com/schemas/Symbolconfiguration.xsd">
  <Header>
    <Version>3.5.14.0</Version>
    <SymbolConfigObject version="4.7.0.0" runtimeid="3.5.17.40" libversion="4.6.0.0" compiler="3.5.22.0" lmm="3.5.22.10" profile="CODESYS V3.5 SP22 Patch 1+" settings="XmlIncludeComments, LayoutCalculator=OptimizedClientSideLayoutCalculator" />
    <ProjectInfo name="DEMO_MACHINE" devicename="Device" appname="Application" />
  </Header>
'''


def esc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def build():
    out = [HEADER, '  <TypeList>\n']
    for name, size, iec, cls in SIMPLE:
        swap = size if cls not in ('Bool', 'String') else 0
        out.append(f'    <TypeSimple name="{name}" size="{size}" swapsize="{swap}" '
                   f'typeclass="{cls}" iecname="{iec}" />\n')

    for name, iec, base, vals in ENUMS:
        out.append(f'    <TypeUserDef name="{name}" size="2" nativesize="2" swapsize="2" '
                   f'typeclass="Enum" iecname="{iec}" basetype="{base}">\n')
        for vn, vv in vals:
            out.append(f'      <UserDefElement type="{name}" iecname="{vn}" enumvalue="{vv}" />\n')
        out.append('    </TypeUserDef>\n')

    for name, iec, size, nativesize, base, lo, hi in ARRAYS:
        out.append(f'    <TypeArray name="{name}" size="{size}" nativesize="{nativesize}" '
                   f'typeclass="Array" iecname="{iec}" basetype="{base}">\n')
        out.append(f'      <ArrayDim minrange="{lo}" maxrange="{hi}" />\n')
        out.append('    </TypeArray>\n')

    for name, iec, size, nativesize, members in STRUCTS:
        out.append(f'    <TypeUserDef name="{name}" size="{size}" nativesize="{nativesize}" '
                   f'typeclass="Userdef" pouclass="STRUCTURE" iecname="{iec}">\n')
        for mn, mt, off, acc in members:
            out.append(f'      <UserDefElement iecname="{mn}" type="{mt}" byteoffset="{off}" '
                       f'vartype="VAR" access="{acc}" />\n')
        out.append('    </TypeUserDef>\n')
    out.append('  </TypeList>\n')

    out.append('  <NodeList>\n')
    out.append('    <Node name="Application">\n')
    for gvl, items in NODES:
        out.append(f'      <Node name="{gvl}">\n')
        for vn, vt, comment in items:
            out.append(f'        <Node name="{vn}" type="{vt}" access="ReadWrite">\n')
            if comment:
                out.append(f'          <Comment> {esc(comment)}</Comment>\n')
            out.append('        </Node>\n')
        out.append('      </Node>\n')
    out.append('    </Node>\n')
    out.append('  </NodeList>\n')
    out.append('</Symbolconfiguration>\n')
    return ''.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default=None)
    a = ap.parse_args()
    dst = a.out or os.path.join(ROOT, 'example', 'DEMO_MACHINE.Device.Application.xml')
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    text = build()
    with open(dst, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    n_nodes = sum(len(v) for _, v in NODES)
    print(f'[v] {dst}')
    print(f'    类型 {len(SIMPLE)} 简单 + {len(ENUMS)} 枚举 + {len(ARRAYS)} 数组 + '
          f'{len(STRUCTS)} 结构体；符号 {n_nodes} 个（{len(NODES)} 个 GVL）')
    print('    注意：本文件为纯合成演示工程，不对应任何真实设备。')


if __name__ == '__main__':
    main()
