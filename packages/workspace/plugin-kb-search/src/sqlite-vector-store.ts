/**
 * SQLite向量存储 - 替代Qdrant
 * 使用纯TypeScript实现向量相似度搜索
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface VectorPoint {
  id: string
  vector: number[]
  payload: Record<string, any>
}

export interface SearchResult {
  id: string
  score: number
  payload: Record<string, any>
}

export interface SearchFilter {
  must?: Array<{ key: string; match: { value: any } }>
}

export class SqliteVectorStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.initTables()
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_collections (
        name TEXT PRIMARY KEY,
        dimension INTEGER NOT NULL,
        distance TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vector_points (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        vector BLOB NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (collection) REFERENCES vector_collections(name) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_vector_points_collection
        ON vector_points(collection);
    `)
  }

  async collectionExists(name: string): Promise<{ exists: boolean }> {
    const row = this.db.prepare(
      'SELECT 1 FROM vector_collections WHERE name = ?'
    ).get(name)
    return { exists: !!row }
  }

  async createCollection(
    name: string,
    config: { vectors: { size: number; distance: string } }
  ): Promise<void> {
    this.db.prepare(`
      INSERT INTO vector_collections (name, dimension, distance, created_at)
      VALUES (?, ?, ?, ?)
    `).run(name, config.vectors.size, config.vectors.distance, Date.now())
  }

  async getCollection(name: string): Promise<any> {
    const row = this.db.prepare(
      'SELECT dimension, distance FROM vector_collections WHERE name = ?'
    ).get(name) as any

    if (!row) throw new Error(`Collection ${name} not found`)

    return {
      config: {
        params: {
          vectors: {
            size: row.dimension,
            distance: row.distance
          }
        }
      }
    }
  }

  async upsert(
    collection: string,
    options: { wait: boolean; points: VectorPoint[] }
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO vector_points (id, collection, vector, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const insertMany = this.db.transaction((points: VectorPoint[]) => {
      for (const point of points) {
        const vectorBuffer = Buffer.from(new Float32Array(point.vector).buffer)
        const payloadJson = JSON.stringify(point.payload)
        stmt.run(point.id, collection, vectorBuffer, payloadJson, Date.now())
      }
    })

    insertMany(options.points)
  }

  async query(
    collection: string,
    options: {
      query: number[]
      filter?: SearchFilter
      limit: number
      with_payload?: boolean
    }
  ): Promise<{ points: SearchResult[] }> {
    // 获取collection信息
    const collectionInfo = await this.getCollection(collection)
    const dimension = collectionInfo.config.params.vectors.size

    // 构建SQL查询
    let sql = 'SELECT id, vector, payload FROM vector_points WHERE collection = ?'
    const params: any[] = [collection]

    // 应用过滤器
    if (options.filter?.must) {
      for (const condition of options.filter.must) {
        sql += ` AND json_extract(payload, '$.${condition.key}') = ?`
        params.push(condition.match.value)
      }
    }

    const rows = this.db.prepare(sql).all(...params) as any[]

    // 计算相似度
    const queryVector = new Float32Array(options.query)
    const results: SearchResult[] = []

    for (const row of rows) {
      const vector = new Float32Array(
        (row.vector as Buffer).buffer,
        (row.vector as Buffer).byteOffset,
        dimension
      )
      const score = this.cosineSimilarity(queryVector, vector)

      results.push({
        id: row.id,
        score,
        payload: options.with_payload ? JSON.parse(row.payload) : {}
      })
    }

    // 排序并限制结果数量
    results.sort((a, b) => b.score - a.score)
    return { points: results.slice(0, options.limit) }
  }

  async delete(
    collection: string,
    options: { wait: boolean; filter: SearchFilter }
  ): Promise<void> {
    if (!options.filter?.must) {
      throw new Error('Delete requires filter')
    }

    let sql = 'DELETE FROM vector_points WHERE collection = ?'
    const params: any[] = [collection]

    for (const condition of options.filter.must) {
      sql += ` AND json_extract(payload, '$.${condition.key}') = ?`
      params.push(condition.match.value)
    }

    this.db.prepare(sql).run(...params)
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB)
    return denominator === 0 ? 0 : dotProduct / denominator
  }

  close() {
    this.db.close()
  }
}
