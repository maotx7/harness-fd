import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import mysql from 'mysql2/promise'

export const name = 'workflow-management'
export const inject = ['tools']

export interface Config {
  mysqlUrl: string
}

export const Config: Schema<Config> = Schema.object({
  mysqlUrl: Schema.string().required().description('MySQL 连接字符串')
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
  let db: mysql.Pool | null = null

  function getDb() {
    if (!db) {
      ctx.logger.info('Initializing MySQL connection pool...')
      db = mysql.createPool(config.mysqlUrl)
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
      const { _tenantId, _userId, workspace_id, name, description = '' } = args

      if (!_tenantId || !_userId) {
        throw new Error('Authentication context missing')
      }

      // 验证 workspace 权限
      const [workspaces] = await getDb().execute<any[]>(
        'SELECT id FROM workspaces WHERE id = ? AND tenant_id = ?',
        [workspace_id, _tenantId]
      )

      if (!workspaces || workspaces.length === 0) {
        throw new Error('Workspace not found or access denied')
      }

      // 创建项目
      const projectId = generateUUID()
      await getDb().execute(
        `INSERT INTO projects (id, workspace_id, name, description, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [projectId, workspace_id, name, description, _userId]
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
      const { _tenantId, workspace_id } = args

      if (!_tenantId) {
        throw new Error('Tenant context missing')
      }

      // 验证 workspace 权限
      const [workspaces] = await getDb().execute<any[]>(
        'SELECT id FROM workspaces WHERE id = ? AND tenant_id = ?',
        [workspace_id, _tenantId]
      )

      if (!workspaces || workspaces.length === 0) {
        throw new Error('Workspace not found or access denied')
      }

      // 查询项目列表
      const [projects] = await getDb().execute<any[]>(
        `SELECT p.id, p.name, p.description, p.created_at, p.created_by,
                COUNT(t.id) as task_count
         FROM projects p
         LEFT JOIN tasks t ON p.id = t.project_id
         WHERE p.workspace_id = ?
         GROUP BY p.id
         ORDER BY p.created_at DESC`,
        [workspace_id]
      )

      return {
        workspace_id,
        projects: projects.map((p: any) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          task_count: p.task_count,
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
        _tenantId,
        _userId,
        project_id,
        title,
        description = '',
        priority = 'medium',
        status = 'todo'
      } = args

      if (!_tenantId || !_userId) {
        throw new Error('Authentication context missing')
      }

      // 验证项目归属（通过 workspace 的租户隔离）
      const [projects] = await getDb().execute<any[]>(
        `SELECT p.id FROM projects p
         JOIN workspaces w ON p.workspace_id = w.id
         WHERE p.id = ? AND w.tenant_id = ?`,
        [project_id, _tenantId]
      )

      if (!projects || projects.length === 0) {
        throw new Error('Project not found or access denied')
      }

      // 创建任务
      const taskId = generateUUID()
      await getDb().execute(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [taskId, project_id, title, description, priority, status, _userId]
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
      const { _tenantId, _userId, task_id, ...updates } = args

      if (!_tenantId || !_userId) {
        throw new Error('Authentication context missing')
      }

      // 验证任务归属
      const [tasks] = await getDb().execute<any[]>(
        `SELECT t.id FROM tasks t
         JOIN projects p ON t.project_id = p.id
         JOIN workspaces w ON p.workspace_id = w.id
         WHERE t.id = ? AND w.tenant_id = ?`,
        [task_id, _tenantId]
      )

      if (!tasks || tasks.length === 0) {
        throw new Error('Task not found or access denied')
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

      updateFields.push('updated_at = NOW()')
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
      const { _tenantId, project_id, status } = args

      if (!_tenantId) {
        throw new Error('Tenant context missing')
      }

      // 验证项目归属
      const [projects] = await getDb().execute<any[]>(
        `SELECT p.id FROM projects p
         JOIN workspaces w ON p.workspace_id = w.id
         WHERE p.id = ? AND w.tenant_id = ?`,
        [project_id, _tenantId]
      )

      if (!projects || projects.length === 0) {
        throw new Error('Project not found or access denied')
      }

      // 查询任务列表
      let query = `SELECT id, title, description, priority, status, created_at, created_by
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
          created_by: t.created_by
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
