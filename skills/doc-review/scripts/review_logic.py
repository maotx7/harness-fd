#!/usr/bin/env python3
"""
逻辑一致性复盘：检查跨章节逻辑冲突

输入：
- document.json (生成文档结构化数据)
- signal_matrix.xlsx (信号矩阵)

输出：
- logic_issues.json (逻辑一致性问题清单)

模型判断维度：
1. 跨章信号使用一致性：同一信号在不同章节的描述/CANID是否一致
2. 信号语义匹配度：信号语义与章节主题是否匹配
"""

import json
import argparse
import re
from pathlib import Path
from typing import Dict, List, Set
from collections import defaultdict
import pandas as pd


class LogicReviewer:
    """逻辑一致性复盘器"""

    # 信号语义规则
    SEMANTIC_RULES = {
        'Crt': '电流',
        'Pwr': '功率',
        'Temp': '温度',
        'Soc': 'SOC',
        'Volt': '电压',
        'Chrg': '充电',
        'Dcha': '放电',
        'Spd': '速度',
        'Pres': '压力',
    }

    def __init__(self, document_path: str, matrix_path: str):
        self.document = self._load_json(document_path)
        self.matrix_df = pd.read_excel(matrix_path)

        # 建立信号索引
        self.signal_index = self._build_signal_index()

    def _load_json(self, path: str) -> Dict:
        """加载JSON文件"""
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)

    def _build_signal_index(self) -> Dict[str, List[Dict]]:
        """建立全文信号索引"""
        print("\n正在建立全文信号索引...")
        index = defaultdict(list)

        for chapter_title, chapter_data in self.document.get('chapters', {}).items():
            for h4_title, h4_data in chapter_data.get('h4_sections', {}).items():
                for signal in h4_data.get('signals', []):
                    index[signal].append({
                        'chapter': chapter_title,
                        'h4_section': h4_title,
                        'usage_context': ' '.join(h4_data.get('paragraphs', [])[:2])[:200]
                    })

                # 从信号表中提取信号和CANID
                if h4_title == '相关信号' and h4_data.get('table'):
                    for row in h4_data['table']:
                        sig_name = row.get('信号名称', '')
                        canid = row.get('报文', '') or row.get('CANID', '')
                        if sig_name:
                            index[sig_name].append({
                                'chapter': chapter_title,
                                'h4_section': h4_title,
                                'canid': canid,
                                'is_signal_table': True
                            })

        print(f"  索引完成：{len(index)}个信号")
        return dict(index)

    def review(self) -> List[Dict]:
        """执行完整复盘流程"""
        print(f"\n{'='*60}")
        print(f"开始逻辑一致性复盘")
        print(f"{'='*60}\n")

        all_issues = []

        # 1. 跨章信号使用一致性检查
        cross_chapter_issues = self._check_cross_chapter_conflicts()
        all_issues.extend(cross_chapter_issues)
        print(f"\n跨章冲突检测完成: {len(cross_chapter_issues)}个问题")

        # 2. 信号语义匹配度检查
        semantic_issues = self._check_semantic_mismatches()
        all_issues.extend(semantic_issues)
        print(f"语义匹配检测完成: {len(semantic_issues)}个问题")

        print(f"\n{'='*60}")
        print(f"逻辑复盘完成！共发现 {len(all_issues)} 个问题")
        print(f"{'='*60}\n")

        return all_issues

    def _check_cross_chapter_conflicts(self) -> List[Dict]:
        """检查跨章节冲突"""
        print("\n正在检查跨章节信号使用一致性...")
        issues = []

        for signal, usages in self.signal_index.items():
            if len(usages) < 2:
                continue

            # 检查CANID一致性
            canids = set()
            chapters_with_canid = []

            for usage in usages:
                if usage.get('is_signal_table') and usage.get('canid'):
                    canids.add(usage['canid'])
                    chapters_with_canid.append(usage['chapter'])

            if len(canids) > 1:
                # 发现CANID不一致！
                issues.append({
                    'type': 'cross_chapter_conflict',
                    'severity': 'high',
                    'signal': signal,
                    'chapters': chapters_with_canid,
                    'canids': list(canids),
                    'evidence': f'信号{signal}在{len(chapters_with_canid)}个章节中CANID不一致：{canids}',
                    'comment': (
                        f'信号更正（逻辑校验跨章冲突+矩阵核对）：'
                        f'信号{signal}在章节{chapters_with_canid}中CANID不一致，'
                        f'分别为{list(canids)}。需统一为矩阵中的正确值。'
                    ),
                    'suggested_fix': {
                        'type': 'signal_fix',
                        'action': '统一CANID'
                    }
                })
                print(f"  ⚠️  {signal}: CANID不一致 {canids}")

        return issues

    def _check_semantic_mismatches(self) -> List[Dict]:
        """检查信号语义匹配度"""
        print("\n正在检查信号语义匹配度...")
        issues = []

        for signal, usages in self.signal_index.items():
            sig_semantic = self._infer_signal_semantic(signal)
            if not sig_semantic:
                continue

            for usage in usages:
                if usage.get('is_signal_table'):
                    continue

                chapter_title = usage['chapter']
                chapter_semantic = self._infer_chapter_semantic(chapter_title)

                if chapter_semantic and sig_semantic != chapter_semantic:
                    # 语义冲突！可能是模板复用错误

                    # 从矩阵中查找正确的信号
                    correct_signals = self._find_correct_signals(chapter_semantic)

                    evidence = f'信号语义为"{sig_semantic}"，章节主题为"{chapter_semantic}"'

                    issues.append({
                        'type': 'signal_semantic_mismatch',
                        'severity': 'high',
                        'signal': signal,
                        'chapter': chapter_title,
                        'signal_semantic': sig_semantic,
                        'chapter_semantic': chapter_semantic,
                        'evidence': evidence,
                        'comment': (
                            f'需求覆盖/模板复用检查：{chapter_title}章相关信号可能误沿用了'
                            f'{sig_semantic}信号 {signal}，应使用{chapter_semantic}相关信号。'
                            f'建议检查矩阵中{chapter_semantic}相关信号并更正。'
                        ),
                        'suggested_fix': {
                            'type': 'signal_fix',
                            'chapter': chapter_title,
                            'signal_prefix': signal,
                            'candidates': correct_signals[:3] if correct_signals else []
                        }
                    })
                    print(f"  ⚠️  {chapter_title}: {signal}({sig_semantic}) 不匹配章节主题({chapter_semantic})")

        return issues

    def _infer_signal_semantic(self, signal_name: str) -> str:
        """推断信号语义类别"""
        for pattern, category in self.SEMANTIC_RULES.items():
            if pattern in signal_name:
                return category
        return ''

    def _infer_chapter_semantic(self, chapter_title: str) -> str:
        """推断章节语义类别"""
        for pattern, category in self.SEMANTIC_RULES.items():
            if category in chapter_title:
                return category
        return ''

    def _find_correct_signals(self, semantic_category: str) -> List[str]:
        """从矩阵中查找匹配语义的信号"""
        if '信号名称' not in self.matrix_df.columns:
            return []

        # 找到反向映射
        pattern_for_category = None
        for pattern, category in self.SEMANTIC_RULES.items():
            if category == semantic_category:
                pattern_for_category = pattern
                break

        if not pattern_for_category:
            return []

        # 在矩阵中查找包含该pattern的信号
        candidates = []
        for sig in self.matrix_df['信号名称']:
            if isinstance(sig, str) and pattern_for_category in sig:
                candidates.append(sig)

        return candidates


def main():
    parser = argparse.ArgumentParser(
        description='逻辑一致性复盘'
    )
    parser.add_argument(
        '--document',
        required=True,
        help='文档JSON文件路径'
    )
    parser.add_argument(
        '--matrix',
        required=True,
        help='信号矩阵Excel文件路径'
    )
    parser.add_argument(
        '--output',
        default='logic_issues.json',
        help='输出JSON文件路径（默认: logic_issues.json）'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='预览模式，不保存文件'
    )

    args = parser.parse_args()

    # 执行复盘
    reviewer = LogicReviewer(args.document, args.matrix)
    issues = reviewer.review()

    # 输出结果
    result = {'issues': issues}
    result_json = json.dumps(result, ensure_ascii=False, indent=2)

    if args.dry_run:
        print("\n【预览模式】发现的问题:")
        for issue in issues[:5]:
            print(f"\n{issue['type']} - {issue.get('chapter', issue.get('chapters'))}")
            print(f"  {issue['comment']}")
        if len(issues) > 5:
            print(f"\n... 还有 {len(issues)-5} 个问题")
    else:
        output_path = Path(args.output)
        output_path.write_text(result_json, encoding='utf-8')
        print(f"\n✓ 已保存到: {output_path.absolute()}")
        print(f"  问题数量: {len(issues)}")


if __name__ == '__main__':
    main()
