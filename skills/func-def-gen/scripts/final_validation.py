#!/usr/bin/env python3
"""Verify that final validation reports belong to the exact delivered DOCX."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from report_provenance import sha256_file


def _report_hash(report: Path) -> str | None:
    text = report.read_text(encoding="utf-8")
    match = re.search(r"\*\*文档 SHA256\*\*:\s*([0-9a-f]{64})", text, re.IGNORECASE)
    return match.group(1).lower() if match else None


def _issue_count(report: Path) -> int | None:
    text = report.read_text(encoding="utf-8")
    for pattern in (r"发现问题:\s*(\d+)", r"逻辑问题条目:\s*\*\*(\d+)\*\*"):
        match = re.search(pattern, text)
        if match:
            return int(match.group(1))
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("docx")
    parser.add_argument("--audit", required=True)
    parser.add_argument("--signals")
    parser.add_argument("--logic")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    docx = Path(args.docx).expanduser().resolve()
    expected = sha256_file(docx)
    reports = [Path(args.audit), *(Path(item) for item in (args.signals, args.logic) if item)]
    failures = []
    for report in reports:
        if not report.is_file():
            failures.append(f"报告不存在: {report}")
            continue
        actual = _report_hash(report)
        if actual != expected:
            failures.append(f"报告与最终 DOCX SHA256 不一致: {report}")
        if args.strict and report.name.startswith("audit") and (_issue_count(report) or 0):
            failures.append(f"审计报告仍有问题: {report}")
        if args.strict and report.name.startswith("logic") and (_issue_count(report) or 0):
            failures.append(f"逻辑校验报告仍有问题: {report}")
    if failures:
        for item in failures:
            print(item)
        return 2
    print(f"final validation passed: {docx}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
