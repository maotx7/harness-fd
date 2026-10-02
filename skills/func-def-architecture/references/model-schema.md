# 架构图模型契约

技能内部使用 JSON 模型，渲染器接受其中的 `title`、`nodes` 和 `edges` 字段。附加字段（例如 `source`、`evidence`、`unresolved_reason`）必须保留在模型文件中，供审阅报告回源；renderer 不需要理解这些字段。

```json
{
  "title": "座舱与车身控制器交互",
  "nodes": [
    {"id": "icc", "label": "ICC", "kind": "controller"},
    {"id": "vdc", "label": "VDC", "kind": "controller"},
    {"id": "ibus", "label": "IBUS", "kind": "bus"},
    {"id": "gateway", "label": "中央网关", "kind": "gateway"}
  ],
  "edges": [
    {
      "from": "icc",
      "to": "vdc",
      "bus": "IBUS",
      "signals": ["PwrMod", "VehSpd"],
      "direction": "bidirectional",
      "status": "verified",
      "source": {"kind": "signal_matrix", "matrix_id": "matrix-1", "location": "row 42"}
    }
  ]
}
```

节点 `kind` 可为 `controller`、`bus`、`gateway` 或 `external`。边 `direction` 使用 `unidirectional` 或 `bidirectional`；边 `status` 使用 `verified`、`pending`、`candidate` 或 `conflict`。当前 renderer 对 `candidate` 的表现与其他未确认状态相同，统一使用虚线。

不确定关系必须带 `unresolved_reason` 或等价说明，并进入 `architecture-unresolved.md`。`source` 只能引用实际读取过的文件、知识库证据或固定矩阵版本。
