import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionIndex } from './index-db'
import { sessionIdForPath, summarizeOne } from './scan'

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

describe('SessionIndex', () => {
  let dir: string
  let index: SessionIndex

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-explorer-test-'))
    index = new SessionIndex(':memory:')
  })

  afterEach(() => {
    index.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function writeSession(name: string, content: string, agent: 'codex' | 'pi' = 'codex') {
    const path = join(dir, name)
    writeFileSync(path, content)
    const summary = await summarizeOne(path, agent)
    if (!summary) throw new Error('failed to summarize fixture')
    return summary
  }

  it('indexes conversation text and finds it by substring', async () => {
    const summary = await writeSession(
      'a.jsonl',
      jsonl(
        { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { cwd: '/proj' } },
        {
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'implement a rate limiter' }] },
        },
      ),
    )

    const count = await index.indexSession(summary)
    expect(count).toBe(1)

    const hits = index.search({ query: 'rate limiter' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe(sessionIdForPath(summary.path))
    expect(hits[0]?.role).toBe('user')
  })

  it('marks the matched span in the snippet', async () => {
    const summary = await writeSession(
      'b.jsonl',
      jsonl({ type: 'message', message: { role: 'user', content: 'alpha bravo charlie' } }),
    )
    await index.indexSession(summary)

    const parts = index.search({ query: 'bravo' })[0]?.snippet ?? []
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(['bravo'])
    expect(parts.map((part) => part.text).join('')).toContain('alpha bravo charlie')
  })

  it('matches CJK text, which trigram tokenization handles', async () => {
    const summary = await writeSession(
      'cjk.jsonl',
      jsonl({ type: 'message', message: { role: 'user', content: '实现一个限流器和令牌桶' } }),
    )
    await index.indexSession(summary)
    expect(index.search({ query: '限流器' })).toHaveLength(1)
    expect(index.search({ query: '令牌桶' })).toHaveLength(1)
  })

  it('treats punctuation literally instead of as query syntax', async () => {
    const summary = await writeSession(
      'code.jsonl',
      jsonl({ type: 'message', message: { role: 'user', content: 'call useEffect(() => {}, [])' } }),
    )
    await index.indexSession(summary)

    // These would be FTS5 syntax errors if passed unquoted.
    expect(index.search({ query: 'useEffect(' })).toHaveLength(1)
    expect(index.search({ query: '=> {}' })).toHaveLength(1)
    expect(index.search({ query: '"' })).toHaveLength(0)
    expect(index.search({ query: 'a OR b' })).toHaveLength(0)
  })

  it('answers queries shorter than a trigram via fallback', async () => {
    const summary = await writeSession(
      'short.jsonl',
      jsonl({ type: 'message', message: { role: 'user', content: 'ab cd' } }),
    )
    await index.indexSession(summary)
    expect(index.search({ query: 'ab' })).toHaveLength(1)
    expect(index.search({ query: 'zz' })).toHaveLength(0)
  })

  it('skips unchanged files and re-indexes appended ones', async () => {
    const path = join(dir, 'grow.jsonl')
    writeFileSync(path, jsonl({ type: 'message', message: { role: 'user', content: 'first' } }))
    const first = (await summarizeOne(path, 'codex'))!

    expect(index.needsIndexing(first)).toBe(true)
    await index.indexSession(first)
    expect(index.needsIndexing(first)).toBe(false)

    writeFileSync(
      path,
      jsonl(
        { type: 'message', message: { role: 'user', content: 'first' } },
        { type: 'message', message: { role: 'user', content: 'second appended' } },
      ),
    )
    const second = (await summarizeOne(path, 'codex'))!
    expect(index.needsIndexing(second)).toBe(true)

    await index.indexSession(second)
    expect(index.search({ query: 'second appended' })).toHaveLength(1)
    // Re-indexing must replace rows, not duplicate them.
    expect(index.search({ query: 'first' })).toHaveLength(1)
    expect(index.countMessages()).toBe(2)
  })

  it('filters by agent and reports registration state', async () => {
    const summary = await writeSession(
      'agent.jsonl',
      jsonl({ type: 'message', message: { role: 'user', content: 'shared phrase' } }),
    )
    expect(index.hasSession(summary.id)).toBe(false)
    await index.indexSession(summary)
    expect(index.hasSession(summary.id)).toBe(true)

    expect(index.search({ query: 'shared phrase', agent: 'codex' })).toHaveLength(1)
    expect(index.search({ query: 'shared phrase', agent: 'pi' })).toHaveLength(0)
  })

  it('removes a session and its searchable rows', async () => {
    const summary = await writeSession(
      'gone.jsonl',
      jsonl({ type: 'message', message: { role: 'user', content: 'temporary content' } }),
    )
    await index.indexSession(summary)
    expect(index.countSessions()).toBe(1)

    index.removeSession(summary.id)
    expect(index.countSessions()).toBe(0)
    expect(index.countMessages()).toBe(0)
    expect(index.search({ query: 'temporary content' })).toHaveLength(0)
  })

  it('counts sessions per agent so paging totals match the filter', async () => {
    await index.indexSession(
      await writeSession(
        'c1.jsonl',
        jsonl({ type: 'message', message: { role: 'user', content: 'one' } }),
        'codex',
      ),
    )
    await index.indexSession(
      await writeSession(
        'c2.jsonl',
        jsonl({ type: 'message', message: { role: 'user', content: 'two' } }),
        'codex',
      ),
    )
    await index.indexSession(
      await writeSession(
        'p1.jsonl',
        jsonl({ type: 'message', message: { role: 'user', content: 'three' } }),
        'pi',
      ),
    )

    expect(index.countSessions()).toBe(3)
    expect(index.countSessions('codex')).toBe(2)
    expect(index.countSessions('pi')).toBe(1)
    expect(index.countSessions('claude')).toBe(0)
  })

  it('ignores empty queries', () => {
    expect(index.search({ query: '   ' })).toEqual([])
  })

  describe('incremental append indexing', () => {
    const userMessage = (text: string) => ({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ text }] },
    })

    /** Re-summarizes from disk the way the watcher does, then reindexes. */
    async function reindex(path: string) {
      const summary = await summarizeOne(path, 'codex')
      if (!summary) throw new Error('failed to summarize fixture')
      return index.indexSession(summary)
    }

    function matches(query: string): number {
      return index.search({ query, limit: 50 }).length
    }

    it('indexes only newly appended lines', async () => {
      const summary = await writeSession(
        'append.jsonl',
        jsonl(userMessage('alpha one'), userMessage('beta two')),
      )
      expect(await index.indexSession(summary)).toBe(2)

      appendFileSync(summary.path, JSON.stringify(userMessage('gamma three')) + '\n')

      // Only the new line is parsed and inserted.
      expect(await reindex(summary.path)).toBe(1)
      expect(matches('alpha one')).toBe(1)
      expect(matches('gamma three')).toBe(1)
    })

    it('keeps byte offsets correct across multi-byte characters', async () => {
      const summary = await writeSession('utf8.jsonl', jsonl(userMessage('需要多字节字符 🚀')))
      expect(await index.indexSession(summary)).toBe(1)

      appendFileSync(summary.path, JSON.stringify(userMessage('tail marker')) + '\n')

      expect(await reindex(summary.path)).toBe(1)
      expect(matches('tail marker')).toBe(1)
      expect(matches('多字节')).toBe(1)
    })

    it('defers a partially written trailing line until it is complete', async () => {
      const summary = await writeSession('partial.jsonl', jsonl(userMessage('first line')))
      expect(await index.indexSession(summary)).toBe(1)

      const pending = JSON.stringify(userMessage('second line'))
      appendFileSync(summary.path, pending.slice(0, 20))

      // The half-flushed line is skipped rather than indexed twice.
      expect(await reindex(summary.path)).toBe(0)
      expect(matches('second line')).toBe(0)

      appendFileSync(summary.path, pending.slice(20) + '\n')
      expect(await reindex(summary.path)).toBe(1)
      expect(matches('second line')).toBe(1)
    })

    it('does not duplicate a valid trailing line that is later extended', async () => {
      const summary = await writeSession('valid-tail.jsonl', jsonl(userMessage('kept line')))
      expect(await index.indexSession(summary)).toBe(1)

      // Valid JSON but no trailing newline: more bytes may still arrive.
      appendFileSync(summary.path, JSON.stringify(userMessage('tail line')))
      await reindex(summary.path)
      appendFileSync(summary.path, '\n')
      await reindex(summary.path)

      expect(matches('tail line')).toBe(1)
    })

    it('fully reindexes when the file is rewritten instead of appended', async () => {
      const summary = await writeSession(
        'rewrite.jsonl',
        jsonl(userMessage('stale content'), userMessage('also stale')),
      )
      expect(await index.indexSession(summary)).toBe(2)

      writeFileSync(summary.path, jsonl(userMessage('fresh content')))

      expect(await reindex(summary.path)).toBe(1)
      expect(matches('stale content')).toBe(0)
      expect(matches('also stale')).toBe(0)
      expect(matches('fresh content')).toBe(1)
    })

    it('detects an in-place rewrite that grows the file', async () => {
      // Size alone cannot distinguish this from an append, so the head
      // signature is what forces a full reindex here.
      const summary = await writeSession(
        'grown-rewrite.jsonl',
        jsonl(userMessage('original head'), userMessage('original tail')),
      )
      expect(await index.indexSession(summary)).toBe(2)

      writeFileSync(
        summary.path,
        jsonl(
          userMessage('replaced head with a much longer body than before'),
          userMessage('replaced tail with a much longer body than before'),
          userMessage('extra appended line to grow the file further'),
        ),
      )

      await reindex(summary.path)
      expect(matches('original head')).toBe(0)
      expect(matches('original tail')).toBe(0)
      expect(matches('replaced head')).toBe(1)
      expect(matches('extra appended line')).toBe(1)
    })

    it('fully reindexes when the file is truncated', async () => {
      const summary = await writeSession(
        'truncate.jsonl',
        jsonl(userMessage('line one'), userMessage('line two'), userMessage('line three')),
      )
      expect(await index.indexSession(summary)).toBe(3)

      writeFileSync(summary.path, jsonl(userMessage('line one')))

      await reindex(summary.path)
      expect(matches('line two')).toBe(0)
      expect(matches('line one')).toBe(1)
    })
  })
})
