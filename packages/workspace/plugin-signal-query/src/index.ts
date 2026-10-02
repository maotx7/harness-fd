import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import mysql from 'mysql2/promise'
import '@deepseek-ai/dsh-host-webserver'
import Busboy from 'busboy'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { registerSignalTools } from './signal-tools.js'

export const name = 'signal-data-query'
export const inject = ['tools', 'webServer']

export interface Config {
  mysqlUrl: string
}

export const Config: Schema<Config> = Schema.object({
  mysqlUrl: Schema.string().required().description('MySQL 连接字符串')
})

interface SignalMatrixSummary {
  id: string
  project_code: string
  network_name: string
  owner_node: string
  version_label: string
  status: string
  source_filename: string
  message_count: number
  signal_count: number
  created_at: Date | string
  updated_at: Date | string
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

  registerSignalTools(ctx, { db: getDb })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/workspace/signals',
    async handler(req, res) {
      try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')

      if (req.method === 'GET' && requestUrl.pathname === '/api/workspace/signals') {
        const [rows] = await getDb().execute<mysql.RowDataPacket[]>(
          `SELECT id, project_code, network_name, owner_node, version_label, status,
                  source_filename, message_count, signal_count, created_at, updated_at
           FROM kb_signal_matrices
           ORDER BY created_at DESC`,
        )
        sendJson(res, 200, {
          matrices: rows.map(row => ({
            ...row,
            source_filename: decodeLegacyMultipartFilename(String(row.source_filename))
          })) as SignalMatrixSummary[]
        })
        return
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/workspace/signals') {
        const upload = await readUpload(req, ['.xlsx', '.xls', '.csv'])
        const sha256 = createHash('sha256').update(upload.buffer).digest('hex')
        const [existing] = await getDb().execute<mysql.RowDataPacket[]>(
          'SELECT id FROM kb_signal_matrices WHERE source_sha256 = ? LIMIT 1',
          [sha256]
        )
        if (existing.length) return sendJson(res, 200, { matrix_id: existing[0].id, deduplicated: true })
        const parsed = parseSignalMatrix(upload.buffer, upload.filename)
        const matrixId = randomUUID()
        const importId = randomUUID()
        const suffix = path.extname(upload.filename).toLowerCase()
        const storageRoot = path.resolve(process.cwd(), 'runtime', 'dsh-catalog', 'signals')
        const objectKey = path.join(storageRoot, `${matrixId}-${sha256}${suffix}`)
        await mkdir(storageRoot, { recursive: true })
        await writeFile(objectKey, upload.buffer)
        const connection = await getDb().getConnection()
        try {
          await connection.beginTransaction()
          await ensureDefaultWorkspace(connection)
          await connection.execute(
            `INSERT INTO kb_signal_matrices
             (id, workspace_id, project_code, architecture, network_name, owner_node,
              version_label, released_at, status, node_names, source_object_key,
              source_filename, source_sha256, source_size, message_count, signal_count,
              validation_report, imported_by, created_at, updated_at)
             VALUES (?, 'default', ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [matrixId, parsed.projectCode, parsed.architecture, parsed.networkName, parsed.ownerNode,
              parsed.versionLabel, parsed.releasedAt, JSON.stringify(parsed.nodeNames), objectKey,
              upload.filename, sha256, upload.buffer.length, parsed.messageCount, parsed.signalCount,
              JSON.stringify({ warnings: parsed.warnings }), upload.fields.imported_by?.trim() || null]
          )
          await connection.execute(
            `INSERT INTO kb_signal_matrix_imports
             (id, workspace_id, matrix_id, status, source_filename, source_sha256, deduplicated, created_at, updated_at)
             VALUES (?, 'default', ?, 'VALIDATED', ?, ?, FALSE, NOW(), NOW())`,
            [importId, matrixId, upload.filename, sha256]
          )
          await connection.commit()
        } catch (error) {
          await connection.rollback()
          await rm(objectKey, { force: true })
          throw error
        } finally {
          connection.release()
        }
        return sendJson(res, 201, { matrix_id: matrixId, deduplicated: false, ...parsed })
      }

      const match = requestUrl.pathname.match(/^\/api\/workspace\/signals\/([^/]+)$/)
      if (req.method === 'DELETE' && match) {
        const matrixId = decodeURIComponent(match[1])
        const [files] = await getDb().execute<mysql.RowDataPacket[]>(
          `SELECT source_object_key FROM kb_signal_matrices
           WHERE id = ? AND status = 'DRAFT'`, [matrixId]
        )
        const [result] = await getDb().execute<mysql.ResultSetHeader>(
          `DELETE FROM kb_signal_matrices
           WHERE id = ? AND status = 'DRAFT'`,
          [matrixId]
        )
        if (result.affectedRows === 0) {
          sendJson(res, 409, { error: 'Only existing DRAFT signal matrices can be deleted' })
          return
        }
        await Promise.all(files.map(file => rm(String(file.source_object_key), { force: true }).catch(() => undefined)))
        res.writeHead(204).end()
        return
      }

      sendJson(res, 404, { error: 'Not found' })
      } catch (error) {
        ctx.logger.warn('Signal API request failed: %s', error instanceof Error ? error.message : String(error))
        if (!res.headersSent) sendJson(res, 400, { error: error instanceof Error ? error.message : '信号矩阵操作失败' })
        else res.end()
      }
    }
  }), 'workspace-signal-query: web API')

  // 清理资源
  ctx.effect(() => async () => {
    if (db) await db.end()
  })
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function ensureDefaultWorkspace(connection: mysql.PoolConnection) {
  await connection.execute(
    `INSERT INTO workspaces (id, name, is_default, created_at, updated_at)
     VALUES ('default', '默认分区', TRUE, NOW(), NOW())
     ON DUPLICATE KEY UPDATE is_default = TRUE, updated_at = NOW()`
  )
}

function readUpload(req: any, extensions: string[]): Promise<{ filename: string; buffer: Buffer; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers?.['content-type'] || '')
    if (!contentType.startsWith('multipart/form-data')) return reject(new Error('必须使用 multipart/form-data 上传文件'))
    const parser = Busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: { files: 1, fileSize: 50 * 1024 * 1024, fields: 8 }
    })
    const fields: Record<string, string> = {}
    let filename = ''
    const chunks: Buffer[] = []
    let truncated = false
    parser.on('field', (name, value) => { fields[name] = value })
    parser.on('file', (_name, stream, info) => {
      filename = path.basename(info.filename)
      if (!extensions.includes(path.extname(filename).toLowerCase())) {
        stream.resume()
        reject(new Error(`仅支持 ${extensions.join('、')} 格式`))
        return
      }
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('limit', () => { truncated = true })
    })
    parser.on('error', reject)
    parser.on('finish', () => {
      if (truncated) return reject(new Error('文件超过 50 MB'))
      if (!filename || !chunks.length) return reject(new Error('请选择非空文件'))
      resolve({ filename, buffer: Buffer.concat(chunks), fields })
    })
    req.pipe(parser)
  })
}

interface ParsedMatrixSummary {
  projectCode: string
  architecture: string | null
  networkName: string
  ownerNode: string
  versionLabel: string
  releasedAt: string | null
  nodeNames: string[]
  messageCount: number
  signalCount: number
  warnings: Array<{ code: string; message: string }>
}

function parseSignalMatrix(buffer: Buffer, filename: string): ParsedMatrixSummary {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const extension = path.extname(filename).toLowerCase()
  if (extension === '.csv') return parseCsvSummary(workbook, filename)
  const required = ['Cover', 'History', 'Matrix', 'Msg List']
  const missing = required.filter(name => !workbook.SheetNames.includes(name))
  if (missing.length) throw new Error(`缺少工作表：${missing.join('、')}`)

  const coverRows = sheetRows(workbook.Sheets.Cover)
  const coverText = coverRows.flat().map(text).filter(Boolean).flatMap(value => value.split(/\r?\n/))
  const title = coverText.find(value => value.includes('项目') && value.includes('网段')) || ''
  const project = title.match(/([^\s]+?)项目/)
  const network = title.match(/项目\s*([A-Za-z0-9_-]+)网段/i)
  const owner = title.match(/网段\s*([A-Za-z0-9_-]+)节点/i)
  if (!project || !network || !owner) throw new Error('Cover 无法识别项目、网段和节点')

  const historyRows = sheetRows(workbook.Sheets.History).slice(1)
  const versions = historyRows.map(row => {
    const match = text(row[0]).match(/V(\d+(?:\.\d+)*)/i)
    return match ? { label: `V${match[1]}`, parts: match[1].split('.').map(Number), date: dateText(row[1]) } : null
  }).filter(Boolean) as Array<{ label: string; parts: number[]; date: string | null }>
  if (!versions.length) throw new Error('History 中没有版本记录')
  versions.sort((left, right) => compareVersion(left.parts, right.parts))
  const latest = versions[versions.length - 1]

  const matrixRows = sheetRows(workbook.Sheets.Matrix)
  const matrixHeaders = matrixRows[0].map(normalizeHeader)
  const signalColumn = matrixHeaders.findIndex(value => value.startsWith('signalname'))
  const brsColumn = matrixHeaders.findIndex(value => value.startsWith('brs') || value.includes('传输速率切换标识位'))
  if (signalColumn < 0 || brsColumn < 0) throw new Error('Matrix 缺少 Signal Name 或 BRS 列')
  const nodeNames = matrixRows[0].slice(brsColumn + 1).map(text).filter(Boolean)
  if (!nodeNames.length) throw new Error('Matrix 没有控制器列')
  const signalCount = matrixRows.slice(1).filter(row => text(row[signalColumn])).length

  const messageRows = sheetRows(workbook.Sheets['Msg List'])
  const messageHeaders = messageRows[0].map(normalizeHeader)
  const messageColumn = messageHeaders.findIndex(value => value.startsWith('msgname'))
  if (messageColumn < 0) throw new Error('Msg List 缺少 Msg Name 列')
  const messageCount = messageRows.slice(1).filter(row => text(row[messageColumn])).length
  if (!messageCount) throw new Error('Msg List 没有报文记录')

  return {
    projectCode: project[1], architecture: null, networkName: network[1].toUpperCase(), ownerNode: owner[1].toUpperCase(),
    versionLabel: latest.label, releasedAt: latest.date, nodeNames, messageCount, signalCount, warnings: []
  }
}

function parseCsvSummary(workbook: XLSX.WorkBook, filename: string): ParsedMatrixSummary {
  const rows = sheetRows(workbook.Sheets[workbook.SheetNames[0]])
  if (rows.length < 2) throw new Error('CSV 没有数据行')
  const headers = rows[0].map(normalizeHeader)
  const index = (names: string[]) => headers.findIndex(header => names.some(name => header.startsWith(name)))
  const messageColumn = index(['msgname'])
  const signalColumn = index(['signalname'])
  const brsColumn = index(['brs', '传输速率切换标识位'])
  if (messageColumn < 0 || signalColumn < 0 || brsColumn < 0) throw new Error('CSV 缺少 Msg Name、Signal Name 或 BRS 列')
  const first = rows[1]
  const value = (names: string[]) => { const column = index(names); return column >= 0 ? text(first[column]) : '' }
  const projectCode = value(['projectcode', 'project'])
  const networkName = value(['networkname', 'network'])
  const ownerNode = value(['ownernode', 'owner'])
  const fromFile = filename.match(/V(\d+(?:\.\d+)*)/i)?.[1]
  const rawVersion = value(['version']) || (fromFile ? `V${fromFile}` : '')
  if (!projectCode || !networkName || !ownerNode || !rawVersion) throw new Error('CSV 必须提供项目、网络、节点和版本信息')
  return {
    projectCode, architecture: value(['architecture']) || null, networkName: networkName.toUpperCase(), ownerNode: ownerNode.toUpperCase(),
    versionLabel: rawVersion.toUpperCase().startsWith('V') ? rawVersion : `V${rawVersion}`,
    releasedAt: value(['releasedate']) || null,
    nodeNames: rows[0].slice(brsColumn + 1).map(text).filter(Boolean),
    messageCount: new Set(rows.slice(1).map(row => text(row[messageColumn])).filter(Boolean)).size,
    signalCount: rows.slice(1).filter(row => text(row[signalColumn])).length,
    warnings: []
  }
}

function sheetRows(sheet: XLSX.WorkSheet): any[][] {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as any[][]
}

function text(value: unknown) { return value == null ? '' : String(value).trim() }
function decodeLegacyMultipartFilename(value: string) {
  if (/\p{Script=Han}/u.test(value)) return value
  const decoded = Buffer.from(value, 'latin1').toString('utf8')
  return !decoded.includes('\uFFFD') && /\p{Script=Han}/u.test(decoded) ? decoded : value
}
function normalizeHeader(value: unknown) { return text(value).toLowerCase().replace(/[\s_\-()（）/]+/g, '') }
function dateText(value: unknown) {
  if (!value) return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}
function compareVersion(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0)
    if (difference) return difference
  }
  return 0
}

