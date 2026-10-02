import { Context } from '@deepseek-ai/cordis'
import type mysql from 'mysql2/promise'

interface Dependencies { db: () => mysql.Pool }

interface ScopeArgs {
  workspace_id: string
  project_code: string
  network_name?: string
  owner_node?: string
}

interface MatrixArgs { workspace_id: string; matrix_id: string }
interface SearchArgs extends MatrixArgs {
  query: string
  target_controller?: string
  direction?: 'TX' | 'RX'
  top_k?: number
}
interface ValidateArgs extends MatrixArgs { signal_names: string[] }

const output = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
}

export function registerSignalTools(ctx: Context, dependencies: Dependencies) {
  ctx.tools.register({
    name: 'get_latest_signal_matrix',
    description: '绑定指定项目、网段和控制器最新发布的权威信号矩阵版本',
    output,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' }, project_code: { type: 'string' },
        network_name: { type: 'string' }, owner_node: { type: 'string' }
      },
      required: ['workspace_id', 'project_code', 'network_name', 'owner_node']
    },
    async execute(args: ScopeArgs) {
      validateScope(args)
      const [rows] = await dependencies.db().execute<mysql.RowDataPacket[]>(
        `SELECT id AS matrix_id, version_label AS matrix_version, status, workspace_id,
                project_code, network_name, owner_node, released_at, message_count, signal_count
         FROM kb_signal_matrices
         WHERE workspace_id = ? AND project_code = ? AND network_name = ? AND owner_node = ?
           AND status = 'ACTIVE'
         ORDER BY released_at DESC, created_at DESC LIMIT 1`,
        [args.workspace_id, args.project_code, args.network_name, args.owner_node]
      )
      if (!rows.length) throw new Error('SIGNAL_MATRIX_NOT_FOUND: 没有匹配的 ACTIVE 信号矩阵')
      return rows[0]
    }
  })

  ctx.tools.register({
    name: 'list_signal_projects',
    description: '列出工作区内拥有 ACTIVE 权威信号矩阵的项目和网段范围',
    output,
    parameters: {
      type: 'object', properties: { workspace_id: { type: 'string' } }, required: ['workspace_id']
    },
    async execute(args: { workspace_id: string }) {
      requireText(args.workspace_id, 'workspace_id', 128)
      const [rows] = await dependencies.db().execute<mysql.RowDataPacket[]>(
        `SELECT project_code, network_name, owner_node
         FROM kb_signal_matrices WHERE workspace_id = ? AND status = 'ACTIVE'
         ORDER BY project_code, network_name, owner_node`, [args.workspace_id]
      )
      const projects = new Map<string, Array<{ network_name: string; owner_node: string }>>()
      for (const row of rows) {
        const scopes = projects.get(row.project_code) || []
        scopes.push({ network_name: row.network_name, owner_node: row.owner_node })
        projects.set(row.project_code, scopes)
      }
      return {
        workspace_id: args.workspace_id,
        projects: [...projects.entries()].map(([project_code, scopes]) => ({ project_code, matrix_count: scopes.length, scopes }))
      }
    }
  })

  ctx.tools.register({
    name: 'get_signal_project_snapshot',
    description: '列出项目当前所有 ACTIVE 网段矩阵，形成任务级不可变信号基线',
    output,
    parameters: {
      type: 'object',
      properties: { workspace_id: { type: 'string' }, project_code: { type: 'string' } },
      required: ['workspace_id', 'project_code']
    },
    async execute(args: ScopeArgs) {
      requireText(args.workspace_id, 'workspace_id', 128)
      requireText(args.project_code, 'project_code', 128)
      const [rows] = await dependencies.db().execute<mysql.RowDataPacket[]>(
        `SELECT id AS matrix_id, version_label AS matrix_version, network_name, owner_node,
                status, released_at, message_count, signal_count
         FROM kb_signal_matrices
         WHERE workspace_id = ? AND project_code = ? AND status = 'ACTIVE'
         ORDER BY network_name, owner_node`, [args.workspace_id, args.project_code]
      )
      return { workspace_id: args.workspace_id, project_code: args.project_code, matrices: rows }
    }
  })

  ctx.tools.register({
    name: 'search_authoritative_signals',
    description: '在固定的已发布矩阵版本中按语义、控制器和收发方向搜索权威信号',
    output,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' }, matrix_id: { type: 'string' }, query: { type: 'string' },
        target_controller: { type: 'string' }, direction: { type: 'string', enum: ['TX', 'RX'] },
        top_k: { type: 'number', default: 10 }
      },
      required: ['workspace_id', 'matrix_id', 'query']
    },
    async execute(args: SearchArgs) {
      requireText(args.query, 'query', 1000)
      const topK = bounded(args.top_k ?? 10, 1, 100, 'top_k')
      const matrix = await loadPublishedMatrix(dependencies.db(), args)
      const signals = await loadSignals(dependencies.db(), args.matrix_id)
      const terms = semanticTerms(args.query)
      const controller = args.target_controller?.toUpperCase()
      const direction = args.direction
      const matches = signals.flatMap(signal => {
        const haystack = [signal.signal_name, signal.chinese_description, signal.english_description,
          signal.message_name, signal.value_description, signal.explanation].join(' ').toLowerCase()
        if (!terms.every(term => haystack.includes(term.toLowerCase()))) return []
        if (controller && !hasEndpoint(signal, controller, direction)) return []
        const exact = haystack.includes(args.query.toLowerCase()) ? 1 : 0
        const score = exact + terms.filter(term => haystack.includes(term.toLowerCase())).length / Math.max(terms.length, 1)
        return [{ ...signal, score }]
      }).sort((left, right) => right.score - left.score || String(left.signal_name).localeCompare(String(right.signal_name)))
      const unique = matches.length === 1
      return {
        matrix_id: matrix.matrix_id, matrix_version: matrix.matrix_version,
        project_code: matrix.project_code, network_name: matrix.network_name, owner_node: matrix.owner_node,
        hits: matches.slice(0, topK).map(hit => ({ ...hit, status: unique ? 'MATCHED' : 'REVIEW' })),
        searched_at: new Date().toISOString()
      }
    }
  })

  ctx.tools.register({
    name: 'validate_authoritative_signals',
    description: '在固定矩阵版本中精确校验信号名，按输入顺序返回 resolved 和 unresolved',
    output,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' }, matrix_id: { type: 'string' },
        signal_names: { type: 'array', items: { type: 'string' } }
      },
      required: ['workspace_id', 'matrix_id', 'signal_names']
    },
    async execute(args: ValidateArgs) {
      if (!Array.isArray(args.signal_names) || !args.signal_names.length || args.signal_names.length > 200) {
        throw new Error('signal_names 必须包含 1-200 个名称')
      }
      const names = [...new Set(args.signal_names.map(name => {
        requireText(name, 'signal_name', 255)
        return name.trim()
      }))]
      const matrix = await loadPublishedMatrix(dependencies.db(), args)
      const placeholders = names.map(() => '?').join(',')
      const [rows] = await dependencies.db().execute<mysql.RowDataPacket[]>(
        `SELECT s.id AS signal_id, s.name AS signal_name, s.chinese_description,
                m.name AS message_name, m.can_id, s.value_description, s.source_sheet, s.source_row
         FROM kb_authoritative_signals s JOIN kb_signal_messages m ON m.id = s.message_id
         WHERE s.matrix_id = ? AND s.name IN (${placeholders})`, [args.matrix_id, ...names]
      )
      const byName = new Map(rows.map(row => [String(row.signal_name), row]))
      const resolved = names.filter(name => byName.has(name)).map(name => byName.get(name))
      return {
        matrix_id: matrix.matrix_id, matrix_version: matrix.matrix_version,
        project_code: matrix.project_code, network_name: matrix.network_name, owner_node: matrix.owner_node,
        resolved, unresolved: names.filter(name => !byName.has(name))
      }
    }
  })
}

async function loadPublishedMatrix(db: mysql.Pool, args: MatrixArgs) {
  requireText(args.workspace_id, 'workspace_id', 128)
  requireText(args.matrix_id, 'matrix_id', 128)
  const [rows] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT id AS matrix_id, version_label AS matrix_version, project_code, network_name, owner_node, status
     FROM kb_signal_matrices WHERE workspace_id = ? AND id = ? AND status IN ('ACTIVE', 'SUPERSEDED') LIMIT 1`,
    [args.workspace_id, args.matrix_id]
  )
  if (!rows.length) throw new Error('SIGNAL_QUERY_INVALID: 矩阵不存在或尚未发布')
  return rows[0]
}

async function loadSignals(db: mysql.Pool, matrixId: string): Promise<any[]> {
  const [rows] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT s.id AS signal_id, s.name AS signal_name, s.chinese_description, s.english_description,
            s.explanation, m.name AS message_name, m.can_id, s.value_description,
            s.source_sheet, s.source_row,
            GROUP_CONCAT(DISTINCT CONCAT(se.controller_name, ':', se.direction) SEPARATOR ',') AS signal_endpoints,
            GROUP_CONCAT(DISTINCT CONCAT(me.controller_name, ':', me.direction) SEPARATOR ',') AS message_endpoints,
            GROUP_CONCAT(DISTINCT CONCAT(sv.code, '=', sv.description) ORDER BY sv.display_order SEPARATOR '; ') AS catalog_values
     FROM kb_authoritative_signals s
     JOIN kb_signal_messages m ON m.id = s.message_id
     LEFT JOIN kb_signal_endpoints se ON se.signal_id = s.id
     LEFT JOIN kb_signal_message_endpoints me ON me.message_id = m.id
     LEFT JOIN kb_signal_values sv ON sv.signal_id = s.id
     WHERE s.matrix_id = ?
     GROUP BY s.id, s.name, s.chinese_description, s.english_description, s.explanation,
              m.name, m.can_id, s.value_description, s.source_sheet, s.source_row`, [matrixId]
  )
  return rows.map(row => ({
    ...row,
    value_description: row.catalog_values || row.value_description,
    signal_endpoints: split(row.signal_endpoints),
    message_endpoints: split(row.message_endpoints)
  }))
}

function semanticTerms(query: string) {
  const compact = query.replace(/\s+/g, '')
  const markers = /开启|关闭|请求|状态|反馈|故障|控制|使能|位置/g
  const terms = new Set<string>()
  for (const match of compact.matchAll(markers)) terms.add(match[0])
  for (const part of query.split(/[\s,，。;；/]+/)) if (part.trim().length >= 2) terms.add(part.trim())
  return [...terms].length ? [...terms] : [compact]
}

function hasEndpoint(signal: any, controller: string, direction?: 'TX' | 'RX') {
  const endpoints = [...signal.signal_endpoints, ...signal.message_endpoints]
  return endpoints.some((endpoint: string) => {
    const [name, rawDirection = ''] = endpoint.toUpperCase().split(':')
    if (name !== controller) return false
    if (!direction) return true
    return rawDirection === direction || rawDirection === direction[0]
  })
}

function validateScope(args: ScopeArgs) {
  requireText(args.workspace_id, 'workspace_id', 128)
  requireText(args.project_code, 'project_code', 128)
  requireText(args.network_name, 'network_name', 128)
  requireText(args.owner_node, 'owner_node', 128)
}

function requireText(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 必须是 1-${max} 字符的字符串`)
}

function bounded(value: number, min: number, max: number, name: string) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须在 ${min}-${max} 之间`)
  return value
}

function split(value: unknown) { return value ? String(value).split(',').filter(Boolean) : [] }
