import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import { createHmac } from 'crypto'

export const name = 'enterprise-auth'

const { verify } = jwt

export interface Config {
  jwtSecret: string
  mysqlUrl: string
  userDataRoot: string
  signatureSecret: string
}

export const Config: Schema<Config> = Schema.object({
  jwtSecret: Schema.string().required().description('JWT 验证密钥'),
  mysqlUrl: Schema.string().required().description('MySQL 连接字符串'),
  userDataRoot: Schema.string().required().description('用户数据根目录'),
  signatureSecret: Schema.string().required().description('Session 元数据签名密钥')
})

interface JWTPayload {
  sub: string       // user_id
  tenant: string    // tenant_id
  username: string
}

interface UserRecord {
  user_id: string
  tenant_id: string
  username: string
}

export function apply(ctx: Context, config: Config) {
  // 延迟初始化数据库连接，只在首次使用时创建
  let db: mysql.Pool | null = null

  function getDb() {
    if (!db) {
      ctx.logger.info('Initializing MySQL connection pool...')
      db = mysql.createPool(config.mysqlUrl)
    }
    return db
  }

  // 辅助函数：生成 Session 元数据签名
  function signMetadata(userId: string, tenantId: string): string {
    return createHmac('sha256', config.signatureSecret)
      .update(`${userId}:${tenantId}`)
      .digest('hex')
  }

  // 辅助函数：验证 Session 元数据签名
  function verifyMetadataSignature(
    userId: string,
    tenantId: string,
    signature: string
  ): boolean {
    const expected = signMetadata(userId, tenantId)
    return expected === signature
  }

  // 1. 拦截 Session 创建，验证 JWT 并绑定用户上下文
  ctx.on('session/created', async (session) => {
    try {
      // 从 WebSocket 连接的查询参数或 Header 获取 Token
      const token = session.metadata.authorization || session.metadata.token

      if (!token) {
        ctx.logger.error('Authentication failed: Missing token')
        throw new Error('Missing authentication token')
      }

      // 验证 JWT
      const payload = verify(token, config.jwtSecret) as JWTPayload

      if (!payload.sub || !payload.tenant) {
        throw new Error('Invalid token payload')
      }

      // 查询用户信息（租户隔离）
      const [rows] = await getDb().execute<any[]>(
        'SELECT user_id, tenant_id, username FROM users WHERE user_id = ? AND tenant_id = ?',
        [payload.sub, payload.tenant]
      )

      if (!rows || rows.length === 0) {
        throw new Error('User not found or tenant mismatch')
      }

      const user = rows[0] as UserRecord

      // 生成签名
      const signature = signMetadata(user.user_id, user.tenant_id)

      // 绑定用户上下文到 Session metadata
      session.metadata.userId = user.user_id
      session.metadata.tenantId = user.tenant_id
      session.metadata.username = user.username
      session.metadata._signature = signature

      // 动态设置该用户的 DSH_HOME 路径
      session.metadata.dshHome = `${config.userDataRoot}/${user.user_id}`

      ctx.logger.info(`Session created for user ${user.username} (${user.user_id})`)

    } catch (error) {
      ctx.logger.error('Authentication failed:', error)
      // 关闭未认证的 Session
      await session.dispose()
      throw error
    }
  })

  // 2. 工具调用前自动注入租户上下文（全局拦截器）
  ctx.on('tools/pre-execute', async (event, next) => {
    const { tool, args, context } = event

    // 从 Session 获取租户信息并验证签名
    const { userId, tenantId, _signature } = context.session.metadata

    if (!userId || !tenantId || !_signature) {
      throw new Error('Session not authenticated')
    }

    // 验证签名防止篡改
    if (!verifyMetadataSignature(userId, tenantId, _signature)) {
      ctx.logger.error('Session metadata signature verification failed')
      throw new Error('Session metadata tampered')
    }

    // 自动注入到所有需要租户隔离的工具调用
    if (
      tool.name.startsWith('search_') ||
      tool.name.startsWith('upload_') ||
      tool.name.startsWith('query_') ||
      tool.name.startsWith('create_') ||
      tool.name.startsWith('update_') ||
      tool.name.startsWith('delete_') ||
      tool.name.startsWith('list_')
    ) {
      event.args = {
        ...args,
        _tenantId: tenantId,  // 内部参数，不暴露给模型
        _userId: userId
      }
    }

    return next()
  })

  // 3. 清理资源
  ctx.effect(() => async () => {
    if (db) await db.end()
  })
}
