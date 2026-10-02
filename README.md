# DeepSeek Harness FD Workspace

基于 DeepSeek Harness 的汽车功能定义工作区。DSH 提供会话、模型调用和 Web UI，`packages/workspace/` 提供认证、知识库、信号查询和工作流插件。

## 目录

```text
packages/workspace/              DSH 业务插件
profiles/workspace-enterprise/  Profile 源配置
skills/                          功能定义技能
runtime/                         本地运行数据（不提交）
```

## 环境要求

- Node.js 20+
- pnpm 8+
- Python 3.11+ 与 uv（仅用于 DOCX/XLSX 技能脚本）
- 可访问的 MySQL、Redis 和 Qdrant
- DeepSeek 与 Embedding API 凭据

根目录 `.env` 可提供共享配置；Profile 运行态的 `.env` 位于 `${DSH_HOME:-~/.dsh}/profiles/workspace-enterprise/.env`。变量模板见 `.env.example` 和 `profiles/workspace-enterprise/.env.example`。

## 安装

```bash
pnpm install
pnpm setup:dsh
python skills/func-def-gen/scripts/setup_env.py
```

`setup:dsh` 创建独立的 DSH 运行态 Profile，并安装官方 Web UI 与本仓库业务插件。若运行态 Profile 已存在，脚本会拒绝覆盖；需要重建时应先显式删除 `${DSH_HOME:-~/.dsh}/profiles/workspace-enterprise`。

## 启动

```bash
pnpm dev:web
```

访问 <http://127.0.0.1:3081/>。

DSH 每次启动都会生成新的进程 token，并通过带 token 的一次性启动 URL 换取浏览器签名 cookie，随后自动跳转到不含 token 的地址。默认不要传 `--no-open`，让 DSH 自动完成该交接。必须无界面启动时可传 `--no-open`，但重启后需要手动打开终端新打印的 `dsh web:` URL；旧 URL 和旧 cookie 不可复用，也不要保存或传播该 URL。

模型提供方和默认模型选择由 DSH 设置页持久化到运行态 Profile。启动时会保留这些 UI 配置，同时同步本仓库托管的业务插件、技能目录和默认兜底模型，因此重启后无需重新添加模型或重新选择模型。API Key 仍由 DSH 凭据存储或环境变量管理，不会写入仓库配置。

## 验证

```bash
pnpm typecheck
pnpm test
```

Profile 的配置职责、插件列表和运行态说明见 `profiles/workspace-enterprise/README.md`。
