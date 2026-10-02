# -*- coding: utf-8 -*-
"""
func-def-gen · 逻辑一致性校验脚本（通用版）

对生成稿每个功能章节做"逻辑层"内部一致性比对，重点抓：
  1. 串章复制：故障处理/故障恢复段错引了其它章节的弹窗名或主题词
     （即"恢复后显示错误弹窗"的硬伤，最常见于模板跨章复制套话）
  2. HMI 属性完整性：弹窗优先级 / 有无报警声音 / 报警声音优先级 是否空缺
  3. 触发条件对齐：触发条件引用的信号是否列在相关信号表、触发值是否合法
  4. 跨章节同信号价值描述冲突：同一信号在不同章写法不一致

注意：模板「故障恢复/故障处理」段是跨章近乎一致的套话，自动检测只覆盖
"弹窗名精确匹配"和"主题词"两类；结论出来后仍需人工通扫全部章节的
故障处理/故障恢复段，排除更多同类复制错误。

用法:
  python logic_verify.py <generated.docx> [--out logic_verify_report.md]
"""
import argparse, re, json
from pathlib import Path
from collections import Counter
from docx import Document
from docx.text.paragraph import Paragraph
from docx.table import Table
from docx.oxml.ns import qn
from report_provenance import provenance_lines

# 常见汽车/座舱主题词（用于串章的主题词判定；非本章主题词出现在故障段即疑似串章）
TOPICS = ['胎压', '安全气囊', '安全带', '车门', '门开', '舱盖', '灯光', '转向', '制动',
          '充电', '空调', '电池', '电机', '发动机', '变速器', '四驱', '差速锁', '涉水',
          '巡航', '防盗', '钥匙', '尾门', '疲劳', '限速', '驾驶模式', '弹射', '坦克掉头',
          '蠕行', '回收', '能量模式', '拖车', '驻车', '保养', '机油', 'GPF', '水温',
          '手机', '雷达', 'EPS', 'PBM', 'EPB', 'AVH']


def topic_of(t):
    for k in TOPICS:
        if k in t:
            return k
    return None


def rows(t):
    return [[c.text.strip() for c in r.cells] for r in t.rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('docx')
    ap.add_argument('--out', help='报告路径（默认写入输入文档所在目录）')
    ap.add_argument('--strict', action='store_true', help='发现逻辑问题时返回非零')
    a = ap.parse_args()
    report_path = a.out or str(Path(a.docx).resolve().parent / 'logic_verify_report.md')

    doc = Document(a.docx)
    body = doc.element.body
    chapters = []
    cur = None
    curh3 = None
    in_feature_area = False
    anchors = {'本功能涉及的法规内容', '功能逻辑架构图', '功能描述', '使能条件',
               '配置字', '触发条件', '执行输出', 'HMI要求', '退出条件',
               '故障处理', '故障恢复', '相关信号'}
    for ch in body.iterchildren():
        if ch.tag == qn('w:p'):
            p = Paragraph(ch, doc)
            st = p.style.name if p.style else ''
            t = p.text.strip()
            if st == 'Heading 1':
                in_feature_area = t.strip().rstrip('：:').strip() == '系统功能描述'
                cur = curh3 = None
            elif st == 'Heading 2':
                curh3 = None
            elif st == 'Heading 3':
                title = t.rstrip('：:').strip()
                if not in_feature_area:
                    curh3 = None
                elif title in anchors and cur is not None:
                    curh3 = {'h': title, 'para': [], 'tbls': []}
                    cur['subs'][title] = curh3
                elif title:
                    cur = {'h': title, 'h1': False, 'subs': {}}
                    chapters.append(cur)
                    curh3 = None
            else:
                if curh3 is not None:
                    curh3['para'].append(t)
                elif cur is not None:
                    cur.setdefault('intro', []).append(t)
        elif ch.tag == qn('w:tbl'):
            tbl = Table(ch, doc)
            if curh3 is not None:
                curh3['tbls'].append(tbl)
            elif cur is not None:
                cur.setdefault('tbls', []).append(tbl)

    func_chapters = chapters

    # 全局弹窗名 -> 归属章节
    popup_owner = {}
    for c in func_chapters:
        for s in c['subs'].values():
            for t in s['tbls']:
                r = rows(t)
                if r and any('弹窗优先级' in h for h in r[0]):
                    for x in r[1:]:
                        if x and x[0].strip():
                            popup_owner.setdefault(x[0].strip(), set()).add(c['h'])

    issues = []
    sig_value_global = {}
    for c in func_chapters:
        title = c['h']
        own = topic_of(title)
        subs = c['subs']
        # HMI 属性完整性
        hmi = None
        for s in subs.values():
            for t in s['tbls']:
                r = rows(t)
                if r and any('弹窗优先级' in h for h in r[0]):
                    hmi = r
                    break
            if hmi:
                break
        if hmi:
            hdr = hmi[0]
            try:
                i_pop = hdr.index('报警弹窗')
                i_cls = [i for i, h in enumerate(hdr) if '弹窗优先级' in h][0]
                i_snd = [i for i, h in enumerate(hdr) if '有无' in h][0]
                i_sndlv = [i for i, h in enumerate(hdr) if '报警声音优先级' in h][0]
            except (ValueError, IndexError):
                i_pop = i_cls = i_snd = i_sndlv = None
            if None not in (i_pop, i_cls, i_snd, i_sndlv):
                for x in hmi[1:]:
                    if not any(x):
                        continue
                    if not x[i_cls].strip():
                        issues.append((title, 'HMI属性不完整', f"弹窗『{x[i_pop]}』弹窗优先级为空"))
                    if x[i_snd].strip() == '有' and (not x[i_sndlv].strip() or x[i_sndlv].strip() == '无'):
                        issues.append((title, 'HMI属性不完整', f"弹窗『{x[i_pop]}』有声音但报警声音优先级为空/无"))
        # 相关信号
        rel = None
        for s in subs.values():
            for t in s['tbls']:
                r = rows(t)
                if r and '信号名称' in r[0] and '报文名称' in r[0]:
                    rel = r
                    break
            if rel:
                break
        sig_vals = {}
        if rel:
            hdr = rel[0]
            si = hdr.index('信号名称')
            vi = hdr.index('信号值描述') if '信号值描述' in hdr else None
            for x in rel[1:]:
                if any(x):
                    sig = x[si]
                    val = re.sub(r'\s+', '', x[vi]) if vi is not None and vi < len(x) else ''
                    sig_vals[sig] = val
                    sig_value_global.setdefault(sig, []).append((title, val))
        # 触发条件对齐 (re.ASCII 避免 \w 匹配中文)
        trig = ' '.join(' '.join(v.get('para', [])) for k, v in subs.items() if k.startswith('触发条件'))
        for sig, val in re.findall(r'([A-Za-z][A-Za-z0-9_]*)=0x([0-9A-Fa-f]+)', trig, re.ASCII):
            key = [s for s in sig_vals if s.upper() == sig.upper()]
            if not key:
                issues.append((title, '触发信号未在相关信号列出', f"触发条件引用 {sig}=0x{val}，相关信号表无此信号"))
            else:
                vals = set(re.findall(r'0x([0-9A-Fa-f]+)', sig_vals[key[0]]))
                if val.lower() not in vals:
                    issues.append((title, '触发值与信号值描述不符', f"触发 {sig}=0x{val} 但该信号值描述无 0x{val}(含{sorted(vals)})"))
        # 串章: 故障处理/故障恢复 (startswith)
        for k in subs:
            if not (k.startswith('故障处理') or k.startswith('故障恢复')):
                continue
            txt = ' '.join(subs[k].get('para', []))
            for popup, owners in popup_owner.items():
                if len(popup) < 4:
                    continue
                if popup in txt and title not in owners:
                    issues.append((title, '串章引用(弹窗名)', f"{k} 提及弹窗『{popup}』属其他章节({list(owners)})"))
            for tk in TOPICS:
                if tk == own:
                    continue
                if tk in txt and re.search(tk + r'.{0,6}(弹窗|报警|显示|故障|提示|灯)', txt):
                    issues.append((title, '串章引用(主题词)', f"{k} 出现非本章主题『{tk}』(本章主题={own})"))
            # 源报文泄漏
            for m in re.findall(r'\b([A-Z][A-Z0-9_]*_0x[0-9A-Fa-f]+)\b', txt):
                if rel and not any(m in ' '.join(c) for c in rel):
                    issues.append((title, '串章引用(源报文)', f"{k} 提及源报文 {m} 非本章相关信号源"))

    conflicts = [(s, l) for s, l in sig_value_global.items() if len({v for _, v in l}) > 1]
    cat = Counter(x[1] for x in issues)
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write("# 逻辑一致性核验报告\n\n")
        f.write("\n".join(provenance_lines(a.docx)) + "\n")
        f.write(f"**功能章节数**: {len(func_chapters)}\n\n")
        f.write(f"## 总览\n\n- 逻辑问题条目: **{len(issues)}**\n")
        for k, v in cat.most_common():
            f.write(f"  - {k}: {v}\n")
        f.write(f"- 跨章节同信号价值冲突: **{len(conflicts)}** 个信号\n\n")
        f.write("## 一、串章引用(故障处理/恢复复制自其它章节)\n\n")
        for title, ca, det in issues:
            if ca.startswith('串章'):
                f.write(f"- **{title}**: {det}\n")
        f.write("\n## 二、HMI属性不完整 / 触发对齐\n\n")
        f.write("| 章节 | 类别 | 说明 |\n|------|------|------|\n")
        for title, ca, det in issues:
            if ca in ('HMI属性不完整', '触发信号未在相关信号列出', '触发值与信号值描述不符'):
                f.write(f"| {title} | {ca} | {det} |\n")
        f.write("\n## 三、跨章节同信号价值冲突\n\n")
        for s, l in conflicts:
            f.write(f"\n### {s}（{len(l)}章, {len({v for _, v in l})}种值描述）\n")
            for t, v in l:
                f.write(f"- {t}: {v[:70]}\n")

    print("条目:", len(issues), dict(cat))
    print("跨章冲突:", len(conflicts))
    print("--- 串章 ---")
    for title, ca, det in issues:
        if ca.startswith('串章'):
            print(f"  {title} | {det}")
    if a.strict and (issues or conflicts):
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
