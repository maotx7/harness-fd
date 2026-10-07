# Harness-FD

基于 DeepSeek Harness 的汽车功能定义工作区。仓库以 pnpm workspace 管理本地插件；知识库、信号矩阵和工作流数据使用 SQLite，知识库原文件保存在本机文件系统。

## 开发环境

要求 Node.js 20+、pnpm 8+，并准备可访问的 DeepSeek 模型服务、embedding 服务和当前认证插件所需的 MySQL。当前认证插件仍使用 MySQL；SQLite 改造覆盖知识库、信号和工作流，不覆盖认证数据。

```bash
git clone <repository-url>
cd harness-fd
pnpm install
cp .env.example .env
# 编辑 .env：填写服务地址和密钥，生成独立的 JWT_SECRET、SIGNATURE_SECRET
pnpm setup:dsh
pnpm build
pnpm dev:web
```

首次安装时 `pnpm setup:dsh` 会在 `${DSH_HOME:-~/.dsh}/profiles/workspace-enterprise` 创建隔离的 DSH 运行态。日常开发修改 `packages/workspace/`、`profiles/workspace-enterprise/` 或 `client/` 下源码后，执行 `pnpm build`，再重启 `pnpm dev:web`。默认监听 `3081` 端口；可用 `pnpm exec dsh --profile workspace-enterprise --port 3082` 临时指定端口。

运行配置统一从项目根 `.env` 加载。Profile 目录只保存可提交的 DSH 配置，不存放第二份环境变量文件。不要提交真实 `.env` 文件或密钥。

## 命令

| 命令 | 用途 |
| --- | --- |
| `pnpm install` | 安装 workspace 依赖 |
| `pnpm setup:dsh` | 首次创建 DSH 运行态 profile |
| `pnpm build` | 构建所有 workspace 插件 |
| `pnpm dev:web` | 启动本地工作区 |
| `pnpm test` | 运行提供了 test 脚本的 workspace 测试 |
| `pnpm migrate:signals` | 从旧 MySQL/MinIO 环境迁移信号矩阵数据（仅迁移时使用） |

## 根目录配置

- `package.json` 定义仓库元信息、Node/pnpm 版本、常用命令和开发依赖。
- `pnpm-workspace.yaml` 将 `packages/workspace/*` 声明为 pnpm workspace，并允许所列原生依赖执行构建脚本。
- `pnpm-lock.yaml` 锁定依赖树；依赖变更后提交它，CI/部署安装使用 `pnpm install --frozen-lockfile`。
- `tsconfig.json` 提供根级 TypeScript 检查设置，覆盖 `packages/`。
- `.env.example` 是本地配置模板；复制为未跟踪的 `.env` 后填写环境相关值。
- `.gitignore` 忽略依赖、构建产物、运行数据库和整个 `/data/` 业务文件目录。

## 目录结构

```text
packages/workspace/                 工作区插件源码
  plugin-auth/                      旧版 MySQL 认证插件
  plugin-kb-search/                 文档上传、解析、embedding 和语义检索
  plugin-signal-query/              信号矩阵查询
  plugin-workflow-mgmt/             工作流管理
  plugin-ui-customization/          工作区 UI 样式定制
client/styles/custom-ui.css         UI 定制样式源码
profiles/workspace-enterprise/      可提交的 DSH profile 配置源码
scripts/                            profile 安装、启动、配置合并和数据迁移工具
runtime/                            DSH 缓存、日志、任务等临时运行数据（本地生成，不提交）
data/                               SQLite 数据库、上传文件及用户文件（本地数据，不提交）
skills/                             面向 Harness 工作流的技能定义
```

`profiles/workspace-enterprise/README.md` 介绍 profile 的配置与同步方式。`skills/doc-review/README.md` 属于独立技能目录，不是应用部署文档。

## 环境变量

完整变量清单和示例值见 [.env.example](.env.example)。运行前至少要按实际环境填写：

- `DEEPSEEK_API_KEY`：模型服务凭据。
- `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSION`：知识库向量化服务。
- `MYSQL_URL`、`JWT_SECRET`、`SIGNATURE_SECRET`、`USER_DATA_ROOT`：当前 `plugin-auth` 的认证配置。认证数据尚未迁移到 SQLite，因此部署仍需 MySQL。
- `DATABASE_PATH`、`VECTOR_DB_PATH`、`LOCAL_STORAGE_ROOT`：SQLite 和知识库文件的持久化位置。生产环境建议使用绝对路径。

`Qdrant`、`Redis` 和 `MinIO` 不属于当前应用运行时依赖。信号迁移脚本如需访问旧 MinIO，则另行提供 `LEGACY_MYSQL_URL`、`MINIO_ENDPOINT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY` 和 `MINIO_BUCKET`。

## 部署

推荐在 Linux 主机上以专用非 root 用户运行。先安装 Node.js 20+ 和 pnpm 8+，部署代码并配置 `.env`，然后执行：

```bash
pnpm install --frozen-lockfile
pnpm setup:dsh
pnpm build
pnpm dev:web
```

生产运行时应由 systemd、进程管理器或等效服务管理器托管启动命令，并配置自动重启、日志收集和非特权运行用户。对外提供服务时，在前置 Nginx/Caddy 等反向代理上终止 HTTPS，并限制数据库和 SQLite 文件的访问权限。不要将开发端口直接暴露到公网。

将以下内容放在持久化磁盘并定期备份：

- `data/`：SQLite 数据库（`harness.db`、`vectors.db`）、知识库上传原文件及其他用户文件。
- `runtime/`：DSH 运行期间生成的缓存、日志、任务和其他临时产物。
- `.env`：密钥和连接配置，需加密保存并限制读取权限。

备份 SQLite 前应暂停写入或使用 SQLite 在线备份能力，保证主数据库与向量数据库处于一致的备份时间点。恢复时先停止服务，恢复配置、数据库和文件目录，再启动并验证登录、文档检索及信号查询。不要只备份数据库而遗漏 `data/` 原文件。

## 仓库数据边界

`data/` 和 `runtime/` 都是运行数据，不应上传到 GitHub；忽略规则已覆盖它们。SQLite 数据库统一放在 `data/`，启动时会在目标库不存在且旧 `runtime/` 数据库存在时做在线备份迁移。迁移不会覆盖已有目标库，也会保留旧库供验证；确认登录、信号查询和知识库检索正常后，可删除 `runtime/harness.db`、`runtime/vectors.db` 及其 `-wal`、`-shm` 文件。请用 `git check-ignore -v data/<文件>` 验证忽略状态。源码、profile 配置和不含密钥的 `.env.example` 才属于仓库内容。
