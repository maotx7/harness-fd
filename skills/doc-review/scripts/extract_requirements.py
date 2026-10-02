#!/usr/bin/env python3
"""
需求文档解析器：将PDF需求文档解析为结构化JSON

输入：需求文档PDF
输出：requirements.json（结构化需求数据）

核心能力：
1. PDF文本提取
2. 章节结构识别（基于标题格式，如"3.1.6 充电状态显示"）
3. 信号名提取（正则匹配）
4. HMI话术提取（引号包裹的文本）
5. 功能描述提取
"""

import json
import re
import argparse
from pathlib import Path
from typing import Dict, List, Optional
import pdfplumber
from dataclasses import dataclass, asdict


@dataclass
class RequirementChapter:
    """需求章节数据结构"""
    title: str
    section_number: str  # 如"3.1.6"
    signals: List[str]
    descriptions: List[str]
    hmi_texts: List[str]
    trigger_conditions: List[str]
    applicability: str  # "纯电" | "增程" | "纯电+增程"

    def to_dict(self):
        return asdict(self)


class RequirementParser:
    """需求文档解析器"""

    # 信号名正则：大写字母+下划线，如VCU_ChrgStsDisp
    SIGNAL_PATTERN = re.compile(r'\b[A-Z][A-Z0-9_]{3,}\b')

    # 章节编号正则：如"3.1.6"
    SECTION_PATTERN = re.compile(r'^(\d+\.\d+\.\d+)\s+(.+)$')

    # HMI话术正则：引号包裹的文本
    HMI_TEXT_PATTERN = re.compile(r'[『「"\'](.*?)[』」"\']')

    def __init__(self, pdf_path: str):
        self.pdf_path = Path(pdf_path)
        if not self.pdf_path.exists():
            raise FileNotFoundError(f"PDF文件不存在: {pdf_path}")

    def extract_text(self) -> str:
        """提取PDF全文"""
        print(f"正在提取PDF文本: {self.pdf_path}")

        full_text = []
        with pdfplumber.open(self.pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                text = page.extract_text()
                if text:
                    full_text.append(text)
                    print(f"  已提取第{page_num}页，共{len(text)}字符")

        result = '\n'.join(full_text)
        print(f"PDF文本提取完成，总计{len(result)}字符")
        return result

    def split_chapters(self, text: str) -> Dict[str, str]:
        """分割章节"""
        print("\n正在分割章节...")

        chapters = {}
        current_section = None
        current_content = []

        for line in text.split('\n'):
            line = line.strip()
            if not line:
                continue

            # 检查是否是章节标题
            match = self.SECTION_PATTERN.match(line)
            if match:
                # 保存上一章节
                if current_section:
                    chapters[current_section] = '\n'.join(current_content)
                    print(f"  章节 {current_section}: {len(current_content)}行")

                # 开始新章节
                current_section = match.group(1)
                current_content = [line]
            elif current_section:
                current_content.append(line)

        # 保存最后一章
        if current_section:
            chapters[current_section] = '\n'.join(current_content)
            print(f"  章节 {current_section}: {len(current_content)}行")

        print(f"章节分割完成，共{len(chapters)}个章节")
        return chapters

    def extract_signals(self, text: str) -> List[str]:
        """提取信号名"""
        signals = set()
        for match in self.SIGNAL_PATTERN.finditer(text):
            sig = match.group(0)
            # 过滤常见误匹配
            if sig not in ['CAN', 'ID', 'HMI', 'SOC', 'VCU', 'TBOX', 'ICM']:
                signals.add(sig)
        return sorted(signals)

    def extract_hmi_texts(self, text: str) -> List[str]:
        """提取HMI话术"""
        texts = []
        for match in self.HMI_TEXT_PATTERN.finditer(text):
            texts.append(match.group(1))
        return texts

    def extract_descriptions(self, text: str) -> List[str]:
        """提取功能描述（启发式方法）"""
        descriptions = []

        # 查找包含"功能"、"描述"、"说明"等关键词的段落
        for line in text.split('\n'):
            line = line.strip()
            if any(kw in line for kw in ['功能', '描述', '说明', '显示', '设置']):
                if len(line) > 10 and not self.SECTION_PATTERN.match(line):
                    descriptions.append(line)

        return descriptions[:5]  # 最多保留5条描述

    def extract_trigger_conditions(self, text: str) -> List[str]:
        """提取触发条件"""
        conditions = []

        # 查找包含"条件"、"当"、"如果"等关键词的段落
        for line in text.split('\n'):
            line = line.strip()
            if any(kw in line for kw in ['条件', '当', '如果', '满足', '触发']):
                if len(line) > 10:
                    conditions.append(line)

        return conditions[:5]

    def infer_applicability(self, text: str) -> str:
        """推断适用性"""
        text_lower = text.lower()

        has_pure_ev = any(kw in text_lower for kw in ['纯电', '纯电动'])
        has_erev = any(kw in text_lower for kw in ['增程', 'erev'])

        if has_pure_ev and has_erev:
            return "纯电+增程"
        elif has_pure_ev:
            return "纯电"
        elif has_erev:
            return "增程"
        else:
            return "未明确"

    def parse_chapter(self, section_num: str, content: str) -> RequirementChapter:
        """解析单个章节"""
        # 提取标题
        first_line = content.split('\n')[0]
        match = self.SECTION_PATTERN.match(first_line)
        title = match.group(2) if match else first_line

        return RequirementChapter(
            title=title,
            section_number=section_num,
            signals=self.extract_signals(content),
            descriptions=self.extract_descriptions(content),
            hmi_texts=self.extract_hmi_texts(content),
            trigger_conditions=self.extract_trigger_conditions(content),
            applicability=self.infer_applicability(content)
        )

    def parse(self) -> Dict:
        """执行完整解析流程"""
        print(f"\n{'='*60}")
        print(f"开始解析需求文档: {self.pdf_path.name}")
        print(f"{'='*60}\n")

        # 1. 提取PDF文本
        full_text = self.extract_text()

        # 2. 分割章节
        chapter_texts = self.split_chapters(full_text)

        # 3. 解析每个章节
        print("\n正在解析章节内容...")
        chapters = {}
        for section_num, content in chapter_texts.items():
            chapter = self.parse_chapter(section_num, content)
            chapters[section_num] = chapter.to_dict()
            print(f"  {section_num} {chapter.title}: "
                  f"{len(chapter.signals)}个信号, "
                  f"{len(chapter.hmi_texts)}条话术")

        # 4. 构建结果
        result = {
            "document_version": self._extract_version(full_text),
            "project": self._extract_project_name(full_text),
            "chapters": chapters
        }

        print(f"\n解析完成！")
        print(f"  文档版本: {result['document_version']}")
        print(f"  项目名称: {result['project']}")
        print(f"  章节数量: {len(chapters)}")
        print(f"  信号总数: {sum(len(ch['signals']) for ch in chapters.values())}")

        return result

    def _extract_version(self, text: str) -> str:
        """提取文档版本号"""
        match = re.search(r'V(\d+\.\d+)', text)
        return f"V{match.group(1)}" if match else "未知版本"

    def _extract_project_name(self, text: str) -> str:
        """从显式的项目字段中提取项目名称。"""
        for pattern in [r'项目名称\s*[:：]\s*([^\s，,]+)', r'项目\s*[:：]\s*([^\s，,]+)']:
            match = re.search(pattern, text)
            if match:
                return match.group(1)
        return "未知项目"


def main():
    parser = argparse.ArgumentParser(
        description='解析需求文档PDF为结构化JSON'
    )
    parser.add_argument(
        '--pdf',
        required=True,
        help='需求文档PDF路径'
    )
    parser.add_argument(
        '--output',
        default='requirements.json',
        help='输出JSON文件路径（默认: requirements.json）'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='预览模式，不保存文件'
    )

    args = parser.parse_args()

    # 执行解析
    parser_obj = RequirementParser(args.pdf)
    result = parser_obj.parse()

    # 输出结果
    result_json = json.dumps(result, ensure_ascii=False, indent=2)

    if args.dry_run:
        print("\n【预览模式】解析结果:")
        print(result_json[:1000])  # 只显示前1000字符
        print(f"\n... (共{len(result_json)}字符)")
    else:
        output_path = Path(args.output)
        output_path.write_text(result_json, encoding='utf-8')
        print(f"\n✓ 已保存到: {output_path.absolute()}")
        print(f"  文件大小: {len(result_json)} 字符")


if __name__ == '__main__':
    main()
