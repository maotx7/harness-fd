#!/usr/bin/env python3
"""
文档解析器：将Word功能定义文档解析为结构化JSON

输入：功能定义文档docx
输出：document.json（结构化文档数据）

核心能力：
1. Word章节结构解析（Heading 3章节 + Heading 4小节）
2. H4小节内容提取（功能描述、触发条件、执行输出等）
3. 信号表提取
4. HMI要求文本提取
"""

import json
import re
import argparse
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from docx import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph
from docx.table import Table


@dataclass
class H4Section:
    """H4小节数据结构"""
    title: str
    paragraphs: List[str]
    signals: List[str]
    conditions: List[str]
    outputs: List[str]
    hmi_texts: List[str]
    table: Optional[List[Dict]] = None

    def to_dict(self):
        return {k: v for k, v in asdict(self).items() if v}


@dataclass
class H3Chapter:
    """H3章节数据结构"""
    h3_title: str
    h4_sections: Dict[str, Dict]

    def to_dict(self):
        return {
            'h3_title': self.h3_title,
            'h4_sections': self.h4_sections
        }


class DocumentParser:
    """文档解析器"""

    # 信号名正则
    SIGNAL_PATTERN = re.compile(r'\b[A-Z][A-Z0-9_]{3,}\b')

    # HMI话术正则
    HMI_TEXT_PATTERN = re.compile(r'[『「"\'](.*?)[』」"\']')

    # H4锚点标题
    H4_ANCHORS = {
        '本功能涉及的法规内容', '功能逻辑架构图', '功能描述', '使能条件',
        '配置字', '触发条件', '执行输出', 'HMI要求', '退出条件',
        '故障处理', '故障恢复', '相关信号'
    }

    def __init__(self, docx_path: str):
        self.docx_path = Path(docx_path)
        if not self.docx_path.exists():
            raise FileNotFoundError(f"Word文件不存在: {docx_path}")

        self.doc = Document(str(self.docx_path))

    def parse(self) -> Dict:
        """执行完整解析流程"""
        print(f"\n{'='*60}")
        print(f"开始解析文档: {self.docx_path.name}")
        print(f"{'='*60}\n")

        chapters = {}
        current_h3 = None
        current_h4 = None
        current_content = []
        in_feature_area = False

        body = self.doc.element.body

        for element in body.iterchildren():
            if element.tag == qn('w:p'):
                para = Paragraph(element, self.doc)
                style = para.style.name if para.style else ''
                text = para.text.strip()

                if style == 'Heading 1':
                    in_feature_area = '系统功能描述' in text
                    if in_feature_area:
                        print(f"进入功能描述区域")

                elif style == 'Heading 3' and in_feature_area:
                    # 保存上一个H4小节
                    if current_h3 and current_h4:
                        self._save_h4_section(
                            chapters, current_h3, current_h4, current_content
                        )

                    # 开始新的H3章节
                    current_h3 = text.rstrip('：:').strip()
                    current_h4 = None
                    current_content = []

                    if current_h3 not in chapters:
                        chapters[current_h3] = H3Chapter(
                            h3_title=current_h3,
                            h4_sections={}
                        )
                        print(f"  章节: {current_h3}")

                elif style == 'Heading 4' and in_feature_area and current_h3:
                    # 保存上一个H4小节
                    if current_h4:
                        self._save_h4_section(
                            chapters, current_h3, current_h4, current_content
                        )

                    # 开始新的H4小节
                    current_h4 = text.rstrip('：:').strip()
                    current_content = []
                    print(f"    小节: {current_h4}")

                elif in_feature_area and current_h3 and text:
                    # 收集小节内容
                    current_content.append(('para', text))

            elif element.tag == qn('w:tbl'):
                # 收集表格
                if in_feature_area and current_h3:
                    table = Table(element, self.doc)
                    table_data = self._extract_table(table)
                    current_content.append(('table', table_data))

        # 保存最后一个小节
        if current_h3 and current_h4:
            self._save_h4_section(chapters, current_h3, current_h4, current_content)

        print(f"\n解析完成！")
        print(f"  章节数量: {len(chapters)}")
        print(f"  H4小节总数: {sum(len(ch.h4_sections) for ch in chapters.values())}")

        return {
            'chapters': {
                title: chapter.to_dict()
                for title, chapter in chapters.items()
            }
        }

    def _save_h4_section(
        self,
        chapters: Dict,
        h3_title: str,
        h4_title: str,
        content: List
    ):
        """保存H4小节内容"""
        paragraphs = []
        signals = set()
        conditions = []
        outputs = []
        hmi_texts = []
        table_data = None

        for item_type, item_data in content:
            if item_type == 'para':
                paragraphs.append(item_data)

                # 提取信号名
                for match in self.SIGNAL_PATTERN.finditer(item_data):
                    sig = match.group(0)
                    if sig not in ['CAN', 'ID', 'HMI', 'SOC']:
                        signals.add(sig)

                # 提取HMI话术
                for match in self.HMI_TEXT_PATTERN.finditer(item_data):
                    hmi_texts.append(match.group(1))

                # 识别条件和输出
                if any(kw in item_data for kw in ['条件', '当', '如果', '满足']):
                    conditions.append(item_data)
                if any(kw in item_data for kw in ['输出', '显示', '设置', '发送']):
                    outputs.append(item_data)

            elif item_type == 'table':
                table_data = item_data

        section = H4Section(
            title=h4_title,
            paragraphs=paragraphs,
            signals=sorted(signals),
            conditions=conditions,
            outputs=outputs,
            hmi_texts=hmi_texts,
            table=table_data
        )

        chapters[h3_title].h4_sections[h4_title] = section.to_dict()

    def _extract_table(self, table: Table) -> List[Dict]:
        """提取表格数据"""
        if not table.rows:
            return []

        # 提取表头
        header_row = table.rows[0]
        headers = [cell.text.strip() for cell in header_row.cells]

        # 提取数据行
        data = []
        for row in table.rows[1:]:
            if len(row.cells) == len(headers):
                row_data = {
                    headers[i]: cell.text.strip()
                    for i, cell in enumerate(row.cells)
                }
                data.append(row_data)

        return data

    def extract_signals(self, text: str) -> List[str]:
        """提取信号名"""
        signals = set()
        for match in self.SIGNAL_PATTERN.finditer(text):
            sig = match.group(0)
            if sig not in ['CAN', 'ID', 'HMI', 'SOC']:
                signals.add(sig)
        return sorted(signals)


def main():
    parser = argparse.ArgumentParser(
        description='解析Word功能定义文档为结构化JSON'
    )
    parser.add_argument(
        '--docx',
        required=True,
        help='功能定义文档路径'
    )
    parser.add_argument(
        '--output',
        default='document.json',
        help='输出JSON文件路径（默认: document.json）'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='预览模式，不保存文件'
    )

    args = parser.parse_args()

    # 执行解析
    parser_obj = DocumentParser(args.docx)
    result = parser_obj.parse()

    # 输出结果
    result_json = json.dumps(result, ensure_ascii=False, indent=2)

    if args.dry_run:
        print("\n【预览模式】解析结果:")
        print(result_json[:1000])
        print(f"\n... (共{len(result_json)}字符)")
    else:
        output_path = Path(args.output)
        output_path.write_text(result_json, encoding='utf-8')
        print(f"\n✓ 已保存到: {output_path.absolute()}")
        print(f"  文件大小: {len(result_json)} 字符")


if __name__ == '__main__':
    main()
