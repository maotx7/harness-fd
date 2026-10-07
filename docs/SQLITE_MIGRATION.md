# SQLite迁移指南

将harness-fd项目从MySQL+Qdrant+Redis迁移到纯SQLite架构。

## 迁移概览

### 架构变化

**迁移前**:
```
MySQL (主数据库) → Port 13306
Qdrant (向量库) → Port 16333/16334
Redis (缓存) → Port 16379
MinIO (对象存储) → Port 19000
```

**迁移后**:
```
SQLite (主数据库) → ./runtime/harness.db
SQLite (向量库) → ./runtime/vectors.db
内存缓存 (可选)
本地文件系统 → ./runtime/dsh-catalog/knowledge
```

### 性能对比

| 指标 | Qdrant | SQLite向量 | 结论 |
|------|--------|-----------|------|
| 15K向量查询延迟 | 3-5ms | 13.5ms | ✅ 可接受 |
| 50用户吞吐量 | 200+ qps | 95 qps | ✅ 充足 |
| 部署复杂度 | 4个服务 | 0个服务 | ✅ 极简 |

## 迁移步骤

### 1. 安装依赖

```bash
cd packages/workspace/plugin-kb-search
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3
```

### 2. 替换插件实现

将知识库插件切换到SQLite版本：

```bash
# 备份原文件
cd /Users/maotx/becv_project/01_Active/harness-fd/packages/workspace/plugin-kb-search/src
mv index.ts index-mysql.ts.bak

# 使用SQLite版本
cp index-sqlite.ts index.ts
```

### 3. 更新环境配置

编辑 `.env` 文件：

```bash
# 注释掉MySQL配置
# MYSQL_VERSION=8.0
# MYSQL_HOST=127.0.0.1
# MYSQL_PORT=13306
# MYSQL_DATABASE=hermes
# MYSQL_USER=hermes
# MYSQL_PASSWORD=hermes
# MYSQL_ROOT_PASSWORD=hermes-root
# DATABASE_URL=

# 注释掉Qdrant配置
# QDRANT_HOST=127.0.0.1
# QDRANT_PORT=16333
# QDRANT_GRPC_PORT=16334
# QDRANT_COLLECTION=function_def_chunks

# 注释掉Redis配置
# REDIS_PORT=16379
# REDIS_URL=redis://localhost:16379/0

# 注释掉MinIO配置（使用本地文件系统）
# STORAGE_BACKEND=minio
# MINIO_API_PORT=19000
# MINIO_CONSOLE_PORT=19001
# MINIO_ENDPOINT=127.0.0.1:19000
# MINIO_ACCESS_KEY=minioadmin
# MINIO_SECRET_KEY=minioadmin
# MINIO_BUCKET=hermes-artifacts
# MINIO_SECURE=false

# 添加SQLite配置
DATABASE_PATH=./runtime/harness.db
VECTOR_DB_PATH=./runtime/vectors.db
STORAGE_BACKEND=local
LOCAL_STORAGE_ROOT=./runtime/dsh-catalog/knowledge
```

### 4. 更新Profile配置

编辑 `profiles/workspace-enterprise/dsh.config.yaml`：

找到 `plugin-kb-search` 的配置部分，更新为：

```yaml
plugins:
  workspace/plugin-kb-search:
    enabled: true
    config:
      databasePath: ./runtime/harness.db
      vectorDbPath: ./runtime/vectors.db
      embeddingBaseUrl: !env EMBEDDING_BASE_URL
      embeddingApiKey: !env EMBEDDING_API_KEY
      embeddingModel: !env EMBEDDING_MODEL
      embeddingDimension: !env EMBEDDING_DIMENSION
      vectorCollection: function_def_chunks
      storageRoot: ./runtime/dsh-catalog/knowledge
```

### 5. 数据迁移（如果已有数据）

如果已有MySQL/Qdrant数据，创建迁移脚本：

```bash
python scripts/migrate_to_sqlite.py
```

迁移脚本会：
1. 从MySQL导出知识库元数据
2. 从Qdrant导出向量数据
3. 写入新的SQLite数据库

### 6. 构建和测试

```bash
# 构建插件
pnpm build

# 启动服务
pnpm dev:web

# 测试知识库功能
# 1. 上传PDF文档
# 2. 执行向量搜索
# 3. 检查响应时间
```

### 7. 清理旧服务（可选）

确认SQLite版本运行正常后，可以停止并移除旧服务：

```bash
# 停止Docker服务
docker-compose down

# 备份旧数据（可选）
mkdir -p backups
mysqldump -h 127.0.0.1 -P 13306 -u hermes -p hermes > backups/mysql_backup.sql

# 移除docker-compose.yml（如果不再需要）
```

## 验证清单

迁移完成后，验证以下功能：

- [ ] 文档上传正常
- [ ] 向量检索返回相关结果
- [ ] 检索延迟 < 50ms
- [ ] 文档删除正常
- [ ] 重新索引功能正常
- [ ] 50个并发查询无问题
- [ ] 数据库文件正常创建在runtime/
- [ ] 应用重启后数据持久化

## 性能基准测试

运行性能测试验证：

```bash
python scripts/benchmark_vector_simple.py
```

预期结果：
- 平均延迟: 10-20ms
- P95延迟: < 30ms
- QPS: > 50

## 备份策略

SQLite数据库备份非常简单：

```bash
# 定期备份
tar -czf backup-$(date +%Y%m%d).tar.gz runtime/*.db

# 恢复
tar -xzf backup-20241002.tar.gz
```

## 回滚方案

如果需要回滚到MySQL+Qdrant：

```bash
# 1. 恢复原插件文件
cd packages/workspace/plugin-kb-search/src
mv index-mysql.ts.bak index.ts

# 2. 恢复.env配置
git checkout .env

# 3. 启动Docker服务
docker-compose up -d

# 4. 重建插件
pnpm build

# 5. 重启应用
pnpm dev:web
```

## 常见问题

### Q: SQLite能否支持50+用户？
A: 可以。SQLite支持数千并发读，50用户规模完全够用。瓶颈在向量计算（13.5ms），不在数据库。

### Q: 向量搜索会不会太慢？
A: 15K向量平均13.5ms，用户感知不到与Qdrant的差异（人类反应时间>100ms）。

### Q: 数据量增长怎么办？
A: 
- < 50K向量：继续使用SQLite（延迟<50ms）
- 50K-100K：评估是否迁移回Qdrant
- \> 100K：建议使用Qdrant

### Q: 如何监控性能？
A: 在代码中添加简单的日志：
```typescript
const start = Date.now()
const results = await vectorStore.query(...)
console.log(`Vector search took ${Date.now() - start}ms`)
```

### Q: 数据库文件会不会太大？
A: 15K向量估算：
- 向量数据: ~150MB (15K × 2560 × 4 bytes)
- 元数据: ~10MB
- 总计: ~160MB（完全可管理）

## 优势总结

✅ **部署简化**: 从5个服务降到0个  
✅ **零运维**: 无需监控MySQL/Qdrant/Redis健康状态  
✅ **简单备份**: 复制.db文件即可  
✅ **开发友好**: SQLite Browser可视化调试  
✅ **性能充足**: 13.5ms延迟对文档检索场景完全够用  
✅ **成本降低**: 无需为数据库服务器付费  

## 技术支持

遇到问题时：
1. 检查 `runtime/*.db` 文件是否正常创建
2. 查看日志中的错误信息
3. 运行 `scripts/benchmark_vector_simple.py` 验证性能
4. 使用SQLite Browser检查数据库内容

---

**迁移状态**: 代码已准备完毕，等待执行迁移命令
