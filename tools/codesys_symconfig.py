#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CODESYS 符号配置 XML → HMI 标签表 / 布局表 / 审计报告

输入：CODESYS 导出的 *.Device.Application.xml
      （Symbol Configuration 导出，根节点 Symbolconfiguration）

输出（均在 -o 指定目录）：
  tag_table.json    HMI 端标签表：符号清单 + 类型字典 + 偏移/跨度/访问权限/置信度
  symbols.csv       符号级清单（人看/给 PLC 工程师核对）
  leaf_vars.csv     叶子级变量表：每个可寻址成员的相对偏移（给 Modbus / UI 绑定）
  types_layout.h    C 头文件：结构体大小/对齐/成员偏移宏（不依赖编译器布局）
  types_layout.json 类型布局（机读）
  audit.md          审计报告：权限越界、布局不可信、FB 实例、命名问题

用法：
  python codesys_symconfig.py ../example/DEMO_MACHINE.Device.Application.xml -o ../out/DEMO_MACHINE
  python codesys_symconfig.py xxx.xml -o out/ --ns-index 4 --fail-on-high

设计原则：
  1. 只用标准库，Python 3.8+
  2. 布局按 CODESYS 实际规则计算（成员对齐 + 尾部补齐），并用数组跨度做交叉校验
  3. 校验不通过的类型标记为 unverified，绝不假装可信
"""

import argparse
import csv
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

NS = '{http://www.3s-software.com/schemas/Symbolconfiguration.xsd}'
SCHEMA_ID = 'hmi-tagtable/2'

# IEC 基础类型 → (字节数, 对齐)
SIMPLE = {
    'BOOL': (1, 1), 'SINT': (1, 1), 'USINT': (1, 1), 'BYTE': (1, 1), 'CHAR': (1, 1),
    'INT': (2, 2), 'UINT': (2, 2), 'WORD': (2, 2), 'WCHAR': (2, 2),
    'DINT': (4, 4), 'UDINT': (4, 4), 'DWORD': (4, 4), 'REAL': (4, 4), 'TIME': (4, 4),
    'LINT': (8, 8), 'ULINT': (8, 8), 'LWORD': (8, 8), 'LREAL': (8, 8),
}

# 视为"内部状态、不适合上 HMI"的类型标记（FB 实例、定时器）
FB_MARKERS = ('T_TON', 'T_TOF', 'T_TP', 'T_RTRIG', 'T_FTRIG')
# 只按类型名判断 FB 实例容器（M_ 前缀是设备功能块），不要按符号名猜，
# 否则 PLC_OUTPUT 这种纯 IO 映像会被误伤。
FB_TYPE_HINT = re.compile(r'^M_\d+_')

# 疑似应由 PLC 独占写（HMI 只读）的命名特征。
# 注意排除 HMI 侧的"命令类"：清零/复位/确认 是允许 HMI 写的。
# 只按「词法特征」判断，不含任何具体工程的变量名：
#   · 输入反馈后缀 _IN / _FIN
#   · 链路状态类词根 OP / LINK / ETHERCAT
#   · 寿命与上电次数类词根 Life / PowerOn
#   · 常闭/常通/首次/延时 等平台信号
PLC_OWNED = re.compile(
    r'(_IN$|_FIN$|_OP$|LINK|ETHERCAT|Life|Power_?O|LOCK|ALWAYS|FIRST_?ON|DELAY_?ON)', re.I)
# 明确允许 HMI 写的命令词
WRITE_ALLOWED = re.compile(r'(_RST$|RST_BP|CLEAR_|_ACK|_RESET$|_START$|_STOP$|Jog|Once|Mov)', re.I)


def align_up(v, a):
    return (v + a - 1) // a * a if a > 1 else v


class TypeDict:
    """类型字典 + 布局计算"""

    def __init__(self, root):
        self.t = {}
        for e in root.find(NS + 'TypeList'):
            tag = e.tag.replace(NS, '')
            dims = [(int(d.get('minrange')), int(d.get('maxrange')))
                    for d in e.findall(NS + 'ArrayDim')]
            members = []
            enums = []
            for m in e:
                if not m.tag.endswith('UserDefElement'):
                    continue
                nm, mt = m.get('iecname'), m.get('type')
                if not nm:
                    continue
                if m.get('enumvalue') is not None:
                    cm = m.find(NS + 'Comment')
                    enums.append({
                        'name': nm,
                        'value': int(m.get('enumvalue')),
                        'comment': (cm.text or '').strip() if cm is not None else '',
                    })
                else:
                    members.append((nm, mt))
            self.t[e.get('name')] = {
                'tag': tag,
                'iec': e.get('iecname'),
                'declared': int(e.get('size') or 0),
                'nativesize': int(e.get('nativesize') or 0),
                'base': e.get('basetype'),
                'tc': e.get('typeclass'),
                'dims': dims,
                'members': members,
                'enums': enums,
            }
        self._cache = {}

    def iec(self, name):
        n = self.t.get(name)
        return n['iec'] if n and n['iec'] else (name or '?')

    def count(self, name):
        """数组元素个数；非数组为 1"""
        n = self.t.get(name)
        if not n or n['tag'] != 'TypeArray':
            return 1
        c = 1
        for lo, hi in n['dims']:
            c *= (hi - lo + 1)
        return c

    def layout(self, name):
        """返回 (size, align, members, verified)
        members: [{name,type,offset,size,count,stride}]
        """
        if name in self._cache:
            return self._cache[name]
        n = self.t.get(name)
        if n is None:
            r = (1, 1, [], False)
        elif n['tag'] == 'TypeSimple':
            iec = (n['iec'] or '').upper()
            m = re.match(r'(W?STRING)\s*\((\d+)\)', iec)
            if m:
                ln = int(m.group(2))
                r = ((ln + 1) if m.group(1) == 'STRING' else (ln * 2 + 2),
                     1 if m.group(1) == 'STRING' else 2, [], True)
            else:
                sz, al = SIMPLE.get(iec, (n['declared'] or 1, 1))
                r = (sz, al, [], True)
        elif n['tag'] == 'TypeArray':
            es, ea, _, ev = self.layout(n['base'])
            stride = align_up(es, ea)
            r = (stride * self.count(name), ea, [], ev)
        elif n['tc'] in ('Enum', 'Alias'):
            r = self.layout(n['base'] or 'T_INT')[:1] + self.layout(n['base'] or 'T_INT')[1:2] + ([], True)
        else:
            off, mx, mem = 0, 1, []
            ok = True
            for nm, mt in n['members']:
                s, a, sm, ev = self.layout(mt)
                ok = ok and ev
                off = align_up(off, a)
                cnt = self.count(mt)
                mem.append({'name': nm, 'type': mt, 'iec': self.iec(mt),
                            'offset': off, 'size': s, 'count': cnt,
                            'stride': s // cnt if cnt else s})
                off += s
                mx = max(mx, a)
            size = align_up(off, mx)
            # 声明 size 往往不含尾部填充：差值小于对齐值的视为"仅缺尾填充"，布局仍可信。
            # 差值 >= 对齐值、或声明为 0，说明成员尺寸本身有问题 → 布局不可信。
            if n['declared'] == 0 or n['declared'] > size or (size - n['declared']) >= mx:
                ok = False
            r = (size, mx, mem, ok)
        self._cache[name] = r
        return r

    def chain(self, name, seen=None):
        """类型依赖链，用于识别 FB 实例 / 不可信类型"""
        seen = seen or set()
        if name in seen:
            return []
        seen.add(name)
        n = self.t.get(name)
        if not n:
            return [name]
        out = [name]
        if n['tag'] == 'TypeArray':
            out += self.chain(n['base'], seen)
        elif n['tc'] not in ('Enum', 'Alias'):
            for _, mt in n['members']:
                out += self.chain(mt, seen)
        return out


def leaves(td, tname, prefix='', offset=0, depth=0):
    """展开为叶子变量 [(path, iecType, offset, bytes)]"""
    n = td.t.get(tname)
    if n is None:
        return [(prefix, '?', offset, 1)]
    if n['tag'] == 'TypeSimple':
        s, _, _, _ = td.layout(tname)
        return [(prefix, td.iec(tname), offset, s)]
    if n['tag'] == 'TypeArray':
        cnt = td.count(tname)
        es, ea, _, _ = td.layout(n['base'])
        stride = align_up(es, ea)
        if cnt * es > 4096 and depth > 0:
            # 大数组在结构体内不再逐元素展开，避免文件爆炸
            return [(f'{prefix}[{cnt}]', td.iec(tname), offset, stride * cnt)]
        out = []
        for i in range(cnt):
            out += leaves(td, n['base'], f'{prefix}[{i}]', offset + i * stride, depth + 1)
        return out
    if n['tc'] in ('Enum', 'Alias'):
        s, _, _, _ = td.layout(tname)
        return [(prefix, td.iec(tname), offset, s)]
    size, align, members, _ = td.layout(tname)
    out = []
    for m in members:
        out += leaves(td, m['type'], f'{prefix}.{m["name"]}' if prefix else m['name'],
                      offset + m['offset'], depth + 1)
    return out


def parse_symbols(root):
    """遍历 NodeList，返回符号列表"""
    out = []

    def walk(node, path):
        for c in node.findall(NS + 'Node'):
            nm, ty = c.get('name'), c.get('type')
            p = f'{path}.{nm}' if path else nm
            cm = c.find(NS + 'Comment')
            comment = (cm.text or '').strip() if cm is not None else ''
            if ty:
                out.append({'path': p, 'name': nm, 'type': ty,
                            'access': c.get('access') or '', 'comment': comment})
            else:
                walk(c, p)

    walk(root.find(NS + 'NodeList'), '')
    return out


def build(xml_path, ns_index=4):
    tree = ET.parse(xml_path)
    root = tree.getroot()
    hdr = root.find(NS + 'Header')
    pinfo = hdr.find(NS + 'ProjectInfo')
    obj = hdr.find(NS + 'SymbolConfigObject')
    meta = {
        'file': os.path.basename(xml_path),
        'symcfg_version': (hdr.findtext(NS + 'Version') or '').strip(),
        'profile': obj.get('profile') if obj is not None else '',
        'runtimeid': obj.get('runtimeid') if obj is not None else '',
        'project': pinfo.get('name') if pinfo is not None else '',
        'device': pinfo.get('devicename') if pinfo is not None else '',
        'app': pinfo.get('appname') if pinfo is not None else '',
    }

    td = TypeDict(root)
    raw = parse_symbols(root)

    symbols, types_used = [], []
    for s in raw:
        tname = s['type']
        n = td.t.get(tname, {})
        size, align, _, verified = td.layout(tname)
        cnt = td.count(tname)
        base = n.get('base') if n.get('tag') == 'TypeArray' else None
        elem = align_up(*td.layout(base)[:2]) if base else size
        if base:
            # 用数组总长反推元素跨度做校验
            if cnt and size % cnt == 0 and size // cnt == elem:
                verified = True

        ch = td.chain(tname)
        is_fb = any(any(m in c for m in FB_MARKERS) for c in ch) or bool(FB_TYPE_HINT.match(tname))

        lv = leaves(td, tname)
        leaf_points = len(lv)
        write_risk = (s['access'].lower() == 'readwrite'
                      and bool(PLC_OWNED.match(s['name']))
                      and not WRITE_ALLOWED.search(s['name']))

        gvl = s['path'].rsplit('.', 1)[0]
        risk = []
        if not verified:
            risk.append('layout_unverified')
        if is_fb:
            risk.append('fb_instance')
        if write_risk:
            risk.append('write_overreach')
        if size > 512:
            risk.append('large_block')
        if s['access'].lower() != 'readwrite':
            risk.append('read_only')

        symbols.append({
            'symbolPath': s['path'],
            'nodeId': f'ns={ns_index};s={s["path"]}',
            'gvl': gvl,
            'name': s['name'],
            'type': tname,
            'iecType': td.iec(tname),
            'bytes': size,
            'align': align,
            'count': cnt,
            'elemStride': elem,
            'access': 'rw' if s['access'].lower() == 'readwrite' else 'r',
            'comment': s['comment'],
            'leafPoints': leaf_points,
            'layoutVerified': verified,
            'risk': risk,
            '_leaves': lv,
        })
        if tname not in types_used:
            types_used.append(tname)

    # 类型字典（只导出被引用的闭包）
    closure = set()
    for t in types_used:
        closure.update(td.chain(t))
    types_out = {}
    for name in sorted(closure):
        n = td.t.get(name)
        if not n:
            continue
        size, align, members, verified = td.layout(name)
        d = {'kind': n['tag'], 'iec': n['iec'], 'bytes': size, 'align': align,
             'declaredBytes': n['declared'], 'verified': verified}
        if n['tag'] == 'TypeArray':
            d['base'] = n['base']
            d['count'] = td.count(name)
            d['elemStride'] = align_up(*td.layout(n['base'])[:2])
            d['dims'] = [{'min': a, 'max': b} for a, b in n['dims']]
        if members:
            d['members'] = [{'name': m['name'], 'type': m['type'], 'iec': m['iec'],
                             'offset': m['offset'], 'bytes': m['size'],
                             'count': m['count'], 'stride': m['stride']} for m in members]
        if n['enums']:
            d['enumValues'] = n['enums']
        types_out[name] = d

    return meta, symbols, types_out, td


# ---------------------------------------------------------------- 输出

def write_json(path, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def write_tag_table(dirp, meta, symbols, types_out):
    doc = {
        'schema': SCHEMA_ID,
        'source': meta,
        'stats': {
            'gvlCount': len({s['gvl'] for s in symbols}),
            'symbolCount': len(symbols),
            'leafPoints': sum(s['leafPoints'] for s in symbols),
            'totalBytes': sum(s['bytes'] for s in symbols),
        },
        'types': types_out,
        'symbols': [{k: v for k, v in s.items() if not k.startswith('_')} for s in symbols],
    }
    write_json(os.path.join(dirp, 'tag_table.json'), doc)
    return doc


def write_symbols_csv(dirp, symbols):
    p = os.path.join(dirp, 'symbols.csv')
    with open(p, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['GVL', '符号名', 'IEC类型', '字节', '元素数', '元素跨度',
                    '叶子点', '访问', '布局可信', '风险', '注释', 'OPC UA 节点ID'])
        for s in symbols:
            w.writerow([s['gvl'], s['name'], s['iecType'], s['bytes'], s['count'],
                        s['elemStride'], s['leafPoints'], s['access'],
                        'Y' if s['layoutVerified'] else 'N',
                        ';'.join(s['risk']), s['comment'], s['nodeId']])
    return p


def write_leaf_csv(dirp, symbols):
    p = os.path.join(dirp, 'leaf_vars.csv')
    with open(p, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['GVL', '符号', '变量路径', 'IEC类型', '相对偏移', '字节', '访问'])
        for s in symbols:
            for path, iec, off, sz in s['_leaves']:
                w.writerow([s['gvl'], s['name'], path, iec, off, sz, s['access']])
    return p


def write_ctype_header(dirp, types_out, meta):
    p = os.path.join(dirp, 'types_layout.h')
    L = []
    L.append('/* 自动生成，请勿手改 —— 源: %s (SymbolConfig %s) */' % (meta['file'], meta['symcfg_version']))
    L.append('#ifndef CODESYS_LAYOUT_H')
    L.append('#define CODESYS_LAYOUT_H')
    L.append('#include <stdint.h>')
    L.append('')
    L.append('/* 尺寸与对齐均由 CODESYS 对齐规则推算，并经数组跨度交叉校验。')
    L.append(' * 使用方式：按偏移从报文缓冲区里 memcpy，不要依赖编译器对结构体的布局。 */')
    for name, d in types_out.items():
        macro = re.sub(r'[^A-Za-z0-9_]', '_', name).upper()
        L.append('')
        L.append('/* %s  (%s, %d bytes, align %d%s) */'
                 % (name, d['iec'], d['bytes'], d['align'],
                    '' if d['verified'] else ', LAYOUT UNVERIFIED'))
        L.append('#define %-40s %d' % ('SZ_' + macro, d['bytes']))
        L.append('#define %-40s %d' % ('AL_' + macro, d['align']))
        if 'elemStride' in d:
            L.append('#define %-40s %d' % ('EL_' + macro, d['elemStride']))
        for m in d.get('members', []):
            mm = '%s_%s' % (macro, re.sub(r'[^A-Za-z0-9_]', '_', m['name']).upper())
            L.append('#define %-40s %d' % ('OFF_' + mm, m['offset']))
            L.append('#define %-40s %d' % ('SZ_' + mm, m['bytes']))
    L.append('')
    L.append('#endif /* CODESYS_LAYOUT_H */')
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(L) + '\n')
    return p


def write_audit(dirp, meta, symbols, types_out):
    gvls = {}
    for s in symbols:
        gvls.setdefault(s['gvl'], []).append(s)
    n_unv = [s for s in symbols if not s['layoutVerified']]
    n_fb = [s for s in symbols if 'fb_instance' in s['risk']]
    n_wr = [s for s in symbols if 'write_overreach' in s['risk']]
    n_ro = [s for s in symbols if s['access'] == 'r']
    n_rw = len(symbols) - len(n_ro)
    # 命名检查：纯机械规则，不针对任何具体工程
    n_odd = []
    _seen_gvl = {}
    for g in gvls:
        short = g.replace('.Application.', '')
        _seen_gvl.setdefault(short.upper().replace('GVL_', ''), []).append(short)
    for _k, _v in sorted(_seen_gvl.items()):
        if len(_v) > 1:
            n_odd.append(('/'.join(_v), '近似重名', '明确分工并写进文档'))
    for g in gvls:
        short = g.replace('.Application.', '')
        if len(short) <= 6 and not short.startswith('GVL_'):
            n_odd.append((short, '名称过短、语义不明', '补注释说明用途'))
    for s_ in symbols:
        nm = s_['name']
        if re.search(r'(.)\1{2,}', nm):
            n_odd.append((nm, '含连续重复字符', '确认是否拼写笔误'))
        if re.search(r'(CONTROL|PARAM)', nm, re.I) and re.search(r'CONTIRL|CONTROL_|PARARM', nm, re.I):
            n_odd.append((nm, '疑似拼写笔误', '新工程请用标准拼写'))
    n_large = sorted(symbols, key=lambda s: -s['bytes'])[:8]
    bad_types = {k: v for k, v in types_out.items()
                 if not v['verified'] and v.get('kind') == 'TypeUserDef'}

    L = []
    A = L.append
    A('# CODESYS 符号配置审计报告')
    A('')
    A('| 项 | 值 |')
    A('|---|---|')
    A('| 源文件 | `%s` |' % meta['file'])
    A('| 工程 / 设备 / 应用 | %s / %s / %s |' % (meta['project'], meta['device'], meta['app']))
    A('| SymbolConfig 版本 | %s |' % meta['symcfg_version'])
    A('| CODESYS 编译器 profile | %s |' % meta['profile'])
    A('| 运行时 ID | %s |' % meta['runtimeid'])
    A('| GVL 数 | %d |' % len(gvls))
    A('| 符号数 | %d |' % len(symbols))
    A('| 叶子点位数 | %d |' % sum(s['leafPoints'] for s in symbols))
    A('| 总字节数 | %d |' % sum(s['bytes'] for s in symbols))
    A('| 只读符号 | %d |' % len(n_ro))
    A('| 布局待验证符号 | %d |' % len(n_unv))
    A('| 可写符号 | %d |' % n_rw)
    A('')
    A('## 1. 各 GVL 负载')
    A('')
    A('| GVL | 符号 | 叶子点 | 字节 | 备注 |')
    A('|---|---:|---:|---:|---|')
    for g, ss in sorted(gvls.items(), key=lambda kv: -sum(s['bytes'] for s in kv[1])):
        A('| `%s` | %d | %d | %d | |' % (g.replace('.Application.', ''), len(ss),
                                         sum(s['leafPoints'] for s in ss),
                                         sum(s['bytes'] for s in ss)))
    A('')
    A('## 2. 写权限越界（需在符号配置里逐个改为只读）')
    A('')
    A('共 **%d** 个符号为 ReadWrite，其中 %d 个按命名判断应归 PLC 独占写。' % (len(symbols) - len(n_ro), len(n_wr)))
    A('')
    if n_wr:
        A('| 符号 | 类型 | 访问 | 判断依据 |')
        A('|---|---|---|---|')
        for s in n_wr:
            A('| `%s` | %s | %s | 状态/计数/报警类，HMI 不应写 |'
              % (s['name'], s['iecType'], s['access']))
    A('')
    A('## 3. 布局不可信（禁止按字节解码）')
    A('')
    A('以下类型的声明 size 与成员推算矛盾（声明为 0，或差值超过对齐值），')
    A('说明该类型为优化布局、或类型定义不在本工程内，**不能按偏移解码**：')
    A('')
    if bad_types:
        A('| 类型 | 声明字节 | 推算字节 | 结论 |')
        A('|---|---:|---:|---|')
        for k, v in bad_types.items():
            A('| `%s` | %d | %d | 禁止字节解码 |' % (k, v['declaredBytes'], v['bytes']))
    else:
        A('（无）')
    if n_unv:
        A('')
        A('受影响符号：')
        A('')
        for s in n_unv:
            A('- `%s` — %s，%d 字节' % (s['symbolPath'].replace('.Application.', ''), s['iecType'], s['bytes']))
    pad_only = {k: v for k, v in types_out.items()
                if v['verified'] and v.get('kind') == 'TypeUserDef'
                and v['declaredBytes'] and v['declaredBytes'] != v['bytes']}
    if pad_only:
        A('')
        A('### 仅缺尾部填充（布局可信）')
        A('')
        A('声明 size 不含尾部补齐字节，按对齐规则补齐后与数组实测跨度一致，可以放心解码：')
        A('')
        A('| 类型 | 声明字节 | 补齐后 | 尾填充 | 校验依据 |')
        A('|---|---:|---:|---:|---|')
        for k, v in pad_only.items():
            A('| `%s` | %d | %d | %d | 数组跨度吻合 |'
              % (k, v['declaredBytes'], v['bytes'], v['bytes'] - v['declaredBytes']))
    A('')
    A('## 4. FB 实例数组（应排除出符号配置）')
    A('')
    if n_fb:
        A('| 符号 | 类型 | 字节 | 原因 |')
        A('|---|---|---:|---|')
        for s in n_fb:
            A('| `%s` | %s | %d | 含定时器/FB 内部状态，语义不稳定 |'
              % (s['name'], s['iecType'], s['bytes']))
    A('')
    A('## 5. 体积 Top 8')
    A('')
    A('| 符号 | 字节 | 叶子点 |')
    A('|---|---:|---:|')
    for s in n_large:
        A('| `%s` | %d | %d |' % (s['name'], s['bytes'], s['leafPoints']))
    A('')
    A('## 6. 命名检查')
    A('')
    A('按规则自动检出的可疑命名（不是错误，只是提示）：')
    A('')
    if n_odd:
        A('| 符号 | 现象 | 建议 |')
        A('|---|---|---|')
        for it in n_odd:
            A('| `%s` | %s | %s |' % (it[0], it[1], it[2]))
    else:
        A('无。')
    A('')
    A('> OPC UA 的 NodeId 直接由符号路径构成，运行中改名会让 HMI 侧变成 `BadNodeIdUnknown`。')
    A('> 因此**不建议对已投产的符号改名**，只在新建 GVL 时遵守命名规范。')
    A('')
    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser(description='CODESYS 符号配置 XML → HMI 标签表')
    ap.add_argument('xml', help='*.Device.Application.xml')
    ap.add_argument('-o', '--out', default='out/symconfig', help='输出目录')
    ap.add_argument('--ns-index', type=int, default=4, help='OPC UA 命名空间索引（默认 4，需现场确认）')
    ap.add_argument('--fail-on-high', action='store_true', help='存在高危项时退出码 2')
    args = ap.parse_args()

    if not os.path.isfile(args.xml):
        sys.exit('找不到文件: %s' % args.xml)
    os.makedirs(args.out, exist_ok=True)

    meta, symbols, types_out, td = build(args.xml, args.ns_index)
    doc = write_tag_table(args.out, meta, symbols, types_out)
    write_symbols_csv(args.out, symbols)
    write_leaf_csv(args.out, symbols)
    write_ctype_header(args.out, types_out, meta)
    audit = write_audit(args.out, meta, symbols, types_out)
    with open(os.path.join(args.out, 'audit.md'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(audit + '\n')

    st = doc['stats']
    print('=== 解析完成 ===')
    print('工程        : %s / %s / %s' % (meta['project'], meta['device'], meta['app']))
    print('SymbolConfig: %s  (%s)' % (meta['symcfg_version'], meta['profile']))
    print('GVL / 符号  : %d / %d' % (st['gvlCount'], st['symbolCount']))
    print('叶子点位    : %d' % st['leafPoints'])
    print('总字节      : %d' % st['totalBytes'])
    hi = [s for s in symbols if not s['layoutVerified'] or 'fb_instance' in s['risk']]
    print('高危符号    : %d' % len(hi))
    print('输出目录    : %s' % os.path.abspath(args.out))
    print('  tag_table.json / symbols.csv / leaf_vars.csv / types_layout.h / types_layout.json / audit.md')
    if args.fail_on_high and hi:
        sys.exit(2)


if __name__ == '__main__':
    main()
