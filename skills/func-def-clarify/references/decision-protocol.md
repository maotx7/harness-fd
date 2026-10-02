# 功能定义澄清决策协议

该协议是技能、后端适配层和前端之间的稳定边界。业务问题与选项由技能动态生成；后端只负责校验、传输、等待和恢复；前端只负责呈现和提交。

## 需求画像

需求画像中的每个事实使用相同结构：

```json
{
  "value": "ICC",
  "status": "confirmed",
  "sources": [
    {"kind": "user", "ref": "message:42", "summary": "用户确认责任控制器为 ICC"}
  ]
}
```

允许的状态：

- `confirmed`：用户或权威输入明确确认；
- `retrieved`：从知识库、项目配置或信号目录唯一检索到；
- `inferred`：根据证据推断但尚未由人确认；
- `ambiguous`：存在多个会改变结果的合理候选；
- `missing`：当前没有足够信息；
- `pending`：用户明确选择暂不决定。

需求画像按当前功能需要扩展，不要为了填满固定表单创建无关字段。常见但非强制的主题包括功能目标与边界、适用项目/车型、责任控制器、触发与前置条件、主流程、退出与恢复、优先级/互斥、输入输出接口、故障与降级、HMI 行为和架构交互。

## 澄清请求

```json
{
  "type": "clarification_request",
  "request_id": "clarify-<unique-id>",
  "decision_key": "<stable semantic key>",
  "task_id": "<current task id>",
  "stage": "scope|behavior|signal_mapping|fault_strategy|architecture|delivery",
  "question": "<context-specific question>",
  "reason": "<why a human decision is required>",
  "evidence": [
    {
      "source": "<actual document, matrix, knowledge item, or user message>",
      "location": "<page, section, sheet, row, or message id when known>",
      "summary": "<relevant fact only>"
    }
  ],
  "selection": "single|multiple",
  "options": [
    {
      "id": "<stable id within this request>",
      "label": "<short user-facing choice>",
      "description": "<what this choice means>",
      "impact": "<effect on the function definition>"
    }
  ],
  "recommended_option_id": null,
  "recommendation_reason": null,
  "allow_free_text": true,
  "required": true
}
```

约束：

- `request_id` 全任务唯一；重连重放同一请求时保持不变。
- `decision_key` 表达业务决策语义，可用于判断新证据是否使旧决定失效。
- `options` 至少两个。除非自由文本本身就是唯一合理输入，否则不要发空选项请求。
- 多选只用于选项可以同时成立的场景，不能用多选回避互斥决策。
- 推荐项只能引用当前证据，不得以“通常如此”作为唯一理由。
- 无安全默认值时提供保守选项，例如暂不确定、形成待确认草案、发起信号申请或暂不纳入本版；具体标签仍由当前上下文生成。

## 澄清回答

```json
{
  "type": "clarification_response",
  "request_id": "clarify-<unique-id>",
  "selected_option_ids": ["<option-id>"],
  "free_text": "<optional user note>"
}
```

校验要求：

- 回答必须指向当前任务中尚未完成的请求；未知、已回答或属于其他任务的请求应拒绝。
- 单选必须恰好选择一个选项；多选至少选择一个选项，除非非必填且提供了自由文本。
- 选项 ID 必须属于原请求。
- `free_text` 只补充选择含义，不能暗中覆盖所选项；发生冲突时产生新的澄清请求。

## 决策记录

```json
{
  "decision_key": "<same semantic key>",
  "request_id": "<request id>",
  "selected_option_ids": ["<option-id>"],
  "free_text": "<optional note>",
  "decided_by": "user",
  "evidence_revision": ["<source identity/version>"],
  "downstream_effects": ["document", "signals", "architecture"],
  "decided_at": "<ISO-8601 timestamp>"
}
```

当需求文件、矩阵版本或项目绑定发生变化并影响已有决定时，不覆盖历史记录。将原决定标为失效，说明新证据，再生成新的请求。

## 生成就绪摘要

```json
{
  "type": "generation_readiness",
  "recommended_mode": "draft|formal|continue_clarification",
  "confirmed_decisions": 0,
  "retrieved_facts": 0,
  "blocking_items": [],
  "pending_items": [],
  "signal_summary": {
    "verified": 0,
    "ambiguous": 0,
    "missing": 0
  },
  "architecture_summary": {
    "confirmed_edges": 0,
    "pending_edges": 0
  }
}
```

`formal` 不能包含会改变正文、信号或正式架构关系的阻塞项。`draft` 可以包含待确认项，但每一项必须能够在 Word、架构图或附属报告中被清楚识别。