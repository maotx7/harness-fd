#!/usr/bin/env node

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import process from 'node:process'

const require = createRequire(import.meta.url)
const mysql = require(path.resolve('packages/workspace/plugin-auth/node_modules/mysql2/promise.js'))
const Database = require(path.resolve('packages/workspace/plugin-kb-search/node_modules/better-sqlite3'))
const { createPool } = await import(pathToFileURL(path.resolve('packages/workspace/plugin-kb-search/dist/sqlite-db.js')).href)

const root = process.cwd()
const sqlitePath = path.resolve(process.env.SQLITE_PATH || 'data/harness.db')
const storageRoot = path.resolve(process.env.SIGNAL_STORAGE_ROOT || 'runtime/dsh-catalog/signals')
const mysqlUrl = process.env.LEGACY_MYSQL_URL || 'mysql://hermes:hermes@127.0.0.1:13306/hermes'
const minioEndpoint = process.env.MINIO_ENDPOINT || 'http://127.0.0.1:19000'
const minioAccessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin'
const minioSecretKey = process.env.MINIO_SECRET_KEY || 'minioadmin'
const minioBucket = process.env.MINIO_BUCKET || 'hermes-artifacts'
const targetWorkspace = process.env.TARGET_WORKSPACE_ID || 'shared'

function jsonText(value) {
  if (value == null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function mysqlTimestamp(value) {
  if (value == null) return null
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const numeric = Number(value)
    return numeric < 1e12 ? numeric * 1000 : numeric
  }
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value).replace(' ', 'T') + 'Z')
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid legacy timestamp: ${value}`)
  return timestamp
}

function localObjectName(matrix) {
  return `${matrix.id}-${matrix.source_sha256}.xlsx`
}

function makeUpsert(db, table, columns) {
  const names = ['id', ...columns]
  const updates = columns.map(column => `${column} = excluded.${column}`).join(', ')
  return db.prepare(`
    INSERT INTO ${table} (${names.join(', ')})
    VALUES (${names.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${updates}
  `)
}

function downloadSource(matrix) {
  const sourceKey = String(matrix.source_object_key)
  if (!sourceKey.startsWith('knowledge/signals/')) {
    throw new Error(`Unsupported legacy source key for ${matrix.id}: ${sourceKey}`)
  }
  const destination = path.join(storageRoot, localObjectName(matrix))
  mkdirSync(storageRoot, { recursive: true })
  const expectedSize = Number(matrix.source_size)
  try {
    if (statSync(destination).size === expectedSize && fileSha256(destination) === matrix.source_sha256) return destination
  } catch {
    // The source has not been copied yet.
  }

  const source = `legacy/${minioBucket}/${sourceKey}`
  // mc reads credentials from the URL in MC_HOST_<alias>.
  const endpointUrl = new URL(minioEndpoint)
  const env = {
    ...process.env,
    MC_HOST_legacy: `${endpointUrl.protocol}//${minioAccessKey}:${minioSecretKey}@${endpointUrl.host}`
  }
  execFileSync('docker', [
    'run', '--rm', '--network', 'host',
    '-e', `MC_HOST_legacy=${env.MC_HOST_legacy}`,
    '-v', `${storageRoot}:/out`,
    'minio/mc:latest', 'cp', source, `/out/${localObjectName(matrix)}`
  ], { cwd: root, env, stdio: 'inherit' })
  if (statSync(destination).size !== expectedSize || fileSha256(destination) !== matrix.source_sha256) {
    throw new Error(`Downloaded source validation failed for ${matrix.id}`)
  }
  return destination
}

function fileSha256(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

async function main() {
  const legacy = await mysql.createConnection(mysqlUrl)
  // Let the application schema adapter add columns/rebuild legacy tables before
  // the migration opens its own SQLite connection.
  const schemaPool = createPool(`sqlite:///${sqlitePath}`)
  await schemaPool.end()
  const sqlite = new Database(sqlitePath)
  sqlite.pragma('foreign_keys = ON')

  try {
    const requiredTables = ['workspaces', 'kb_signal_matrices', 'kb_signal_matrix_imports']
    for (const table of requiredTables) {
      const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      if (!exists) throw new Error(`Target SQLite table is missing: ${table}. Start the service once before migrating.`)
    }

    const [matrices] = await legacy.query(`
      SELECT id, project_code, architecture, network_name, owner_node, version_label,
             released_at, status, node_names, source_object_key, source_filename,
             source_sha256, source_size, message_count, signal_count, validation_report,
             imported_by, reviewed_by, published_at,
             UNIX_TIMESTAMP(created_at) * 1000 AS created_at_ms,
             UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at_ms
      FROM kb_signal_matrices
      ORDER BY created_at ASC
    `)
    const [imports] = await legacy.query(`
      SELECT id, matrix_id, status, source_filename, source_sha256, deduplicated,
             error_code, error_message,
             UNIX_TIMESTAMP(created_at) * 1000 AS created_at_ms,
             UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at_ms
      FROM kb_signal_matrix_imports
      ORDER BY created_at ASC
    `)
    const [messages] = await legacy.query('SELECT * FROM kb_signal_messages')
    const [signals] = await legacy.query('SELECT * FROM kb_authoritative_signals')
    const [signalEndpoints] = await legacy.query('SELECT * FROM kb_signal_endpoints')
    const [messageEndpoints] = await legacy.query('SELECT * FROM kb_signal_message_endpoints')
    const [signalValues] = await legacy.query('SELECT * FROM kb_signal_values')

    const insertMatrix = sqlite.prepare(`
      INSERT INTO kb_signal_matrices
        (id, workspace_id, project_code, architecture, network_name, owner_node,
         version_label, released_at, status, node_names, source_object_key,
         source_filename, source_sha256, source_size, message_count, signal_count,
         validation_report, imported_by, reviewed_by, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        project_code = excluded.project_code,
        architecture = excluded.architecture,
        network_name = excluded.network_name,
        owner_node = excluded.owner_node,
        version_label = excluded.version_label,
        released_at = excluded.released_at,
        status = excluded.status,
        node_names = excluded.node_names,
        source_object_key = excluded.source_object_key,
        source_filename = excluded.source_filename,
        source_sha256 = excluded.source_sha256,
        source_size = excluded.source_size,
        message_count = excluded.message_count,
        signal_count = excluded.signal_count,
        validation_report = excluded.validation_report,
        imported_by = excluded.imported_by,
        reviewed_by = excluded.reviewed_by,
        published_at = excluded.published_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `)
    const insertImport = sqlite.prepare(`
      INSERT INTO kb_signal_matrix_imports
        (id, workspace_id, matrix_id, status, source_filename, source_sha256,
         deduplicated, error_code, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        matrix_id = excluded.matrix_id,
        status = excluded.status,
        source_filename = excluded.source_filename,
        source_sha256 = excluded.source_sha256,
        deduplicated = excluded.deduplicated,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `)
    const insertMessage = makeUpsert(sqlite, 'kb_signal_messages', [
      'matrix_id', 'name', 'message_type', 'can_id', 'send_type', 'cycle_time_ms',
      'length_bytes', 'fdf', 'brs', 'source_sheet', 'source_row'
    ])
    const insertSignal = makeUpsert(sqlite, 'kb_authoritative_signals', [
      'matrix_id', 'message_id', 'name', 'chinese_description', 'english_description',
      'byte_order', 'start_byte', 'start_bit', 'bit_length', 'end_bit', 'send_type',
      'data_type', 'resolution', 'offset', 'physical_min', 'physical_max', 'bus_min',
      'bus_max', 'initial_value', 'invalid_value', 'inactive_value', 'unit',
      'value_description', 'security_level', 'configuration', 'explanation',
      'source_sheet', 'source_row'
    ])
    const insertSignalEndpoint = makeUpsert(sqlite, 'kb_signal_endpoints', [
      'signal_id', 'controller_name', 'direction'
    ])
    const insertMessageEndpoint = makeUpsert(sqlite, 'kb_signal_message_endpoints', [
      'message_id', 'controller_name', 'direction'
    ])
    const insertSignalValue = makeUpsert(sqlite, 'kb_signal_values', [
      'signal_id', 'code', 'description', 'display_order'
    ])

    const migrate = sqlite.transaction(() => {
      const now = Date.now()
      sqlite.prepare(`
        INSERT INTO workspaces (id, name, is_default, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(targetWorkspace, '共享工作区', now, now)

      for (const matrix of matrices) {
        const localPath = downloadSource(matrix)
        insertMatrix.run(
          matrix.id, targetWorkspace, matrix.project_code, matrix.architecture,
          matrix.network_name, matrix.owner_node, matrix.version_label,
          matrix.released_at == null ? null : String(matrix.released_at), matrix.status,
          jsonText(matrix.node_names), localPath, matrix.source_filename, matrix.source_sha256,
          Number(matrix.source_size), Number(matrix.message_count), Number(matrix.signal_count),
          jsonText(matrix.validation_report), matrix.imported_by, matrix.reviewed_by,
          matrix.published_at == null ? null : mysqlTimestamp(matrix.published_at),
          mysqlTimestamp(matrix.created_at_ms), mysqlTimestamp(matrix.updated_at_ms)
        )
      }
      for (const entry of imports) {
        insertImport.run(
          entry.id, targetWorkspace, entry.matrix_id || null, entry.status,
          entry.source_filename, entry.source_sha256, Number(entry.deduplicated) ? 1 : 0,
          entry.error_code, entry.error_message, mysqlTimestamp(entry.created_at_ms),
          mysqlTimestamp(entry.updated_at_ms)
        )
      }
      for (const row of messages) insertMessage.run(...messageColumns(row))
      for (const row of signals) insertSignal.run(...signalColumns(row))
      for (const row of signalEndpoints) insertSignalEndpoint.run(...endpointColumns(row))
      for (const row of messageEndpoints) insertMessageEndpoint.run(...messageEndpointColumns(row))
      for (const row of signalValues) insertSignalValue.run(...valueColumns(row))
    })

    migrate()
    console.log(`Migrated ${matrices.length} matrices, ${imports.length} imports, ${messages.length} messages, ${signals.length} signals, ${signalEndpoints.length} signal endpoints, ${messageEndpoints.length} message endpoints, and ${signalValues.length} signal values into ${sqlitePath}`)
    for (const matrix of matrices) console.log(`  ${matrix.id}: ${localObjectName(matrix)}`)
  } finally {
    sqlite.close()
    await legacy.end()
  }
}

function messageColumns(row) {
  return [row.id, row.matrix_id, row.name, row.message_type, row.can_id, row.send_type,
    row.cycle_time_ms, row.length_bytes, row.fdf, row.brs, row.source_sheet, Number(row.source_row)]
}

function signalColumns(row) {
  return [row.id, row.matrix_id, row.message_id, row.name, row.chinese_description,
    row.english_description, row.byte_order, row.start_byte, row.start_bit, row.bit_length,
    row.end_bit, row.send_type, row.data_type, row.resolution, row.offset, row.physical_min,
    row.physical_max, row.bus_min, row.bus_max, row.initial_value, row.invalid_value,
    row.inactive_value, row.unit, row.value_description, row.security_level,
    row.configuration, row.explanation, row.source_sheet, Number(row.source_row)]
}

function endpointColumns(row) {
  return [row.id, row.signal_id, row.controller_name, row.direction]
}

function messageEndpointColumns(row) {
  return [row.id, row.message_id, row.controller_name, row.direction]
}

function valueColumns(row) {
  return [row.id, row.signal_id, row.code, row.description, Number(row.display_order)]
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
})
