#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import YAML from 'yaml'

const [sourcePath, runtimePath] = process.argv.slice(2)

if (!sourcePath || !runtimePath) {
  throw new Error('usage: merge-profile-patch.mjs <source-patch> <runtime-patch>')
}

const uiOwnedIds = new Set([
  'agent-default-model',
  'llm-deepseek',
  'llm-deepseek-account',
  'llm-pi-ai'
])
const cordisTags = [{
  tag: 'tag:yaml.org,2002:js',
  resolve: value => value,
  stringify: item => item.value
}]

function parsePatch(source, filename) {
  const document = YAML.parseDocument(source, { customTags: cordisTags, keepSourceTokens: true })
  if (document.errors.length > 0) {
    throw new Error(`${filename} is not valid YAML: ${document.errors[0].message}`)
  }
  if (!YAML.isSeq(document.contents)) {
    throw new Error(`${filename} must contain a YAML sequence`)
  }
  return document
}

function entryId(node) {
  if (!YAML.isMap(node)) return undefined
  const id = node.get('id', true)
  return YAML.isScalar(id) && typeof id.value === 'string' ? id.value : undefined
}

const sourceDocument = parsePatch(await readFile(sourcePath, 'utf8'), sourcePath)
let runtimeDocument
try {
  runtimeDocument = parsePatch(await readFile(runtimePath, 'utf8'), runtimePath)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

if (runtimeDocument) {
  const runtimeOverrides = new Map()
  const runtimeExtras = []
  const sourceIds = new Set(sourceDocument.contents.items.map(entryId).filter(Boolean))

  for (const entry of runtimeDocument.contents.items) {
    const id = entryId(entry)
    if (!id) continue
    if (uiOwnedIds.has(id)) {
      runtimeOverrides.set(id, entry)
    } else if (!sourceIds.has(id)) {
      runtimeExtras.push(entry)
    }
  }

  sourceDocument.contents.items = sourceDocument.contents.items.filter(entry => {
    const id = entryId(entry)
    return !id || !runtimeOverrides.has(id)
  })
  sourceDocument.contents.items.push(...runtimeExtras, ...runtimeOverrides.values())
}

const destinationDir = path.dirname(runtimePath)
const temporaryPath = path.join(destinationDir, `.cordis.patch.${process.pid}.tmp`)
await mkdir(destinationDir, { recursive: true })

let mode = 0o600
try {
  mode = (await stat(runtimePath)).mode & 0o777
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

await writeFile(temporaryPath, sourceDocument.toString(), { mode })
await chmod(temporaryPath, mode)
await rename(temporaryPath, runtimePath)
