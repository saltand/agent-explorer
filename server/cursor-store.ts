import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { extractUserQuery } from './extract'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asBytes(value: unknown): Buffer | undefined {
  if (value instanceof Buffer) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return undefined
}

function parseJson(data: Buffer): Record<string, unknown> | undefined {
  if (data.length === 0 || (data[0] !== 0x7b && data[0] !== 0x5b)) return undefined
  try {
    const parsed: unknown = JSON.parse(data.toString('utf8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function decodeMetaValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const hex = value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value)
    const text = hex ? Buffer.from(value, 'hex').toString('utf8') : value
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function readSidecarMeta(storePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dirname(storePath), 'meta.json'), 'utf8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function normalizeContent(content: unknown): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.map((part) => {
    if (!isRecord(part)) return part
    if (part.type === 'reasoning') {
      const text =
        (typeof part.text === 'string' && part.text) ||
        (typeof part.thinking === 'string' && part.thinking) ||
        ''
      return { type: 'thinking', thinking: text }
    }
    return part
  })
}

function toTranscriptRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const role = record.role
  if (typeof role !== 'string') return undefined
  return {
    role,
    message: { content: normalizeContent(record.content) },
  }
}

function childBlobIds(data: Buffer, hashes: Map<string, Buffer>): string[] {
  const found: Array<{ offset: number; id: string }> = []
  for (const [id, hash] of hashes) {
    let from = 0
    while (from + hash.length <= data.length) {
      const offset = data.indexOf(hash, from)
      if (offset === -1) break
      found.push({ offset, id })
      from = offset + hash.length
    }
  }
  found.sort((a, b) => a.offset - b.offset)
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of found) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    ids.push(item.id)
  }
  return ids
}

interface StoreBlob {
  id: string
  data: Buffer
}

function loadBlobs(storePath: string): { blobs: StoreBlob[]; rootId?: string; storeMeta?: Record<string, unknown> } {
  const database = new DatabaseSync(storePath, { readOnly: true, timeout: 2000 })
  try {
    const blobs = database
      .prepare('select id, data from blobs')
      .all()
      .flatMap((row) => {
        const record = row as { id?: unknown; data?: unknown }
        if (typeof record.id !== 'string') return []
        const data = asBytes(record.data)
        if (!data) return []
        return [{ id: record.id, data }]
      })

    const metaRow = database.prepare('select value from meta limit 1').get() as
      | { value?: unknown }
      | undefined
    const storeMeta = decodeMetaValue(metaRow?.value)
    const rootId =
      typeof storeMeta?.latestRootBlobId === 'string' ? storeMeta.latestRootBlobId : undefined
    return { blobs, rootId, storeMeta }
  } finally {
    database.close()
  }
}

function orderedRecords(blobs: StoreBlob[], rootId?: string): Record<string, unknown>[] {
  const byId = new Map(blobs.map((blob) => [blob.id, blob]))
  const hashes = new Map(
    blobs.flatMap((blob) => {
      try {
        return [[blob.id, Buffer.from(blob.id, 'hex')] as const]
      } catch {
        return []
      }
    }),
  )

  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()

  function visit(id: string): void {
    if (seen.has(id)) return
    const blob = byId.get(id)
    if (!blob) return
    seen.add(id)

    const json = parseJson(blob.data)
    if (json) {
      const record = toTranscriptRecord(json)
      if (record) out.push(record)
      return
    }

    for (const child of childBlobIds(blob.data, hashes)) visit(child)
  }

  if (rootId && byId.has(rootId)) visit(rootId)

  if (out.length === 0) {
    for (const blob of blobs) {
      const json = parseJson(blob.data)
      if (!json) continue
      const record = toTranscriptRecord(json)
      if (record) out.push(record)
    }
  }

  return out
}

/** True when this path is a Cursor ACP / CLI SQLite conversation store. */
export function isCursorStorePath(path: string): boolean {
  return basename(path) === 'store.db'
}

/**
 * Size and mtime include the WAL: Cursor often leaves the main db at 4 KB
 * while the conversation lives in `store.db-wal`.
 */
export function cursorStoreStat(path: string): { size: number; mtimeMs: number } {
  const paths = [path, `${path}-wal`, `${path}-shm`]
  let size = 0
  let mtimeMs = 0
  for (const candidate of paths) {
    try {
      const info = statSync(candidate)
      size += info.size
      if (info.mtimeMs > mtimeMs) mtimeMs = info.mtimeMs
    } catch {
      // Sidecar files are optional.
    }
  }
  return { size, mtimeMs }
}

export function cursorStoreRecords(storePath: string): Record<string, unknown>[] {
  const { blobs, rootId } = loadBlobs(storePath)
  return orderedRecords(blobs, rootId)
}

export function cursorStoreToJsonl(storePath: string): string {
  return cursorStoreRecords(storePath)
    .map((record) => JSON.stringify(record))
    .join('\n')
}

export function summarizeCursorStore(storePath: string): {
  cwd?: string
  title?: string
  startedAt?: number
} {
  const sidecar = readSidecarMeta(storePath)
  const { blobs, rootId, storeMeta } = loadBlobs(storePath)
  const records = orderedRecords(blobs, rootId)

  let cwd: string | undefined
  if (typeof sidecar?.cwd === 'string') cwd = sidecar.cwd
  else if (typeof storeMeta?.cwd === 'string') cwd = storeMeta.cwd

  let title: string | undefined
  if (typeof sidecar?.title === 'string') title = sidecar.title.trim() || undefined
  const storeName = typeof storeMeta?.name === 'string' ? storeMeta.name.trim() : undefined
  if (!title && storeName && storeName !== 'New Agent') title = storeName

  if (!title) {
    for (const record of records) {
      if (record.role !== 'user' || !isRecord(record.message)) continue
      const content = record.message.content
      const texts: string[] = []
      if (Array.isArray(content)) {
        for (const part of content) {
          if (isRecord(part) && typeof part.text === 'string') texts.push(part.text)
        }
      }
      const text = texts.join('\n')
      const query = extractUserQuery(text)
      const candidate = (query ?? text).replace(/\s+/g, ' ').trim()
      if (!candidate || candidate.startsWith('<')) continue
      title = candidate.length > 120 ? `${candidate.slice(0, 120)}…` : candidate
      break
    }
  }

  const created =
    typeof storeMeta?.createdAt === 'number'
      ? storeMeta.createdAt
      : typeof sidecar?.createdAtMs === 'number'
        ? sidecar.createdAtMs
        : undefined

  return { cwd, title, startedAt: created }
}
