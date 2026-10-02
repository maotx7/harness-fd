---
name: func-def-gen
description: 继续有持久化检查点的旧版汽车功能定义任务；新建任务请使用对应的场景技能。
license: MIT
metadata:
  version: 0.6.0
  author: "Hermes Agent"
  platforms: [macos, linux, windows]
  hermes:
    category: automotive
    tags: [automotive, docx, requirements, can]
---

# 功能定义旧任务兼容入口

本技能只用于恢复已有的旧版 `func-def-gen` 任务。新建任务必须按输入场景路由：

- 已有功能定义需要迁移或改写：`func-def-rewrite`
- 已有 PRD/需求材料需要形成新功能定义：`func-def-from-prd`
- 从一句话或少量描述开始，需要澄清、形成并审批需求草案后再生成：`func-def-from-idea`

## 恢复旧任务

1. 通过持久化的 task ID 查询任务快照、阶段、checkpoint 和已有 artifacts；不得仅凭聊天记录推断阶段。
2. 按快照恢复原任务及原场景，不要求用户重新上传已持久化的输入，不创建重复 task ID。
3. 如果运行时没有可靠的恢复入口，保留现有 artifacts 并说明具体阻塞阶段；不要声称任务正在继续，也不要从头重做已完成工作。
4. 恢复后遵守任务创建时有效的场景约定与共享质量/交付契约。若旧 checkpoint 与当前运行时状态冲突，以运行时实际支持的状态迁移为准，并明确报告无法自动恢复的部分。
5. 只有最终 DOCX 已校验、持久化并通过前端或飞书送达后才能报告完成。送达失败时保留文件并仅重试送达。

## 不在本技能范围内

本入口不负责新任务的场景识别、需求解释、功能逻辑设计、模板选择或 Word 回填。不要把旧版场景 A/B/C 的流程、阶段名、阈值或脚本步骤套用到新任务；分别加载对应场景技能。DOCX 的机械处理可使用本目录 `scripts/` 中确实适用于当前模板的工具，但脚本输出不能代替对需求逻辑的判断和最终文档审阅。
