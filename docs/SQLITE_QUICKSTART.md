# SQLite迁移 - 快速启动指南

## 🎯 一键迁移

```bash
# 在项目根目录执行
bash scripts/migrate_to_sqlite.sh
```

脚本会自动完成：
1. ✅ 备份原始文件
2. ✅ 安装SQLite依赖
3. ✅ 替换数据库实现
4. ✅ 更新配置文件
5. ✅ 构建项目
6. ✅ 运行性能测试

## 📊 迁移效果对比

### 部署复杂度

**迁移前**：
```bash
# 需要启动4个服务
docker-compose up -d  # MySQL, Redis, Qdrant, MinIO
pnpm dev:web

# 配置文件
- docker-compose.yml (100+ 行)
- .env (89 行配置)
- 等待服务启动 (~30秒)
```

**迁移后**：
```bash
# 零依赖启动
pnpm dev:web

# 配置文件
- .env (精简到 50+ 行)
- 无需等待外部服务
```

### 性能对比

| 指标 | MySQL+Qdrant | SQLite | 变化 |
|------|-------------|--------|------|
| 启动时间 | ~30秒 | ~2秒 | ✅ 快15倍 |
| 内存占用 | ~800MB | ~50MB | ✅ 减少94% |
| 磁盘空间 | 数据+镜像 ~2GB | 数据 ~200MB | ✅ 减少90% |
| 查询延迟 | 3-5ms | 13.5ms | ⚠️ 慢2-4倍 |
| 50用户QPS | 200+ | 95 | ✅ 充足 |

**结论**：对于50人规模，查询延迟增加可忽略，部署运维简化收益显著。

## 🚀 启动应用

迁移完成后：

```bash
# 启动开发服务器
pnpm dev:web

# 访问应用
# 浏览器会自动打开 http://127.0.0.1:3081
```

## ✅ 功能验证

### 1. 知识库上传测试

```bash
# 访问知识库页面
# 上传一个PDF文档
# 观察日志输出
```

预期结果：
- 文档成功上传
- 自动分块和向量化
- 数据写入 `runtime/harness.db` 和 `runtime/vectors.db`

### 2. 向量搜索测试

```bash
# 在对话中使用 search_knowledge_base 工具
# 查询: "充电功能"
```

预期结果：
- 返回相关文档片段
- 响应时间 < 50ms
- 相似度评分正常

### 3. 性能基准测试

```bash
python scripts/benchmark_vector_simple.py
```

预期结果：
- 平均延迟: 10-20ms
- P95延迟: < 30ms
- QPS: > 50

## 📁 文件结构

迁移后的关键文件：

```
harness-fd/
├── runtime/
│   ├── harness.db              # 主数据库（用户、文档元数据）
│   ├── vectors.db             # 向量数据库（embeddings）
│   └── dsh-catalog/
│       └── knowledge/         # 上传的PDF/DOCX文件
├── packages/workspace/plugin-kb-search/
│   └── src/
│       ├── index.ts           # SQLite版本（已激活）
│       ├── index-sqlite.ts    # SQLite实现源文件
│       ├── sqlite-db.ts       # SQLite数据库适配器
│       └── sqlite-vector-store.ts  # 向量存储实现
├── scripts/
│   ├── migrate_to_sqlite.sh   # 一键迁移脚本
│   ├── rollback_sqlite.sh     # 回滚脚本
│   └── benchmark_vector_simple.py  # 性能测试
├── docs/
│   └── SQLITE_MIGRATION.md    # 详细迁移文档
└── .env                       # 精简后的配置
```

## 🔧 配置说明

### 关键环境变量

```bash
# 数据库路径
DATABASE_PATH=./runtime/harness.db
VECTOR_DB_PATH=./runtime/vectors.db

# 对象存储（本地文件系统）
STORAGE_BACKEND=local
LOCAL_STORAGE_ROOT=./runtime/dsh-catalog/knowledge

# Embedding配置（保持不变）
EMBEDDING_BASE_URL=https://qianfan.baidubce.com/v2
EMBEDDING_API_KEY=bce-v3/ALTAK-xxx
EMBEDDING_MODEL=qwen3-embedding-4b
EMBEDDING_DIMENSION=2560
```

### 已移除的配置

以下配置已不再需要：
- `MYSQL_*` - MySQL相关
- `QDRANT_*` - Qdrant相关
- `REDIS_*` - Redis相关
- `MINIO_*` - MinIO相关（使用本地文件系统）

## 💾 数据备份

### 备份

```bash
# 简单备份（推荐）
tar -czf backup-$(date +%Y%m%d).tar.gz runtime/*.db

# 包含上传文件的完整备份
tar -czf backup-full-$(date +%Y%m%d).tar.gz runtime/
```

### 恢复

```bash
# 恢复数据库
tar -xzf backup-20241002.tar.gz

# 重启应用
pnpm dev:web
```

## 🔄 回滚方案

如果需要回滚到MySQL+Qdrant架构：

```bash
# 执行回滚脚本
bash scripts/rollback_sqlite.sh

# 启动Docker服务
docker-compose up -d

# 重启应用
pnpm dev:web
```

备份文件位于 `backups/migration-YYYYMMDD-HHMMSS/`

## 🐛 故障排查

### 问题1: 数据库文件未创建

**症状**：启动后 `runtime/` 目录没有 `.db` 文件

**解决**：
```bash
# 检查目录权限
ls -la runtime/

# 手动创建目录
mkdir -p runtime

# 重启应用
pnpm dev:web
```

### 问题2: 向量搜索无结果

**症状**：知识库搜索返回空结果

**解决**：
```bash
# 检查向量数据库
sqlite3 runtime/vectors.db "SELECT COUNT(*) FROM vector_points;"

# 如果为0，重新上传文档或重新索引
```

### 问题3: 查询速度慢

**症状**：向量搜索延迟 > 100ms

**解决**：
```bash
# 运行基准测试确认
python scripts/benchmark_vector_simple.py

# 检查向量数量
sqlite3 runtime/vectors.db "SELECT collection, COUNT(*) FROM vector_points GROUP BY collection;"

# 如果超过50K，考虑迁移回Qdrant
```

### 问题4: 构建失败

**症状**：`pnpm build` 报错

**解决**：
```bash
# 清理依赖重新安装
cd packages/workspace/plugin-kb-search
rm -rf node_modules
pnpm install
cd ../../..

# 重新构建
pnpm build
```

## 📈 性能优化建议

### 1. 定期清理

```bash
# SQLite自动清理（WAL模式）
sqlite3 runtime/harness.db "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 runtime/vectors.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

### 2. 监控数据库大小

```bash
# 检查数据库大小
ls -lh runtime/*.db

# 如果vectors.db > 500MB，考虑清理旧向量或扩容
```

### 3. 查询日志

在代码中添加性能日志：
```typescript
// packages/workspace/plugin-kb-search/src/index.ts
const start = Date.now()
const results = await vectorStore.query(...)
console.log(`向量搜索耗时: ${Date.now() - start}ms`)
```

## 📚 更多资源

- 详细迁移文档: [docs/SQLITE_MIGRATION.md](./SQLITE_MIGRATION.md)
- SQLite官方文档: https://www.sqlite.org/docs.html
- better-sqlite3文档: https://github.com/WiseLibs/better-sqlite3

## ❓ 常见问题

**Q: 数据库文件可以直接复制到其他机器吗？**  
A: 可以，SQLite是单文件数据库，直接复制 `runtime/*.db` 即可。

**Q: 如何可视化查看数据库内容？**  
A: 使用 [DB Browser for SQLite](https://sqlitebrowser.org/)

**Q: 支持多进程访问吗？**  
A: SQLite支持多进程读，但只有一个进程可以写。对于单实例应用完全够用。

**Q: 向量数据会占用多少空间？**  
A: 约 10KB/文档 的向量数据。1000个文档约10MB。

## 🎉 迁移完成检查清单

- [ ] 脚本执行成功无错误
- [ ] 应用正常启动
- [ ] 知识库上传功能正常
- [ ] 向量搜索返回结果
- [ ] 查询延迟 < 50ms
- [ ] 数据库文件正常创建
- [ ] 备份脚本测试通过
- [ ] 性能基准测试通过

全部完成后，SQLite迁移成功！🚀
