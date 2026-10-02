# Workspace Enterprise Profile

企业级工作区 Profile，集成认证、知识库、信号查询、工作流管理四大插件。

## 目录职责

- 本目录是 Profile 配置的唯一源码，配置变更应提交到这里。
- `${DSH_HOME:-~/.dsh}/profiles/workspace-enterprise` 是 DSH 管理的运行态，包含独立的 `package.json`、锁文件和 `node_modules`。
- `scripts/start-dsh.sh` 启动前会将本目录的 Cordis 配置同步到运行态，但不会覆盖运行态的 `.env`、依赖或锁文件。
- 项目根 `node_modules` 用于 monorepo 开发，Profile 的 `node_modules` 用于 DSH 插件隔离解析，二者不能直接合并。

首次安装或显式删除运行态后，执行：

```bash
bash scripts/setup-dsh-profile.sh
```

## 插件列表

### 1. plugin-auth
- **功能**：JWT 认证、租户隔离、会话管理
- **工具**：
  - `authenticate_user` - 用户认证
  - `verify_workspace_access` - 工作区权限验证

### 2. plugin-kb-search
- **功能**：知识库文档检索和上传
- **工具**：
  - `search_knowledge_base` - 语义搜索
  - `upload_document_to_kb` - 文档索引

### 3. plugin-signal-query
- **功能**：车辆特征信号数据查询
- **工具**：
  - `query_vehicle_signals` - 信号查询
  - `get_signal_definition` - 信号定义

### 4. plugin-workflow-mgmt
- **功能**：工作流任务编排和执行
- **工具**：
  - `create_workflow` - 创建工作流
  - `execute_workflow` - 执行工作流
  - `get_workflow_status` - 查询状态

## 环境变量

复制 `.env.example` 为 `.env` 并配置：

```bash
cp .env.example .env
```

必填项：
- `MYSQL_URL` - 数据库连接
- `JWT_SECRET` - JWT 密钥
- `QDRANT_URL` - 向量数据库
- `REDIS_URL` - Redis 地址
- `DEEPSEEK_API_KEY` - DeepSeek API Key

## 启动

```bash
# 在项目根目录
pnpm dev:web
```

## 测试

```bash
# 测试认证
curl -X POST http://localhost:3080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}'
```
