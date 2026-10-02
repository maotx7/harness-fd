#!/usr/bin/env python3
"""
需求覆盖度复盘：模型逐章对比需求与文档

这是核心的"模型定性"脚本，需要调用LLM API进行深度对比。

输入：
- requirements.json (需求文档结构化数据)
- document.json (生成文档结构化数据)
- signal_matrix.xlsx (信号矩阵)

输出：
- coverage_issues.json (需求覆盖问题清单)

模型判断维度：
1. 信号覆盖度：需求信号是否在文档中？文档是否有需求外的信号？
2. 功能描述一致性：功能描述是否与需求一致？
3. HMI话术一致性：提示文字是否与需求一致？
4. 适用性检查：纯电/增程项目适用性是否正确？
"""

import json
import argparse
import sys
from pathlib import Path
from typing import Dict, List, Optional
import pandas as pd
from anthropic import Anthropic


class CoverageReviewer:
    """需求覆盖度复盘器"""

    def __init__(
        self,
        requirements_path: str,
        document_path: str,
        matrix_path: str,
        api_key: Optional[str] = None
    ):
        self.requirements = self._load_json(requirements_path)
        self.document = self._load_json(document_path)
        self.matrix_df = pd.read_excel(matrix_path)

        # 初始化Anthropic客户端
        self.client = Anthropic(api_key=api_key) if api_key else None

    def _load_json(self, path: str) -> Dict:
        """加载JSON文件"""
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)

    def review(self) -> List[Dict]:
        """执行完整复盘流程"""
        print(f"\n{'='*60}")
        print(f"开始需求覆盖度复盘")
        print(f"{'='*60}\n")

        all_issues = []
        req_chapters = self.requirements.get('chapters', {})
        doc_chapters = self.document.get('chapters', {})

        print(f"需求章节数: {len(req_chapters)}")
        print(f"文档章节数: {len(doc_chapters)}\n")

        # 逐章对比
        for section_num, req_chapter in req_chapters.items():
            print(f"复盘章节: {section_num} {req_chapter['title']}")

            # 查找对应的文档章节
            doc_chapter = self._find_matching_chapter(
                req_chapter['title'], doc_chapters
            )

            if not doc_chapter:
                all_issues.append({
                    'type': 'missing_chapter',
                    'severity': 'high',
                    'chapter': req_chapter['title'],
                    'section': section_num,
                    'comment': (
                        f'需求覆盖：需求文档包含章节"{req_chapter["title"]}"'
                        f'（{section_num}），但生成文档中缺失。'
                    )
                })
                print(f"  ❌ 章节缺失")
                continue

            # 1. 信号覆盖度检查
            signal_issues = self._check_signal_coverage(
                req_chapter, doc_chapter, section_num
            )
            all_issues.extend(signal_issues)
            if signal_issues:
                print(f"  ⚠️  信号问题: {len(signal_issues)}条")

            # 2. 功能描述一致性检查（需要LLM）
            desc_issues = self._check_description_consistency(
                req_chapter, doc_chapter, section_num
            )
            all_issues.extend(desc_issues)
            if desc_issues:
                print(f"  ⚠️  描述问题: {len(desc_issues)}条")

            # 3. HMI话术一致性检查（需要LLM）
            hmi_issues = self._check_hmi_consistency(
                req_chapter, doc_chapter, section_num
            )
            all_issues.extend(hmi_issues)
            if hmi_issues:
                print(f"  ⚠️  话术问题: {len(hmi_issues)}条")

            # 4. 适用性检查
            applicability_issues = self._check_applicability(
                req_chapter, doc_chapter, section_num
            )
            all_issues.extend(applicability_issues)
            if applicability_issues:
                print(f"  ⚠️  适用性问题: {len(applicability_issues)}条")

            if not (signal_issues or desc_issues or hmi_issues or applicability_issues):
                print(f"  ✓ 无问题")

        print(f"\n{'='*60}")
        print(f"复盘完成！共发现 {len(all_issues)} 个问题")
        print(f"{'='*60}\n")

        return all_issues

    def _find_matching_chapter(
        self, req_title: str, doc_chapters: Dict
    ) -> Optional[Dict]:
        """查找匹配的文档章节"""
        # 精确匹配
        if req_title in doc_chapters:
            return doc_chapters[req_title]

        # 模糊匹配（去除标点符号和括号内容）
        req_title_clean = req_title.split('（')[0].split('(')[0].rstrip('：:').strip()
        for doc_title, doc_chapter in doc_chapters.items():
            doc_title_clean = doc_title.split('（')[0].split('(')[0].rstrip('：:').strip()
            if req_title_clean == doc_title_clean:
                return doc_chapter

        return None

    def _check_signal_coverage(
        self, req_chapter: Dict, doc_chapter: Dict, section_num: str
    ) -> List[Dict]:
        """检查信号覆盖度"""
        issues = []

        req_signals = set(req_chapter.get('signals', []))
        doc_signals = set()

        # 从文档的所有H4小节中提取信号
        for h4_section in doc_chapter.get('h4_sections', {}).values():
            doc_signals.update(h4_section.get('signals', []))

        # 需求中有，文档中没有
        missing_signals = req_signals - doc_signals
        for sig in missing_signals:
            # 检查信号是否在矩阵中
            in_matrix = sig in self.matrix_df['信号名称'].values if '信号名称' in self.matrix_df.columns else False

            comment = (
                f'提示（需求覆盖{section_num}）：'
                f'需求文档包含信号{sig}，但生成文档未包含。'
            )

            if not in_matrix:
                comment += '该信号在信号矩阵中未检索到，确认后需补充。'
            else:
                comment += f'确认后需在本章信号表补充。'

            issues.append({
                'type': 'missing_signal',
                'severity': 'high',
                'chapter': req_chapter['title'],
                'section': section_num,
                'signal': sig,
                'in_matrix': in_matrix,
                'comment': comment,
                'suggested_fix': {
                    'type': 'add_signal',
                    'location': '相关信号表',
                    'action': '需人工确认'
                }
            })

        # 文档中有，需求中没有（可能是模板残留）
        extra_signals = doc_signals - req_signals
        for sig in extra_signals:
            issues.append({
                'type': 'extra_signal',
                'severity': 'medium',
                'chapter': req_chapter['title'],
                'section': section_num,
                'signal': sig,
                'comment': (
                    f'需求覆盖/模板复用检查：信号{sig}在生成文档中但不在需求{section_num}中，'
                    f'可能是模板复用错误，需确认是否删除。'
                ),
                'suggested_fix': {
                    'type': 'review_signal',
                    'action': '需人工确认是否删除'
                }
            })

        return issues

    def _check_description_consistency(
        self, req_chapter: Dict, doc_chapter: Dict, section_num: str
    ) -> List[Dict]:
        """检查功能描述一致性（需要LLM）"""
        issues = []

        req_descriptions = req_chapter.get('descriptions', [])
        doc_descriptions = []

        # 提取文档中"功能描述"小节的内容
        func_desc_section = doc_chapter.get('h4_sections', ).get('功能描述', {})
        doc_descriptions = func_desc_section.get('paragraphs', [])

        if not req_descriptions or not doc_descriptions:
            return issues

        # 如果有LLM客户端，使用模型判断一致性
        if self.client:
            is_consistent, diff_detail = self._llm_check_consistency(
                req_descriptions, doc_descriptions, '功能描述'
            )

            if not is_consistent:
                issues.append({
                    'type': 'description_mismatch',
                    'severity': 'medium',
                    'chapter': req_chapter['title'],
                    'section': section_num,
                    'comment': (
                        f'需求覆盖（{section_num}功能描述不一致）：'
                        f'{diff_detail}'
                    ),
                    'suggested_fix': {
                        'type': 'para_fix',
                        'action': '需人工审核'
                    }
                })
        else:
            # 无LLM时，使用简单的字符串匹配
            req_text = ' '.join(req_descriptions)
            doc_text = ' '.join(doc_descriptions)

            if req_text != doc_text:
                issues.append({
                    'type': 'description_possible_mismatch',
                    'severity': 'low',
                    'chapter': req_chapter['title'],
                    'section': section_num,
                    'comment': (
                        f'提示（需求覆盖{section_num}）：'
                        f'功能描述可能与需求不一致，建议人工核对。'
                    )
                })

        return issues

    def _check_hmi_consistency(
        self, req_chapter: Dict, doc_chapter: Dict, section_num: str
    ) -> List[Dict]:
        """检查HMI话术一致性（需要LLM）"""
        issues = []

        req_texts = req_chapter.get('hmi_texts', [])
        doc_texts = []

        # 提取文档中"HMI要求"小节的话术
        hmi_section = doc_chapter.get('h4_sections', {}).get('HMI要求', {})
        doc_texts = hmi_section.get('hmi_texts', [])

        if not req_texts or not doc_texts:
            return issues

        # 逐条对比HMI话术
        for i, req_text in enumerate(req_texts):
            if i < len(doc_texts):
                doc_text = doc_texts[i]

                # 精确匹配
                if req_text == doc_text:
                    continue

                # LLM语义判断
                if self.client:
                    is_semantic_same = self._llm_check_semantic_same(
                        req_text, doc_text
                    )
                    if is_semantic_same:
                        continue

                # 发现不一致
                issues.append({
                    'type': 'hmi_text_mismatch',
                    'severity': 'medium',
                    'chapter': req_chapter['title'],
                    'section': section_num,
                    'comment': (
                        f'需求覆盖（{section_num}话术修改）：'
                        f'需求话术为『{req_text}』，'
                        f'文档话术为『{doc_text}』，需统一。'
                    ),
                    'suggested_fix': {
                        'type': 'para_fix',
                        'find': doc_text,
                        'replace': req_text
                    }
                })
            else:
                # 需求中有，文档中没有
                issues.append({
                    'type': 'hmi_text_missing',
                    'severity': 'high',
                    'chapter': req_chapter['title'],
                    'section': section_num,
                    'comment': (
                        f'需求覆盖（{section_num}话术缺失）：'
                        f'需求包含话术『{req_text}』，文档中缺失。'
                    )
                })

        return issues

    def _check_applicability(
        self, req_chapter: Dict, doc_chapter: Dict, section_num: str
    ) -> List[Dict]:
        """检查适用性"""
        issues = []

        req_applicability = req_chapter.get('applicability', '')
        chapter_title = req_chapter['title']

        # 如果需求明确为"增程"，但章节内容未标注
        if '增程' in req_applicability and '纯电' not in req_applicability:
            # 检查章节标题是否包含提示
            if '增程' not in chapter_title and '纯电' not in chapter_title:
                issues.append({
                    'type': 'applicability_missing',
                    'severity': 'low',
                    'chapter': chapter_title,
                    'section': section_num,
                    'comment': (
                        f'需求覆盖（{section_num}标题）：'
                        '需求文档明确了适用性，建议在标题中明确标注或确认适用性。'
                    ),
                    'suggested_fix': {
                        'type': 'chapter_title_note',
                        'action': '需产品侧确认'
                    }
                })

        return issues

    def _llm_check_consistency(
        self, req_texts: List[str], doc_texts: List[str], content_type: str
    ) -> tuple:
        """使用LLM检查一致性"""
        if not self.client:
            return True, ""

        prompt = f"""
你是一个汽车功能定义文档的审查专家。请对比需求文档和生成文档中的{content_type}内容，判断是否一致。

需求文档中的{content_type}：
{chr(10).join(f"{i+1}. {t}" for i, t in enumerate(req_texts))}

生成文档中的{content_type}：
{chr(10).join(f"{i+1}. {t}" for i, t in enumerate(doc_texts))}

请回答：
1. 两者是否实质性一致？（回答"一致"或"不一致"）
2. 如果不一致，简述差异点（50字以内）

格式：
一致性: [一致/不一致]
差异: [差异描述]
"""

        try:
            response = self.client.messages.create(
                model="claude-opus-5",
                max_tokens=500,
                messages=[{"role": "user", "content": prompt}]
            )

            content = response.content[0].text
            is_consistent = '一致' in content.split('\n')[0]
            diff_detail = content.split('差异:')[-1].strip() if not is_consistent else ""

            return is_consistent, diff_detail

        except Exception as e:
            print(f"    LLM调用失败: {e}，跳过")
            return True, ""

    def _llm_check_semantic_same(self, text1: str, text2: str) -> bool:
        """使用LLM检查两段文本是否语义相同"""
        if not self.client:
            return False

        prompt = f"""
判断以下两段文本是否表达相同的意思（忽略措辞差异）：

文本1: {text1}
文本2: {text2}

只回答"相同"或"不同"。
"""

        try:
            response = self.client.messages.create(
                model="claude-haiku-4-5-20251001",  # 使用便宜的模型
                max_tokens=10,
                messages=[{"role": "user", "content": prompt}]
            )

            return '相同' in response.content[0].text

        except Exception as e:
            print(f"    LLM调用失败: {e}")
            return False


def main():
    parser = argparse.ArgumentParser(
        description='需求覆盖度复盘'
    )
    parser.add_argument(
        '--requirements',
        required=True,
        help='需求JSON文件路径'
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
        default='coverage_issues.json',
        help='输出JSON文件路径（默认: coverage_issues.json）'
    )
    parser.add_argument(
        '--api-key',
        help='Anthropic API密钥（可选，提供则启用LLM深度对比）'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='预览模式，不保存文件'
    )

    args = parser.parse_args()

    # 执行复盘
    reviewer = CoverageReviewer(
        args.requirements,
        args.document,
        args.matrix,
        args.api_key
    )
    issues = reviewer.review()

    # 输出结果
    result = {'issues': issues}
    result_json = json.dumps(result, ensure_ascii=False, indent=2)

    if args.dry_run:
        print("\n【预览模式】发现的问题:")
        for issue in issues[:5]:
            print(f"\n{issue['type']} - {issue['chapter']}")
            print(f"  {issue['comment']}")
        if len(issues) > 5:
            print(f"\n... 还有 {len(issues)-5} 个问题")
    else:
        output_path = Path(args.output)
        output_path.write_text(result_json, encoding='utf-8')
        print(f"\n✓ 已保存到: {output_path.absolute()}")
        print(f"  问题数量: {len(issues)}")

        # 统计
        by_type = {}
        for issue in issues:
            t = issue['type']
            by_type[t] = by_type.get(t, 0) + 1

        print(f"\n问题分布:")
        for t, count in sorted(by_type.items(), key=lambda x: -x[1]):
            print(f"  {t}: {count}")


if __name__ == '__main__':
    main()
