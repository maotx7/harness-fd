"""Deterministic SVG renderer for controller-interaction architecture diagrams."""

from __future__ import annotations

from html import escape
from pathlib import Path
from typing import Any


NODE_STYLES = {
    "controller": {"fill": "#e5f1ee", "stroke": "#147d73", "text": "#123f3a"},
    "bus": {"fill": "#f3f5f2", "stroke": "#69716b", "text": "#303832"},
    "gateway": {"fill": "#fff4e8", "stroke": "#bd6c2e", "text": "#6b3a18"},
    "external": {"fill": "#f5f7f4", "stroke": "#929a94", "text": "#49524b"},
}


def _text(value: Any) -> str:
    return escape(str(value or ""), quote=True)


def _validate_model(model: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    nodes = model.get("nodes", [])
    edges = model.get("edges", [])
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError("架构图 nodes 和 edges 必须是数组")
    ids: set[str] = set()
    normalized_nodes: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or not str(node.get("id", "")).strip():
            raise ValueError("架构图节点必须包含 id")
        node_id = str(node["id"]).strip()
        if node_id in ids:
            raise ValueError(f"架构图节点 id 重复: {node_id}")
        ids.add(node_id)
        normalized_nodes.append({
            "id": node_id,
            "label": str(node.get("label", node_id)).strip() or node_id,
            "kind": str(node.get("kind", "controller")).strip() or "controller",
        })

    normalized_edges: list[dict[str, Any]] = []
    for edge in edges:
        if not isinstance(edge, dict):
            raise ValueError("架构图边必须是对象")
        source = str(edge.get("from", "")).strip()
        target = str(edge.get("to", "")).strip()
        if source not in ids or target not in ids:
            raise ValueError(f"架构图边引用不存在的节点: {source} -> {target}")
        direction = str(edge.get("direction", "unidirectional")).strip()
        if direction not in {"unidirectional", "bidirectional"}:
            raise ValueError(f"不支持的架构图方向: {direction}")
        status = str(edge.get("status", "verified")).strip()
        if status not in {"verified", "pending", "candidate", "conflict"}:
            raise ValueError(f"不支持的架构图状态: {status}")
        signals = edge.get("signals", [])
        if isinstance(signals, str):
            signals = [signals]
        normalized_edges.append({
            "from": source,
            "to": target,
            "bus": str(edge.get("bus", "")).strip(),
            "signals": [str(signal).strip() for signal in signals if str(signal).strip()],
            "direction": direction,
            "status": status,
        })
    return normalized_nodes, normalized_edges


def render_architecture_svg(model: dict[str, Any], *, width: int = 1100, row_height: int = 112) -> str:
    """Render a stable, reviewable SVG without relying on model image generation."""
    nodes, edges = _validate_model(model)
    columns = max(1, min(4, len(nodes)))
    margin_x, margin_y = 70, 92
    node_width, node_height = 190, 58
    gap_x = 50
    rows = max(1, (len(nodes) + columns - 1) // columns)
    height = max(300, margin_y + rows * row_height + 82)
    positions: dict[str, tuple[int, int]] = {}
    for index, node in enumerate(nodes):
        col = index % columns
        row = index // columns
        positions[node["id"]] = (
            margin_x + col * (node_width + gap_x),
            margin_y + row * row_height,
        )
    actual_width = max(width, margin_x * 2 + columns * node_width + (columns - 1) * gap_x)
    title = _text(model.get("title", "控制器交互架构图"))

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" '
        f'viewBox="0 0 {actual_width} {height}" width="{actual_width}" height="{height}">',
        '<title id="title">' + title + '</title>',
        '<desc id="desc">控制器、总线和信号交互关系；虚线表示待确认或存在冲突的关系。</desc>',
        '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">'
        '<path d="M0,0 L8,4 L0,8 z" fill="#69716b"/></marker></defs>',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="{margin_x}" y="38" font-family="Avenir Next, PingFang SC, sans-serif" '
        f'font-size="22" font-weight="650" fill="#202420">{title}</text>',
    ]

    for edge in edges:
        x1, y1 = positions[edge["from"]]
        x2, y2 = positions[edge["to"]]
        start_x, start_y = x1 + node_width / 2, y1 + node_height / 2
        end_x, end_y = x2 + node_width / 2, y2 + node_height / 2
        status_style = ' stroke-dasharray="7 5"' if edge["status"] != "verified" else ""
        start_marker = ' marker-start="url(#arrow)"' if edge["direction"] == "bidirectional" else ""
        label = ", ".join(edge["signals"])
        if edge["bus"]:
            label = f'{edge["bus"]}: {label}' if label else edge["bus"]
        if edge["status"] in {"pending", "candidate"}:
            label = f'待确认 · {label}' if label else '待确认'
        elif edge["status"] == "conflict":
            label = f'冲突 · {label}' if label else '冲突'
        out.append(
            f'<line x1="{start_x:g}" y1="{start_y:g}" x2="{end_x:g}" y2="{end_y:g}" '
            f'stroke="#69716b" stroke-width="2"{status_style}{start_marker} marker-end="url(#arrow)"/>'
        )
        if label:
            lx, ly = (start_x + end_x) / 2, (start_y + end_y) / 2 - 8
            out.append(
                f'<text x="{lx:g}" y="{ly:g}" text-anchor="middle" font-family="Avenir Next, PingFang SC, sans-serif" '
                f'font-size="12" fill="#49524b">{_text(label)}</text>'
            )

    for node in nodes:
        x, y = positions[node["id"]]
        style = NODE_STYLES.get(node["kind"], NODE_STYLES["external"])
        out.append(
            f'<g data-node="{_text(node["id"])}"><rect x="{x}" y="{y}" width="{node_width}" height="{node_height}" '
            f'rx="6" fill="{style["fill"]}" stroke="{style["stroke"]}" stroke-width="2"/>'
            f'<text x="{x + node_width / 2:g}" y="{y + 35:g}" text-anchor="middle" '
            f'font-family="Avenir Next, PingFang SC, sans-serif" font-size="16" font-weight="650" '
            f'fill="{style["text"]}">{_text(node["label"])}</text></g>'
        )

    out.append(
        f'<text x="{margin_x}" y="{height - 25}" font-family="Avenir Next, PingFang SC, sans-serif" '
        f'font-size="11" fill="#69716b">实线：已核验　虚线：待确认或冲突</text>'
    )
    out.append('</svg>')
    return "".join(out)


def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    model = json.loads(args.model.read_text(encoding="utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_architecture_svg(model), encoding="utf-8")


if __name__ == "__main__":
    main()
