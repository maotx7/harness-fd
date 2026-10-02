# doc-review

`doc-review` 是一个与项目无关的功能定义文档复盘技能。Hermes 主导需求覆盖、逻辑和领域规范的语义判断；随附脚本是可选的抽取、精确比对、汇总和批注工具，不是通用逻辑审查器。

## 目录

```text
skills/doc-review/
├── SKILL.md
├── README.md
├── requirements.txt
├── examples/
│   └── review_report.md
└── scripts/
    ├── extract_requirements.py
    ├── extract_document.py
    ├── review_coverage.py
    ├── review_logic.py
    ├── merge_issues.py
    ├── apply_review_comments.py
    └── generate_report.py
```

## 快速开始

按 [SKILL.md](SKILL.md) 复核本次任务的真实来源。只有在脚本能降低机械错误时才调用；工具不可用时，仍应完成有证据的人工语义复核，并披露抽取/验证范围。

技能包本身的结构和脚本检查属于维护者工作，不作为运行时命令随技能分发。

## 设计原则

- 项目事实只来自调用方输入，不在技能内置车型、版本、供应商或历史结果。
- Hermes 负责所有需要语义判断的部分；脚本辅助解析、精确比对、合并、批注和可重复执行。
- 脚本无报错或匹配率达标不能单独证明功能逻辑正确；工具报告也须回到原文核验。
- 所有自动修改都应能追溯到问题清单中的证据和建议。
- 不把某次项目的验证输出作为技能样例或回归基线。

## 脚本的可选依赖

```bash
python -m pip install -r requirements.txt
```
