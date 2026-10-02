"""Quality gates for the semantic PRD-to-function-definition draft.

The checker runs before DOCX rendering.  It validates traceability and catches
prose that is structurally complete but too vague for an engineering review.
It intentionally does not attempt to replace a domain expert's semantic
review.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any


VAGUE_PHRASES = ("相关模块配合", "适时处理", "正常情况下", "按需处理", "等")
PLACEHOLDER_PHRASES = ("TBD", "TODO", "待定", "待补充", "???")


def _load_contract_module():
    path = Path(__file__).with_name("workflow_contract.py")
    spec = importlib.util.spec_from_file_location("prd_workflow_contract", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载契约模块: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            result.extend(_strings(item))
        return result
    if isinstance(value, dict):
        result = []
        for item in value.values():
            result.extend(_strings(item))
        return result
    return []


def _finding(code: str, severity: str, message: str, path: str) -> dict[str, str]:
    return {"code": code, "severity": severity, "message": message, "path": path}


def review_prd_spec(normalized: dict[str, Any]) -> dict[str, Any]:
    """Return blocking and advisory findings for a normalized PRD spec."""
    findings: list[dict[str, str]] = []
    mode = str(normalized.get("mode", "draft")).lower()
    subfunctions = normalized.get("subfunctions", {})
    scenarios = normalized.get("scenarios", {})
    requirements = normalized.get("requirements", {})
    signals = normalized.get("signals", {})
    chapters = normalized.get("chapters", {})

    covered_requirements = {
        str(requirement_id).strip()
        for item in subfunctions.values()
        for requirement_id in item.get("requirement_ids", [])
    }
    for requirement_id in sorted(set(requirements) - covered_requirements):
        findings.append(
            _finding(
                "ORPHAN_REQUIREMENT",
                "error",
                f"需求未映射到任何子功能: {requirement_id}",
                f"requirements.{requirement_id}",
            )
        )

    referenced_signal_keys: set[str] = set()
    for item in subfunctions.values():
        referenced_signal_keys.update(str(key).strip() for key in item.get("signal_keys", []))
    for item in scenarios.values():
        referenced_signal_keys.update(str(key).strip() for key in item.get("signal_keys", []))
    for chapter_id in ("5", "6"):
        referenced_signal_keys.update(
            str(key).strip() for key in chapters.get(chapter_id, {}).get("signal_keys", [])
        )
    for signal_key in sorted(set(signals) - referenced_signal_keys):
        findings.append(
            _finding(
                "ORPHAN_SIGNAL",
                "error",
                f"信号未被正文引用: {signal_key}",
                f"signals.{signal_key}",
            )
        )

    # A proposed/pending signal is acceptable in draft mode when no matrix is
    # available.  It must remain visible as a requirement rather than silently
    # disappearing from the document.
    if not normalized.get("signal_matrix_available", False):
        for key in sorted(referenced_signal_keys):
            item = signals.get(key, {})
            if item.get("status") == "confirmed" and not item.get("source"):
                findings.append(
                    _finding(
                        "CONFIRMED_SIGNAL_WITHOUT_SOURCE",
                        "error" if mode == "final" else "warning",
                        f"无信号矩阵时，正式信号缺少来源: {key}",
                        f"signals.{key}",
                    )
                )

    prose_items: list[tuple[str, str]] = []
    for chapter_id, chapter in chapters.items():
        for section, text in chapter.get("sections", {}).items():
            prose_items.append((f"chapters.{chapter_id}.sections.{section}", str(text)))
    for scenario_id, scenario in scenarios.items():
        for field in ("purpose", "preconditions", "enable_conditions", "triggers", "steps", "outputs", "exceptions", "recovery"):
            prose_items.append((f"scenarios.{scenario_id}.{field}", " ".join(_strings(scenario.get(field)))))

    for path, text in prose_items:
        if any(placeholder in text for placeholder in PLACEHOLDER_PHRASES):
            findings.append(
                _finding("PLACEHOLDER_TEXT", "error", "章节或场景仍包含占位内容", path)
            )
        for phrase in VAGUE_PHRASES:
            if phrase in text:
                severity = "error" if mode == "final" else "warning"
                findings.append(
                    _finding("VAGUE_WORDING", severity, f"包含需要具体化的模糊表达: {phrase}", path)
                )
        if len(text) > 180 and not any(mark in text for mark in "。；！？"):
            findings.append(
                _finding("UNPUNCTUATED_BLOCK", "error" if mode == "final" else "warning", "连续长句缺少工程化分句", path)
            )

    errors = [item for item in findings if item["severity"] == "error"]
    return {"ok": not errors, "findings": findings, "error_count": len(errors)}


def _write_report(path: Path, report: dict[str, Any]) -> None:
    lines = [
        "# PRD 功能定义质量报告",
        "",
        f"- 结果: **{'通过' if report['ok'] else '不通过'}**",
        f"- 阻断问题: **{report['error_count']}**",
        f"- 总问题数: **{len(report['findings'])}**",
        "",
        "## 问题明细",
        "",
        "| 严重度 | 规则 | 路径 | 说明 |",
        "|---|---|---|---|",
    ]
    for item in report["findings"]:
        lines.append(
            f"| {item['severity']} | {item['code']} | {item['path']} | {item['message']} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 PRD 到功能定义的结构化草稿")
    parser.add_argument("spec", help="function_definition_spec JSON 文件")
    parser.add_argument("--out", help="Markdown 报告路径")
    parser.add_argument("--strict", action="store_true", help="将警告也视为失败")
    args = parser.parse_args()

    contract = _load_contract_module()
    try:
        payload = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        normalized = contract.normalize_prd_spec_contract(payload)
    except (OSError, json.JSONDecodeError, contract.WorkflowContractError) as exc:
        report = {"ok": False, "error_count": 1, "findings": [{"severity": "error", "code": "CONTRACT", "path": args.spec, "message": str(exc)}]}
    else:
        report = review_prd_spec(normalized)

    output = Path(args.out) if args.out else Path(args.spec).with_name("quality_report.md")
    _write_report(output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["ok"] or (args.strict and report["findings"]):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
