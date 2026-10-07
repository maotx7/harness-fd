/**
 * SQLite数据库适配器 - 替代MySQL
 * 兼容mysql2 Pool接口
 */
import Database from 'better-sqlite3'

export interface RowDataPacket {
  [key: string]: any
}

export interface ResultSetHeader {
  affectedRows: number
  insertId: number
}

export class SqlitePool {
  private db: Database.Database

  constructor(connectionString: string) {
    // 解析sqlite:///path格式
    const dbPath = connectionString.replace(/^sqlite:\/\/\//, '')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initSchema()
  }

  private initSchema() {
    const now = Date.now()
    this.db.exec(`
      -- 工作区表
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 用户表
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT,
        display_name TEXT,
        avatar_url TEXT,
        password_hash TEXT,
        role TEXT DEFAULT 'user',
        status TEXT DEFAULT 'active',
        login_count INTEGER DEFAULT 0,
        last_login_at INTEGER,
        last_login_ip TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      );

      -- 会话表
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        last_access_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- 对话历史表（按用户隔离）
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT,
        context TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- 对话消息表
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- 知识库文档表
      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      -- 文档版本表
      CREATE TABLE IF NOT EXISTS kb_document_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_for_reuse INTEGER DEFAULT 0,
        raw_object_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
      );

      -- 源文件表
      CREATE TABLE IF NOT EXISTS kb_source_files (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        object_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        original_name TEXT NOT NULL,
        source_format TEXT NOT NULL,
        size INTEGER NOT NULL,
        source_uri TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (version_id) REFERENCES kb_document_versions(id) ON DELETE CASCADE
      );

      -- 索引任务表
      CREATE TABLE IF NOT EXISTS kb_ingestion_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        attempt_count INTEGER DEFAULT 1,
        deduplicated INTEGER DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE,
        FOREIGN KEY (version_id) REFERENCES kb_document_versions(id) ON DELETE CASCADE
      );

      -- 信号矩阵表（用于 plugin-signal-query）
      CREATE TABLE IF NOT EXISTS kb_signal_matrices (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_code TEXT NOT NULL,
        architecture TEXT,
        network_name TEXT NOT NULL,
        owner_node TEXT NOT NULL,
        version_label TEXT NOT NULL,
        released_at TEXT,
        status TEXT DEFAULT 'DRAFT',
        node_names TEXT,
        source_object_key TEXT NOT NULL,
        source_filename TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0,
        signal_count INTEGER DEFAULT 0,
        validation_report TEXT,
        imported_by TEXT,
        reviewed_by TEXT,
        published_at TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      -- 信号矩阵导入记录表
      CREATE TABLE IF NOT EXISTS kb_signal_matrix_imports (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        matrix_id TEXT,
        status TEXT NOT NULL,
        source_filename TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        deduplicated INTEGER DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (matrix_id) REFERENCES kb_signal_matrices(id) ON DELETE CASCADE
      );

      -- 信号矩阵明细（从旧权威信号目录迁移）
      CREATE TABLE IF NOT EXISTS kb_signal_messages (
        id TEXT PRIMARY KEY,
        matrix_id TEXT NOT NULL,
        name TEXT NOT NULL,
        message_type TEXT,
        can_id TEXT,
        send_type TEXT,
        cycle_time_ms TEXT,
        length_bytes TEXT,
        fdf TEXT,
        brs TEXT,
        source_sheet TEXT NOT NULL,
        source_row INTEGER NOT NULL,
        FOREIGN KEY (matrix_id) REFERENCES kb_signal_matrices(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kb_authoritative_signals (
        id TEXT PRIMARY KEY,
        matrix_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        name TEXT NOT NULL,
        chinese_description TEXT,
        english_description TEXT,
        byte_order TEXT,
        start_byte TEXT,
        start_bit TEXT,
        bit_length TEXT,
        end_bit TEXT,
        send_type TEXT,
        data_type TEXT,
        resolution TEXT,
        offset TEXT,
        physical_min TEXT,
        physical_max TEXT,
        bus_min TEXT,
        bus_max TEXT,
        initial_value TEXT,
        invalid_value TEXT,
        inactive_value TEXT,
        unit TEXT,
        value_description TEXT,
        security_level TEXT,
        configuration TEXT,
        explanation TEXT,
        source_sheet TEXT NOT NULL,
        source_row INTEGER NOT NULL,
        FOREIGN KEY (matrix_id) REFERENCES kb_signal_matrices(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES kb_signal_messages(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kb_signal_endpoints (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        controller_name TEXT NOT NULL,
        direction TEXT NOT NULL,
        FOREIGN KEY (signal_id) REFERENCES kb_authoritative_signals(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kb_signal_message_endpoints (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        controller_name TEXT NOT NULL,
        direction TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES kb_signal_messages(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kb_signal_values (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        code TEXT NOT NULL,
        description TEXT NOT NULL,
        display_order INTEGER NOT NULL,
        FOREIGN KEY (signal_id) REFERENCES kb_authoritative_signals(id) ON DELETE CASCADE
      );

      -- 项目表（用于 plugin-workflow-mgmt）
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      -- 任务表（用于 plugin-workflow-mgmt）
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'todo',
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_kb_documents_workspace
        ON kb_documents(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_kb_documents_updated
        ON kb_documents(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_kb_documents_created_by
        ON kb_documents(created_by);
      CREATE INDEX IF NOT EXISTS idx_kb_source_files_sha256
        ON kb_source_files(sha256);
      CREATE INDEX IF NOT EXISTS idx_kb_versions_document
        ON kb_document_versions(document_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_user
        ON conversations(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_username
        ON users(username);
      CREATE INDEX IF NOT EXISTS idx_signal_matrices_workspace
        ON kb_signal_matrices(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_signal_matrices_sha256
        ON kb_signal_matrices(source_sha256);
      CREATE INDEX IF NOT EXISTS idx_signal_matrices_created
        ON kb_signal_matrices(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signal_messages_matrix
        ON kb_signal_messages(matrix_id);
      CREATE INDEX IF NOT EXISTS idx_signal_signals_matrix
        ON kb_authoritative_signals(matrix_id);
      CREATE INDEX IF NOT EXISTS idx_signal_signals_message
        ON kb_authoritative_signals(message_id);
      CREATE INDEX IF NOT EXISTS idx_signal_endpoints_signal
        ON kb_signal_endpoints(signal_id);
      CREATE INDEX IF NOT EXISTS idx_signal_message_endpoints_message
        ON kb_signal_message_endpoints(message_id);
      CREATE INDEX IF NOT EXISTS idx_signal_values_signal
        ON kb_signal_values(signal_id);
      CREATE INDEX IF NOT EXISTS idx_projects_workspace
        ON projects(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_project
        ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status
        ON tasks(status);
    `)

    this.ensureSignalSchemaCompatibility()

    // 插入默认工作区（使用变量避免模板字符串问题）
    this.db.prepare(`
      INSERT OR IGNORE INTO workspaces (id, name, is_default, created_at, updated_at)
      VALUES ('shared', '共享工作区', 1, ?, ?)
    `).run(now, now)
  }

  private ensureSignalSchemaCompatibility() {
    const matrixColumns = new Set(
      this.db.prepare('PRAGMA table_info(kb_signal_matrices)').all().map((column: any) => column.name)
    )
    for (const [name, type] of [['reviewed_by', 'TEXT'], ['published_at', 'TEXT']] as const) {
      if (!matrixColumns.has(name)) this.db.exec(`ALTER TABLE kb_signal_matrices ADD COLUMN ${name} ${type}`)
    }

    const importColumns = this.db.prepare('PRAGMA table_info(kb_signal_matrix_imports)').all() as any[]
    const importColumnNames = new Set(importColumns.map(column => column.name))
    for (const [name, type] of [['error_code', 'TEXT'], ['error_message', 'TEXT']] as const) {
      if (!importColumnNames.has(name)) this.db.exec(`ALTER TABLE kb_signal_matrix_imports ADD COLUMN ${name} ${type}`)
    }

    // Older SQLite databases declared matrix_id NOT NULL, which made it
    // impossible to preserve legacy FAILED imports that have no matrix.
    const matrixIdColumn = importColumns.find(column => column.name === 'matrix_id')
    if (matrixIdColumn?.notnull) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        CREATE TABLE kb_signal_matrix_imports_new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          matrix_id TEXT,
          status TEXT NOT NULL,
          source_filename TEXT NOT NULL,
          source_sha256 TEXT NOT NULL,
          deduplicated INTEGER DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (matrix_id) REFERENCES kb_signal_matrices(id) ON DELETE CASCADE
        );
        INSERT INTO kb_signal_matrix_imports_new
          (id, workspace_id, matrix_id, status, source_filename, source_sha256,
           deduplicated, error_code, error_message, created_at, updated_at)
        SELECT id, workspace_id, matrix_id, status, source_filename, source_sha256,
               deduplicated, error_code, error_message, created_at, updated_at
        FROM kb_signal_matrix_imports;
        DROP TABLE kb_signal_matrix_imports;
        ALTER TABLE kb_signal_matrix_imports_new RENAME TO kb_signal_matrix_imports;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `)
    }
  }

  async execute<T = any>(sql: string, params: any[] = []): Promise<[T[], any]> {
    // 转换MySQL的NOW()为SQLite的时间戳
    const sqliteSql = sql
      .replace(/NOW\(\)/g, Date.now().toString())
      .replace(/ON DUPLICATE KEY UPDATE/gi, 'ON CONFLICT DO UPDATE SET')

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

  async getConnection(): Promise<SqliteConnection> {
    return new SqliteConnection(this.db)
  }

  async end(): Promise<void> {
    this.db.close()
  }
}

export class SqliteConnection {
  private inTransaction = false

  constructor(private db: Database.Database) {}

  async beginTransaction(): Promise<void> {
    this.db.prepare('BEGIN TRANSACTION').run()
    this.inTransaction = true
  }

  async commit(): Promise<void> {
    this.db.prepare('COMMIT').run()
    this.inTransaction = false
  }

  async rollback(): Promise<void> {
    this.db.prepare('ROLLBACK').run()
    this.inTransaction = false
  }

  async execute<T = any>(sql: string, params: any[] = []): Promise<[T[], any]> {
    const sqliteSql = sql
      .replace(/NOW\(\)/g, Date.now().toString())
      .replace(/ON DUPLICATE KEY UPDATE/gi, 'ON CONFLICT DO UPDATE SET')

    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      const rows = this.db.prepare(sqliteSql).all(...params)
      return [rows as T[], {}]
    }

    const result = this.db.prepare(sqliteSql).run(...params)
    return [[] as T[], { affectedRows: result.changes }]
  }

  release(): void {
    if (this.inTransaction) {
      this.rollback()
    }
  }
}

export function createPool(connectionString: string): SqlitePool {
  return new SqlitePool(connectionString)
}
