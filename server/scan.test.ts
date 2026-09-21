import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pathForSessionId, scanSessions, sessionIdForPath, summarizeOne } from './scan'

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

describe('session ids', () => {
  it('round-trips paths, including non-ASCII', () => {
    for (const path of ['/home/u/.codex/sessions/a.jsonl', '/tmp/项目/会话.jsonl']) {
      expect(pathForSessionId(sessionIdForPath(path))).toBe(path)
    }
  })

  it('produces url-safe ids', () => {
    const id = sessionIdForPath('/home/u/.codex/sessions/2026/09/20/rollout-a+b/c.jsonl')
    expect(id).toBe(encodeURIComponent(id))
  })
})

describe('summarizeOne', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-explorer-scan-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('pulls cwd, title, and time range from a Codex rollout', async () => {
    const path = join(dir, 'rollout.jsonl')
    writeFileSync(
      path,
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { cwd: '/home/u/project' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'refactor the parser' }] },
        },
        { timestamp: '2026-01-01T00:05:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
      ),
    )

    const summary = await summarizeOne(path, 'codex')
    expect(summary?.cwd).toBe('/home/u/project')
    expect(summary?.title).toBe('refactor the parser')
    expect(summary?.startedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(summary?.endedAt).toBe(Date.parse('2026-01-01T00:05:00.000Z'))
  })

  it('reads a Pi session whose role is nested under message', async () => {
    const path = join(dir, 'pi.jsonl')
    writeFileSync(
      path,
      jsonl(
        { type: 'session', id: 'x', timestamp: '2026-02-02T10:00:00.000Z', cwd: '/home/u/pi-proj' },
        {
          type: 'message',
          timestamp: '2026-02-02T10:00:02.000Z',
          message: { role: 'user', content: [{ type: 'text', text: '这个项目是什么' }] },
        },
      ),
    )

    const summary = await summarizeOne(path, 'pi')
    expect(summary?.cwd).toBe('/home/u/pi-proj')
    expect(summary?.title).toBe('这个项目是什么')
  })

  it('skips injected context when choosing a title', async () => {
    const path = join(dir, 'ctx.jsonl')
    writeFileSync(
      path,
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: '<environment_context>\n</environment_context>' }] },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'the real question' }] },
        },
      ),
    )

    expect((await summarizeOne(path, 'codex'))?.title).toBe('the real question')
  })

  it('handles records far larger than a single read buffer', async () => {
    const path = join(dir, 'big.jsonl')
    const padding = 'x'.repeat(200_000)
    writeFileSync(
      path,
      jsonl(
        {
          timestamp: '2026-03-03T00:00:00.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'developer', content: [{ text: padding }] },
        },
        {
          timestamp: '2026-03-03T00:00:01.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'after a huge record' }] },
        },
      ),
    )

    const summary = await summarizeOne(path, 'codex')
    expect(summary?.startedAt).toBe(Date.parse('2026-03-03T00:00:00.000Z'))
    expect(summary?.title).toBe('after a huge record')
  })

  it('falls back to mtime when no timestamp is present', async () => {
    const path = join(dir, 'plain.jsonl')
    writeFileSync(path, jsonl({ type: 'message', message: { role: 'user', content: 'hi' } }))
    const summary = await summarizeOne(path, 'pi')
    expect(summary?.endedAt).toBeGreaterThan(0)
  })

  it('ignores empty and missing files', async () => {
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '')
    expect(await summarizeOne(empty, 'pi')).toBeUndefined()
    expect(await summarizeOne(join(dir, 'nope.jsonl'), 'pi')).toBeUndefined()
  })
})

describe('scanSessions', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-explorer-roots-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks nested directories, skips non-jsonl, and sorts newest first', async () => {
    const root = join(dir, 'sessions')
    mkdirSync(join(root, '2026', '09'), { recursive: true })
    const older = join(root, '2026', 'old.jsonl')
    const newer = join(root, '2026', '09', 'new.jsonl')
    writeFileSync(older, jsonl({ type: 'message', message: { role: 'user', content: 'older' } }))
    writeFileSync(newer, jsonl({ type: 'message', message: { role: 'user', content: 'newer' } }))
    writeFileSync(join(root, 'notes.txt'), 'ignore me')

    const summaries = await scanSessions([{ agent: 'codex', dir: root }])
    expect(summaries.map((item) => item.fileName)).toHaveLength(2)
    expect(summaries[0]!.mtimeMs).toBeGreaterThanOrEqual(summaries[1]!.mtimeMs)
    expect(summaries.every((item) => item.agent === 'codex')).toBe(true)
  })

  it('returns nothing for a missing root instead of throwing', async () => {
    await expect(scanSessions([{ agent: 'pi', dir: join(dir, 'absent') }])).resolves.toEqual([])
  })
})
