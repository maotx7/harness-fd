/**
 * SQLite版本的知识库搜索插件
 * 替换MySQL和Qdrant为SQLite
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-host-webserver'
import Busboy from 'busboy'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import WordExtractor from 'word-extractor'
import { SqlitePool, RowDataPacket, ResultSetHeader } from './sqlite-db.js'
import { SqliteVectorStore } from './sqlite-vector-store.js'
import { registerKnowledgeTools } from './knowledge-tools.js'
import { persistUploadedKnowledgeDocument } from './knowledge-storage.js'
import { DEFAULT_WORKSPACE_ID } from './workspace.js'

export const name = 'knowledge-base-search'
export const inject = ['tools', 'webServer']

export interface Config {
  databasePath: string
  vectorDbPath: string
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  embeddingDimension: number
  vectorCollection: string
  storageRoot: string
}

export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default('./data/harness.db').description('SQLite 数据库路径'),
  vectorDbPath: Schema.string().default('./data/vectors.db').description('SQLite 向量数据库路径'),
  embeddingBaseUrl: Schema.string().required().description('Embedding API 地址'),
  embeddingApiKey: Schema.string().required().description('Embedding API 密钥'),
  embeddingModel: Schema.string().required().description('Embedding 模型'),
  embeddingDimension: Schema.number().default(2560).description('Embedding 向量维度'),
  vectorCollection: Schema.string().default('function_def_chunks').description('向量集合名称'),
  storageRoot: Schema.string().default('./data/workspace-ai/shared/knowledge').description('文件存储根目录')
})

const toolOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
}

interface SearchArgs {
  query: string
  top_k?: number
}

interface ChunkData {
  id: string
  text: string
  position: number
}

export function apply(ctx: Context, config: Config) {
  // 延迟初始化数据库连接
  let db: SqlitePool | null = null
  let vectorStore: SqliteVectorStore | null = null

  function getDb() {
    if (!db) {
      ctx.logger.info('Initializing SQLite database...')
      const dbPath = path.resolve(process.cwd(), config.databasePath)
      db = new SqlitePool(`sqlite:///${dbPath}`)
    }
    return db
  }

  function getVectorStore() {
    if (!vectorStore) {
      ctx.logger.info('Initializing SQLite vector store...')
      const vectorPath = path.resolve(process.cwd(), config.vectorDbPath)
      vectorStore = new SqliteVectorStore(vectorPath)
    }
    return vectorStore
  }

  registerKnowledgeTools(ctx, config, {
    db: getDb,
    qdrant: getVectorStore,
    embed: texts => embedTexts(config, texts)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/workspace/knowledge',
    async handler(req, res) {
      try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')

      // GET /api/workspace/knowledge - 列出所有文档
      if (req.method === 'GET' && requestUrl.pathname === '/api/workspace/knowledge') {
        const [rows] = await getDb().execute<RowDataPacket[]>(
          `SELECT d.id, d.title, d.status, d.created_by, d.created_at, d.updated_at,
                  COUNT(DISTINCT v.id) AS version_count,
                  MAX(s.original_name) AS source_filename,
                  MAX(s.size) AS source_size
           FROM kb_documents d
           LEFT JOIN kb_document_versions v ON v.document_id = d.id
           LEFT JOIN kb_source_files s ON s.version_id = v.id
           GROUP BY d.id, d.title, d.status, d.created_by, d.created_at, d.updated_at
           ORDER BY d.updated_at DESC`
        )
        return sendJson(res, 200, {
          documents: rows.map((row: any) => ({
            ...row,
            title: decodeLegacyMultipartFilename(String(row.title)),
            source_filename: row.source_filename
              ? decodeLegacyMultipartFilename(String(row.source_filename))
              : null
          }))
        })
      }

      // POST /api/workspace/knowledge - 上传新文档
      if (req.method === 'POST' && requestUrl.pathname === '/api/workspace/knowledge') {
        const upload = await readUpload(req, ['.pdf', '.docx', '.doc'])
        const sha256 = createHash('sha256').update(upload.buffer).digest('hex')

        // 检查是否已存在
        const [existing] = await getDb().execute<RowDataPacket[]>(
          `SELECT d.id FROM kb_source_files s
           JOIN kb_document_versions v ON v.id = s.version_id
           JOIN kb_documents d ON d.id = v.document_id
           WHERE s.sha256 = ? LIMIT 1`,
          [sha256]
        )
        if (existing.length) return sendJson(res, 200, { document_id: (existing[0] as any).id, deduplicated: true })

        const documentId = randomUUID()
        const versionId = randomUUID()
        const sourceId = randomUUID()
        const jobId = randomUUID()
        const suffix = path.extname(upload.filename).toLowerCase()
        const title = upload.fields.title?.trim() || path.basename(upload.filename, suffix)

        // 提取文本和生成向量
        const content = await extractDocumentText(upload.buffer, suffix)
        const chunks = parseAndChunk(content)
        const vectors = await embedTexts(config, chunks.map(chunk => chunk.text))

        // 保存文件
        const storageRoot = path.resolve(process.cwd(), config.storageRoot)
        const objectKey = path.join(storageRoot, `${documentId}-${sha256}${suffix}`)
        await mkdir(storageRoot, { recursive: true })
        await writeFile(objectKey, upload.buffer)

        // 保存到数据库（事务）
        const connection = await getDb().getConnection()
        try {
          await connection.beginTransaction()

          const createdAt = Date.now()
          await persistUploadedKnowledgeDocument(connection, {
            documentId,
            versionId,
            sourceId,
            jobId,
            title,
            createdBy: upload.fields.created_by?.trim() || null,
            objectKey,
            sha256,
            filename: upload.filename,
            suffix,
            size: upload.buffer.length,
            createdAt
          })

          await connection.commit()
        } catch (error) {
          await connection.rollback()
          await rm(objectKey, { force: true })
          throw error
        } finally {
          connection.release()
        }

        // 索引向量
        try {
          await indexDocument(getVectorStore(), config, {
            documentId,
            versionId,
            title,
            sourceFilename: upload.filename,
            chunks,
            vectors
          })

          await getDb().execute(
            `UPDATE kb_documents SET status = 'EXTRACTED', updated_at = ? WHERE id = ?`,
            [Date.now(), documentId]
          )
          await getDb().execute(
            `UPDATE kb_document_versions SET status = 'EXTRACTED', updated_at = ? WHERE id = ?`,
            [Date.now(), versionId]
          )
          await getDb().execute(
            `UPDATE kb_ingestion_jobs
             SET status = 'EXTRACTED', stage = 'complete', error_code = NULL, error_message = NULL, updated_at = ?
             WHERE id = ?`,
            [Date.now(), jobId]
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await getDb().execute(
            `UPDATE kb_documents SET status = 'QUARANTINED', updated_at = ? WHERE id = ?`,
            [Date.now(), documentId]
          )
          await getDb().execute(
            `UPDATE kb_document_versions SET status = 'QUARANTINED', updated_at = ? WHERE id = ?`,
            [Date.now(), versionId]
          )
          await getDb().execute(
            `UPDATE kb_ingestion_jobs
             SET status = 'FAILED', stage = 'index', error_code = 'VECTOR_INDEX_ERROR', error_message = ?, updated_at = ?
             WHERE id = ?`,
            [message.slice(0, 4000), Date.now(), jobId]
          )
          throw new Error(`文档已保存，但向量索引失败：${message}`)
        }

        return sendJson(res, 201, { document_id: documentId, chunks_count: chunks.length, deduplicated: false })
      }

      // POST /api/workspace/knowledge/:id/index - 重新索引
      const indexMatch = requestUrl.pathname.match(/^\/api\/workspace\/knowledge\/([^/]+)\/index$/)
      if (req.method === 'POST' && indexMatch) {
        const documentId = decodeURIComponent(indexMatch[1])
        const [rows] = await getDb().execute<RowDataPacket[]>(
          `SELECT d.title, v.id AS version_id, s.object_key, s.original_name
           FROM kb_documents d
           JOIN kb_document_versions v ON v.document_id = d.id
           JOIN kb_source_files s ON s.version_id = v.id
           WHERE d.id = ?
           ORDER BY v.created_at DESC LIMIT 1`,
          [documentId]
        )
        if (!rows.length) return sendJson(res, 404, { error: '知识库文档不存在' })

        const source = rows[0] as any
        try {
          await getDb().execute(
            `UPDATE kb_documents SET status = 'INDEXING', updated_at = ? WHERE id = ?`,
            [Date.now(), documentId]
          )
          await getDb().execute(
            `UPDATE kb_document_versions SET status = 'INDEXING', updated_at = ? WHERE id = ?`,
            [Date.now(), source.version_id]
          )

          const buffer = await readFile(String(source.object_key))
          const suffix = path.extname(String(source.original_name)).toLowerCase()
          const content = await extractDocumentText(buffer, suffix)
          const chunks = parseAndChunk(content)
          const vectors = await embedTexts(config, chunks.map(chunk => chunk.text))

          await deleteDocumentVectors(getVectorStore(), config.vectorCollection, documentId)
          await indexDocument(getVectorStore(), config, {
            documentId,
            versionId: String(source.version_id),
            title: decodeLegacyMultipartFilename(String(source.title)),
            sourceFilename: decodeLegacyMultipartFilename(String(source.original_name)),
            chunks,
            vectors
          })

          await getDb().execute(
            `UPDATE kb_documents SET status = 'EXTRACTED', updated_at = ? WHERE id = ?`,
            [Date.now(), documentId]
          )
          await getDb().execute(
            `UPDATE kb_document_versions SET status = 'EXTRACTED', updated_at = ? WHERE id = ?`,
            [Date.now(), source.version_id]
          )

          return sendJson(res, 200, { document_id: documentId, chunks_count: chunks.length })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await getDb().execute(
            `UPDATE kb_documents SET status = 'QUARANTINED', updated_at = ? WHERE id = ?`,
            [Date.now(), documentId]
          )
          await getDb().execute(
            `UPDATE kb_document_versions SET status = 'QUARANTINED', updated_at = ? WHERE id = ?`,
            [Date.now(), source.version_id]
          )
          throw new Error(`重新向量化失败：${message}`)
        }
      }

      // DELETE /api/workspace/knowledge/:id - 删除文档
      const match = requestUrl.pathname.match(/^\/api\/workspace\/knowledge\/([^/]+)$/)
      if (req.method === 'DELETE' && match) {
        const documentId = decodeURIComponent(match[1])
        const [files] = await getDb().execute<RowDataPacket[]>(
          `SELECT s.object_key FROM kb_source_files s
           JOIN kb_document_versions v ON v.id = s.version_id
           WHERE v.document_id = ?`,
          [documentId]
        )
        if (!files.length) return sendJson(res, 404, { error: '知识库文档不存在' })

        await deleteDocumentVectors(getVectorStore(), config.vectorCollection, documentId)
        const [result] = await getDb().execute<ResultSetHeader>('DELETE FROM kb_documents WHERE id = ?', [documentId])
        if (!(result as any).affectedRows) return sendJson(res, 409, { error: '知识库目录删除失败' })

        await Promise.all(files.map((file: any) => rm(String(file.object_key), { force: true })))
        res.writeHead(204).end()
        return
      }

      return sendJson(res, 404, { error: 'Not found' })
      } catch (error) {
        ctx.logger.warn('Knowledge API request failed: %s', error instanceof Error ? error.message : String(error))
        if (!res.headersSent) sendJson(res, 400, { error: error instanceof Error ? error.message : '知识库操作失败' })
        else res.end()
      }
    }
  }), 'workspace-kb-search: web API')

  // 注册工具
  ctx.tools.register({
    name: 'search_knowledge_base',
    description: '在全局知识库中搜索相关文档片段',
    output: toolOutput,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询文本'
        },
        top_k: {
          type: 'number',
          default: 5,
          description: '返回结果数量'
        }
      },
      required: ['query']
    },
    async execute(args: SearchArgs) {
      const { query, top_k = 5 } = args
      const [queryVector] = await embedTexts(config, [query])
      const response = await getVectorStore().query(config.vectorCollection, {
        query: queryVector,
        filter: {
          must: [{ key: 'workspace_id', match: { value: DEFAULT_WORKSPACE_ID } }]
        },
        limit: top_k,
        with_payload: true
      })
      return {
        chunks: (response.points || []).map((point: any) => ({
          content: point.payload?.text,
          source: point.payload?.source_filename,
          title: point.payload?.title,
          score: point.score,
          document_id: point.payload?.document_id
        }))
      }
    }
  })

  // 清理资源
  ctx.effect(() => async () => {
    if (db) await db.end()
    if (vectorStore) vectorStore.close()
  })
}

// 辅助函数
async function extractDocumentText(buffer: Buffer, suffix: string) {
  if (suffix === '.pdf') {
    const parsed = await pdfParse(buffer)
    return normalizeExtractedText(parsed.text)
  }
  const document = await new WordExtractor().extract(buffer)
  return normalizeExtractedText(document.getBody())
}

function normalizeExtractedText(content: string) {
  const normalized = content
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!normalized) throw new Error('文档没有可用于向量化的文本内容')
  return normalized
}

function parseAndChunk(content: string, chunkSize: number = 1200, overlap: number = 150): ChunkData[] {
  const chunks: ChunkData[] = []
  let position = 0
  for (let offset = 0; offset < content.length; offset += chunkSize - overlap) {
    const text = content.slice(offset, offset + chunkSize).trim()
    if (!text) continue
    chunks.push({
      id: `chunk-${position}`,
      text,
      position: position++
    })
  }
  if (!chunks.length) throw new Error('文档没有生成可检索的文本分块')
  return chunks
}

async function embedTexts(config: Config, texts: string[]) {
  const endpoint = embeddingEndpoint(config.embeddingBaseUrl)
  const vectors: number[][] = []
  for (let offset = 0; offset < texts.length; offset += 32) {
    const batch = texts.slice(offset, offset + 32)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.embeddingApiKey}`
      },
      body: JSON.stringify({ model: config.embeddingModel, input: batch })
    })
    if (!response.ok) throw new Error(`Embedding 服务返回 HTTP ${response.status}`)
    const body: any = await response.json()
    const ordered = Array.isArray(body.data)
      ? [...body.data].sort((left, right) => Number(left.index) - Number(right.index))
      : []
    if (ordered.length !== batch.length) throw new Error('Embedding 服务返回的向量数量不匹配')
    for (const item of ordered) {
      if (!Array.isArray(item.embedding) || item.embedding.length !== config.embeddingDimension) {
        throw new Error(`Embedding 向量维度不是 ${config.embeddingDimension}`)
      }
      vectors.push(item.embedding)
    }
  }
  return vectors
}

function embeddingEndpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/embeddings') ? normalized : `${normalized}/embeddings`
}

async function indexDocument(
  vectorStore: SqliteVectorStore,
  config: Config,
  document: {
    documentId: string
    versionId: string
    title: string
    sourceFilename: string
    chunks: ChunkData[]
    vectors: number[][]
  }
) {
  const exists = await vectorStore.collectionExists(config.vectorCollection)
  if (!exists.exists) {
    await vectorStore.createCollection(config.vectorCollection, {
      vectors: { size: config.embeddingDimension, distance: 'Cosine' }
    })
  } else {
    const collection: any = await vectorStore.getCollection(config.vectorCollection)
    const size = collection.config?.params?.vectors?.size
    if (size !== config.embeddingDimension) {
      throw new Error(`Vector collection 向量维度为 ${size}，预期 ${config.embeddingDimension}`)
    }
  }

  await vectorStore.upsert(config.vectorCollection, {
    wait: true,
    points: document.chunks.map((chunk, index) => ({
      id: randomUUID(),
      vector: document.vectors[index],
      payload: {
        workspace_id: DEFAULT_WORKSPACE_ID,
        document_id: document.documentId,
        version_id: document.versionId,
        chunk_id: chunk.id,
        chunk_type: 'text_block',
        text: chunk.text,
        title: document.title,
        source_filename: document.sourceFilename,
        status: 'EXTRACTED',
        approved_for_reuse: false,
        position: chunk.position,
        section_path: `片段 ${chunk.position + 1}`,
        field_type: 'description'
      }
    }))
  })
}

async function deleteDocumentVectors(vectorStore: SqliteVectorStore, collection: string, documentId: string) {
  const exists = await vectorStore.collectionExists(collection)
  if (!exists.exists) return
  await vectorStore.delete(collection, {
    wait: true,
    filter: {
      must: [
        { key: 'workspace_id', match: { value: DEFAULT_WORKSPACE_ID } },
        { key: 'document_id', match: { value: documentId } }
      ]
    }
  })
}

function sendJson(res: any, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
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

function decodeLegacyMultipartFilename(value: string) {
  if (/\p{Script=Han}/u.test(value)) return value
  const decoded = Buffer.from(value, 'latin1').toString('utf8')
  return !decoded.includes('�') && /\p{Script=Han}/u.test(decoded) ? decoded : value
}
