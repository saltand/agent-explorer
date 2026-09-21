import { createReadStream } from 'node:fs'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { AgentKind, AgentRoot } from './agents'
import { isIndexedSessionFile } from './agents'
import {
  cursorStoreStat,
  cursorStoreToJsonl,
  isCursorStorePath,
  summarizeCursorStore,
} from './cursor-store'
import { extractUserQuery } from './extract'

export interface SessionSummary {
  /** Stable id derived from the absolute path. */
  id: string
  path: string
  agent: AgentKind
  fileName: string
  /** Project directory the session ran in, when the log records one. */
  cwd?: string
  size: number
  mtimeMs: number
  /** First timestamp found in the head of the file. */
  startedAt?: number
  /** Last timestamp found in the tail of the file. */
  endedAt?: number
  title?: string
}

const TAIL_BYTES = 256 * 1024
/** Caps for the head probe. Records can be tens of KB, so bound both axes. */
const HEAD_MAX_LINES = 60
const HEAD_MAX_BYTES = 1024 * 1024

export function sessionIdForPath(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url')
}

export function pathForSessionId(id: string): string {
  return Buffer.from(id, 'base64url').toString('utf8')
}

async function readTail(path: string, size: number, bytes: number): Promise<string> {
  const start = Math.max(0, size - bytes)
  const handle = await open(path, 'r')
  try {
    const length = size - start
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/** Timestamps live under different keys per agent, so probe the known ones. */
function timestampFromRecord(record: Record<string, unknown>): number | undefined {
  const direct = parseTimestamp(record.timestamp)
  if (direct !== undefined) return direct
  if (isRecord(record.payload)) {
    const payload = parseTimestamp(record.payload.timestamp)
    if (payload !== undefined) return payload
  }
  return undefined
}

function cwdFromRecord(record: Record<string, unknown>): string | undefined {
  if (typeof record.cwd === 'string') return record.cwd
  if (isRecord(record.payload) && typeof record.payload.cwd === 'string') {
    return record.payload.cwd
  }
  return undefined
}

function recordRole(record: Record<string, unknown>): string | undefined {
  if (typeof record.synthetic_reason === 'string') return undefined
  if (typeof record.role === 'string') return record.role
  const message = isRecord(record.message) ? record.message : undefined
  if (message && typeof message.role === 'string') return message.role
  const payload = isRecord(record.payload) ? record.payload : undefined
  if (payload && typeof payload.role === 'string') return payload.role
  if (record.type === 'user' || record.type === 'assistant') return record.type
  return undefined
}

function recordContent(record: Record<string, unknown>): unknown {
  const message = isRecord(record.message) ? record.message : undefined
  const payload = isRecord(record.payload) ? record.payload : undefined
  return message?.content ?? payload?.content ?? record.content ?? record.text
}

/**
 * Best-effort first user message, used as the session title. Each agent nests
 * the role differently: Codex under `payload`, Pi/Cursor under `message`,
 * Claude and Grok use a top-level `type`.
 */
function titleFromRecord(record: Record<string, unknown>): string | undefined {
  if (recordRole(record) !== 'user') return undefined
  const text = extractText(recordContent(record))
  if (!text) return undefined
  const query = extractUserQuery(text)
  if (query) return cleanTitle(query) ?? query
  return cleanTitle(text)
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    if (!isRecord(part)) continue
    const text = part.text
    if (typeof text === 'string' && text.trim()) return text
  }
  return undefined
}

/**
 * Agents inject context blocks as synthetic user turns. Those make useless
 * titles, so skip them rather than showing XML to the user.
 */
function cleanTitle(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('<')) return undefined
  if (trimmed.startsWith('# ') && trimmed.length > 400) return undefined
  const normalized = trimmed.replace(/\s+/g, ' ')
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized
}

function completeLines(chunk: string, dropFirst: boolean): string[] {
  const lines = chunk.split('\n')
  if (dropFirst && lines.length > 1) lines.shift()
  return lines.filter((line) => line.trim().length > 0)
}

async function summarizeFile(
  path: string,
  agent: AgentKind,
  size: number,
  mtimeMs: number,
): Promise<SessionSummary> {
  const parentName = basename(dirname(path))
  const summary: SessionSummary = {
    id: sessionIdForPath(path),
    path,
    agent,
    fileName:
      basename(path) === 'chat_history.jsonl' || basename(path) === 'store.db'
        ? parentName
        : basename(path),
    size,
    mtimeMs,
  }

  if (isCursorStorePath(path)) {
    try {
      const extra = summarizeCursorStore(path)
      summary.cwd ??= extra.cwd
      summary.title ??= extra.title
      summary.startedAt ??= extra.startedAt
    } catch {
      // Unreadable stores still appear with stat-only metadata.
    }
    summary.endedAt ??= mtimeMs
    return summary
  }

  await applySidecarMetadata(path, summary)

  try {
    let lineCount = 0
    let byteCount = 0
    let lastHeadTimestamp: number | undefined

    for await (const line of streamLines(path)) {
      lineCount += 1
      byteCount += Buffer.byteLength(line, 'utf8') + 1

      if (line.trim()) {
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          record = undefined
        }
        if (isRecord(record)) {
          const ts = timestampFromRecord(record)
          if (ts !== undefined) {
            summary.startedAt ??= ts
            lastHeadTimestamp = ts
          }
          summary.cwd ??= cwdFromRecord(record)
          summary.title ??= titleFromRecord(record)
        }
      }

      const complete = summary.startedAt !== undefined && summary.cwd && summary.title
      if (complete || lineCount >= HEAD_MAX_LINES || byteCount >= HEAD_MAX_BYTES) break
    }

    // Small files were fully covered by the head pass already.
    if (byteCount < size) {
      const tail = await readTail(path, size, TAIL_BYTES)
      // The first line of a tail read is usually a partial record.
      for (const line of completeLines(tail, true).reverse()) {
        try {
          const record: unknown = JSON.parse(line)
          if (!isRecord(record)) continue
          const ts = timestampFromRecord(record)
          if (ts !== undefined) {
            summary.endedAt = ts
            break
          }
        } catch {
          continue
        }
      }
    } else if (lastHeadTimestamp !== undefined) {
      summary.endedAt = lastHeadTimestamp
    }
  } catch {
    // Unreadable files still show up in the list with stat-only metadata.
  }

  summary.endedAt ??= mtimeMs
  return summary
}

async function applySidecarMetadata(path: string, summary: SessionSummary): Promise<void> {
  if (basename(path) !== 'chat_history.jsonl') return

  const sidecarPath = join(dirname(path), 'summary.json')
  try {
    const raw: unknown = JSON.parse(await readFile(sidecarPath, 'utf8'))
    if (!isRecord(raw)) return
    const info = isRecord(raw.info) ? raw.info : undefined
    if (typeof info?.cwd === 'string') summary.cwd ??= info.cwd
    if (typeof raw.generated_title === 'string') summary.title ??= cleanTitle(raw.generated_title)
    if (typeof raw.session_summary === 'string') summary.title ??= cleanTitle(raw.session_summary)
    const created = parseTimestamp(raw.created_at)
    if (created !== undefined) summary.startedAt ??= created
    const updated = parseTimestamp(raw.updated_at ?? raw.last_active_at)
    if (updated !== undefined) summary.endedAt ??= updated
  } catch {
    // Sidecar is optional; JSONL probing still fills what it can.
  }

  if (!summary.cwd) {
    try {
      const decoded = decodeURIComponent(basename(dirname(dirname(path))))
      if (decoded.startsWith('/')) summary.cwd = decoded
    } catch {
      // Encoded parent is best-effort.
    }
  }
}

async function collectJsonlFiles(dir: string, out: string[], fileName?: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  const subdirs: string[] = []
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      subdirs.push(full)
    } else if (entry.isFile()) {
      const matches = fileName ? entry.name === fileName : entry.name.endsWith('.jsonl')
      if (matches) out.push(full)
    }
  }

  await Promise.all(subdirs.map((sub) => collectJsonlFiles(sub, out, fileName)))
}

export async function scanSessions(roots: AgentRoot[]): Promise<SessionSummary[]> {
  const perRoot = await Promise.all(
    roots.map(async (root) => {
      const files: string[] = []
      await collectJsonlFiles(root.dir, files, root.fileName)
      return { root, files }
    }),
  )

  const summaries: SessionSummary[] = []
  for (const { root, files } of perRoot) {
    const results = await Promise.all(
      files.map(async (file) => {
        try {
          if (!isIndexedSessionFile(file, root)) return undefined
          const info = isCursorStorePath(file) ? cursorStoreStat(file) : await stat(file)
          const size = 'size' in info ? info.size : 0
          const mtimeMs = 'mtimeMs' in info ? info.mtimeMs : 0
          if (size === 0) return undefined
          return await summarizeFile(file, root.agent, size, mtimeMs)
        } catch {
          return undefined
        }
      }),
    )
    for (const result of results) {
      if (result) summaries.push(result)
    }
  }

  summaries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return summaries
}

export async function summarizeOne(
  path: string,
  agent: AgentKind,
): Promise<SessionSummary | undefined> {
  try {
    if (isCursorStorePath(path)) {
      const info = cursorStoreStat(path)
      if (info.size === 0) return undefined
      return await summarizeFile(path, agent, info.size, info.mtimeMs)
    }
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) return undefined
    return await summarizeFile(path, agent, info.size, info.mtimeMs)
  } catch {
    return undefined
  }
}

/** Yields JSONL lines, converting Cursor SQLite stores on the fly. */
export async function* streamSessionLines(path: string): AsyncIterable<string> {
  if (isCursorStorePath(path)) {
    const jsonl = cursorStoreToJsonl(path)
    if (jsonl) yield* jsonl.split('\n')
    return
  }
  yield* streamLines(path)
}

/** Streams a file line by line without holding it in memory. */
export function streamLines(path: string, start = 0): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8', start })
  return lineIterator(stream)
}

async function* lineIterator(stream: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      yield buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
  if (buffer.length > 0) yield buffer
}
