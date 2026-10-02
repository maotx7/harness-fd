# -*- coding: utf-8 -*-
"""Audit a generated function-definition docx for empty/placeholder subsections.
Usage: python audit.py <generated.docx> <report.txt>
Scans for: NA / empty '；' / empty Heading3 / consecutive empty sections / TBD / TODO.
Emphasizes 相关信号 / 故障处理 / 故障恢复 still empty.
"""
import argparse
import sys
from docx import Document
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn
from report_provenance import provenance_lines

MODULE_SUBSECTIONS = {
    '本功能涉及的法规内容', '功能逻辑架构图', '功能描述', '使能条件',
    '配置字', '触发条件', '执行输出', 'HMI要求', '退出条件',
    '故障处理', '故障恢复', '相关信号',
}
CORE_SECTIONS = ('功能描述', '使能条件', '触发条件', '执行输出', 'HMI要求', '退出条件')


def _heading(text):
    return str(text or '').strip().rstrip('：:').strip()


def inspect_modules(doc):
    """Count H3 feature modules and core sections (H3 or H4) without paragraph indexes."""
    modules = []
    current = None
    section = None
    feature_area = False
    for child in doc.element.body.iterchildren():
        if child.tag == qn('w:p'):
            p = Paragraph(child, doc)
            style = p.style.name if p.style else ''
            text = _heading(p.text)
            if style == 'Heading 1':
                feature_area = text == '系统功能描述'
                current = section = None
            elif feature_area and style == 'Heading 2':
                current = section = None
            elif feature_area and style == 'Heading 3':
                # H3 can be either a module subsection (when current exists) or a new module
                if text in MODULE_SUBSECTIONS and current is not None:
                    section = {'title': text, 'has_content': False}
                    current['sections'][text] = section
                elif text:
                    current = {'title': text, 'sections': {}}
                    modules.append(current)
                    section = None
            elif feature_area and style == 'Heading 4':
                # H4 is treated as a module subsection when a module exists
                if text in MODULE_SUBSECTIONS and current is not None:
                    section = {'title': text, 'has_content': False}
                    current['sections'][text] = section
            elif feature_area and section is not None and not style.startswith('Heading'):
                if p.text.strip():
                    section['has_content'] = True
        elif feature_area and section is not None and child.tag == qn('w:tbl'):
            # Tables are handled below through python-docx; a non-empty table is content.
            from docx.table import Table
            table = Table(child, doc)
            if any(cell.text.strip() for row in table.rows for cell in row.cells):
                section['has_content'] = True
    empty = []
    filled = []
    for module in modules:
        for name in CORE_SECTIONS:
            item = module['sections'].get(name)
            key = f"{module['title']}/{name}"
            if item and item['has_content']:
                filled.append(key)
            else:
                empty.append(key)
    total = len(modules) * len(CORE_SECTIONS)
    return {
        'module_count': len(modules),
        'target_section_count': total,
        'filled_section_count': len(filled),
        'empty_section_count': len(empty),
        'coverage': len(filled) / total if total else 0.0,
        'empty_sections': empty,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('docx')
    ap.add_argument('report')
    ap.add_argument('--strict', action='store_true', help='核心正文不完整时返回非零')
    args = ap.parse_args()
    if not args.docx or not args.report:
        print("usage: audit.py <generated.docx> <report.txt>")
        sys.exit(1)
    doc = Document(args.docx)
    structure = inspect_modules(doc)
    issues = []
    # walk body in order, track heading stack
    body = doc.element.body
    blocks = []  # ('h1'|'h2'|'h3'|'p'|'tbl', text_or_None, has_content)
    for child in body.iterchildren():
        if child.tag == qn('w:p'):
            p = Paragraph(child, doc)
            style = p.style.name if p.style else ''
            txt = p.text.strip()
            if style.startswith('Heading'):
                blocks.append((style, txt, bool(txt)))
            else:
                blocks.append(('p', txt, bool(txt)))
        elif child.tag == qn('w:tbl'):
            from docx.table import Table
            t = Table(child, doc)
            has = any(any(c.text.strip() for c in row.cells) for row in t.rows)
            blocks.append(('tbl', None, has))
    # detect Heading3 with no following content until next heading
    n = len(blocks)
    EMPTY_FLAGS = ['na', 'n/a', 'tbd', 'todo', '待补', '待定']
    for i, (kind, txt, has) in enumerate(blocks):
        if kind == 'Heading 3':
            # look ahead for first content or next heading
            j = i + 1
            content_found = False
            while j < n:
                k2, _t2, h2 = blocks[j]
                if k2.startswith('Heading'):
                    break
                if h2:
                    content_found = True
                    break
                j += 1
            if not content_found:
                issues.append(f"空章节: [{kind}] {txt} (其后无内容直到下个标题)")
        if kind == 'p' and txt:
            low = txt.lower()
            if any(f in low for f in EMPTY_FLAGS) or txt.strip() in ('；', ';', 'NA', '无'):
                issues.append(f"疑似空占位: {txt[:60]}")
    # report
    with open(args.report, 'w', encoding='utf-8') as f:
        f.write(f"# 查漏报告: {args.docx}\n")
        f.write("\n".join(provenance_lines(args.docx)) + "\n")
        f.write(f"功能模块数: {structure['module_count']}\n")
        f.write(
            f"核心正文覆盖: {structure['filled_section_count']}/"
            f"{structure['target_section_count']} "
            f"({structure['coverage']:.1%})\n"
        )
        if structure['empty_sections']:
            f.write("核心正文空小节:\n")
            for item in structure['empty_sections']:
                f.write(f"- {item}\n")
        f.write("\n")
        f.write(f"总块数: {n}, 发现问题: {len(issues)}\n\n")
        if not issues:
            f.write("未发现明显的空占位/空章节。\n")
        else:
            for it in issues:
                f.write("- " + it + "\n")
    # special emphasis: did 相关信号 / 故障处理 keep empty?
    for target in ['相关信号', '故障处理', '故障恢复']:
        empties = [x for x in issues if target in x]
        print(f"{target}: {'空 ' + str(len(empties)) + ' 处' if empties else '已填充'}")
    print(
        f"modules={structure['module_count']} "
        f"core={structure['filled_section_count']}/{structure['target_section_count']}"
    )
    print(f"total issues: {len(issues)} -> {args.report}")
    if args.strict and (not structure['module_count'] or structure['empty_section_count']):
        return 2
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
