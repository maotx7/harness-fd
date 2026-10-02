#!/usr/bin/env python3
"""
生成复盘报告：将review_fixes.json转换为人类可读的Markdown报告

输入：review_fixes.json
输出：review_report.md
"""

import json
import argparse
from pathlib import Path
from typing import Dict, List
from collections import defaultdict


class ReportGenerator:
    """复盘报告生成器"""

    def __init__(self, fixes_path: str):
        with open(fixes_path, 'r', encoding='utf-8') as f:
            self.fixes = json.load(f)

    def generate(self) -> str:
        """生成完整报告"""
        sections = [
            self._generate_header(),
            self._generate_summary(),
            self._generate_classification(),
            self._generate_signal_fixes(),
            self._generate_para_fixes(),
            self._generate_signal_notes(),
        ]

        return '\n\n'.join(sections)

    def _generate_header(self) -> str:
        """生成报告头"""
        return "# 功能定义文档复盘报告\n\n生成时间: (自动生成)"

    def _generate_summary(self) -> str:
        """生成概述"""
        total = (
            len(self.fixes.get('signal_fixes', [])) +
            len(self.fixes.get('para_fixes', [])) +
            len(self.fixes.get('signal_notes', []))
        )

        return f"""## 概述

- 发现问题：**{total}** 条
- 信号修正：{len(self.fixes.get('signal_fixes', []))} 条
- 段落修正：{len(self.fixes.get('para_fixes', []))} 条
- 提示批注：{len(self.fixes.get('signal_notes', []))} 条"""

    def _generate_classification(self) -> str:
        """生成问题分类"""
        # 从批注内容中提取问题类型
        type_counts = defaultdict(int)

        for note in self.fixes.get('signal_notes', []):
            comment = note.get('note', '')
            if '需求覆盖' in comment:
                type_counts['需求覆盖类'] += 1
            elif '跨章冲突' in comment:
                type_counts['跨章冲突类'] += 1
            elif '模板纠错' in comment:
                type_counts['模板纠错类'] += 1
            else:
                type_counts['其他'] += 1

        for fix in self.fixes.get('signal_fixes', []):
            comment = fix.get('comment', '')
            if '模板纠错' in comment:
                type_counts['模板纠错类'] += 1
            else:
                type_counts['信号校验类'] += 1

        for fix in self.fixes.get('para_fixes', []):
            type_counts['需求覆盖类'] += 1

        lines = ["## 问题分类\n", "| 类型 | 数量 |", "|------|------|"]
        for type_name, count in sorted(type_counts.items(), key=lambda x: -x[1]):
            lines.append(f"| {type_name} | {count} |")

        return '\n'.join(lines)

    def _generate_signal_fixes(self) -> str:
        """生成信号修正清单"""
        fixes = self.fixes.get('signal_fixes', [])
        if not fixes:
            return ""

        lines = [
            f"## 信号修正清单（{len(fixes)}条）\n",
            "这些问题已确定修正方案，可自动应用。\n"
        ]

        for i, fix in enumerate(fixes, 1):
            lines.append(f"### {i}. {fix.get('chapter', '未知章节')}")
            lines.append(f"- **原信号**: `{fix.get('signal_prefix', '')}`")
            lines.append(f"- **新信号**: `{fix.get('new_sig', '')}`")
            lines.append(f"- **批注**: {fix.get('comment', '')}\n")

        return '\n'.join(lines)

    def _generate_para_fixes(self) -> str:
        """生成段落修正清单"""
        fixes = self.fixes.get('para_fixes', [])
        if not fixes:
            return ""

        lines = [
            f"## 段落修正清单（{len(fixes)}条）\n",
            "这些问题涉及文字修改，可自动应用。\n"
        ]

        for i, fix in enumerate(fixes, 1):
            lines.append(f"### {i}. {fix.get('chapter', '未知章节')}")
            lines.append(f"- **原文**: {fix.get('find', '')}")
            lines.append(f"- **修改为**: {fix.get('replace', '')}")
            lines.append(f"- **批注**: {fix.get('comment', '')}\n")

        return '\n'.join(lines)

    def _generate_signal_notes(self) -> str:
        """生成提示批注清单"""
        notes = self.fixes.get('signal_notes', [])
        if not notes:
            return ""

        lines = [
            f"## 提示批注清单（{len(notes)}条）\n",
            "这些问题需要人工确认或进一步核对。\n"
        ]

        for i, note in enumerate(notes, 1):
            signal = note.get('signal_prefix', '')
            content = note.get('note', '')

            lines.append(f"### {i}. {signal if signal else '（无关联信号）'}")
            lines.append(f"{content}\n")

        return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(
        description='生成复盘报告'
    )
    parser.add_argument(
        '--fixes',
        required=True,
        help='review_fixes.json文件路径'
    )
    parser.add_argument(
        '--output',
        default='review_report.md',
        help='输出报告文件路径（默认: review_report.md）'
    )

    args = parser.parse_args()

    # 生成报告
    generator = ReportGenerator(args.fixes)
    report = generator.generate()

    # 保存
    output_path = Path(args.output)
    output_path.write_text(report, encoding='utf-8')
    print(f"✓ 报告已生成: {output_path.absolute()}")


if __name__ == '__main__':
    main()
