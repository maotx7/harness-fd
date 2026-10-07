import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import Database from 'better-sqlite3'

// 简化的 SqlitePool 类（内嵌）
class SqlitePool {
  private db: Database.Database

  constructor(connectionString: string) {
    const dbPath = connectionString.replace(/^sqlite:\/\/\//, '')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  async execute<T = any>(sql: string, params: any[] = []): Promise<[T[], any]> {
    const sqliteSql = sql.replace(/NOW\(\)/g, Date.now().toString())

    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      const rows = this.db.prepare(sqliteSql).all(...params)
      return [rows as T[], {}]
    }

    if (sql.trim().toUpperCase().startsWith('DELETE')) {
      const result = this.db.prepare(sqliteSql).run(...params)
      return [[] as T[], { affectedRows: result.changes }]
    }

    const result = this.db.prepare(sqliteSql).run(...params)
    return [[] as T[], { affectedRows: result.changes, insertId: result.lastInsertRowid }]
  }

  async end(): Promise<void> {
    this.db.close()
  }
}

export const name = 'workflow-management'
export const inject = ['tools']

export interface Config {
  databasePath: string
}

export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().required().description('SQLite 数据库路径')
})

const toolOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
}

interface CreateProjectArgs {
  _tenantId?: string
  _userId?: string
  workspace_id: string
  name: string
  description?: string
}

interface CreateTaskArgs {
  _tenantId?: string
  _userId?: string
  project_id: string
  title: string
  description?: string
  priority?: 'low' | 'medium' | 'high'
  status?: 'todo' | 'in_progress' | 'done'
}

interface UpdateTaskArgs {
  _tenantId?: string
  _userId?: string
  task_id: string
  title?: string
  description?: string
  priority?: 'low' | 'medium' | 'high'
  status?: 'todo' | 'in_progress' | 'done'
}

export function apply(ctx: Context, config: Config) {
  // 延迟初始化数据库连接
  let db: SqlitePool | null = null

  function getDb() {
    if (!db) {
      ctx.logger.info('Initializing SQLite connection...')
      db = new SqlitePool(`sqlite:///${config.databasePath}`)
    }
    return db
  }

  // 注册创建项目工具
  ctx.tools.register({
    name: 'create_project',
    description: '在工作区中创建新项目',
    output: toolOutput,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区ID'
        },
        name: {
          type: 'string',
          description: '项目名称'
        },
        description: {
          type: 'string',
          description: '项目描述（可选）'
        }
      },
      required: ['workspace_id', 'name']
    },
    async execute(args: CreateProjectArgs, context) {
      const { workspace_id, name, description = '' } = args
      const userId = args._userId || 'system'

      // 验证 workspace 存在
      const [workspaces] = await getDb().execute<any[]>(
        'SELECT id FROM workspaces WHERE id = ?',
        [workspace_id]
      )

      if (!workspaces || workspaces.length === 0) {
        throw new Error('Workspace not found')
      }

      // 创建项目
      const projectId = generateUUID()
      const now = Date.now()
      await getDb().execute(
        `INSERT INTO projects (id, workspace_id, name, description, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [projectId, workspace_id, name, description, userId, now, now]
      )

      return {
        project_id: projectId,
        name,
        workspace_id,
        status: 'created'
      }
    }
  })

  // 注册列出项目工具
  ctx.tools.register({
    name: 'list_projects',
    description: '列出工作区的所有项目',
    output: toolOutput,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区ID'
        }
      },
      required: ['workspace_id']
    },
    async execute(args: { _tenantId?: string; workspace_id: string }, context) {
      const { workspace_id } = args

      // 验证 workspace 存在
      const [workspaces] = await getDb().execute<any[]>(
        'SELECT id FROM workspaces WHERE id = ?',
        [workspace_id]
      )

      if (!workspaces || workspaces.length === 0) {
        throw new Error('Workspace not found')
      }

      // 查询项目列表（包含任务数统计）
      const [projects] = await getDb().execute<any[]>(
        `SELECT p.id, p.name, p.description, p.created_at, p.created_by,
                COUNT(t.id) as task_count
         FROM projects p
         LEFT JOIN tasks t ON p.id = t.project_id
         WHERE p.workspace_id = ?
         GROUP BY p.id, p.name, p.description, p.created_at, p.created_by
         ORDER BY p.created_at DESC`,
        [workspace_id]
      )

      return {
        workspace_id,
        projects: projects.map((p: any) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          task_count: p.task_count || 0,
          created_at: p.created_at,
          created_by: p.created_by
        }))
      }
    }
  })

  // 注册创建任务工具
  ctx.tools.register({
    name: 'create_task',
    description: '在项目中创建新任务',
    output: toolOutput,
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '项目ID'
        },
        title: {
          type: 'string',
          description: '任务标题'
        },
        description: {
          type: 'string',
          description: '任务描述（可选）'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '优先级（可选，默认 medium）'
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done'],
          description: '状态（可选，默认 todo）'
        }
      },
      required: ['project_id', 'title']
    },
    async execute(args: CreateTaskArgs, context) {
      const {
        project_id,
        title,
        description = '',
        priority = 'medium',
        status = 'todo'
      } = args
      const userId = args._userId || 'system'

      // 验证项目存在
      const [projects] = await getDb().execute<any[]>(
        'SELECT id FROM projects WHERE id = ?',
        [project_id]
      )

      if (!projects || projects.length === 0) {
        throw new Error('Project not found')
      }

      // 创建任务
      const taskId = generateUUID()
      const now = Date.now()
      await getDb().execute(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [taskId, project_id, title, description, priority, status, userId, now, now]
      )

      return {
        task_id: taskId,
        project_id,
        title,
        priority,
        status,
        created: true
      }
    }
  })

  // 注册更新任务工具
  ctx.tools.register({
    name: 'update_task',
    description: '更新任务信息',
    output: toolOutput,
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '任务ID'
        },
        title: {
          type: 'string',
          description: '新标题（可选）'
        },
        description: {
          type: 'string',
          description: '新描述（可选）'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '新优先级（可选）'
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done'],
          description: '新状态（可选）'
        }
      },
      required: ['task_id']
    },
    async execute(args: UpdateTaskArgs, context) {
      const { task_id, ...updates } = args

      // 验证任务存在
      const [tasks] = await getDb().execute<any[]>(
        'SELECT id FROM tasks WHERE id = ?',
        [task_id]
      )

      if (!tasks || tasks.length === 0) {
        throw new Error('Task not found')
      }

      // 构建更新语句
      const updateFields: string[] = []
      const updateValues: any[] = []

      if (updates.title !== undefined) {
        updateFields.push('title = ?')
        updateValues.push(updates.title)
      }
      if (updates.description !== undefined) {
        updateFields.push('description = ?')
        updateValues.push(updates.description)
      }
      if (updates.priority !== undefined) {
        updateFields.push('priority = ?')
        updateValues.push(updates.priority)
      }
      if (updates.status !== undefined) {
        updateFields.push('status = ?')
        updateValues.push(updates.status)
      }

      if (updateFields.length === 0) {
        throw new Error('No fields to update')
      }

      updateFields.push('updated_at = ?')
      updateValues.push(Date.now())
      updateValues.push(task_id)

      // 执行更新
      await getDb().execute(
        `UPDATE tasks SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      )

      return {
        task_id,
        updated: true,
        fields: Object.keys(updates)
      }
    }
  })

  // 注册列出任务工具
  ctx.tools.register({
    name: 'list_tasks',
    description: '列出项目的所有任务',
    output: toolOutput,
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '项目ID'
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done'],
          description: '按状态过滤（可选）'
        }
      },
      required: ['project_id']
    },
    async execute(args: { _tenantId?: string; project_id: string; status?: string }, context) {
      const { project_id, status } = args

      // 验证项目存在
      const [projects] = await getDb().execute<any[]>(
        'SELECT id FROM projects WHERE id = ?',
        [project_id]
      )

      if (!projects || projects.length === 0) {
        throw new Error('Project not found')
      }

      // 查询任务列表
      let query = `SELECT id, title, description, priority, status, created_at, created_by, updated_at
                   FROM tasks
                   WHERE project_id = ?`
      const params: any[] = [project_id]

      if (status) {
        query += ' AND status = ?'
        params.push(status)
      }

      query += ' ORDER BY created_at DESC'

      const [tasks] = await getDb().execute<any[]>(query, params)

      return {
        project_id,
        filter: status ? { status } : {},
        tasks: tasks.map((t: any) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          priority: t.priority,
          status: t.status,
          created_at: t.created_at,
          created_by: t.created_by,
          updated_at: t.updated_at
        }))
      }
    }
  })

  // 清理资源
  ctx.effect(() => async () => {
    if (db) await db.end()
  })
}

// 辅助函数：生成 UUID
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
