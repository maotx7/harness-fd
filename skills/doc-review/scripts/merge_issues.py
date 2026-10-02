#!/usr/bin/env python3
"""
合并问题清单：将所有复盘问题合并为统一的fixes.json

输入：
- coverage_issues.json (需求覆盖问题)
- logic_issues.json (逻辑一致性问题)

输出：
- review_fixes.json (统一的fixes格式，可直接用于apply_signal_fixes.py)

数据转换：
1. 将问题清单转换为fixes格式
2. 按优先级排序
3. 去重
"""

import json
import argparse
from pathlib import Path
from typing import Dict, List


class IssuesMerger:
    """问题清单合并器"""

    def __init__(self):
        self.signal_fixes = []
        self.para_fixes = []
        self.signal_notes = []

    def merge(
        self,
        coverage_issues_path: str,
        logic_issues_path: str
    ) -> Dict:
        """合并所有问题清单"""
        print(f"\n{'='*60}")
        print(f"开始合并问题清单")
        print(f"{'='*60}\n")

        # 加载问题清单
        coverage_issues = self._load_issues(coverage_issues_path)
        logic_issues = self._load_issues(logic_issues_path)

        print(f"需求覆盖问题: {len(coverage_issues)}")
        print(f"逻辑一致性问题: {len(logic_issues)}")

        # 转换为fixes格式
        self._convert_coverage_issues(coverage_issues)
        self._convert_logic_issues(logic_issues)

        # 去重
        self._deduplicate()

        result = {
            'signal_fixes': self.signal_fixes,
            'para_fixes': self.para_fixes,
            'signal_notes': self.signal_notes
        }

        print(f"\n合并完成:")
        print(f"  signal_fixes: {len(self.signal_fixes)}")
        print(f"  para_fixes: {len(self.para_fixes)}")
        print(f"  signal_notes: {len(self.signal_notes)}")
        print(f"  总计: {len(self.signal_fixes) + len(self.para_fixes) + len(self.signal_notes)}")

        return result

    def _load_issues(self, path: str) -> List[Dict]:
        """加载问题清单"""
        if not Path(path).exists():
            print(f"  警告: {path} 不存在，跳过")
            return []

        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get('issues', [])

    def _convert_coverage_issues(self, issues: List[Dict]):
        """转换需求覆盖问题为fixes格式"""
        print("\n正在转换需求覆盖问题...")

        for issue in issues:
            issue_type = issue['type']
            suggested_fix = issue.get('suggested_fix', {})

            if issue_type in ['missing_signal', 'extra_signal']:
                # 信号相关问题 -> signal_notes（需人工确认）
                self.signal_notes.append({
                    'signal_prefix': issue.get('signal', ''),
                    'note': issue['comment']
                })

            elif issue_type == 'hmi_text_mismatch':
                # HMI话术不一致 -> para_fixes
                if suggested_fix.get('type') == 'para_fix':
                    self.para_fixes.append({
                        'chapter': issue['chapter'],
                        'find': suggested_fix.get('find', ''),
                        'replace': suggested_fix.get('replace', ''),
                        'comment': issue['comment']
                    })

            elif issue_type in ['description_mismatch', 'hmi_text_missing']:
                # 描述不一致或缺失 -> signal_notes
                self.signal_notes.append({
                    'signal_prefix': issue.get('signal', ''),
                    'note': issue['comment']
                })

            elif issue_type == 'applicability_missing':
                # 适用性标注 -> signal_notes
                self.signal_notes.append({
                    'signal_prefix': '',
                    'note': issue['comment']
                })

    def _convert_logic_issues(self, issues: List[Dict]):
        """转换逻辑一致性问题为fixes格式"""
        print("正在转换逻辑一致性问题...")

        for issue in issues:
            issue_type = issue['type']
            suggested_fix = issue.get('suggested_fix', {})

            if issue_type == 'cross_chapter_conflict':
                # 跨章冲突 -> signal_notes（需人工确认正确CANID）
                self.signal_notes.append({
                    'signal_prefix': issue.get('signal', ''),
                    'note': issue['comment']
                })

            elif issue_type == 'signal_semantic_mismatch':
                # 语义不匹配 -> signal_fixes（如果有明确候选）
                candidates = suggested_fix.get('candidates', [])
                if candidates:
                    self.signal_fixes.append({
                        'signal_prefix': issue.get('signal', ''),
                        'chapter': issue.get('chapter', ''),
                        'new_sig': candidates[0],  # 使用第一个候选
                        'comment': issue['comment']
                    })
                else:
                    # 无候选，需人工确认
                    self.signal_notes.append({
                        'signal_prefix': issue.get('signal', ''),
                        'note': issue['comment']
                    })

    def _deduplicate(self):
        """去重"""
        print("\n正在去重...")

        # signal_fixes去重（按signal_prefix + chapter）
        seen = set()
        unique_signal_fixes = []
        for fix in self.signal_fixes:
            key = (fix['signal_prefix'], fix['chapter'])
            if key not in seen:
                seen.add(key)
                unique_signal_fixes.append(fix)
        removed = len(self.signal_fixes) - len(unique_signal_fixes)
        if removed > 0:
            print(f"  signal_fixes去重: 移除{removed}条")
        self.signal_fixes = unique_signal_fixes

        # para_fixes去重（按chapter + find）
        seen = set()
        unique_para_fixes = []
        for fix in self.para_fixes:
            key = (fix['chapter'], fix['find'])
            if key not in seen:
                seen.add(key)
                unique_para_fixes.append(fix)
        removed = len(self.para_fixes) - len(unique_para_fixes)
        if removed > 0:
            print(f"  para_fixes去重: 移除{removed}条")
        self.para_fixes = unique_para_fixes

        # signal_notes去重（按note内容）
        seen = set()
        unique_signal_notes = []
        for note in self.signal_notes:
            key = note['note']
            if key not in seen:
                seen.add(key)
                unique_signal_notes.append(note)
        removed = len(self.signal_notes) - len(unique_signal_notes)
        if removed > 0:
            print(f"  signal_notes去重: 移除{removed}条")
        self.signal_notes = unique_signal_notes


def main():
    parser = argparse.ArgumentParser(
        description='合并问题清单为fixes.json'
    )
    parser.add_argument(
        '--coverage',
        required=True,
        help='需求覆盖问题JSON文件'
    )
    parser.add_argument(
        '--logic',
        required=True,
        help='逻辑一致性问题JSON文件'
    )
    parser.add_argument(
        '--output',
        default='review_fixes.json',
        help='输出fixes文件路径（默认: review_fixes.json）'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='预览模式，不保存文件'
    )

    args = parser.parse_args()

    # 执行合并
    merger = IssuesMerger()
    result = merger.merge(args.coverage, args.logic)

    # 输出结果
    result_json = json.dumps(result, ensure_ascii=False, indent=2)

    if args.dry_run:
        print("\n【预览模式】fixes内容:")
        print(result_json[:1000])
        print(f"\n... (共{len(result_json)}字符)")
    else:
        output_path = Path(args.output)
        output_path.write_text(result_json, encoding='utf-8')
        print(f"\n✓ 已保存到: {output_path.absolute()}")


if __name__ == '__main__':
    main()
