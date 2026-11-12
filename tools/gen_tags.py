#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen_tags.py — CODESYS 符号配置 XML → 消费者数据文件 一键生成器
════════════════════════════════════════════════════════════════════
用途：换任何新 PLC 程序时，只需把它的 *.Device.Application.xml 放进 Test/
     目录，本工具自动产出全部消费者数据文件，程序（验证台/固件）直接加载，
     不再手写点表。

硬规则（2026-11-11 用户指定）：
     所有变量类型以 XML 符号配置定义为唯一准则，禁止猜测数据类型。
     生成器只做「XML → 数据」的搬运，任何类型都不做推断。

产出（按 XML ProjectInfo name 命名，如 DEMO_MACHINE）：
     server/gen/<APP>.tags.json     验证台点表（verify-server.js 启动加载）
     server/gen/<APP>.symbols.json  全量符号清单（人类可读 + 审计基线）
     firmware/gen/hmi_tags_<APP>.c  固件点表（烧屏集成时整体替换 hmi_tags.c）
     firmware/gen/hmi_tags_<APP>.h  固件点表头（含 HMI_TAG_COUNT）
     server/profiles/<APP>.profile.json  点位选择档案（首次生成后可手工编辑）

用法：
     python tools/gen_tags.py --all                 # 扫描 Test/ 下全部 XML
     python tools/gen_tags.py <xml路径> [xml路径…]  # 指定 XML
     python tools/gen_tags.py <xml> --check        # 只校验不落盘（CI 用）

点位选择优先级：
     ① server/profiles/<APP>.profile.json 存在 → 以档案为准（类型仍取 XML）
     ② 否则用内置模板选点表（演示工程 GVL 模板的自然子集），
        并把实际生成的选择写成 .profile.json 供后续手工微调
"""
import json
import os
import re
import sys
import glob
import xml.etree.ElementTree as ET
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 验证台/固件支持的标量类型（XML iecname → 消费者类型） ─────────────
IEC_MAP = {
    'BOOL': 'BOOL', 'DINT': 'DINT', 'REAL': 'REAL', 'LREAL': 'LREAL',
    # 以下类型出现在 XML 但固件枚举暂不支持：允许进验证台、固件侧跳过
    'INT': 'INT', 'UINT': 'UINT', 'WORD': 'WORD', 'DWORD': 'DWORD',
    'UDINT': 'UDINT', 'TIME': 'TIME', 'STRING': 'STRING', 'WSTRING': 'WSTRING',
    'SINT': 'SINT', 'USINT': 'USINT', 'BYTE': 'BYTE', 'DWORD_': 'DWORD',
}

# ── 内置模板选点表（演示工程 DEMO_MACHINE 的自然子集；顺序即界面顺序） ──
#  格式: 完整路径 → (label, unit, group, digits)
#  说明：只有 XML 中真实存在的点才会被选用；换别的程序时若不匹配会自动选点。
DEFAULT_META = {
    # ── 生产计数 ──
    'GVL_MAIN.diTotalCount':        ('累计产量', 'pcs',  'count', 0),
    'GVL_MAIN.diPartCount':         ('循环计数', 'pcs',  'count', 0),
    'GVL_STATION.diOkCount':        ('合格数',   'pcs',  'count', 0),
    'GVL_STATION.diNgCount':        ('不良数',   'pcs',  'count', 0),
    'GVL_STATION.diTarget':         ('设定产量', 'pcs',  'count', 0),
    # ── 运行状态 ──
    'GVL_MAIN.bRunning':            ('运行中',   '',     'run',   0),
    'GVL_MAIN.bAutoMode':           ('自动模式', '',     'run',   0),
    'GVL_MAIN.lrSpeed':             ('实际速度', 'mm/s', 'run',   1),
    'GVL_STATION.rActual':          ('当前实测', 'mm',   'run',   2),
    'GVL_STATION.diStationNo':      ('当前工位', '',     'run',   0),
    'GVL_STATION.diCycleCount':     ('循环计数', '',     'run',   0),
    # ── 链路状态 ──
    'GVL_MAIN.bEStop':              ('急停回路', '',     'link',  0),
    'GVL_MAIN.bEtherCAT':           ('总线就绪', '',     'link',  0),
    'GVL_MAIN.bIoOk':               ('IO 模块',  '',     'link',  0),
    'GVL_IO.bSafetyDoor':           ('安全门到位', '',   'link',  0),
    'GVL_IO.bSafetyOk':             ('安全允许', '',     'link',  0),
    'GVL_IO.bAirPressure':          ('气压正常', '',     'link',  0),
    'GVL_IO.diPowerOnCount':        ('开机次数', '',     'link',  0),
    # ── 设定参数 ──
    'GVL_STATION.rTarget':          ('目标值',   'mm',   'param', 2),
    'GVL_STATION.rUpperLimit':      ('上限设定', 'mm',   'param', 1),
    'GVL_STATION.rLowerLimit':      ('下限设定', 'mm',   'param', 1),
    'GVL_STATION.rReference':       ('基准值',   'mm',   'param', 1),
    'GVL_STATION.bVisionEnable':    ('视觉启用', '',     'param', 0),
}

FW_HMI = {'BOOL': 'HMI_BOOL', 'DINT': 'HMI_DINT', 'REAL': 'HMI_REAL', 'LREAL': 'HMI_LREAL'}


def strip_ns(el):
    el.tag = el.tag.split('}')[-1]
    for c in el:
        strip_ns(c)


def parse_xml(xml_path):
    """XML → (app名, 类型表, 全量叶子符号 dict{key: (iec, tname)})"""
    tree = ET.parse(xml_path)
    root = tree.getroot()
    strip_ns(root)

    app = None
    types = {}
    symbols = {}
    section = None
    for el in root:
        if el.tag == 'Header':
            pi = el.find('ProjectInfo')
            if pi is not None:
                app = pi.get('name')
            continue
        if el.tag == 'TypeList':
            for t in el:
                entry = {
                    'kind': t.tag, 'iec': t.get('iecname', ''),
                    'size': int(t.get('size', '0') or 0),
                }
                # ── 类型成员/维度（结构体钻取功能的数据基础） ──
                if t.tag == 'TypeUserDef':
                    members, enums = [], {}
                    is_enum = t.get('typeclass') == 'Enum'
                    entry['basetype'] = t.get('basetype', '')
                    for c in t:
                        if c.tag != 'UserDefElement':
                            continue
                        if is_enum or c.get('enumvalue') is not None:
                            # 枚举字面量：名字 → 值（钻取界面显示枚举名用）
                            enums[c.get('iecname', '')] = int(c.get('enumvalue', '0') or 0)
                        else:
                            members.append({
                                'name': c.get('iecname', ''),
                                'type': c.get('type', ''),
                                'byteoffset': int(c.get('byteoffset', '0') or 0),
                                'access': c.get('access', ''),
                            })
                    entry['members'] = members        # 枚举 = {}（不可再展开）
                    if enums:
                        entry['enums'] = enums
                elif t.tag == 'TypeArray':
                    dim = t.find('ArrayDim')
                    if dim is not None:
                        entry['lo'] = int(dim.get('minrange', '0'))
                        entry['hi'] = int(dim.get('maxrange', '0'))
                    entry['basetype'] = t.get('basetype', '')
                types[t.get('name')] = entry
            continue
        # NodeList > Node(Application) > Node(GVL) > ...
        def walk(node, path):
            name = node.get('name')
            p = f'{path}.{name}' if path else name
            kids = [c for c in node if c.tag == 'Node']
            if not kids:
                tname = node.get('type')
                t = types.get(tname, {})
                symbols[p] = {
                    'key': p, 'typeName': tname,
                    'kind': t.get('kind', '?'), 'iec': t.get('iec', ''),
                    'size': t.get('size', 0),
                    'isArrayElem': bool(re.search(r'\[\d+\]$', name)),
                }
            else:
                symbols[p] = {
                    'key': p, 'typeName': node.get('type'),
                    'kind': 'CONTAINER', 'iec': '', 'size': 0,
                    'isArrayElem': False,
                }
                for c in kids:
                    walk(c, p)
        app_node = [c for c in el if c.tag == 'Node']
        for a in app_node:
            # 约定：key 不带 Application. 前缀（消费端自行补全）
            for gvl in [c for c in a if c.tag == 'Node']:
                walk(gvl, '')
    return app, types, symbols


def safe_app_name(name):
    r"""程序名 → 可用作文件名 / URL 参数 / 校验正则的 ASCII 标识符。

    为什么要转：程序名同时是
      · server/gen/<APP>.tags.json 等文件名
      · /api/select?app=<APP> 的参数（服务端按 ^\w+$ 校验，中文必然被拒）
    中文名（如「HMI标签测试」）直接当标识符会生成文件却选不回来。
    转法：保留 ASCII 字母数字与 _-，其余压成单个下划线；若原名含非 ASCII，
    追加 6 位内容哈希，避免「HMI标签测试」「HMI测试」都退化成同一个 ID。
    原始名称保存在 appDisplay 里供界面显示。
    """
    raw = (name or '').strip()
    if not raw:
        return 'IMPORTED_APP'
    ascii_part = re.sub(r'[^A-Za-z0-9_-]+', '_', raw).strip('_')
    if not ascii_part:
        ascii_part = 'APP'
    if ascii_part[0].isdigit():
        ascii_part = 'APP_' + ascii_part
    ascii_part = ascii_part[:40]
    if any(ord(c) > 127 for c in raw):
        import hashlib
        ascii_part += '_' + hashlib.md5(raw.encode('utf-8')).hexdigest()[:6]
    return ascii_part


def array_elem_iec(types, sym):
    """数组符号 → 元素 IEC 类型（不支持的返回 None）。
    XML 的 iecname 形如 'ARRAY [0..1999] OF REAL'，取 OF 之后的基类型；
    旧编译器（SP17 及更早）也是这个写法，两种格式都能取到。"""
    m = re.search(r'\bOF\s+([A-Za-z_]\w*)\s*$', sym.get('iec') or '', re.I)
    if m:
        base = m.group(1).upper()
        return base if base in IEC_MAP else None
    t = types.get(sym.get('typeName') or '', {})
    base_t = types.get(t.get('basetype') or '', {})
    iec = (base_t.get('iec') or '').upper()
    return iec if iec in IEC_MAP else None


def resolve_point(symbols, types, key):
    """把一个点位 key 解析成 (iec, kind)。支持两种写法：
      · 标量      GVL.Main.Speed
      · 数组元素  GVL.Main.aVal[3]      （PLC 侧按元素名寻址，读取机制与标量一致）
    返回 None 表示该 key 在 XML 中不存在或类型不支持。"""
    sym = symbols.get(key)
    if sym:
        return (sym['iec'], sym['kind']) if sym['kind'] == 'TypeSimple' else None
    m = re.match(r'^(.*)\[(\d+)\]$', key)
    if m:
        base = symbols.get(m.group(1))
        if not base or base['kind'] != 'TypeArray':
            return None
        t = types.get(base['typeName']) or {}
        lo, hi = t.get('lo'), t.get('hi')
        idx = int(m.group(2))
        if lo is not None and not (lo <= idx <= hi):
            return None
        iec = array_elem_iec(types, base)
        return (iec, 'TypeSimple') if iec else None
    return None


def auto_select_points(symbols, types=None):
    """模板全不匹配（外来程序）：自动选点保证控制台开箱即用。

    规则（两级，按路径排序）：
      ① 先收全部 TypeSimple 标量，最多 32 个；
      ② 标量不足 8 个时，从数组里补**前几个元素**（GVL.CommValue[0]、[1]…），
         补到 8 个为止。数组元素在 PLC 侧按元素名寻址，读取机制与标量相同，
         可以正常进点表；数组本体仍在全量页整体展示。

    ②是为了兼容「整个程序只有一个大数组」的工程（旧编译器导出的 HMI 点表常见）：
    这种 XML 里一个标量都没有，只按 ① 选点会得到 0 个点，整条导入链直接失败。
    """
    types = types or {}
    out = []

    def push(key, iec):
        out.append((key, {'label': key, 'unit': '', 'group': 'auto',
                          'digits': 2, 'type': IEC_MAP[iec], 'iec': iec}))

    for key in sorted(symbols):
        sym = symbols[key]
        if sym['kind'] != 'TypeSimple' or sym['isArrayElem']:
            continue
        if sym['iec'] not in IEC_MAP:
            continue
        push(key, sym['iec'])
        if len(out) >= 32:
            return out

    if len(out) < 8:
        per_array = 8 - len(out)
        for key in sorted(symbols):
            sym = symbols[key]
            if sym['kind'] != 'TypeArray':
                continue
            iec = array_elem_iec(types, sym)
            if not iec:
                continue
            t = types.get(sym['typeName']) or {}
            lo, hi = t.get('lo'), t.get('hi')
            if lo is None:
                continue
            for i in range(lo, min(hi, lo + per_array - 1) + 1):
                push(f'{key}[{i}]', iec)
            per_array = 8 - len(out)
            if per_array <= 0:
                break
    return out


def select_points(app, symbols, profile_path, types=None):
    """返回 [(key, meta)]，类型一律 XML。档案存在则档案优先。
    内置模板 0 命中（外来程序）→ 自动选点，保证控制台能起。"""
    if os.path.exists(profile_path):
        prof = json.load(open(profile_path, encoding='utf-8'))
        pts = prof.get('points', [])
        out = []
        for p in pts:
            key = p['key']
            r = resolve_point(symbols, types, key)
            if r is None:
                hint = ''
                if key in symbols:
                    hint = f'（类型 {symbols[key]["typeName"]} / {symbols[key]["kind"]}）'
                die(f'档案里的点无法解析: {key}{hint}'
                    '——XML 为唯一准则，请核对路径/拼写/下标范围')
            iec = r[0]
            out.append((key, {
                'label': p.get('label', key), 'unit': p.get('unit', ''),
                'group': p.get('group', 'param'), 'digits': int(p.get('digits', 0)),
                'type': IEC_MAP[iec], 'iec': iec,
            }))
        return out, False  # already profiled
    # 内置模板选点：只有 XML 中真实存在才收录
    out = []
    for key, (label, unit, group, digits) in DEFAULT_META.items():
        r = resolve_point(symbols, types, key)
        if r is None or r[1] != 'TypeSimple':
            continue
        iec = r[0]
        out.append((key, {'label': label, 'unit': unit, 'group': group,
                          'digits': digits, 'type': IEC_MAP[iec], 'iec': iec}))
    if not out:
        print('  [!] 与内置模板（DEMO_MACHINE）完全不匹配——外来程序，自动选点（可后续在 profile 微调）')
        out = auto_select_points(symbols, types)
    return out, True


def die(msg):
    print(f'[x] {msg}')
    sys.exit(2)


def gen_for_xml(xml_path, check_only=False):
    xml_path = os.path.abspath(xml_path)
    try:
        app, types, symbols = parse_xml(xml_path)
    except ET.ParseError as e:
        die(f'{xml_path} 不是合法 XML（别人程序导出不完整？）: {e}')
    if not app:
        app = fallback_app_name(xml_path)
        print(f'  [!] XML Header 无 ProjectInfo name，按文件名回退命名: {app}')
    app_display = app
    app = safe_app_name(app)
    print(f'\n■ {app_display}  ← {os.path.relpath(xml_path, ROOT)}')
    if app != app_display:
        print(f'  App ID: {app} (non-ASCII name transliterated; UI keeps the original)')
    print(f'  符号总数（含容器/数组元素展开）: {len(symbols)}，类型数: {len(types)}')

    profile_path = os.path.join(ROOT, 'server', 'profiles', f'{app}.profile.json')
    pts, need_profile = select_points(app, symbols, profile_path, types)
    if not pts:
        die('一个点都没选中——XML 里既没有可用标量，也没有可写数组元素；'
            '请手工建 profile 档案指定点位')
    print(f'  点表选择: {len(pts)} 点（来源: {"内置模板" if need_profile else os.path.relpath(profile_path, ROOT)}）')

    # ── 校验：固件支持的类型子集 ──
    fw_pts = []
    for key, m in pts:
        if m['type'] in FW_HMI:
            fw_pts.append((key, m))
        else:
            print(f'  [!] 固件侧跳过 {key}（{m["type"]} 不在 HMI 枚举）')

    if check_only:
        print('  [v] 校验通过（--check 不落盘）')
        return app

    # ── 0) 全量符号表（验证台全量模式数据源：out/<APP>/tag_table.json） ──
    import subprocess
    out_dir = os.path.join(ROOT, 'out', app)
    out_json = os.path.join(out_dir, 'tag_table.json')
    # 产物已存在且比 XML 新 → 跳过（避免无谓覆写；XML 没变数据就不会变）
    if os.path.exists(out_json) and os.path.getmtime(out_json) > os.path.getmtime(xml_path):
        print(f'  = out{os.sep}{app}{os.sep}tag_table.json 已是最新，跳过')
    else:
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'codesys_symconfig.py'),
                            xml_path, '-o', out_dir],
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
        if r.returncode != 0:
            # 产物被占用（如 CSV 正被编辑器打开）时保留旧版继续，而不是中断整条链
            if os.path.exists(out_json):
                tail = (r.stderr or r.stdout or '').strip().splitlines()
                print(f'  [!] 全量表重生成失败（文件可能被编辑器占用），沿用现有版本')
                if tail:
                    print(f'    {tail[-1][:120]}')
            else:
                die(f'codesys_symconfig.py 失败且无历史产物: {(r.stderr or r.stdout).strip()[:200]}')
        else:
            print(f'  [v] out{os.sep}{app}{os.sep}tag_table.json（全量符号表）')

    # ── 1) server/gen/<APP>.tags.json（验证台） ──
    gen_dir = os.path.join(ROOT, 'server', 'gen')
    os.makedirs(gen_dir, exist_ok=True)
    tags = [{'key': k, 'label': m['label'], 'unit': m['unit'],
             'type': m['type'], 'digits': m['digits'], 'group': m['group'],
             'iec': m['iec']} for k, m in pts]
    tags_path = os.path.join(gen_dir, f'{app}.tags.json')
    json.dump({'schema': 'gen-tags/1', 'app': app, 'appDisplay': app_display,
               'generatedFrom': xml_path,
               'generatedAt': datetime.now().isoformat(timespec='seconds'),
               'note': '由 tools/gen_tags.py 从 XML 符号配置自动生成，禁止手改；'
                       '类型以 XML 为唯一准则。改选点请编辑 server/profiles/%s.profile.json' % app,
               'tags': tags},
              open(tags_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'  [v] {os.path.relpath(tags_path, ROOT)}（{len(tags)} 点）')

    # ── 2) 全量符号清单 ──
    sym_path = os.path.join(gen_dir, f'{app}.symbols.json')
    json.dump({'schema': 'gen-symbols/1', 'app': app, 'appDisplay': app_display,
               'generatedFrom': xml_path,
               'symbolCount': len(symbols),
               'symbols': [symbols[k] for k in sorted(symbols)]},
              open(sym_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'  [v] {os.path.relpath(sym_path, ROOT)}（{len(symbols)} 符号）')

    # ── 2.5) 类型定义库（结构体钻取：成员名/偏移/访问权限 + 数组维度） ──
    types_path = os.path.join(gen_dir, f'{app}.types.json')
    json.dump({'schema': 'gen-types/1', 'app': app, 'appDisplay': app_display,
               'generatedFrom': xml_path,
               'note': 'TypeList 原样搬运：结构体成员（iecname/byteoffset/access）与数组维度'
                       '（minrange/maxrange/basetype）。成员路径合成与钻取读取的依据。',
               'types': types},
              open(types_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'  [v] {os.path.relpath(types_path, ROOT)}（{len(types)} 类型）')

    # ── 3) 固件 C 点表（可选产物：仓库内存在 firmware/ 工程时才生成） ──
    fw_dir = os.path.join(ROOT, 'firmware', 'gen')
    if not os.path.isdir(os.path.join(ROOT, 'firmware')):
        print('  · 跳过固件点表（本包不含 firmware/ 工程；需要时建该目录后重新生成）')
    else:
        os.makedirs(fw_dir, exist_ok=True)
        rows = ',\n'.join(
            f'    {{ "{k}",{FW_HMI[m["type"]]}, false, 0, 0, 0, 0 }}'
            for k, m in fw_pts)
        c_text = f"""/* hmi_tags_{app}.c — 由 tools/gen_tags.py 自动生成（{datetime.now().strftime('%Y-%m-%d %H:%M')}）
   来源 XML: {xml_path}
   ══════════════════════════════════════════════════════════════
   烧屏集成方法：
     1. 本文件整体覆盖 firmware/main/hmi_tags.c
     2. 用 hmi_tags_{app}.h 里的 HMI_TAG_COUNT 同步 hmi_tags.h
     3. UI 层按新点序重排索引
   类型一律来自 XML 符号配置（唯一准则），共 {len(fw_pts)} 点。 */

#include "hmi_tags.h"
#include <string.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"

static hmi_tag_t s_tags[HMI_TAG_COUNT] = {{
{rows}
}};

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

void hmi_tags_init(void)
{{
    for (int i = 0; i < HMI_TAG_COUNT; i++) {{
        s_tags[i].valid = false;
        s_tags[i].i = 0; s_tags[i].f = 0.0f; s_tags[i].b = false;
        s_tags[i].at_ms = 0;
    }}
}}

hmi_tag_t *hmi_tags_table(void) {{ return s_tags; }}

void hmi_tags_push(int idx, const cs3_value_t *v)
{{
    if (idx < 0 || idx >= HMI_TAG_COUNT || !v) return;
    hmi_tag_t *t = &s_tags[idx];

    int32_t  i = 0;
    float    f = 0.0f;
    bool     b = false;
    switch (t->type) {{
    case HMI_DINT:  i = cs3_val_i32(v); break;
    case HMI_REAL:  f = cs3_val_f32(v); break;
    case HMI_LREAL: f = (float)cs3_val_f64(v); break;
    case HMI_BOOL:  b = cs3_val_bool(v); break;
    }}

    taskENTER_CRITICAL(&s_mux);
    t->i = i; t->f = f; t->b = b;
    t->valid = true;
    t->at_ms = (uint32_t)(esp_timer_get_time() / 1000);
    taskEXIT_CRITICAL(&s_mux);
}}

const char *hmi_tag_text(int idx, char *buf, int cap)
{{
    if (idx < 0 || idx >= HMI_TAG_COUNT || !buf || cap <= 0) return "";
    hmi_tag_t *t = &s_tags[idx];
    if (!t->valid) {{ snprintf(buf, cap, "--"); return buf; }}

    switch (t->type) {{
    case HMI_DINT:
        snprintf(buf, cap, "%d", (int)t->i);
        break;
    case HMI_REAL:
    case HMI_LREAL:
        snprintf(buf, cap, "%.2f", (double)t->f);
        break;
    case HMI_BOOL:
        snprintf(buf, cap, "%s", t->b ? "ON" : "OFF");
        break;
    }}
    return buf;
}}
"""
        c_path = os.path.join(fw_dir, f'hmi_tags_{app}.c')
        open(c_path, 'w', encoding='utf-8').write(c_text)
        h_path = os.path.join(fw_dir, f'hmi_tags_{app}.h')
        open(h_path, 'w', encoding='utf-8').write(f"""/* hmi_tags_{app}.h — 自动生成 · HMI_TAG_COUNT={len(fw_pts)}
   集成时把此值同步进 firmware/main/hmi_tags.h */
#define HMI_TAG_COUNT_{app} {len(fw_pts)}
""")
        print(f'  [v] {os.path.relpath(c_path, ROOT)}（固件 {len(fw_pts)} 点）')
        print(f'  [v] {os.path.relpath(h_path, ROOT)}')

    # ── 4) 首次生成时写出 profile 档案（之后可手工编辑微调） ──
    if need_profile:
        os.makedirs(os.path.dirname(profile_path), exist_ok=True)
        json.dump({'schema': 'gen-profile/1', 'app': app,
                   'note': '选点档案：改这里再跑 tools/gen_tags.py 即可换点；'
                           'key 必须与 XML 一致，类型一律由 XML 决定（不许写 type）。',
                   'points': [{'key': k, 'label': m['label'], 'unit': m['unit'],
                               'group': m['group'], 'digits': m['digits']} for k, m in pts]},
                  open(profile_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'  [v] {os.path.relpath(profile_path, ROOT)}（首次生成，可手工微调）')

    return app


def list_apps():
    """列出全部已导入程序（server/gen/<APP>.tags.json 为准），供控制台选择。
    输出：APP|生成时间|点数 —— 按生成时间倒序，最上面即最新导入。"""
    gen_dir = os.path.join(ROOT, 'server', 'gen')
    rows = []
    for f in sorted(glob.glob(os.path.join(gen_dir, '*.tags.json'))):
        try:
            d = json.load(open(f, encoding='utf-8'))
            rows.append((d.get('generatedAt', ''), d.get('app', '?'),
                         len(d.get('tags', [])), f))
        except Exception:
            continue
    rows.sort(reverse=True)
    if not rows:
        print('（还没有已导入的程序——把 XML 放进 example/ 或 Test/，再跑 1-gen-tags.bat）')
        return
    for ts, app, n, _ in rows:
        print(f'{app}|{ts}|{n} 点')


def main():
    check_only = '--check' in sys.argv
    if '--list' in sys.argv:
        list_apps()
        return
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    xmls = []
    if '--all' in sys.argv or not args:
        # 扫描 example/（随包示例）与 Test/（自行放入的 XML）两个位置
        pats = [os.path.join(ROOT, 'example', '*.Device.Application.xml'),
                os.path.join(ROOT, 'example', '*', '*.Device.Application.xml'),
                os.path.join(ROOT, 'Test', '*.Device.Application.xml'),
                os.path.join(ROOT, 'Test', '*', '*.Device.Application.xml')]
        for p in pats:
            xmls.extend(glob.glob(p))
        xmls = sorted(set(os.path.abspath(x) for x in xmls))
        if not xmls:
            die('没找到 *.Device.Application.xml——请把 XML 放进 example/ 或 Test/，或直接传路径')
    else:
        for a in args:
            if not os.path.exists(a):
                die(f'文件不存在: {a}')
            xmls.append(a)
    print(f'gen_tags.py · {len(xmls)} 个 XML · 类型以 XML 为唯一准则')
    apps = []
    for x in xmls:
        app = gen_for_xml(x, check_only)
        if app:
            apps.append(app)
    print('\n[OK] 生成完毕')
    for app in apps:
        print(f'APP={app}')   # 供脚本解析（机器可读，勿改格式）


if __name__ == '__main__':
    main()
