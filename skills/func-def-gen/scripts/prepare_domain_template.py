# -*- coding: utf-8 -*-
"""Prepare a reusable domain template from an existing function definition.

The source document is never modified.  The output keeps the common cover,
introduction, tables, headers/footers and one reusable feature chapter while
removing project-specific content, people, dates, revision/comment markup and
feature-specific body text.
"""
from __future__ import annotations

import argparse
import copy
import re
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from docx.oxml.ns import qn
from lxml import etree


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _unwrap_revision_markup(root: etree._Element) -> None:
    """Accept insertions, discard deletions and remove comment anchors."""
    removable = {"del", "commentRangeStart", "commentRangeEnd", "commentReference"}
    wrappers = {"ins", "moveTo"}
    for parent in list(root.iter()):
        for child in list(parent):
            name = _local_name(child.tag)
            if name in removable:
                parent.remove(child)
            elif name in wrappers:
                index = parent.index(child)
                parent.remove(child)
                for nested in list(child):
                    parent.insert(index, nested)
                    index += 1
            else:
                _unwrap_revision_markup(child)
        for attr in list(parent.attrib):
            if _local_name(attr).lower().startswith("rsid"):
                del parent.attrib[attr]


def _clean_zip(source: Path, target: Path) -> None:
    """Clean OOXML markup without asking python-docx to reinterpret drawings."""
    with ZipFile(source) as zin, ZipFile(target, "w", ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            name = info.filename
            if re.search(r"(?:^|/)comments[^/]*\.xml$", name, re.I):
                continue
            data = zin.read(name)
            if name.endswith(".xml"):
                try:
                    root = etree.fromstring(data)
                    _unwrap_revision_markup(root)
                    if name == "[Content_Types].xml":
                        for child in list(root):
                            part = child.get("PartName", "")
                            if "comments" in part.lower():
                                root.remove(child)
                    if name.endswith(".rels"):
                        for child in list(root):
                            if "comment" in child.get("Target", "").lower():
                                root.remove(child)
                    data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
                except etree.XMLSyntaxError:
                    pass
            zout.writestr(info, data)


def _iter_body_children(doc):
    for child in list(doc.element.body):
        if child.tag == qn("w:p"):
            from docx.text.paragraph import Paragraph

            yield child, Paragraph(child, doc)
        elif child.tag == qn("w:tbl"):
            from docx.table import Table

            yield child, Table(child, doc)


def _clear_paragraph(paragraph) -> None:
    for run in paragraph.runs:
        run.text = ""


def _set_text(paragraph, text: str) -> None:
    _clear_paragraph(paragraph)
    paragraph.add_run(text)


def _make_one_feature_chapter(doc: Document) -> None:
    blocks = list(_iter_body_children(doc))
    h2 = next(
        (i for i, (_, obj) in enumerate(blocks)
         if hasattr(obj, "style") and obj.style and obj.style.name == "Heading 2"
         and "收音机" in obj.text),
        None,
    )
    if h2 is None:
        raise ValueError("源文档中未找到可抽取的座舱功能章节")
    first_h3 = next(
        (i for i in range(h2 + 1, len(blocks))
         if hasattr(blocks[i][1], "style") and blocks[i][1].style
         and blocks[i][1].style.name in {"Heading 3", "Heading 4"}),
        None,
    )
    if first_h3 is None:
        raise ValueError("源文档中未找到可复用的功能子章节")

    # Find the next feature heading; everything after it is a second feature
    # and is excluded from the reusable one-chapter asset.
    next_feature = next(
        (i for i in range(first_h3 + 1, len(blocks))
         if hasattr(blocks[i][1], "style") and blocks[i][1].style
         and blocks[i][1].style.name == "Heading 3"),
        len(blocks),
    )

    # Keep the common prefix.  Replace the domain-specific H2 and first H3
    # labels with neutral chapter names.
    _set_text(blocks[h2][1], "功能模块")
    _set_text(blocks[first_h3][1], "功能模块 1")

    # Keep only headings in the reusable chapter.  This preserves styles and
    # allows the generator to insert signals/fault text after the anchors.
    keep = {blocks[h2][0], blocks[first_h3][0]}
    for element, obj in blocks[first_h3 + 1:next_feature]:
        if hasattr(obj, "style") and obj.style and obj.style.name in {"Heading 3", "Heading 4"}:
            keep.add(element)
            if obj.style.name == "Heading 4":
                obj.style = doc.styles["Heading 3"]
                # Normalize punctuation variants used by source documents.
                text = obj.text.rstrip("：:").strip()
                _set_text(obj, text)

    # Convert the feature title to the same anchor level as the source's
    # reusable subsection headings; the surrounding module remains Heading 2.
    blocks[first_h3][1].style = doc.styles["Heading 3"]

    # Drop the source feature summary that precedes the first subsection.
    # It is radio-specific and would otherwise leak into every generated spec.
    for element, _ in blocks[h2 + 1:first_h3]:
        element.getparent().remove(element)

    for element, _ in blocks[first_h3 + 1:next_feature]:
        if element not in keep:
            element.getparent().remove(element)
    for element, _ in blocks[next_feature:]:
        element.getparent().remove(element)

    # Remove radio-specific reference/glossary rows while retaining table
    # geometry for future projects to populate.
    for table_index in (1, 2):
        if table_index >= len(doc.tables):
            continue
        table = doc.tables[table_index]
        for row in list(table.rows)[1:]:
            table._tbl.remove(row._tr)
        blank = table.add_row()
        for cell in blank.cells:
            cell.text = ""


def _sanitize_text(doc: Document) -> None:
    replacements = [
        ("ICC（8295）", "{{项目名称}}"),
        ("ICC (8295)", "{{项目名称}}"),
        ("8295", "{{项目代号}}"),
        ("侯雪", ""),
        ("李响", ""),
        ("谢明维", ""),
        ("袁兴洋", ""),
        ("王金龙", ""),
        ("lixiang13", ""),
        ("2026年9月7日", ""),
        ("2026.09.07", ""),
        ("20260907", ""),
        ("已经签批完的OA流程及签批意见贴在此处", ""),
        ("本地收音机", "{{功能名称}}"),
        ("收音机", "{{功能名称}}"),
    ]
    def clean_value(text: str) -> str:
        for old, new in replacements:
            text = text.replace(old, new)
        text = re.sub(r"20\d{2}[./-]\d{1,2}[./-]\d{1,2}", "", text)
        text = re.sub(r"20\d{6}", "", text)
        return text

    def clean_table(table) -> None:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    text = clean_value(paragraph.text)
                    if text != paragraph.text:
                        _set_text(paragraph, text)
                for nested in cell.tables:
                    clean_table(nested)

    for paragraph in doc.paragraphs:
        if paragraph.style and paragraph.style.name.startswith("toc"):
            continue
        text = clean_value(paragraph.text)
        if text != paragraph.text:
            _set_text(paragraph, text)
    for section in doc.sections:
        for part in (section.header, section.footer):
            for paragraph in part.paragraphs:
                text = clean_value(paragraph.text)
                if text != paragraph.text:
                    _set_text(paragraph, text)
            for table in part.tables:
                clean_table(table)
    # Blank people/date fields in the cover and change record without
    # disturbing their labels or table layout.
    for paragraph in doc.paragraphs:
        if any(label in paragraph.text for label in ("交付时间", "编    制", "校    对", "审    核", "审    定", "会    签", "批    准")):
            label = paragraph.text.split("：", 1)[0] if "：" in paragraph.text else paragraph.text.split(":", 1)[0]
            _set_text(paragraph, label + "：")
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                if "更改人" in cell.text or "生效日期" in cell.text:
                    continue
                text = clean_value(cell.text)
                if text != cell.text:
                    cell.text = text

    # The source TOC is a cached field result and still lists removed radio
    # chapters.  Keep a small neutral cache; Word can refresh it later.
    toc = [
        "1. 导言\t1",
        "1.1. 目的和适用范围\t1",
        "1.2. 参考文档\t1",
        "1.3. 措辞约定\t1",
        "1.4. 术语和缩略语\t1",
        "2. 功能概述\t2",
        "3. 系统功能描述\t2",
        "3.1. 功能模块 1\t2",
    ]
    toc_paragraphs = [p for p in doc.paragraphs if p.style and p.style.name.startswith("toc")]
    for paragraph, text in zip(toc_paragraphs, toc):
        _set_text(paragraph, text)
    for paragraph in toc_paragraphs[len(toc):]:
        _clear_paragraph(paragraph)

    # Make the retained change-record geometry neutral.
    if doc.tables:
        table = doc.tables[0]
        for row in table.rows[1:]:
            for cell in row.cells:
                cell.text = ""

    props = doc.core_properties
    props.author = ""
    props.last_modified_by = ""
    props.title = "座舱域功能定义模板"
    props.subject = ""
    props.keywords = ""
    props.comments = ""
    props.category = ""
    props.content_status = ""


def prepare(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".docx") as tmp:
        _clean_zip(source, Path(tmp.name))
        doc = Document(tmp.name)
        _make_one_feature_chapter(doc)
        _sanitize_text(doc)
        doc.save(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    prepare(args.source, args.output)


if __name__ == "__main__":
    main()
