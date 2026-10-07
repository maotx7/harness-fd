import { Context } from '@deepseek-ai/cordis'

interface SqlitePool {
  execute<T = any>(sql: string, params: any[]): Promise<[T[], any]>
}

interface Dependencies { db: () => SqlitePool }

interface ScopeArgs {
  workspace_id: string
  project_code: string
  network_name?: string
  owner_node?: string
}

interface MatrixArgs { workspace_id: string; matrix_id: string }

const output = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
}

export function registerSignalTools(ctx: Context, dependencies: Dependencies) {
  ctx.tools.register({
    name: 'get_latest_signal_matrix',
    description: '获取指定项目、网段和控制器最新的信号矩阵版本',
    output,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        project_code: { type: 'string' },
        network_name: { type: 'string' },
        owner_node: { type: 'string' }
      },
      required: ['workspace_id', 'project_code', 'network_name', 'owner_node']
    },
    async execute(args: ScopeArgs) {
      validateScope(args)
      const [rows] = await dependencies.db().execute<any>(
        `SELECT id AS matrix_id, version_label AS matrix_version, status, workspace_id,
                project_code, network_name, owner_node, released_at, message_count, signal_count
         FROM kb_signal_matrices
         WHERE workspace_id = ? AND project_code = ? AND network_name = ? AND owner_node = ?
         ORDER BY created_at DESC LIMIT 1`,
        [args.workspace_id, args.project_code, args.network_name, args.owner_node]
      )
      if (!rows.length) throw new Error('SIGNAL_MATRIX_NOT_FOUND: 没有匹配的信号矩阵')
      return rows[0]
    }
  })

  ctx.tools.register({
    name: 'list_signal_projects',
    description: '列出工作区内所有信号矩阵的项目和网段',
    output,
    parameters: {
      type: 'object',
      properties: { workspace_id: { type: 'string' } },
      required: ['workspace_id']
    },
    async execute(args: { workspace_id: string }) {
      requireText(args.workspace_id, 'workspace_id', 128)
      const [rows] = await dependencies.db().execute<any>(
        `SELECT project_code, network_name, owner_node, COUNT(*) as count
         FROM kb_signal_matrices
         WHERE workspace_id = ?
         GROUP BY project_code, network_name, owner_node
         ORDER BY project_code, network_name, owner_node`,
        [args.workspace_id]
      )
      const projects = new Map<string, Array<{ network_name: string; owner_node: string }>>()
      for (const row of rows) {
        const scopes = projects.get(row.project_code) || []
        scopes.push({ network_name: row.network_name, owner_node: row.owner_node })
        projects.set(row.project_code, scopes)
      }
      return {
        workspace_id: args.workspace_id,
        projects: [...projects.entries()].map(([project_code, scopes]) => ({
          project_code,
          matrix_count: scopes.length,
          scopes
        }))
      }
    }
  })

  ctx.tools.register({
    name: 'get_signal_project_snapshot',
    description: '列出项目当前所有网段矩阵，形成信号基线快照',
    output,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        project_code: { type: 'string' }
      },
      required: ['workspace_id', 'project_code']
    },
    async execute(args: ScopeArgs) {
      requireText(args.workspace_id, 'workspace_id', 128)
      requireText(args.project_code, 'project_code', 128)
      const [rows] = await dependencies.db().execute<any>(
        `SELECT id AS matrix_id, version_label AS matrix_version, network_name, owner_node,
                status, released_at, message_count, signal_count
         FROM kb_signal_matrices
         WHERE workspace_id = ? AND project_code = ?
         ORDER BY network_name, owner_node`,
        [args.workspace_id, args.project_code]
      )
      return {
        workspace_id: args.workspace_id,
        project_code: args.project_code,
        matrices: rows
      }
    }
  })

  ctx.tools.register({
    name: 'get_signal_matrix_info',
    description: '获取信号矩阵的详细信息',
    output,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        matrix_id: { type: 'string' }
      },
      required: ['workspace_id', 'matrix_id']
    },
    async execute(args: MatrixArgs) {
      requireText(args.workspace_id, 'workspace_id', 128)
      requireText(args.matrix_id, 'matrix_id', 128)
      const [rows] = await dependencies.db().execute<any>(
        `SELECT id AS matrix_id, version_label AS matrix_version,
                project_code, network_name, owner_node, status,
                released_at, message_count, signal_count,
                source_filename, node_names, validation_report
         FROM kb_signal_matrices
         WHERE workspace_id = ? AND id = ?
         LIMIT 1`,
        [args.workspace_id, args.matrix_id]
      )
      if (!rows.length) throw new Error('SIGNAL_MATRIX_NOT_FOUND: 矩阵不存在')
      const matrix = rows[0]
      // 解析 JSON 字段
      if (matrix.node_names) {
        try {
          matrix.node_names = JSON.parse(matrix.node_names)
        } catch {}
      }
      if (matrix.validation_report) {
        try {
          matrix.validation_report = JSON.parse(matrix.validation_report)
        } catch {}
      }
      return matrix
    }
  })
}

function validateScope(args: ScopeArgs) {
  requireText(args.workspace_id, 'workspace_id', 128)
  requireText(args.project_code, 'project_code', 128)
  if (args.network_name) requireText(args.network_name, 'network_name', 128)
  if (args.owner_node) requireText(args.owner_node, 'owner_node', 128)
}

function requireText(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} 必须是 1-${max} 字符的字符串`)
  }
}
