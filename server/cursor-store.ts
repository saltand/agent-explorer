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

/**
 * Blob ids are fixed-width hashes embedded verbatim in parent blobs. Bucketing
 * them by their first four bytes turns child lookup into a single scan of the
 * parent, instead of one `indexOf` sweep per candidate id.
 */
interface HashIndex {
  byPrefix: Map<number, Array<readonly [string, Buffer]>>
  hashLength: number
}

function buildHashIndex(hashes: Map<string, Buffer>): HashIndex {
  const byPrefix = new Map<number, Array<readonly [string, Buffer]>>()
  let hashLength = 0
  for (const [id, hash] of hashes) {
    if (hash.length < 4) continue
    hashLength = hash.length
    const prefix = hash.readUInt32BE(0)
    const bucket = byPrefix.get(prefix)
    if (bucket) bucket.push([id, hash])
    else byPrefix.set(prefix, [[id, hash]])
  }
  return { byPrefix, hashLength }
}

/** Child ids in the order their hashes appear in the parent blob. */
function childBlobIds(data: Buffer, index: HashIndex): string[] {
  const { byPrefix, hashLength } = index
  if (hashLength === 0 || data.length < hashLength) return []

  const ids: string[] = []
  const seen = new Set<string>()
  const last = data.length - hashLength
  for (let offset = 0; offset <= last; offset += 1) {
    const bucket = byPrefix.get(data.readUInt32BE(offset))
    if (!bucket) continue
    for (const [id, hash] of bucket) {
      if (seen.has(id)) continue
      if (data.compare(hash, 0, hashLength, offset, offset + hashLength) !== 0) continue
      seen.add(id)
      ids.push(id)
      break
    }
  }
  return ids
}

interface StoreBlob {
  id: string
  data: Buffer
}

function readStoreMeta(database: DatabaseSync): Record<string, unknown> | undefined {
  const metaRow = database.prepare('select value from meta limit 1').get() as
    | { value?: unknown }
    | undefined
  return decodeMetaValue(metaRow?.value)
}

/**
 * Reads just the `meta` row. Metadata-only callers use this so listing a store
 * never has to pull its blobs, which are the entire conversation by volume.
 */
function loadStoreMeta(storePath: string): Record<string, unknown> | undefined {
  const database = new DatabaseSync(storePath, { readOnly: true, timeout: 2000 })
  try {
    return readStoreMeta(database)
  } finally {
    database.close()
  }
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

    const storeMeta = readStoreMeta(database)
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
  const hashIndex = buildHashIndex(hashes)

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

    for (const child of childBlobIds(blob.data, hashIndex)) visit(child)
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
 *
 * The `-shm` file is deliberately excluded from the change signal. SQLite
 * touches that shared-memory index whenever a reader or writer connects, so its
 * mtime churns even when no conversation data changed, which would invalidate
 * the index on every scan. Its size is still counted (it is fixed-size, so it
 * does not mask edits), but a real commit always changes the db or WAL.
 */
export function cursorStoreStat(path: string): { size: number; mtimeMs: number } {
  let size = 0
  let mtimeMs = 0
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const info = statSync(candidate)
      size += info.size
      const volatile = candidate.endsWith('-shm')
      if (!volatile && info.mtimeMs > mtimeMs) mtimeMs = info.mtimeMs
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
  const storeMeta = loadStoreMeta(storePath)

  let cwd: string | undefined
  if (typeof sidecar?.cwd === 'string') cwd = sidecar.cwd
  else if (typeof storeMeta?.cwd === 'string') cwd = storeMeta.cwd

  let title: string | undefined
  if (typeof sidecar?.title === 'string') title = sidecar.title.trim() || undefined
  const storeName = typeof storeMeta?.name === 'string' ? storeMeta.name.trim() : undefined
  if (!title && storeName && storeName !== 'New Agent') title = storeName

  // Deriving a title from the transcript means decoding every blob, so only do
  // it when the store carries no usable name of its own.
  if (!title) title = titleFromStoreBlobs(storePath)

  const created =
    typeof storeMeta?.createdAt === 'number'
      ? storeMeta.createdAt
      : typeof sidecar?.createdAtMs === 'number'
        ? sidecar.createdAtMs
        : undefined

  return { cwd, title, startedAt: created }
}

/** First real user message in a store, used only as a title fallback. */
function titleFromStoreBlobs(storePath: string): string | undefined {
  let records: Record<string, unknown>[]
  try {
    records = cursorStoreRecords(storePath)
  } catch {
    return undefined
  }

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
    return candidate.length > 120 ? `${candidate.slice(0, 120)}…` : candidate
  }

  return undefined
}
