# -*- coding: utf-8 -*-
"""
func-def-gen · 增强逻辑一致性校验脚本

相比原版logic_verify.py，新增6类深度检查：
  1. 内容缺失检查 - 识别TBD/NA/空内容为逻辑问题
  2. 逻辑流程闭环 - 检查使能→触发→执行→退出完整性
  3. 触发退出对称性 - 分析信号重叠度
  4. 信号方向合理性 - 输入信号触发/输出信号执行
  5. 条件覆盖度 - 信号值是否全部有处理分支
  6. 异常处理完备性 - 超时/无效/丢失是否有处理

用法:
  python logic_verify_enhanced.py <generated.docx> [--out report.md] [--strict]
"""
import argparse, re, json
from pathlib import Path
from collections import Counter, defaultdict
from docx import Document
from docx.text.paragraph import Paragraph
from docx.table import Table
from docx.oxml.ns import qn

# 复用原版的主题词和工具函数
TOPICS = ['胎压', '安全气囊', '安全带', '车门', '门开', '舱盖', '灯光', '转向', '制动',
          '充电', '空调', '电池', '电机', '发动机', '变速器', '四驱', '差速锁', '涉水',
          '巡航', '防盗', '钥匙', '尾门', '疲劳', '限速', '驾驶模式', '弹射', '坦克掉头',
          '蠕行', '回收', '能量模式', '拖车', '驻车', '保养', '机油', 'GPF', '水温',
          '手机', '雷达', 'EPS', 'PBM', 'EPB', 'AVH']

def topic_of(t):
    for k in TOPICS:
        if k in t:
            return k
    return None

def rows(t):
    return [[c.text.strip() for c in r.cells] for r in t.rows]


# ========== 新增检查函数 ==========

def check_content_completeness(chapters: list) -> list:
    """检查1：内容完整性 - 识别TBD/NA/空内容"""
    issues = []
    core_sections = ['功能描述', '使能条件', '触发条件', '执行输出', 'HMI要求', '退出条件']

    for c in chapters:
        title = c['h']
        subs = c['subs']

        # 统计该章节的TBD数量
        tbd_count = 0
        empty_count = 0

        for section_name in core_sections:
            if section_name in subs:
                content = ' '.join(subs[section_name].get('para', [])).strip()

                # 检查TBD占位
                if 'TBD' in content:
                    tbd_count += 1
                    if len(content) < 20:  # 纯TBD，几乎没有其他内容
                        issues.append((title, '内容缺失', f'{section_name}仅有TBD占位'))

                # 检查NA占位（在关键小节不应为NA）
                if content in ['NA', 'N/A', '无', '']:
                    if section_name in ['功能描述', '触发条件', '执行输出']:
                        issues.append((title, '逻辑不完整', f'{section_name}标记为NA或为空'))
                        empty_count += 1

                # 检查空内容
                if not content and section_name in ['功能描述', '触发条件']:
                    issues.append((title, '内容缺失', f'{section_name}为空'))
                    empty_count += 1
            else:
                # 核心小节缺失
                if section_name in ['功能描述', '触发条件', '执行输出']:
                    issues.append((title, '结构缺失', f'缺少{section_name}小节'))
                    empty_count += 1

        # 如果整章5个以上核心小节都是TBD/空，标记为空骨架
        if tbd_count + empty_count >= 5:
            issues.append((title, '空骨架章节', f'核心小节{tbd_count+empty_count}/6为TBD或空'))

    return issues


def check_logic_flow_completeness(chapters: list) -> list:
    """检查2：逻辑流程完整性"""
    issues = []

    for c in chapters:
        title = c['h']
        subs = c['subs']

        # 提取各环节
        enable_cond = ' '.join(subs.get('使能条件', {}).get('para', [])).strip()
        trigger_cond = ' '.join(subs.get('触发条件', {}).get('para', [])).strip()
        exec_output = ' '.join(subs.get('执行输出', {}).get('para', [])).strip()
        exit_cond = ' '.join(subs.get('退出条件', {}).get('para', [])).strip()

        # 检查1：有触发必须有退出（闭环检查）
        if trigger_cond and len(trigger_cond) > 10 and 'TBD' not in trigger_cond:
            if not exit_cond or len(exit_cond) < 10 or 'TBD' in exit_cond:
                issues.append((title, '流程不闭环', '有触发条件但退出条件为空/TBD'))

        # 检查2：有执行必须有触发
        if exec_output and len(exec_output) > 10 and 'TBD' not in exec_output:
            if not trigger_cond or 'TBD' in trigger_cond:
                issues.append((title, '流程不完整', '有执行输出但触发条件为空/TBD'))

        # 检查3：使能条件是触发条件的必要前提
        if enable_cond and 'TBD' not in enable_cond and len(enable_cond) > 10:
            if not trigger_cond or 'TBD' in trigger_cond:
                issues.append((title, '逻辑不一致', '有使能条件但触发条件为TBD'))

    return issues


def check_trigger_exit_symmetry(chapters: list) -> list:
    """检查3：触发退出对称性"""
    issues = []

    for c in chapters:
        title = c['h']
        subs = c['subs']

        trigger_text = ' '.join(subs.get('触发条件', {}).get('para', [])).strip()
        exit_text = ' '.join(subs.get('退出条件', {}).get('para', [])).strip()

        if not trigger_text or not exit_text or 'TBD' in trigger_text or 'TBD' in exit_text:
            continue

        # 提取信号名（大写字母开头，可能包含数字和下划线）
        trigger_signals = set(re.findall(r'\b([A-Z][A-Za-z0-9_]{3,})\s*[=<>]', trigger_text))
        exit_signals = set(re.findall(r'\b([A-Z][A-Za-z0-9_]{3,})\s*[=<>]', exit_text))

        if trigger_signals and exit_signals:
            # 至少应该有部分信号重叠（对称性）
            overlap = trigger_signals & exit_signals
            if not overlap and len(trigger_signals) > 0:
                issues.append((title, '触发退出信号不对称',
                             f'触发用{list(trigger_signals)[:3]}，退出用{list(exit_signals)[:3]}，无重叠'))

    return issues


def check_signal_direction_rationality(chapters: list) -> list:
    """检查4：信号方向合理性"""
    issues = []

    for c in chapters:
        title = c['h']
        subs = c['subs']

        # 获取相关信号表
        sig_table = None
        for s in subs.values():
            for t in s.get('tbls', []):
                r = rows(t)
                if r and '信号名称' in r[0] and '信号方向' in r[0]:
                    sig_table = r
                    break
            if sig_table:
                break

        if not sig_table or len(sig_table) < 2:
            continue

        # 解析信号方向
        hdr = sig_table[0]
        try:
            sig_idx = hdr.index('信号名称')
            dir_idx = hdr.index('信号方向')
        except ValueError:
            continue

        input_signals = set()
        output_signals = set()

        for row in sig_table[1:]:
            if len(row) > max(sig_idx, dir_idx):
                sig_name = row[sig_idx].strip()
                direction = row[dir_idx].strip()

                if any(x in direction for x in ['R', '接收', 'Rx', 'receive']):
                    input_signals.add(sig_name)
                if any(x in direction for x in ['T', '发送', 'Tx', 'transmit']):
                    output_signals.add(sig_name)

        # 检查：触发条件应该主要使用输入信号
        trigger_text = ' '.join(subs.get('触发条件', {}).get('para', []))
        for sig in output_signals:
            if sig and len(sig) > 3 and sig in trigger_text:
                issues.append((title, '信号方向不当',
                             f'触发条件使用了输出信号{sig}（应优先用输入信号触发）'))

        # 检查：执行输出应该主要发送输出信号
        exec_text = ' '.join(subs.get('执行输出', {}).get('para', []))
        send_pattern = r'发送|输出|设置|置位|下发'
        for sig in input_signals:
            if sig and len(sig) > 3 and sig in exec_text:
                if re.search(f'{sig}.{{0,15}}({send_pattern})', exec_text):
                    issues.append((title, '信号方向不当',
                                 f'执行输出尝试发送输入信号{sig}（只能接收）'))

    return issues


def check_condition_coverage(chapters: list) -> list:
    """检查5：条件覆盖度"""
    issues = []

    for c in chapters:
        title = c['h']
        subs = c['subs']

        # 获取信号值描述
        sig_values = {}
        for s in subs.values():
            for t in s.get('tbls', []):
                r = rows(t)
                if r and '信号名称' in r[0]:
                    try:
                        hdr = r[0]
                        sig_idx = hdr.index('信号名称')
                        val_idx = hdr.index('信号值描述') if '信号值描述' in hdr else None

                        if val_idx is not None:
                            for row in r[1:]:
                                if len(row) > max(sig_idx, val_idx):
                                    sig_name = row[sig_idx].strip()
                                    val_desc = row[val_idx].strip()
                                    if sig_name and val_desc:
                                        # 提取所有0x值
                                        values = set(re.findall(r'0x[0-9A-Fa-f]+', val_desc))
                                        if values:
                                            sig_values[sig_name] = values
                    except (ValueError, IndexError):
                        pass

        # 检查触发条件是否覆盖所有信号值
        trigger_text = ' '.join(subs.get('触发条件', {}).get('para', []))
        exec_text = ' '.join(subs.get('执行输出', {}).get('para', []))

        for sig_name, all_values in sig_values.items():
            if sig_name in trigger_text or sig_name in exec_text:
                # 提取代码中使用的值
                used_values = set(re.findall(
                    f'{re.escape(sig_name)}\\s*[=:]\\s*(0x[0-9A-Fa-f]+)',
                    trigger_text + exec_text
                ))

                # 如果使用了该信号，但只覆盖了部分值
                if used_values and len(all_values) > 2:  # 至少有3个值才检查
                    uncovered = all_values - used_values
                    if len(uncovered) > len(all_values) * 0.5:  # 超过一半未覆盖
                        issues.append((title, '条件覆盖不全',
                                     f'{sig_name}有{len(all_values)}个值，仅覆盖{len(used_values)}个，{len(uncovered)}个未定义'))

    return issues


def check_exception_handling(chapters: list) -> list:
    """检查6：异常处理完备性"""
    issues = []
    exception_keywords = ['超时', '无效', '异常', '丢失', '失败', 'timeout', 'invalid', 'fail']

    for c in chapters:
        title = c['h']
        subs = c['subs']

        # 如果有触发条件和执行输出，应该考虑异常处理
        trigger_text = ' '.join(subs.get('触发条件', {}).get('para', [])).strip()
        exec_text = ' '.join(subs.get('执行输出', {}).get('para', [])).strip()
        fault_text = ' '.join(subs.get('故障处理', {}).get('para', [])).strip()

        # 跳过TBD章节
        if 'TBD' in trigger_text or 'TBD' in exec_text:
            continue

        # 如果有实质内容但没有故障处理
        if trigger_text and exec_text and len(exec_text) > 20:
            if not fault_text or len(fault_text) < 10:
                issues.append((title, '缺少异常处理', '有触发和执行但故障处理为空'))
            elif not any(kw in fault_text for kw in exception_keywords):
                issues.append((title, '异常处理不完整', '故障处理未提及超时/无效/失败等异常场景'))

    return issues


def main():
    ap = argparse.ArgumentParser(description='增强版逻辑一致性校验')
    ap.add_argument('docx', help='生成的功能定义文档')
    ap.add_argument('--out', help='报告路径（默认写入输入文档所在目录）')
    ap.add_argument('--strict', action='store_true', help='发现逻辑问题时返回非零')
    a = ap.parse_args()

    report_path = a.out or str(Path(a.docx).resolve().parent / 'logic_verify_enhanced_report.md')

    doc = Document(a.docx)
    body = doc.element.body

    # 解析文档结构（复用原版逻辑）
    chapters = []
    cur = None
    curh3 = None
    in_feature_area = False
    anchors = {'本功能涉及的法规内容', '功能逻辑架构图', '功能描述', '使能条件',
               '配置字', '触发条件', '执行输出', 'HMI要求', '退出条件',
               '故障处理', '故障恢复', '相关信号'}

    for ch in body.iterchildren():
        if ch.tag == qn('w:p'):
            p = Paragraph(ch, doc)
            st = p.style.name if p.style else ''
            t = p.text.strip()
            if st == 'Heading 1':
                in_feature_area = t.strip().rstrip('：:').strip() == '系统功能描述'
                cur = curh3 = None
            elif st == 'Heading 2':
                curh3 = None
            elif st == 'Heading 3':
                title = t.rstrip('：:').strip()
                if not in_feature_area:
                    curh3 = None
                elif title in anchors and cur is not None:
                    curh3 = {'h': title, 'para': [], 'tbls': []}
                    cur['subs'][title] = curh3
                elif title:
                    cur = {'h': title, 'h1': False, 'subs': {}}
                    chapters.append(cur)
                    curh3 = None
            else:
                if curh3 is not None:
                    curh3['para'].append(t)
                elif cur is not None:
                    cur.setdefault('intro', []).append(t)
        elif ch.tag == qn('w:tbl'):
            tbl = Table(ch, doc)
            if curh3 is not None:
                curh3['tbls'].append(tbl)
            elif cur is not None:
                cur.setdefault('tbls', []).append(tbl)

    func_chapters = chapters

    # 运行所有检查
    print(f"解析到 {len(func_chapters)} 个功能章节，开始检查...")

    issues = []
    issues.extend(check_content_completeness(func_chapters))
    issues.extend(check_logic_flow_completeness(func_chapters))
    issues.extend(check_trigger_exit_symmetry(func_chapters))
    issues.extend(check_signal_direction_rationality(func_chapters))
    issues.extend(check_condition_coverage(func_chapters))
    issues.extend(check_exception_handling(func_chapters))

    # 统计
    cat = Counter(x[1] for x in issues)

    # 生成报告
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write("# 增强逻辑一致性核验报告\n\n")
        f.write(f"**文档**: {Path(a.docx).name}\n")
        f.write(f"**功能章节数**: {len(func_chapters)}\n\n")

        f.write(f"## 总览\n\n")
        f.write(f"- **逻辑问题条目**: **{len(issues)}**\n")
        for k, v in cat.most_common():
            f.write(f"  - {k}: {v}\n")

        f.write("\n## 一、内容完整性问题\n\n")
        f.write("| 章节 | 类别 | 说明 |\n|------|------|------|\n")
        for title, ca, det in issues:
            if ca in ('内容缺失', '结构缺失', '空骨架章节'):
                f.write(f"| {title} | {ca} | {det} |\n")

        f.write("\n## 二、逻辑流程完整性\n\n")
        f.write("| 章节 | 类别 | 说明 |\n|------|------|------|\n")
        for title, ca, det in issues:
            if ca in ('流程不闭环', '流程不完整', '逻辑不一致'):
                f.write(f"| {title} | {ca} | {det} |\n")

        f.write("\n## 三、触发退出对称性\n\n")
        f.write("| 章节 | 类别 | 说明 |\n|------|------|------|\n")
        for title, ca, det in issues:
            if ca == '触发退出信号不对称':
                f.write(f"| {title} | {ca} | {det} |\n")

        f.write("\n## 四、信号方向合理性\n\n")
        f.write("| 章节 | 类别 | 说明 |\n|------|------|------|\n")
        for title, ca, det in issues:
            if ca == '信号方向不当':
                f.write(f"| {title} | {ca} | {det} |\n")

        f.write("\n## 五、条件覆盖度\n\n")
        f.write("| 章节 | 类别 | 说明 |\n|------|------|------|\n")
        for title, ca, det in issues:
            if ca == '条件覆盖不全':
                f.write(f"| {title} | {ca} | {det} |\n")

        f.write("\n## 六、异常处理完备性\n\n")
        f.write("| 章节 | 类别 | 说明 |\n|------|------|------|\n")
        for title, ca, det in issues:
            if ca in ('缺少异常处理', '异常处理不完整'):
                f.write(f"| {title} | {ca} | {det} |\n")

    print(f"\n逻辑问题总数: {len(issues)}")
    print(dict(cat))
    print(f"\n报告已保存: {report_path}")

    if a.strict and issues:
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
