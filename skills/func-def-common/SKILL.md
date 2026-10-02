---
name: func-def-common
description: 汽车功能定义任务共用的证据、章节、信号、行文和交付质量约束。
license: MIT
metadata:
  version: 0.1.0
  author: "Hermes FD"
  platforms: [macos, linux, windows]
  hermes:
    category: automotive
    tags: [automotive, requirements, signals, quality]
---

# 功能定义共享质量契约

本技能只提供 `func-def-rewrite`、`func-def-from-prd` 和
`func-def-from-idea` 共用的质量约束，不单独生成 Word，也不替代具体场景技能。
处理汽车功能定义任务前必须读取本目录的
`references/quality-delivery-contract.md`，并同时遵守当前场景技能的流程。

核心要求：

- 需求、章节、子功能、场景和信号必须双向可追溯，不能只凭正文关键词判断覆盖。
- 每个场景必须形成“前置条件/使能 → 触发 → 执行 → 输出 → 完成/退出 → 异常/恢复”闭环。
- 有信号矩阵时只能使用可回溯的正式信号；没有矩阵时仍要写信号需求，但必须标记为 `proposed` 或 `pending`，不得伪造正式信号、报文或 CAN ID。
- 正文要统一术语，明确对象、条件、动作和结果；不得用模糊表达代替行为逻辑。
- 语义草稿通过质量门禁后才能生成独立排版 DOCX；模板回填仅在用户明确要求时执行。
