import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SqlitePool } from '../dist/sqlite-db.js'
import { persistUploadedKnowledgeDocument } from '../dist/knowledge-storage.js'
import { DEFAULT_WORKSPACE_ID } from '../dist/workspace.js'

test('persists an uploaded document and its related records in the seeded workspace', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kb-upload-'))
  const pool = new SqlitePool(path.join(directory, 'knowledge.db'))
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()
    await persistUploadedKnowledgeDocument(connection, {
      documentId: 'document-1',
      versionId: 'version-1',
      sourceId: 'source-1',
      jobId: 'job-1',
      title: '测试文档',
      createdBy: null,
      objectKey: '/tmp/document.pdf',
      sha256: 'abc123',
      filename: 'document.pdf',
      suffix: '.pdf',
      size: 42,
      createdAt: 1000
    })
    await connection.commit()

    const [rows] = await pool.execute(
      `SELECT d.workspace_id AS document_workspace, v.workspace_id AS version_workspace,
              s.workspace_id AS source_workspace, j.workspace_id AS job_workspace,
              d.title, s.original_name
       FROM kb_documents d
       JOIN kb_document_versions v ON v.document_id = d.id
       JOIN kb_source_files s ON s.version_id = v.id
       JOIN kb_ingestion_jobs j ON j.document_id = d.id
       WHERE d.id = ?`,
      ['document-1']
    )

    assert.equal(DEFAULT_WORKSPACE_ID, 'shared')
    assert.equal(rows.length, 1)
    assert.deepEqual(
      [rows[0].document_workspace, rows[0].version_workspace, rows[0].source_workspace, rows[0].job_workspace],
      [DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID]
    )
    assert.equal(rows[0].title, '测试文档')
    assert.equal(rows[0].original_name, 'document.pdf')
  } finally {
    connection.release()
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  }
})
