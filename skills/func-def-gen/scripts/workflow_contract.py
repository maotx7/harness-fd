"""Structured workflow contracts for function-definition generation.

The agent may reason about requirements, but the renderer only accepts this
small, deterministic contract.  Keeping validation here prevents a DOCX from
being used as the working memory for chapter and signal decisions.
"""

from __future__ import annotations

from pathlib import Path
import json
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_REGISTRY = SKILL_ROOT / "assets" / "template_registry.json"


class WorkflowContractError(ValueError):
    """Raised when structured chapter/signal input is unsafe to render."""


# Stable first-phase PRD specification contract.  These chapter names are
# intentionally independent from a DOCX template so the semantic draft can be
# reviewed before any Word backfill occurs.
PRD_SPEC_CHAPTERS: tuple[dict[str, Any], ...] = (
    {"id": "1", "title": "导言", "sections": ("目的", "范围", "来源")},
    {
        "id": "2",
        "title": "概述",
        "sections": ("功能背景", "功能目标", "适用范围", "术语和缩写"),
    },
    {
        "id": "3",
        "title": "系统功能描述",
        "sections": (
            "主功能",
            "功能场景",
            "系统功能架构",
            "子功能分解",
            "系统功能描述",
            "系统边界和网络拓扑",
        ),
    },
    {
        "id": "4",
        "title": "系统需求",
        "sections": (
            "功能需求",
            "车辆及环境条件",
            "诊断和故障需求",
            "功能安全需求",
            "性能需求",
        ),
    },
    {
        "id": "5",
        "title": "接口和信号",
        "sections": ("HMI接口", "电子接口", "信号接口", "信号定义和信号状态"),
    },
    {
        "id": "6",
        "title": "具体功能定义",
        "sections": (
            "子功能概述",
            "子功能逻辑架构",
            "功能场景和时序",
            "信号交互",
            "变量、参数和阈值",
            "详细功能描述",
            "故障定义和处理",
            "故障恢复",
            "功能安全",
            "性能规范",
        ),
    },
    {
        "id": "7",
        "title": "需求和信号追溯",
        "sections": ("需求追溯", "信号追溯", "未决事项"),
    },
)

PRD_SPEC_SIGNAL_STATUSES = {"confirmed", "proposed", "pending", "conflict"}


def _non_empty_text(value: Any) -> str:
    """Normalize a scalar section value without accepting placeholders."""
    if isinstance(value, list):
        return " ".join(str(item).strip() for item in value if str(item).strip()).strip()
    return str(value or "").strip()


def _require_list(value: Any, field: str) -> list[Any]:
    if not isinstance(value, list) or not value:
        raise WorkflowContractError(f"{field} 必须是非空数组")
    return value


def normalize_prd_spec_contract(cfg: dict[str, Any]) -> dict[str, Any]:
    """Validate the semantic PRD-to-function-definition draft contract.

    This contract is deliberately separate from ``normalize_workflow_contract``:
    the latter protects the DOCX renderer, while this one protects the
    pre-template semantic draft and its chapter-level quality gates.
    """
    if not isinstance(cfg, dict):
        raise WorkflowContractError("PRD功能定义草稿必须是对象")
    if cfg.get("spec_version") != 1:
        raise WorkflowContractError("PRD功能定义草稿必须使用 spec_version=1")
    if cfg.get("artifact_type") != "function_definition_spec":
        raise WorkflowContractError("artifact_type 必须为 function_definition_spec")
    mode = str(cfg.get("mode", "draft")).strip().lower()
    if mode not in {"draft", "final"}:
        raise WorkflowContractError("mode 只能是 draft 或 final")

    raw_chapters = _require_list(cfg.get("chapters"), "chapters")
    chapters_by_id: dict[str, dict[str, Any]] = {}
    chapter_defs = {item["id"]: item for item in PRD_SPEC_CHAPTERS}
    for raw in raw_chapters:
        if not isinstance(raw, dict):
            raise WorkflowContractError("chapters 的成员必须是对象")
        chapter_id = str(raw.get("id", "")).strip()
        if chapter_id not in chapter_defs:
            raise WorkflowContractError(f"章节 ID 不在固定章节契约中: {chapter_id}")
        if chapter_id in chapters_by_id:
            raise WorkflowContractError(f"章节 ID 重复: {chapter_id}")
        sections = raw.get("sections")
        if not isinstance(sections, dict):
            raise WorkflowContractError(f"章节 {chapter_id} 的 sections 必须是对象")
        missing = [
            name
            for name in chapter_defs[chapter_id]["sections"]
            if not _non_empty_text(sections.get(name))
        ]
        if missing:
            raise WorkflowContractError(
                f"章节 {chapter_id} 缺少必填小节: {'、'.join(missing)}"
            )
        chapter = {**raw, "id": chapter_id, "sections": sections}
        chapters_by_id[chapter_id] = chapter

    missing_chapters = sorted(set(chapter_defs) - set(chapters_by_id))
    if missing_chapters:
        raise WorkflowContractError(f"缺少必需章节: {', '.join(missing_chapters)}")

    raw_requirements = _require_list(cfg.get("requirements"), "requirements")
    requirements: dict[str, dict[str, Any]] = {}
    for raw in raw_requirements:
        if not isinstance(raw, dict):
            raise WorkflowContractError("requirements 的成员必须是对象")
        requirement_id = str(raw.get("id", "")).strip()
        text = _non_empty_text(raw.get("text"))
        if not requirement_id or not text:
            raise WorkflowContractError("每条需求必须有 id 和 text")
        if requirement_id in requirements:
            raise WorkflowContractError(f"需求 ID 重复: {requirement_id}")
        requirements[requirement_id] = {**raw, "id": requirement_id, "text": text}

    raw_subfunctions = _require_list(cfg.get("subfunctions"), "subfunctions")
    subfunctions: dict[str, dict[str, Any]] = {}
    for raw in raw_subfunctions:
        if not isinstance(raw, dict):
            raise WorkflowContractError("subfunctions 的成员必须是对象")
        subfunction_id = str(raw.get("id", "")).strip()
        title = _non_empty_text(raw.get("title"))
        if not subfunction_id or not title:
            raise WorkflowContractError("每个子功能必须有 id 和 title")
        if subfunction_id in subfunctions:
            raise WorkflowContractError(f"子功能 ID 重复: {subfunction_id}")
        requirement_ids = _require_list(raw.get("requirement_ids"), f"子功能 {subfunction_id} 的 requirement_ids")
        unknown_requirements = sorted(
            {str(item).strip() for item in requirement_ids} - set(requirements)
        )
        if unknown_requirements:
            raise WorkflowContractError(
                f"子功能 {subfunction_id} 引用了未知需求: {', '.join(unknown_requirements)}"
            )
        signal_keys = _require_list(raw.get("signal_keys"), f"子功能 {subfunction_id} 的 signal_keys")
        subfunctions[subfunction_id] = {
            **raw,
            "id": subfunction_id,
            "title": title,
            "requirement_ids": [str(item).strip() for item in requirement_ids],
            "signal_keys": [str(item).strip() for item in signal_keys if str(item).strip()],
        }

    raw_scenarios = _require_list(cfg.get("scenarios"), "scenarios")
    scenarios: dict[str, dict[str, Any]] = {}
    scenario_fields = (
        "preconditions",
        "enable_conditions",
        "triggers",
        "steps",
        "outputs",
        "completion_conditions",
        "exit_conditions",
        "exceptions",
        "recovery",
        "signal_keys",
    )
    for raw in raw_scenarios:
        if not isinstance(raw, dict):
            raise WorkflowContractError("scenarios 的成员必须是对象")
        scenario_id = str(raw.get("id", "")).strip()
        title = _non_empty_text(raw.get("title"))
        subfunction_id = str(raw.get("subfunction_id", "")).strip()
        if not scenario_id or not title or not subfunction_id:
            raise WorkflowContractError("每个场景必须有 id、title 和 subfunction_id")
        if scenario_id in scenarios:
            raise WorkflowContractError(f"场景 ID 重复: {scenario_id}")
        if subfunction_id not in subfunctions:
            raise WorkflowContractError(f"场景 {scenario_id} 引用了未知子功能: {subfunction_id}")
        if not _non_empty_text(raw.get("purpose")):
            raise WorkflowContractError(f"场景 {scenario_id} 缺少 purpose")
        for field in scenario_fields:
            values = raw.get(field)
            if not isinstance(values, list) or not values:
                if field == "signal_keys":
                    raise WorkflowContractError(f"场景必须至少引用一个信号: {scenario_id}")
                label = "退出条件" if field == "exit_conditions" else field
                raise WorkflowContractError(f"场景 {scenario_id} 缺少必填项: {label}")
        if not all(isinstance(step, dict) for step in raw["steps"]):
            raise WorkflowContractError(f"场景 {scenario_id} 的 steps 必须是对象数组")
        scenarios[scenario_id] = {**raw, "id": scenario_id, "title": title, "subfunction_id": subfunction_id}

    raw_signals = _require_list(cfg.get("signals"), "signals")
    signals: dict[str, dict[str, Any]] = {}
    for raw in raw_signals:
        if not isinstance(raw, dict):
            raise WorkflowContractError("signals 的成员必须是对象")
        key = str(raw.get("semantic_key", "")).strip()
        status = str(raw.get("status", "")).strip().lower()
        if not key:
            raise WorkflowContractError("信号缺少 semantic_key")
        if key in signals:
            raise WorkflowContractError(f"信号语义重复: {key}")
        if status not in PRD_SPEC_SIGNAL_STATUSES:
            raise WorkflowContractError(f"信号 {key} 的 status 无效: {status}")
        if not _non_empty_text(raw.get("semantic_name")):
            raise WorkflowContractError(f"信号 {key} 缺少 semantic_name")
        if not _non_empty_text(raw.get("signal_name") or raw.get("suggested_name")):
            raise WorkflowContractError(f"信号 {key} 必须有正式名称或建议名称")
        if not _non_empty_text(raw.get("direction")):
            raise WorkflowContractError(f"信号 {key} 缺少 direction")
        if not _non_empty_text(raw.get("purpose")):
            raise WorkflowContractError(f"信号 {key} 缺少 purpose")
        signals[key] = {**raw, "semantic_key": key, "status": status}

    referenced_signal_keys = set()
    for item in subfunctions.values():
        referenced_signal_keys.update(item["signal_keys"])
    for item in scenarios.values():
        referenced_signal_keys.update(str(key).strip() for key in item["signal_keys"])
    for chapter_id in ("5", "6"):
        keys = chapters_by_id[chapter_id].get("signal_keys", [])
        if not isinstance(keys, list) or not keys:
            raise WorkflowContractError(f"章节 {chapter_id} 必须提供 signal_keys")
        referenced_signal_keys.update(str(key).strip() for key in keys)
    unknown_signals = sorted(key for key in referenced_signal_keys if key not in signals)
    if unknown_signals:
        raise WorkflowContractError(f"引用了未定义信号: {', '.join(unknown_signals)}")

    for subfunction_id, item in subfunctions.items():
        scenario_ids = _require_list(item.get("scenario_ids"), f"子功能 {subfunction_id} 的 scenario_ids")
        unknown_scenarios = sorted(
            {str(value).strip() for value in scenario_ids} - set(scenarios)
        )
        if unknown_scenarios:
            raise WorkflowContractError(
                f"子功能 {subfunction_id} 引用了未知场景: {', '.join(unknown_scenarios)}"
            )

    matrix_available = bool(cfg.get("signal_matrix") or cfg.get("signal_matrix_available"))
    if mode == "final":
        unresolved = sorted(
            key for key in referenced_signal_keys if signals[key]["status"] != "confirmed"
        )
        if unresolved:
            raise WorkflowContractError(f"正式版信号未确认: {', '.join(unresolved)}")

    return {
        "spec_version": 1,
        "artifact_type": "function_definition_spec",
        "mode": mode,
        "signal_matrix_available": matrix_available,
        "chapters": chapters_by_id,
        "requirements": requirements,
        "subfunctions": subfunctions,
        "scenarios": scenarios,
        "signals": signals,
    }


def _as_list(value: Any, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise WorkflowContractError(f"{field} 必须是数组")
    return value


def domain_required_sections(domain: str) -> tuple[str, ...]:
    """Return required module sections from the registered domain contract."""
    requested = str(domain or "").strip().lower()
    try:
        registry = json.loads(TEMPLATE_REGISTRY.read_text(encoding="utf-8"))
        templates = registry.get("templates", {})
    except (OSError, json.JSONDecodeError) as exc:
        raise WorkflowContractError("功能定义模板注册表不可读") from exc
    entry = templates.get(requested)
    if not isinstance(entry, dict):
        for candidate in templates.values():
            aliases = candidate.get("aliases", []) if isinstance(candidate, dict) else []
            if requested in {str(alias).strip().lower() for alias in aliases}:
                entry = candidate
                break
    sections = entry.get("required_sections") if isinstance(entry, dict) else None
    if not isinstance(sections, list) or not sections:
        raise WorkflowContractError(f"功能定义领域未注册 required_sections: {domain}")
    normalized = tuple(str(section).strip() for section in sections if str(section).strip())
    if not normalized:
        raise WorkflowContractError(f"功能定义领域 required_sections 为空: {domain}")
    return normalized


def normalize_workflow_contract(cfg: dict[str, Any]) -> dict[str, Any] | None:
    """Validate and normalize the opt-in v2 contract.

    Legacy configs remain supported.  A v2 config must contain stable feature
    IDs, chapter content keyed by those IDs, and explicit signal decisions.
    """
    if cfg.get("workflow_version") != 2:
        return None

    domain = str(cfg.get("domain", "")).strip()
    if not domain:
        raise WorkflowContractError("workflow_version=2 必须指定 domain")
    required_sections = domain_required_sections(domain)

    hierarchy = cfg.get("feature_hierarchy")
    raw_features = hierarchy.get("features") if isinstance(hierarchy, dict) else hierarchy
    features = _as_list(raw_features, "feature_hierarchy.features")
    if not features:
        raise WorkflowContractError("feature_hierarchy.features 不能为空")

    feature_ids: set[str] = set()
    feature_titles: set[str] = set()
    normalized_features: list[dict[str, Any]] = []
    for feature in features:
        if not isinstance(feature, dict):
            raise WorkflowContractError("feature_hierarchy.features 的成员必须是对象")
        feature_id = str(feature.get("id", "")).strip()
        title = str(feature.get("title", "")).strip()
        if not feature_id or not title:
            raise WorkflowContractError("每个功能章节都必须有 id 和 title")
        if feature_id in feature_ids:
            raise WorkflowContractError(f"功能章节 ID 重复: {feature_id}")
        if title in feature_titles:
            raise WorkflowContractError(f"功能章节标题重复，请使用稳定 ID 区分: {title}")
        feature_ids.add(feature_id)
        feature_titles.add(title)
        requirements = feature.get("requirements", [])
        signal_keys = feature.get("signal_keys", [])
        if not isinstance(requirements, list) or not isinstance(signal_keys, list):
            raise WorkflowContractError(f"章节 {feature_id} 的 requirements/signal_keys 必须是数组")
        parent_id = feature.get("parent_id")
        if parent_id is not None and str(parent_id).strip() == feature_id:
            raise WorkflowContractError(f"章节不能把自己作为父节点: {feature_id}")
        normalized_features.append({**feature, "id": feature_id, "title": title,
                                    "requirements": requirements, "signal_keys": signal_keys})

    # Parent references are checked after collecting all IDs so a malformed
    # hierarchy cannot silently become a flat list during rendering.
    for feature in normalized_features:
        parent_id = feature.get("parent_id")
        if parent_id is not None and str(parent_id).strip() not in feature_ids:
            raise WorkflowContractError(
                f"章节 {feature['id']} 引用了未知 parent_id: {parent_id}"
            )

    # If an inventory is supplied, every inventory requirement must be covered
    # by at least one planned chapter.  The field is optional for legacy/v1
    # callers, but v2 callers cannot accidentally drop known requirements.
    inventory = cfg.get("requirement_inventory")
    if inventory is not None:
        raw_requirements = inventory.get("requirements") if isinstance(inventory, dict) else inventory
        raw_requirements = _as_list(raw_requirements, "requirement_inventory.requirements")
        inventory_ids = set()
        for item in raw_requirements:
            requirement_id = item.get("id") if isinstance(item, dict) else item
            requirement_id = str(requirement_id or "").strip()
            if not requirement_id:
                raise WorkflowContractError("需求清单中的每项都必须有 id")
            inventory_ids.add(requirement_id)
        covered_ids = {
            str(requirement).strip()
            for feature in normalized_features
            for requirement in feature["requirements"]
            if str(requirement).strip()
        }
        missing_requirements = sorted(inventory_ids - covered_ids)
        if missing_requirements:
            raise WorkflowContractError(
                f"需求未映射到章节: {', '.join(missing_requirements)}"
            )

    raw_mapping = cfg.get("signal_mapping")
    mappings = raw_mapping.get("signals") if isinstance(raw_mapping, dict) else raw_mapping
    mappings = _as_list(mappings, "signal_mapping.signals")
    mapping_by_key: dict[str, dict[str, Any]] = {}
    for item in mappings:
        if not isinstance(item, dict):
            raise WorkflowContractError("signal_mapping.signals 的成员必须是对象")
        key = str(item.get("semantic_key", "")).strip()
        status = str(item.get("status", "")).strip().lower()
        if not key:
            raise WorkflowContractError("信号映射缺少 semantic_key")
        if key in mapping_by_key:
            raise WorkflowContractError(f"信号语义重复: {key}")
        if status not in {"confirmed", "ambiguous", "unresolved", "conflict"}:
            raise WorkflowContractError(f"信号 {key} 的 status 无效: {status}")
        mapping_by_key[key] = {**item, "semantic_key": key, "status": status}

    chapters = cfg.get("chapters")
    if not isinstance(chapters, list):
        raise WorkflowContractError("workflow_version=2 必须提供 chapters 数组")
    chapters_by_id: dict[str, dict[str, Any]] = {}
    for chapter in chapters:
        if not isinstance(chapter, dict):
            raise WorkflowContractError("chapters 的成员必须是对象")
        feature_id = str(chapter.get("feature_id", "")).strip()
        if feature_id not in feature_ids:
            raise WorkflowContractError(f"章节内容引用了未知 feature_id: {feature_id}")
        if feature_id in chapters_by_id:
            raise WorkflowContractError(f"章节内容重复: {feature_id}")
        sections = chapter.get("sections")
        if not isinstance(sections, dict):
            raise WorkflowContractError(f"章节 {feature_id} 的 sections 必须是对象")
        missing = [name for name in required_sections if not str(sections.get(name, "")).strip()]
        if missing and str(cfg.get("mode", "final")).lower() == "final":
            raise WorkflowContractError(f"章节 {feature_id} 核心小节为空: {'、'.join(missing)}")
        signal_keys = chapter.get("signal_keys", [])
        if not isinstance(signal_keys, list):
            raise WorkflowContractError(f"章节 {feature_id} 的 signal_keys 必须是数组")
        chapters_by_id[feature_id] = {**chapter, "feature_id": feature_id,
                                      "sections": sections, "signal_keys": signal_keys}

    missing_chapters = feature_ids - chapters_by_id.keys()
    if missing_chapters:
        raise WorkflowContractError(f"缺少章节内容: {', '.join(sorted(missing_chapters))}")

    required_keys = set()
    for feature in normalized_features:
        required_keys.update(str(key).strip() for key in feature["signal_keys"] if str(key).strip())
    for chapter in chapters_by_id.values():
        required_keys.update(str(key).strip() for key in chapter["signal_keys"] if str(key).strip())
    if str(cfg.get("mode", "final")).lower() == "final":
        unresolved = sorted(key for key in required_keys
                            if mapping_by_key.get(key, {}).get("status") != "confirmed")
        if unresolved:
            raise WorkflowContractError(f"正式版信号未确认: {', '.join(unresolved)}")

    return {
        "domain": domain,
        "required_sections": required_sections,
        "features": normalized_features,
        "chapters": chapters_by_id,
        "signals": mapping_by_key,
    }


def contract_to_legacy_config(cfg: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    """Project the v2 contract onto the existing DOCX renderer inputs."""
    features = contract["features"]
    chapters = contract["chapters"]
    signal_mapping = contract["signals"]
    feature_chapters = [{"id": item["id"], "title": item["title"]} for item in features]
    section_content = {
        next(item["title"] for item in features if item["id"] == feature_id): chapter["sections"]
        for feature_id, chapter in chapters.items()
    }
    signals: dict[str, list[str]] = {}
    chapter_signals: dict[str, list[str]] = {}
    for key, item in signal_mapping.items():
        if item["status"] != "confirmed":
            continue
        name = str(item.get("signal") or item.get("signal_name") or "").strip()
        if not name:
            continue
        signals[key] = [
            str(item.get("message") or item.get("message_name") or ""),
            str(item.get("can_id") or ""),
            name,
            str(item.get("description") or item.get("chinese_description") or ""),
            str(item.get("value_description") or ""),
        ]
    for feature in features:
        chapter = chapters[feature["id"]]
        keys = [key for key in chapter["signal_keys"] if key in signals]
        chapter_signals[feature["id"]] = keys
    projected = dict(cfg)
    projected.update({
        "feature_chapters": feature_chapters,
        "section_content": section_content,
        "signals": signals,
        "chapter_signals": chapter_signals,
    })
    return projected
