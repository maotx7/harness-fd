# -*- coding: utf-8 -*-
"""Extract text/tables from docx / xls / pdf into a readable txt for diffing.
Usage: python extract_doc.py <input_file> <output_txt>
"""
import sys, os

def main():
    if len(sys.argv) < 3:
        print("usage: extract_doc.py <input> <output>")
        sys.exit(1)
    inp, outp = sys.argv[1], sys.argv[2]
    ext = os.path.splitext(inp)[1].lower()
    if ext in ('.docx', '.doc'):
        extract_docx(inp, outp)
    elif ext in ('.xls', '.xlsx'):
        extract_xls(inp, outp)
    elif ext == '.pdf':
        extract_pdf(inp, outp)
    else:
        print("unsupported ext:", ext)
        sys.exit(1)
    print("done ->", outp)

def extract_docx(path, outp):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn
    doc = Document(path)
    def iter_blocks(parent):
        body = parent.element.body
        for child in body.iterchildren():
            if child.tag == qn('w:p'):
                yield Paragraph(child, parent)
            elif child.tag == qn('w:tbl'):
                yield Table(child, parent)
    tcount = 0
    with open(outp, 'w', encoding='utf-8') as f:
        for block in iter_blocks(doc):
            if isinstance(block, Paragraph):
                t = block.text.strip()
                if t:
                    style = block.style.name if block.style else ''
                    f.write(f"[{style}] {t}\n")
            else:
                tcount += 1
                f.write(f"\n===== TABLE {tcount} (rows={len(block.rows)}, cols={len(block.columns)}) =====\n")
                for ri, row in enumerate(block.rows):
                    cells = []
                    seen = set()
                    for c in row.cells:
                        if c._tc in seen: continue
                        seen.add(c._tc)
                        cells.append(c.text.replace('\n', '/').strip())
                    f.write(f"R{ri}: " + " | ".join(cells) + "\n")
                f.write("===== END TABLE =====\n\n")

def extract_xls(path, outp):
    import xlrd
    wb = xlrd.open_workbook(path)
    with open(outp, 'w', encoding='utf-8') as f:
        for sh in wb.sheet_names():
            ws = wb.sheet_by_name(sh)
            f.write(f"\n===== SHEET: {sh} (rows={ws.nrows}, cols={ws.ncols}) =====\n")
            for r in range(ws.nrows):
                vals = []
                for c in range(ws.ncols):
                    v = ws.cell_value(r, c)
                    if v is not None and str(v).strip() != "":
                        vals.append(str(v).replace('\n', '/'))
                if vals:
                    f.write(" | ".join(vals) + "\n")

def extract_pdf(path, outp):
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        n = len(pdf.pages)
        with open(outp, 'w', encoding='utf-8') as f:
            for i, page in enumerate(pdf.pages):
                f.write(f"\n===== PAGE {i+1} =====\n")
                f.write((page.extract_text() or "") + "\n")
        print("pages:", n, end=" ")

if __name__ == '__main__':
    main()
