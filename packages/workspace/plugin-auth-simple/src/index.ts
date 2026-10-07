/**
 * 简单用户认证插件
 * 支持用户名快速登录，无密码
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-host-webserver'
import { createHmac, randomUUID } from 'node:crypto'

export const name = 'auth-simple'
export const inject = ['webServer']

export interface Config {
  databasePath: string
  tokenSecret: string
  sessionExpireDays: number
  usernameMinLength: number
  usernameMaxLength: number
  rateLimit: number
}

export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default('./data/harness.db').description('数据库路径'),
  tokenSecret: Schema.string().required().description('Token签名密钥'),
  sessionExpireDays: Schema.number().default(7).description('Session过期天数'),
  usernameMinLength: Schema.number().default(2).description('用户名最小长度'),
  usernameMaxLength: Schema.number().default(20).description('用户名最大长度'),
  rateLimit: Schema.number().default(10).description('每分钟登录限制')
})

interface UserContext {
  userId: string
  username: string
  displayName: string
  role: string
  sessionId: string
}

// 简单的频率限制
const loginAttempts = new Map<string, number[]>()

export function apply(ctx: Context, config: Config) {
  const Database = require('better-sqlite3')
  const db = new Database(config.databasePath)

  // 注册认证API
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/auth',
    async handler(req, res) {
      try {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
        const pathname = requestUrl.pathname

        // POST /api/auth/quick-login - 快速登录/注册
        if (req.method === 'POST' && pathname === '/api/auth/quick-login') {
          const body = await readBody(req)
          const { username } = body

          // 验证用户名
          if (!username || typeof username !== 'string') {
            return sendJson(res, 400, { error: '用户名必填' })
          }

          if (username.length < config.usernameMinLength || username.length > config.usernameMaxLength) {
            return sendJson(res, 400, {
              error: `用户名长度必须在${config.usernameMinLength}-${config.usernameMaxLength}字符之间`
            })
          }

          if (!/^[一-龥a-zA-Z0-9_]+$/.test(username)) {
            return sendJson(res, 400, { error: '用户名只能包含中文、字母、数字和下划线' })
          }

          // 频率限制
          const clientIp = getClientIp(req)
          if (!checkRateLimit(clientIp, config.rateLimit)) {
            return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' })
          }

          // 查询或创建用户
          let user = db.prepare('SELECT * FROM users WHERE username = ? AND status = ?')
            .get(username, 'active')

          const now = Date.now()
          const isNewUser = !user

          if (isNewUser) {
            // 创建新用户
            const userId = `usr_${randomUUID()}`
            db.prepare(`
              INSERT INTO users (id, username, display_name, role, status, login_count, last_login_at, last_login_ip, created_at, updated_at)
              VALUES (?, ?, ?, 'user', 'active', 1, ?, ?, ?, ?)
            `).run(userId, username, username, now, clientIp, now, now)

            user = { id: userId, username, display_name: username, role: 'user' }
            ctx.logger.info(`✅ 新用户注册: ${username} (${userId})`)
          } else {
            // 更新登录信息
            db.prepare(`
              UPDATE users
              SET login_count = login_count + 1, last_login_at = ?, last_login_ip = ?, updated_at = ?
              WHERE id = ?
            `).run(now, clientIp, now, user.id)
            ctx.logger.info(`✅ 用户登录: ${username} (${user.id})`)
          }

          // 创建session
          const sessionId = `ses_${randomUUID()}`
          const expiresAt = now + config.sessionExpireDays * 24 * 60 * 60 * 1000

          db.prepare(`
            INSERT INTO sessions (id, user_id, ip_address, user_agent, created_at, last_access_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(sessionId, user.id, clientIp, req.headers['user-agent'] || '', now, now, expiresAt)

          // 生成token
          const token = generateToken(sessionId, config.tokenSecret)

          return sendJson(res, 200, {
            success: true,
            isNewUser,
            user: {
              id: user.id,
              username: user.username,
              displayName: user.display_name || user.username,
              role: user.role
            },
            token,
            expiresAt
          })
        }

        // GET /api/auth/me - 获取当前用户信息
        if (req.method === 'GET' && pathname === '/api/auth/me') {
          const token = extractToken(req)
          if (!token) {
            return sendJson(res, 401, { error: '未登录' })
          }

          const sessionId = verifyToken(token, config.tokenSecret)
          if (!sessionId) {
            return sendJson(res, 401, { error: 'Token无效' })
          }

          const session = db.prepare(`
            SELECT s.*, u.username, u.display_name, u.role, u.login_count, u.last_login_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.id = ? AND s.expires_at > ?
          `).get(sessionId, Date.now())

          if (!session) {
            return sendJson(res, 401, { error: 'Session已过期' })
          }

          // 更新访问时间
          db.prepare('UPDATE sessions SET last_access_at = ? WHERE id = ?')
            .run(Date.now(), sessionId)

          return sendJson(res, 200, {
            user: {
              id: session.user_id,
              username: session.username,
              displayName: session.display_name || session.username,
              role: session.role,
              loginCount: session.login_count,
              lastLoginAt: session.last_login_at
            }
          })
        }

        // POST /api/auth/logout - 退出登录
        if (req.method === 'POST' && pathname === '/api/auth/logout') {
          const token = extractToken(req)
          if (token) {
            const sessionId = verifyToken(token, config.tokenSecret)
            if (sessionId) {
              db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
              ctx.logger.info(`🔒 用户退出: session ${sessionId}`)
            }
          }
          return sendJson(res, 200, { success: true })
        }

        // PATCH /api/auth/profile - 更新用户信息
        if (req.method === 'PATCH' && pathname === '/api/auth/profile') {
          const token = extractToken(req)
          if (!token) {
            return sendJson(res, 401, { error: '未登录' })
          }

          const sessionId = verifyToken(token, config.tokenSecret)
          if (!sessionId) {
            return sendJson(res, 401, { error: 'Token无效' })
          }

          const session = db.prepare('SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?')
            .get(sessionId, Date.now())

          if (!session) {
            return sendJson(res, 401, { error: 'Session已过期' })
          }

          const body = await readBody(req)
          const { displayName, email } = body

          const updates: string[] = []
          const params: any[] = []

          if (displayName && typeof displayName === 'string') {
            updates.push('display_name = ?')
            params.push(displayName)
          }

          if (email !== undefined) {
            updates.push('email = ?')
            params.push(email)
          }

          if (updates.length > 0) {
            updates.push('updated_at = ?')
            params.push(Date.now())
            params.push(session.user_id)

            db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params)
          }

          const user = db.prepare('SELECT id, username, display_name, email, role FROM users WHERE id = ?')
            .get(session.user_id)

          return sendJson(res, 200, {
            success: true,
            user: {
              id: user.id,
              username: user.username,
              displayName: user.display_name || user.username,
              email: user.email,
              role: user.role
            }
          })
        }

        return sendJson(res, 404, { error: 'Not found' })
      } catch (error) {
        ctx.logger.error('Auth API error:', error)
        return sendJson(res, 500, { error: '服务器错误' })
      }
    }
  }), 'auth-simple: API')

  // 注册认证中间件（注释掉，因为DSH框架的middleware方式不同）
  // 实际的用户上下文注入会在具体业务插件中处理
  // ctx.middleware(async (session, next) => { ... })

  // 定期清理过期session
  const cleanupInterval = setInterval(() => {
    try {
      const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
      if (result.changes > 0) {
        ctx.logger.info(`🧹 清理过期session: ${result.changes}条`)
      }
    } catch (error) {
      ctx.logger.error('Session cleanup error:', error)
    }
  }, 60 * 60 * 1000) // 每小时清理一次

  ctx.effect(() => () => {
    clearInterval(cleanupInterval)
    db.close()
  })
}

// 工具函数
function generateToken(sessionId: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(sessionId)
    .digest('hex')
    .slice(0, 16)

  return `${sessionId}.${signature}`
}

function verifyToken(token: string, secret: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [sessionId, signature] = parts

  const expected = createHmac('sha256', secret)
    .update(sessionId)
    .digest('hex')
    .slice(0, 16)

  return signature === expected ? sessionId : null
}

function extractToken(req: any): string | null {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return null
  return auth.slice(7)
}

function getClientIp(req: any): string {
  return req.headers['x-forwarded-for']?.split(',')[0] ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    'unknown'
}

function checkRateLimit(ip: string, limit: number): boolean {
  const now = Date.now()
  const attempts = loginAttempts.get(ip) || []

  // 过滤掉1分钟前的记录
  const recentAttempts = attempts.filter(time => now - time < 60000)

  if (recentAttempts.length >= limit) {
    return false
  }

  recentAttempts.push(now)
  loginAttempts.set(ip, recentAttempts)

  // 定期清理
  if (Math.random() < 0.01) {
    for (const [key, times] of loginAttempts.entries()) {
      if (times.every(t => now - t > 60000)) {
        loginAttempts.delete(key)
      }
    }
  }

  return true
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString()
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: any, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
