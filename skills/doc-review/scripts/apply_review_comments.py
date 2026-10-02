#!/usr/bin/env python3
"""
应用复盘批注：将review_fixes.json应用为Word批注

直接调用func-def-gen/apply_signal_fixes.py脚本
"""

import sys
from pathlib import Path
import subprocess
import json

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='应用复盘批注到Word文档'
    )
    parser.add_argument(
        '--docx',
        required=True,
        help='原始功能定义文档路径'
    )
    parser.add_argument(
        '--fixes',
        required=True,
        help='review_fixes.json文件路径'
    )
    parser.add_argument(
        '--output',
        required=True,
        help='输出文档路径'
    )
    parser.add_argument(
        '--author',
        default='bot',
        help='批注作者名（默认: bot）'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='预览模式，不实际修改文件'
    )

    args = parser.parse_args()

    print(f"\n{'='*60}")
    print(f"应用复盘批注")
    print(f"{'='*60}\n")
    print(f"输入文档: {args.docx}")
    print(f"fixes文件: {args.fixes}")
    print(f"输出文档: {args.output}")
    print(f"批注作者: {args.author}")

    # 读取review_fixes.json，转换为apply_signal_fixes.py期望的格式
    with open(args.fixes, 'r', encoding='utf-8') as f:
        review_fixes = json.load(f)

    # 创建临时config文件供apply_signal_fixes.py使用
    config = {
        'src': args.docx,  # apply_signal_fixes.py期望的键名是'src'
        'out': args.output,
        'comment_author': args.author,  # 期望的键名是'comment_author'
        'signal_fixes': review_fixes.get('signal_fixes', []),
        'para_fixes': review_fixes.get('para_fixes', []),
        'cell_fixes': review_fixes.get('cell_fixes', []),
        'signal_notes': review_fixes.get('signal_notes', [])
    }

    # 保存临时config文件
    temp_config = Path(args.fixes).parent / 'temp_apply_config.json'
    with open(temp_config, 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    # 调用apply_signal_fixes.py
    script_dir = Path(__file__).parent.resolve()
    apply_script = script_dir.parent.parent / 'func-def-gen' / 'scripts' / 'apply_signal_fixes.py'

    if not apply_script.exists():
        print(f"错误: 找不到apply_signal_fixes.py")
        print(f"路径: {apply_script}")
        sys.exit(1)

    cmd = [sys.executable, str(apply_script), str(temp_config)]
    if args.dry_run:
        cmd.append('--dry-run')

    print(f"\n执行命令: {' '.join(cmd)}\n")
    result = subprocess.run(cmd, capture_output=False)

    # 清理临时文件
    if temp_config.exists():
        temp_config.unlink()

    if result.returncode == 0:
        print(f"\n✓ 批注已应用，保存到: {args.output}")
    else:
        print(f"\n✗ 应用批注失败，退出码: {result.returncode}")
        sys.exit(result.returncode)


if __name__ == '__main__':
    main()

