# -*- coding: utf-8 -*-
"""
func-def-gen · 信号校验脚本（通用版）

抽取生成稿每个功能章节「相关信号」表的 (报文名称 / CANID / 信号名称)，
逐条比对目标项目的信号矩阵（xlsx），输出：
  - 信号全部匹配矩阵的章节
  - 存在信号不匹配、需要工程师复核的章节（并按根因归类）
  - 无信号表（空骨架）的章节

用法:
  python signals_verify.py <generated.docx> <matrix.xlsx> [--msgsheet "Msg List"] \
      [--matsheet "Matrix"] [--msg_name_col 0] [--msg_id_col 2] [--sig_col 6] \
      [--out report.md]

矩阵默认值适配 N65QB IBUS ICC 类 CANFD 矩阵：
  Msg List  : col0=Msg Name, col2=Msg ID(0x..)
  Matrix    : 行首合并单元 col0=Msg Name, col6=Signal Name
其他项目矩阵请按实际列索引传参。
"""
import argparse, re, json
from pathlib import Path
from docx import Document
from docx.text.paragraph import Paragraph
from docx.table import Table
from docx.oxml.ns import qn
import openpyxl
from report_provenance import provenance_lines


def norm(s):
    return re.sub(r'\s+', '', str(s).strip()).upper() if s is not None else ''


def pure_sig(s):
    """模板「信号名称」单元格常为 'SigName/中文描述' 或 '中文描述 SigName' 复合写法，
    取全部英文 token 再比对：任一 token 与矩阵信号名一致即视为匹配，
    避免『中文在前』的写法（如 '洗车模式开关信号 ICC_WashCarModReq'）被误判为不匹配。"""
    if s is None:
        return []
    return re.findall(r'[A-Za-z][A-Za-z0-9_]{3,}', str(s))


def hexint(s):
    if s is None:
        return None
    s = str(s).strip().replace('0X', '0x')
    m = re.search(r'0x[0-9A-Fa-f]+', s)
    if not m:
        m = re.search(r'^[0-9A-Fa-f]+$', s)
        if not m:
            return None
        try:
            return int(m.group(0), 16)
        except ValueError:
            return None
    try:
        return int(m.group(0)[2:], 16)
    except ValueError:
        return None


def load_matrix(path, msgsheet, matsheet, mnc, mic, sc):
    wb = openpyxl.load_workbook(path, data_only=True)
    ml = wb[msgsheet]
    mt = wb[matsheet]
    msg_names = set()
    msg_canid = {}          # norm_name -> set(canid_int)
    for r in ml.iter_rows(values_only=True):
        if r[0] is None:
            continue
        n = norm(r[0])
        if not n:
            continue
        msg_names.add(n)
        cid = hexint(r[mic]) if mic < len(r) else None
        msg_canid.setdefault(n, set()).add(cid)
    sig_pairs = set()       # (norm_msg, norm_sig)
    cur_msg = None
    for r in mt.iter_rows(values_only=True):
        mn = r[0]
        sn = r[sc] if sc < len(r) else None
        if mn is not None and norm(mn):
            cur_msg = norm(mn)
        if cur_msg and sn is not None:
            s = norm(sn)
            if s:
                sig_pairs.add((cur_msg, s))
    return msg_names, msg_canid, sig_pairs


def extract_chapters(docx):
    doc = Document(docx)
    body = doc.element.body
    blocks = []
    cur = None
    in_feature_area = False
    anchors = {'本功能涉及的法规内容', '功能逻辑架构图', '功能描述', '使能条件',
               '配置字', '触发条件', '执行输出', 'HMI要求', '退出条件',
               '故障处理', '故障恢复', '相关信号'}
    for ch in body.iterchildren():
        if ch.tag == qn('w:p'):
            p = Paragraph(ch, doc)
            st = p.style.name if p.style else ''
            title = p.text.strip().rstrip('：:').strip()
            if st == 'Heading 1':
                in_feature_area = title == '系统功能描述'
                cur = None
            elif in_feature_area and st == 'Heading 2':
                cur = None
            elif in_feature_area and st == 'Heading 3':
                if title and title not in anchors:
                    cur = {'h': title, 'h1': False, 'tbls': []}
                    blocks.append(cur)
        elif ch.tag == qn('w:tbl') and cur is not None:
            cur['tbls'].append(Table(ch, doc))
    return blocks


def dedupe_cells(row):
    """合并单元格去重：同一 _tc 连续重复只保留一次，使数据行列位与表头对齐。
    坑：横向合并单元格行 row.cells 会返回重复项，按固定列索引取值会错位漏检。"""
    seen = []
    for c in row.cells:
        if not seen or c._tc is not seen[-1]._tc:
            seen.append(c)
    return [c.text.strip() for c in seen]


def is_signal_table(t):
    hdr = dedupe_cells(t.rows[0])
    return ('报文名称' in hdr) and ('信号名称' in hdr)


def get_cols(hdr):
    return (next((i for i, h in enumerate(hdr) if h == '报文名称'), None),
            next((i for i, h in enumerate(hdr) if h == 'CANID'), None),
            next((i for i, h in enumerate(hdr) if h == '信号名称'), None))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('docx')
    ap.add_argument('matrix')
    ap.add_argument('--msgsheet', default='Msg List')
    ap.add_argument('--matsheet', default='Matrix')
    ap.add_argument('--msg_name_col', type=int, default=0)
    ap.add_argument('--msg_id_col', type=int, default=2)
    ap.add_argument('--sig_col', type=int, default=6)
    ap.add_argument('--out', help='报告路径（默认写入输入文档所在目录）')
    ap.add_argument('--strict', action='store_true', help='缺信号表或存在不匹配时返回非零')
    a = ap.parse_args()
    report_path = a.out or str(Path(a.docx).resolve().parent / 'signals_verify_report.md')

    msg_names, msg_canid, sig_pairs = load_matrix(
        a.matrix, a.msgsheet, a.matsheet, a.msg_name_col, a.msg_id_col, a.sig_col)
    print(f"[matrix] 报文数={len(msg_names)}  信号对={len(sig_pairs)}")

    chapters = extract_chapters(a.docx)
    report = []
    ok = []
    mismatch = []
    skeleton = []
    for b in chapters:
        title = b['h']
        rows_found = []
        for t in b['tbls']:
            if is_signal_table(t):
                hdr = [c.text.strip() for c in t.rows[0].cells]
                mi, ci, si = get_cols(hdr)
                for r in t.rows[1:]:
                    cells = dedupe_cells(r)
                    if not any(cells):
                        continue
                    msg = cells[mi] if mi is not None else ''
                    cid = cells[ci] if ci is not None else ''
                    sgn = cells[si] if si is not None else ''
                    if not msg and not sgn:
                        continue
                    rows_found.append((msg, cid, sgn))
        if not rows_found:
            skeleton.append(title)
            continue
        issues = []
        for msg, cid, sgn in rows_found:
            mn = norm(msg)
            cint = hexint(cid)
            if not mn:
                issues.append(f"空报文名/信号={sgn}")
                continue
            if mn not in msg_names:
                issues.append(f"报文不存在于矩阵: {msg} (信号 {sgn})")
                continue
            tokens = pure_sig(sgn) if isinstance(pure_sig(sgn), list) else [pure_sig(sgn)]
            if tokens and not any((mn, norm(t)) in sig_pairs for t in tokens):
                issues.append(f"信号不在该报文内: {msg}/{sgn}")
            elif not tokens and (mn, norm(pure_sig(sgn))) not in sig_pairs:
                pass  # 无英文 token（纯中文/空），不计入信号名不匹配
            if cint is not None and cint not in msg_canid.get(mn, set()):
                issues.append(f"CANID不一致: {msg} 文档={cid} 矩阵={sorted(msg_canid.get(mn, set()))}")
        rec = {'title': title, 'rows': len(rows_found), 'issues': issues}
        report.append(rec)
        (mismatch if issues else ok).append(rec)

    with open(report_path, 'w', encoding='utf-8') as f:
        f.write("# 信号源矩阵核验报告\n\n")
        f.write("\n".join(provenance_lines(a.docx, 矩阵=a.matrix)) + "\n")
        f.write(f"(报文{len(msg_names)} / 信号对{len(sig_pairs)})\n\n")
        f.write(f"- 功能模块总数: **{len(chapters)}**\n")
        f.write(f"- 功能章节(含信号表)总数: **{len(report)}**\n")
        f.write(f"- 信号全部匹配矩阵: **{len(ok)}**\n")
        f.write(f"- 存在信号不匹配(需复核): **{len(mismatch)}**\n")
        f.write(f"- 无信号表(空骨架, 未纳入信号核对): **{len(skeleton)}**\n\n")
        f.write("## 一、需复核章节(信号不匹配)\n\n")
        f.write("| 章节 | 行数 | 问题 |\n|------|------|------|\n")
        for r in mismatch:
            f.write(f"| {r['title']} | {r['rows']} | {' ; '.join(r['issues'])} |\n")
        f.write("\n## 二、信号全匹配章节\n\n")
        for r in ok:
            f.write(f"- {r['title']}\n")
        f.write("\n## 三、无信号表章节(骨架/空)\n\n")
        for t in skeleton:
            f.write(f"- {t}\n")

    print("需复核章节数:", len(mismatch))
    print("信号全匹配:", len(ok))
    print("骨架/空章节:", len(skeleton))
    for r in mismatch:
        print(f"  [需复核] {r['title']}: {r['issues']}")
    if a.strict and (skeleton or mismatch):
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
