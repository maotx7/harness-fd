import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { QdrantClient } from '@qdrant/js-client-rest'
import type mysql from 'mysql2/promise'

interface KnowledgeConfig {
  vectorCollection: string
  embeddingDimension: number
}

interface KnowledgeDependencies {
  db: () => mysql.Pool
  qdrant: () => QdrantClient
  embed: (texts: string[]) => Promise<number[][]>
}

interface SearchArgs {
  query: string
  workspace_id?: string
  top_k?: number
  project_code?: string
  function_domain?: string
  powertrain_type?: string
  status?: string
  approved_only?: boolean
}

interface BundleArgs {
  workspace_id?: string
  document_id: string
  version_id: string
  include_sub_functions?: boolean
  include_fields?: boolean
  max_tokens?: number
}

interface EvidenceArgs extends BundleArgs {
  task_goal: string
  target_context?: Record<string, string | null>
  target_fields?: string[]
}

const DEFAULT_TARGET_FIELDS = [
  '法规内容', '功能逻辑架构图', '功能描述', '使能条件', '配置字', '触发条件',
  '执行输出', 'HMI要求', '退出条件', '故障处理', '故障恢复', '相关信号'
]

const FIELD_TARGETS: Record<string, string> = {
  regulatory: '法规内容', architecture: '功能逻辑架构图', description: '功能描述',
  enable: '使能条件', configuration: '配置字', trigger: '触发条件', execution: '执行输出',
  hmi: 'HMI要求', exit: '退出条件', fault: '故障处理', fault_recovery: '故障恢复',
  signals: '相关信号', safety: '功能安全要求'
}

const output = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
}

export function registerKnowledgeTools(
  ctx: Context,
  config: KnowledgeConfig,
  dependencies: KnowledgeDependencies
) {
  ctx.tools.register({
    name: 'knowledge_doctor',
    description: '检查知识库数据库、向量集合和 Embedding 配置是否可用',
    output,
    parameters: { type: 'object', properties: {} },
    async execute() {
      const result: any = {
        healthy: true,
        embedding: { configured: config.embeddingDimension > 0, dimension: config.embeddingDimension },
        mysql: { healthy: false },
        qdrant: { healthy: false, collection: config.vectorCollection }
      }
      try {
        await dependencies.db().query('SELECT 1')
        result.mysql.healthy = true
      } catch (error) {
        result.healthy = false
        result.mysql.error = message(error)
      }
      try {
        const info: any = await dependencies.qdrant().getCollection(config.vectorCollection)
        result.qdrant = {
          healthy: true,
          collection: config.vectorCollection,
          status: info.status,
          points: info.points_count ?? info.indexed_vectors_count ?? 0
        }
      } catch (error) {
        result.healthy = false
        result.qdrant.error = message(error)
      }
      return result
    }
  })

  ctx.tools.register({
    name: 'search_function_bundles',
    description: '按文档聚合检索历史功能定义，返回可精确展开的候选版本',
    output,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' }, workspace_id: { type: 'string', default: 'default' },
        top_k: { type: 'number', default: 3 }, project_code: { type: 'string' },
        function_domain: { type: 'string' }, powertrain_type: { type: 'string' },
        status: { type: 'string' }, approved_only: { type: 'boolean', default: false }
      },
      required: ['query']
    },
    execute: (args: SearchArgs) => searchBundles(config, dependencies, args)
  })

  ctx.tools.register({
    name: 'load_function_bundle',
    description: '用 document_id 和 version_id 精确展开一份功能定义及其来源片段',
    output,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', default: 'default' }, document_id: { type: 'string' },
        version_id: { type: 'string' }, include_sub_functions: { type: 'boolean', default: true },
        include_fields: { type: 'boolean', default: true }, max_tokens: { type: 'number', default: 12000 }
      },
      required: ['document_id', 'version_id']
    },
    execute: (args: BundleArgs) => loadBundle(config, dependencies, args)
  })

  ctx.tools.register({
    name: 'build_evidence_pack',
    description: '从一份精确功能定义版本构建可回源、按目标模板字段归类的证据包',
    output,
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', default: 'default' }, document_id: { type: 'string' },
        version_id: { type: 'string' }, task_goal: { type: 'string' },
        target_context: { type: 'object' }, target_fields: { type: 'array', items: { type: 'string' } },
        max_tokens: { type: 'number', default: 12000 }
      },
      required: ['document_id', 'version_id', 'task_goal']
    },
    async execute(args: EvidenceArgs) {
      requireText(args.task_goal, 'task_goal', 4000)
      const targetFields = args.target_fields?.length ? args.target_fields : DEFAULT_TARGET_FIELDS
      if (targetFields.length > 50) throw new Error('target_fields 最多 50 项')
      const loaded: any = await loadBundle(config, dependencies, { ...args, include_fields: true })
      const bundle = loaded.bundle
      const items = (bundle.document_fields || []).map((field: any, index: number) => {
        const target = FIELD_TARGETS[field.field_type] || '功能描述'
        const signal = target === '相关信号'
        return {
          id: `${bundle.bundle_id}:${index + 1}`,
          status: signal ? 'REVIEW' : 'MODIFY',
          document_id: bundle.source.document_id,
          version_id: bundle.source.version_id,
          source_filename: bundle.source.source_filename,
          source_uri: bundle.source.source_uri,
          section_path: field.section_path,
          target_section: target,
          primary_field: target,
          operation: signal ? 'OVERRIDE' : 'NORMALIZE_WORDING',
          quote: field.text,
          source: field.source,
          rationale: signal
            ? '旧项目信号仅作语义线索，最终值由目标项目矩阵覆盖'
            : '按唯一主归属字段迁移并规范化措辞',
          differences: signal ? ['不得直接复用旧信号名、报文、CAN ID、节点或枚举'] : []
        }
      })
      const covered = new Set(items.map((item: any) => item.target_section))
      const contextDifferences = contextDiffs(bundle, args.target_context || {})
      return {
        source_bundle_id: bundle.bundle_id,
        evidence_pack: {
          id: randomUUID(),
          request: { workspace_id: bundle.workspace_id, task_goal: args.task_goal, target_context: args.target_context || {} },
          items,
          context_differences: contextDifferences,
          conflicts: contextDifferences.filter(item => item.status === 'REVIEW').map(item =>
            `${item.field}：源值 ${item.source_value} 与目标值 ${item.target_value} 不一致，禁止静默覆盖`),
          uncovered_requirements: targetFields.filter(field => !covered.has(field)).map(field =>
            `${field}：未形成独立字段证据，需从功能原文拆分或由项目确认`),
          unresolved: targetFields.includes('相关信号') ? ['相关信号：必须使用目标项目权威信号矩阵解析'] : [],
          created_at: new Date().toISOString()
        },
        truncated: loaded.truncated,
        max_tokens: loaded.max_tokens,
        estimated_tokens: loaded.estimated_tokens
      }
    }
  })
}

async function searchBundles(config: KnowledgeConfig, dependencies: KnowledgeDependencies, args: SearchArgs) {
  requireText(args.query, 'query', 4000)
  const workspaceId = args.workspace_id || 'default'
  const topK = bounded(args.top_k ?? 3, 1, 20, 'top_k')
  const [vector] = await dependencies.embed([args.query])
  const response: any = await dependencies.qdrant().query(config.vectorCollection, {
    query: vector,
    filter: { must: [{ key: 'workspace_id', match: { value: workspaceId } }] },
    limit: Math.max(50, topK * 10),
    with_payload: true
  })
  const groups = new Map<string, { payload: any; scores: number[]; locations: any[] }>()
  for (const point of response.points || []) {
    const payload = point.payload || {}
    if (!payload.document_id || !payload.version_id) continue
    const key = `${payload.document_id}:${payload.version_id}`
    const group = groups.get(key) || { payload, scores: [], locations: [] }
    group.scores.push(Number(point.score || 0))
    group.locations.push({
      section_path: payload.section_path || null,
      page_start: payload.page_start ?? null,
      page_end: payload.page_end ?? null,
      text: payload.text || payload.content || ''
    })
    groups.set(key, group)
  }
  const candidates: any[] = []
  for (const group of groups.values()) {
    const p = group.payload
    const [rows] = await dependencies.db().execute<mysql.RowDataPacket[]>(
      `SELECT d.title, v.project_code, v.platform, v.architecture, v.powertrain_type,
              v.function_domain, v.status, v.approved_for_reuse, s.original_name, s.source_uri
       FROM kb_documents d JOIN kb_document_versions v ON v.document_id = d.id
       LEFT JOIN kb_source_files s ON s.version_id = v.id
       WHERE d.workspace_id = ? AND d.id = ? AND v.id = ? LIMIT 1`,
      [workspaceId, p.document_id, p.version_id]
    )
    if (!rows.length) continue
    const row = rows[0]
    if (args.project_code && row.project_code !== args.project_code) continue
    if (args.function_domain && row.function_domain !== args.function_domain) continue
    if (args.powertrain_type && row.powertrain_type !== args.powertrain_type) continue
    if (args.status && row.status !== args.status) continue
    if (args.approved_only && !row.approved_for_reuse) continue
    const scores = group.scores.sort((a, b) => b - a)
    const max = scores[0] || 0
    const mean = scores.slice(0, 3).reduce((sum, value) => sum + value, 0) / Math.min(3, scores.length)
    const coverage = Math.min(scores.length / 10, 1)
    candidates.push({
      bundle_id: `${p.document_id}:${p.version_id}`,
      title: row.title,
      source: { document_id: p.document_id, version_id: p.version_id, source_filename: row.original_name, source_uri: row.source_uri },
      main_functions: [], matched_locations: group.locations.slice(0, 5),
      project_code: row.project_code, platform: row.platform, architecture: row.architecture,
      powertrain_type: row.powertrain_type, function_domain: row.function_domain,
      approved_for_reuse: Boolean(row.approved_for_reuse), hit_count: scores.length,
      scores: { max, mean_top_three: mean, coverage },
      combined_score: 0.78 * max + 0.20 * mean + 0.02 * coverage
    })
  }
  candidates.sort((left, right) => right.combined_score - left.combined_score)
  return { query: args.query, workspace_id: workspaceId, candidates: candidates.slice(0, topK), total_chunk_hits: response.points?.length || 0, truncated: false }
}

async function loadBundle(config: KnowledgeConfig, dependencies: KnowledgeDependencies, args: BundleArgs) {
  const workspaceId = args.workspace_id || 'default'
  requireId(args.document_id, 'document_id')
  requireId(args.version_id, 'version_id')
  const maxTokens = bounded(args.max_tokens ?? 12000, 256, 100000, 'max_tokens')
  const [rows] = await dependencies.db().execute<mysql.RowDataPacket[]>(
    `SELECT d.title, v.version_label, v.project_code, v.platform, v.architecture,
            v.powertrain_type, v.function_domain, v.status, v.approved_for_reuse,
            s.original_name, s.source_uri
     FROM kb_documents d JOIN kb_document_versions v ON v.document_id = d.id
     LEFT JOIN kb_source_files s ON s.version_id = v.id
     WHERE d.workspace_id = ? AND d.id = ? AND v.id = ? LIMIT 1`,
    [workspaceId, args.document_id, args.version_id]
  )
  if (!rows.length) throw new Error('BUNDLE_NOT_FOUND: 未找到指定知识文档版本')
  const points: any[] = []
  let offset: any = undefined
  do {
    const page: any = await dependencies.qdrant().scroll(config.vectorCollection, {
      filter: { must: [
        { key: 'workspace_id', match: { value: workspaceId } },
        { key: 'document_id', match: { value: args.document_id } },
        { key: 'version_id', match: { value: args.version_id } }
      ] },
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false
    })
    points.push(...(page.points || []))
    offset = page.next_page_offset
  } while (offset != null && points.length < 2000)
  if (!points.length) throw new Error('BUNDLE_NOT_FOUND: 指定版本没有可用索引片段')
  const row = rows[0]
  let usedCharacters = 0
  const characterBudget = maxTokens * 4
  let truncated = false
  const fields: any[] = []
  for (const point of points.sort((a, b) => Number(a.payload?.position || 0) - Number(b.payload?.position || 0))) {
    const payload = point.payload || {}
    let text = String(payload.text || payload.content || '')
    if (usedCharacters + text.length > characterBudget) {
      text = text.slice(0, Math.max(0, characterBudget - usedCharacters))
      truncated = true
    }
    if (!text) break
    usedCharacters += text.length
    fields.push({
      field_type: payload.field_type || inferFieldType(payload.section_path, text),
      text,
      section_path: payload.section_path || `片段 ${fields.length + 1}`,
      source: { page_start: payload.page_start ?? null, page_end: payload.page_end ?? null, source_uri: row.source_uri }
    })
    if (truncated) break
  }
  const bundle = {
    bundle_id: `${args.document_id}:${args.version_id}`,
    workspace_id: workspaceId,
    title: row.title,
    source: { document_id: args.document_id, version_id: args.version_id, source_filename: row.original_name, source_uri: row.source_uri },
    version_label: row.version_label, project_code: row.project_code, platform: row.platform,
    architecture: row.architecture, powertrain_type: row.powertrain_type, function_domain: row.function_domain,
    status: row.status, approved_for_reuse: Boolean(row.approved_for_reuse),
    document_fields: args.include_fields === false ? [] : fields,
    main_functions: fields.map((field, index) => ({
      function_id: `chunk-${index + 1}`, name: field.section_path, text: field.text,
      section_path: field.section_path, source: field.source, fields: args.include_fields === false ? [] : [field], sub_functions: []
    }))
  }
  return { bundle, truncated, max_tokens: maxTokens, estimated_tokens: Math.ceil(usedCharacters / 4) }
}

function contextDiffs(bundle: any, target: Record<string, string | null>) {
  return ['project_code', 'platform', 'architecture', 'powertrain_type', 'version_label'].flatMap(field => {
    const targetValue = target[field]
    if (!targetValue) return []
    const sourceValue = bundle[field]
    const status = !sourceValue ? 'UNRESOLVED' : sourceValue === targetValue ? 'MATCH' : 'REVIEW'
    return [{ field, source_value: sourceValue, target_value: targetValue, status,
      rationale: status === 'MATCH' ? '源值与目标值一致' : status === 'UNRESOLVED' ? '源文档未识别该字段' : '源值与目标值不同，需要项目依据' }]
  })
}

function inferFieldType(sectionPath: unknown, text: string) {
  const value = `${sectionPath || ''} ${text.slice(0, 80)}`
  if (/信号|报文|CAN/i.test(value)) return 'signals'
  if (/故障恢复/.test(value)) return 'fault_recovery'
  if (/故障|异常/.test(value)) return 'fault'
  if (/退出|结束/.test(value)) return 'exit'
  if (/触发/.test(value)) return 'trigger'
  if (/使能|前提|条件/.test(value)) return 'enable'
  if (/HMI|显示|提示/.test(value)) return 'hmi'
  if (/架构/.test(value)) return 'architecture'
  return 'description'
}

function requireText(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 必须是 1-${max} 字符的字符串`)
}

function requireId(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(`${name} 格式无效`)
}

function bounded(value: number, min: number, max: number, name: string) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须在 ${min}-${max} 之间`)
  return value
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
