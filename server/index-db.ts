import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { extractMessages, isDeadRecordLine } from './extract'
import { isCursorStorePath } from './cursor-store'
import {
  streamLinesWithOffsets,
  streamSessionLines,
  type OffsetLine,
  type SessionSummary,
} from './scan'

export interface SearchHit {
  sessionId: string
  path: string
  agent: string
  fileName: string
  cwd?: string
  title?: string
  mtimeMs: number
  lineIndex: number
  role: string
  /**
   * Match context split into parts. Structured rather than pre-highlighted HTML
   * so the client can render it without injecting markup.
   */
  snippet: SnippetPart[]
}

export interface SnippetPart {
  text: string
  match: boolean
}

export interface SearchOptions {
  query: string
  agent?: string
  limit?: number
}

/** Trigram indexes cannot serve queries shorter than three characters. */
const MIN_TRIGRAM_LENGTH = 3
const MAX_INDEXED_TEXT = 100_000

/** Wraps the query as an FTS5 phrase so punctuation can't break the syntax. */
function toPhraseQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`
}

/** Builds a match window with the hit isolated as its own part. */
function buildSnippet(text: string, query: string, radius = 90): SnippetPart[] {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const index = collapsed.toLowerCase().indexOf(query.toLowerCase())
  if (index === -1) {
    const head = collapsed.slice(0, radius * 2)
    return [{ text: head + (collapsed.length > head.length ? '…' : ''), match: false }]
  }

  const start = Math.max(0, index - radius)
  const end = Math.min(collapsed.length, index + query.length + radius)
  const parts: SnippetPart[] = []

  const before = (start > 0 ? '…' : '') + collapsed.slice(start, index)
  if (before) parts.push({ text: before, match: false })
  parts.push({ text: collapsed.slice(index, index + query.length), match: true })
  const after = collapsed.slice(index + query.length, end) + (end < collapsed.length ? '…' : '')
  if (after) parts.push({ text: after, match: false })

  return parts
}

/**
 * The sqlite driver types rows as `Record<string, SQLOutputValue>`, which does
 * not overlap with our row shapes. These helpers keep the cast in one place.
 */
function asRow<T>(row: unknown): T | undefined {
  return row as T | undefined
}

function asRows<T>(rows: unknown): T[] {
  return rows as T[]
}

export class SessionIndex {
  readonly #db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.#db = new DatabaseSync(dbPath)
    this.#db.exec('pragma journal_mode = wal')
    this.#db.exec('pragma synchronous = normal')
    // Trigram FTS writes touch many pages per insert; a larger page cache keeps
    // the index build from thrashing. Negative values are KiB, so this is 64 MiB.
    this.#db.exec('pragma cache_size = -65536')
    this.#migrate()
  }

  #migrate(): void {
    this.#db.exec(`
      create table if not exists sessions (
        id integer primary key,
        session_id text not null unique,
        path text not null,
        agent text not null,
        file_name text not null,
        cwd text,
        title text,
        size integer not null,
        mtime_ms real not null,
        started_at real,
        ended_at real,
        indexed_size integer not null default 0,
        indexed_mtime_ms real not null default 0,
        indexed_bytes integer not null default 0,
        indexed_lines integer not null default 0,
        head_signature text
      );

      create index if not exists sessions_mtime on sessions (mtime_ms desc);

      create table if not exists messages (
        id integer primary key,
        session_pk integer not null references sessions(id) on delete cascade,
        line_index integer not null,
        role text not null,
        body text not null
      );

      create index if not exists messages_session on messages (session_pk);

      create virtual table if not exists messages_fts using fts5(
        body,
        content='messages',
        content_rowid='id',
        tokenize='trigram'
      );
    `)

    // Older databases predate the incremental-append columns.
    const columns = new Set(
      asRows<{ name: string }>(this.#db.prepare('pragma table_info(sessions)').all()).map(
        (row) => row.name,
      ),
    )
    if (!columns.has('indexed_bytes')) {
      this.#db.exec('alter table sessions add column indexed_bytes integer not null default 0')
    }
    if (!columns.has('indexed_lines')) {
      this.#db.exec('alter table sessions add column indexed_lines integer not null default 0')
    }
    if (!columns.has('head_signature')) {
      this.#db.exec('alter table sessions add column head_signature text')
    }
  }

  close(): void {
    this.#db.close()
  }

  /** Inserts or updates session metadata, returning the internal row id. */
  upsertSession(summary: SessionSummary): number {
    this.#db
      .prepare(
        `insert into sessions (session_id, path, agent, file_name, cwd, title, size, mtime_ms, started_at, ended_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(session_id) do update set
           path = excluded.path,
           agent = excluded.agent,
           file_name = excluded.file_name,
           cwd = coalesce(excluded.cwd, sessions.cwd),
           title = coalesce(excluded.title, sessions.title),
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           started_at = coalesce(excluded.started_at, sessions.started_at),
           ended_at = excluded.ended_at`,
      )
      .run(
        summary.id,
        summary.path,
        summary.agent,
        summary.fileName,
        summary.cwd ?? null,
        summary.title ?? null,
        summary.size,
        summary.mtimeMs,
        summary.startedAt ?? null,
        summary.endedAt ?? null,
      )

    const row = asRow<{ id: number }>(
      this.#db.prepare('select id from sessions where session_id = ?').get(summary.id),
    )
    return row!.id
  }

  /**
   * Snapshot of every indexed session keyed by path, including the size/mtime
   * of the last index pass. A rescan uses this to skip re-probing files that
   * have not changed, which is the bulk of startup work on a large history.
   */
  indexedSnapshot(): Map<string, { summary: SessionSummary; indexedSize: number; indexedMtimeMs: number }> {
    const rows = asRows<SessionRow & { indexed_size: number; indexed_mtime_ms: number }>(
      this.#db.prepare('select * from sessions').all(),
    )
    const map = new Map<
      string,
      { summary: SessionSummary; indexedSize: number; indexedMtimeMs: number }
    >()
    for (const row of rows) {
      map.set(row.path, {
        summary: rowToSummary(row),
        indexedSize: row.indexed_size,
        indexedMtimeMs: row.indexed_mtime_ms,
      })
    }
    return map
  }

  /** True when the session is already present in the index. */
  hasSession(sessionId: string): boolean {
    return (
      asRow<{ id: number }>(
        this.#db.prepare('select id from sessions where session_id = ?').get(sessionId),
      ) !== undefined
    )
  }

  /**
   * True when the file grew or changed since the last index pass. Used to skip
   * unchanged files on rescan, which is what keeps startup cheap.
   */
  needsIndexing(summary: SessionSummary): boolean {
    const row = asRow<{ indexed_size: number; indexed_mtime_ms: number }>(
      this.#db
        .prepare('select indexed_size, indexed_mtime_ms from sessions where session_id = ?')
        .get(summary.id),
    )
    if (!row) return true
    return row.indexed_size !== summary.size || row.indexed_mtime_ms !== summary.mtimeMs
  }

  /**
   * Reads a session's messages into the index.
   *
   * Live sessions grow by appending, so when the already-indexed prefix is
   * still intact only the new tail is parsed. Anything else (rewrite, truncate,
   * Cursor's SQLite stores) falls back to a full reindex.
   */
  async indexSession(summary: SessionSummary): Promise<number> {
    const previous = asRow<{
      id: number
      indexed_bytes: number
      indexed_lines: number
      head_signature: string | null
    }>(
      this.#db
        .prepare(
          'select id, indexed_bytes, indexed_lines, head_signature from sessions where session_id = ?',
        )
        .get(summary.id),
    )

    const canAppend =
      previous !== undefined &&
      !isCursorStorePath(summary.path) &&
      previous.indexed_bytes > 0 &&
      previous.head_signature !== null &&
      summary.size >= previous.indexed_bytes &&
      (await this.#headSignature(summary.path)) === previous.head_signature

    const sessionPk = this.upsertSession(summary)
    const startOffset = canAppend ? previous.indexed_bytes : 0
    const startLine = canAppend ? previous.indexed_lines : 0
    if (!canAppend) this.#deleteMessages(sessionPk)

    const insertMessage = this.#db.prepare(
      'insert into messages (session_pk, line_index, role, body) values (?, ?, ?, ?)',
    )
    const insertFts = this.#db.prepare(
      'insert into messages_fts (rowid, body) values (?, ?)',
    )

    let lineIndex = startLine
    let count = 0
    let committedBytes = startOffset
    let committedLines = startLine

    // Cursor stores are converted wholesale and have no byte offsets, so they
    // always take the simple full-reindex iterator.
    const cursorStore = isCursorStorePath(summary.path)
    const lines: AsyncIterable<OffsetLine> = cursorStore
      ? mapToOffsetLines(streamSessionLines(summary.path))
      : streamLinesWithOffsets(summary.path, startOffset)

    this.#db.exec('begin')
    try {
      for await (const { line, endOffset } of lines) {
        const currentLine = lineIndex

        // A tail without a trailing newline is a partially flushed write. Stop
        // before it and leave the checkpoint where it is; the next pass picks
        // the line up once it is complete. Indexing it now would duplicate the
        // row when the rest arrives.
        const complete = cursorStore || endOffset > committedBytes
        if (!complete) break

        lineIndex += 1
        if (!cursorStore) {
          committedBytes = endOffset
          committedLines = lineIndex
        }

        if (!line.trim()) continue

        // Tool output and lifecycle events are most of the bytes and none of the
        // messages. Rejecting them as text keeps JSON.parse off that volume; the
        // checkpoint above is already updated, so skipping here is safe.
        if (isDeadRecordLine(line)) continue

        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }

        for (const message of extractMessages(record)) {
          const body =
            message.text.length > MAX_INDEXED_TEXT
              ? message.text.slice(0, MAX_INDEXED_TEXT)
              : message.text
          const result = insertMessage.run(sessionPk, currentLine, message.role, body)
          insertFts.run(result.lastInsertRowid, body)
          count += 1
        }
      }

      this.#db
        .prepare(
          'update sessions set indexed_size = ?, indexed_mtime_ms = ?, indexed_bytes = ?, indexed_lines = ?, head_signature = ? where id = ?',
        )
        .run(
          summary.size,
          summary.mtimeMs,
          committedBytes,
          committedLines,
          canAppend ? previous.head_signature : await this.#headSignature(summary.path),
          sessionPk,
        )
      this.#db.exec('commit')
    } catch (error) {
      this.#db.exec('rollback')
      throw error
    }

    return count
  }

  /**
   * Fingerprints the first line of a session file. If this changes, the file was
   * rewritten rather than appended to and the existing rows are stale.
   */
  async #headSignature(path: string): Promise<string | null> {
    if (isCursorStorePath(path)) return null
    for await (const { line } of streamLinesWithOffsets(path, 0)) {
      return `${line.length}:${line.slice(0, 200)}`
    }
    return ''
  }

  #deleteMessages(sessionPk: number): void {
    // The FTS table is external-content, so its rows must be removed explicitly.
    const rows = asRows<{ id: number; body: string }>(
      this.#db.prepare('select id, body from messages where session_pk = ?').all(sessionPk),
    )
    if (rows.length === 0) return

    const deleteFts = this.#db.prepare(
      "insert into messages_fts (messages_fts, rowid, body) values ('delete', ?, ?)",
    )
    for (const row of rows) deleteFts.run(row.id, row.body)
    this.#db.prepare('delete from messages where session_pk = ?').run(sessionPk)
  }

  removeSession(sessionId: string): void {
    const row = asRow<{ id: number }>(
      this.#db.prepare('select id from sessions where session_id = ?').get(sessionId),
    )
    if (!row) return
    this.#deleteMessages(row.id)
    this.#db.prepare('delete from sessions where id = ?').run(row.id)
  }

  listSessions(options: { agent?: string; limit?: number; offset?: number } = {}): SessionSummary[] {
    const limit = options.limit ?? 200
    const offset = options.offset ?? 0
    const rows = options.agent
      ? asRows<SessionRow>(
          this.#db
            .prepare('select * from sessions where agent = ? order by mtime_ms desc limit ? offset ?')
            .all(options.agent, limit, offset),
        )
      : asRows<SessionRow>(
          this.#db
            .prepare('select * from sessions order by mtime_ms desc limit ? offset ?')
            .all(limit, offset),
        )
    return rows.map(rowToSummary)
  }

  /** Counts sessions, optionally within a single agent so paging totals match. */
  countSessions(agent?: string): number {
    const row = agent
      ? this.#db.prepare('select count(*) as c from sessions where agent = ?').get(agent)
      : this.#db.prepare('select count(*) as c from sessions').get()
    return asRow<{ c: number }>(row)!.c
  }

  countMessages(): number {
    return asRow<{ c: number }>(this.#db.prepare('select count(*) as c from messages').get())!.c
  }

  search(options: SearchOptions): SearchHit[] {
    const query = options.query.trim()
    if (!query) return []
    const limit = options.limit ?? 100

    // Short queries fall back to LIKE, which trigram FTS cannot answer.
    const rows =
      query.length < MIN_TRIGRAM_LENGTH
        ? this.#searchLike(query, options.agent, limit)
        : this.#searchFts(query, options.agent, limit)

    return rows.map((row) => ({
      sessionId: row.session_id,
      path: row.path,
      agent: row.agent,
      fileName: row.file_name,
      cwd: row.cwd ?? undefined,
      title: row.title ?? undefined,
      mtimeMs: row.mtime_ms,
      lineIndex: row.line_index,
      role: row.role,
      snippet: buildSnippet(row.body, query),
    }))
  }

  #searchFts(query: string, agent: string | undefined, limit: number): HitRow[] {
    const sql = `
      select s.session_id, s.path, s.agent, s.file_name, s.cwd, s.title, s.mtime_ms,
             m.line_index, m.role, m.body
      from messages_fts f
      join messages m on m.id = f.rowid
      join sessions s on s.id = m.session_pk
      where f.body match ?${agent ? ' and s.agent = ?' : ''}
      order by s.mtime_ms desc
      limit ?
    `
    const statement = this.#db.prepare(sql)
    const phrase = toPhraseQuery(query)
    return asRows<HitRow>(
      agent ? statement.all(phrase, agent, limit) : statement.all(phrase, limit),
    )
  }

  #searchLike(query: string, agent: string | undefined, limit: number): HitRow[] {
    const sql = `
      select s.session_id, s.path, s.agent, s.file_name, s.cwd, s.title, s.mtime_ms,
             m.line_index, m.role, m.body
      from messages m
      join sessions s on s.id = m.session_pk
      where m.body like ? escape '\\'${agent ? ' and s.agent = ?' : ''}
      order by s.mtime_ms desc
      limit ?
    `
    const statement = this.#db.prepare(sql)
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    return asRows<HitRow>(
      agent ? statement.all(pattern, agent, limit) : statement.all(pattern, limit),
    )
  }
}

interface SessionRow {
  session_id: string
  path: string
  agent: string
  file_name: string
  cwd: string | null
  title: string | null
  size: number
  mtime_ms: number
  started_at: number | null
  ended_at: number | null
}

interface HitRow {
  session_id: string
  path: string
  agent: string
  file_name: string
  cwd: string | null
  title: string | null
  mtime_ms: number
  line_index: number
  role: string
  body: string
}

function rowToSummary(row: SessionRow): SessionSummary {
  return {
    id: row.session_id,
    path: row.path,
    agent: row.agent as SessionSummary['agent'],
    fileName: row.file_name,
    cwd: row.cwd ?? undefined,
    title: row.title ?? undefined,
    size: row.size,
    mtimeMs: row.mtime_ms,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
  }
}

/** Adapts a plain line stream to the offset-carrying shape. */
async function* mapToOffsetLines(
  source: AsyncIterable<string>,
): AsyncIterable<OffsetLine> {
  for await (const line of source) yield { line, endOffset: 0 }
}
