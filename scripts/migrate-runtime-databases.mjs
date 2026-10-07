#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(path.resolve('packages/workspace/plugin-kb-search/package.json'))
const Database = require('better-sqlite3')

const legacyDirectory = process.env.LEGACY_DATABASE_DIR || 'runtime'
const databases = [
  [path.join(legacyDirectory, 'harness.db'), process.env.DATABASE_PATH || 'data/harness.db'],
  [path.join(legacyDirectory, 'vectors.db'), process.env.VECTOR_DB_PATH || 'data/vectors.db']
]

for (const [legacyRelative, targetRelative] of databases) {
  const legacyPath = path.resolve(legacyRelative)
  const targetPath = path.resolve(targetRelative)

  mkdirSync(path.dirname(targetPath), { recursive: true })
  if (legacyPath === targetPath || existsSync(targetPath) || !existsSync(legacyPath)) continue

  const source = new Database(legacyPath, { readonly: true, fileMustExist: true })
  try {
    await source.backup(targetPath)
  } finally {
    source.close()
  }
  console.log(`Migrated SQLite database: ${legacyRelative} -> ${path.relative(process.cwd(), targetPath)}`)
}
