# Workspace Enterprise Profile

本目录是 `workspace-enterprise` DSH profile 的可提交配置源码。修改 profile 时提交本目录的配置，不要直接修改 DSH 自动生成的运行态文件。

## 文件职责

- `cordis.yml`：基础 Cordis 配置入口；当前保持为空，插件由 patch 组合。
- `cordis.patch.yml`：插件、插件配置、模型和技能目录的实际声明。
- `cordis.schema.json`：Cordis 配置结构校验 schema。
- 环境变量统一维护在仓库根目录 `.env`；模板见根目录 `.env.example`。

## 运行态

`scripts/setup-dsh-profile.sh` 首次创建 `${DSH_HOME:-~/.dsh}/profiles/workspace-enterprise` 并安装 DSH 与本仓库插件。项目根 `node_modules` 用于 workspace 开发；profile 下的 `node_modules` 是 DSH 运行时依赖，两者独立。

启动时 `scripts/start-dsh.sh` 将本目录的 `cordis.yml`、`cordis.schema.json` 同步到运行态，并将 `cordis.patch.yml` 合并到运行态 patch。环境变量只从项目根 `.env` 加载。不要手动编辑运行态配置来持久化变更。

## 插件组成

- `plugin-auth`：现有认证插件，仍依赖 MySQL；认证存储还没有迁移到 SQLite。
- `plugin-kb-search`：知识库上传、文档处理、embedding 和语义搜索；SQLite 存储向量，原文件本地保存。
- `plugin-signal-query`：信号矩阵查询，使用 SQLite。
- `plugin-workflow-mgmt`：工作流管理，使用 SQLite。
- `plugin-ui-customization`：打包并注入 `client/styles/custom-ui.css`。

## 配置与启动

```bash
# 在仓库根目录首次安装
cp .env.example .env
# 编辑 .env，填写模型、embedding、认证和数据库所需值
pnpm setup:dsh
pnpm build
pnpm dev:web
```

变量含义和部署要求见仓库根 [README](../../README.md) 及 [.env.example](../../.env.example)。知识库向量化需要有效的 embedding 服务配置；上传原文件、SQLite 数据库和用户运行文件都应保存在持久化磁盘，且不应提交到 Git。
