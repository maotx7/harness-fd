import { DEFAULT_WORKSPACE_ID } from './workspace.js'
import type { SqliteConnection } from './sqlite-db.js'

export interface UploadedKnowledgeDocument {
  documentId: string
  versionId: string
  sourceId: string
  jobId: string
  title: string
  createdBy: string | null
  objectKey: string
  sha256: string
  filename: string
  suffix: string
  size: number
  createdAt: number
}

export async function persistUploadedKnowledgeDocument(
  connection: SqliteConnection,
  document: UploadedKnowledgeDocument
) {
  const { documentId, versionId, sourceId, jobId, title, createdBy, objectKey, sha256, filename, suffix, size, createdAt } = document

  await connection.execute(
    `INSERT INTO kb_documents (id, workspace_id, title, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'INDEXING', ?, ?, ?)`,
    [documentId, DEFAULT_WORKSPACE_ID, title, createdBy, createdAt, createdAt]
  )

  await connection.execute(
    `INSERT INTO kb_document_versions
     (id, workspace_id, document_id, status, approved_for_reuse, raw_object_key, created_at, updated_at)
     VALUES (?, ?, ?, 'INDEXING', 0, ?, ?, ?)`,
    [versionId, DEFAULT_WORKSPACE_ID, documentId, objectKey, createdAt, createdAt]
  )

  await connection.execute(
    `INSERT INTO kb_source_files
     (id, workspace_id, version_id, object_key, sha256, original_name, source_format, size, source_uri, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sourceId, DEFAULT_WORKSPACE_ID, versionId, objectKey, sha256, filename, suffix.slice(1), size, objectKey, createdAt]
  )

  await connection.execute(
    `INSERT INTO kb_ingestion_jobs
     (id, workspace_id, document_id, version_id, status, stage, attempt_count, deduplicated, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'INDEXING', 'index', 1, 0, ?, ?)`,
    [jobId, DEFAULT_WORKSPACE_ID, documentId, versionId, createdAt, createdAt]
  )
}
