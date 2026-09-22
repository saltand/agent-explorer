import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grokHistoryToJsonl, isGrokHistoryPath } from './grok-usage'

function writeSession(history: unknown[], updates?: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'grok-usage-'))
  const historyPath = join(dir, 'chat_history.jsonl')
  writeFileSync(historyPath, history.map((line) => JSON.stringify(line)).join('\n'))
  if (updates) {
    writeFileSync(join(dir, 'updates.jsonl'), updates.map((line) => JSON.stringify(line)).join('\n'))
  }
  return historyPath
}

function turnUpdate(usage: Record<string, number>, promptId: string): unknown {
  return {
    timestamp: 1788369846,
    params: { update: { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn', usage } },
  }
}

describe('isGrokHistoryPath', () => {
  it('matches only the conversation log', () => {
    expect(isGrokHistoryPath('/s/chat_history.jsonl')).toBe(true)
    expect(isGrokHistoryPath('/s/updates.jsonl')).toBe(false)
  })
})

describe('grokHistoryToJsonl', () => {
  it('returns the history unchanged when no sidecar exists', () => {
    const path = writeSession([{ type: 'user', prompt_index: 0 }])
    expect(grokHistoryToJsonl(path)).toBe('{"type":"user","prompt_index":0}')
  })

  it('appends the turn usage record after its turn', () => {
    const path = writeSession(
      [
        { type: 'user', prompt_index: 0 },
        { type: 'assistant', content: 'one' },
        { type: 'user', prompt_index: 1 },
        { type: 'assistant', content: 'two' },
      ],
      [turnUpdate({ inputTokens: 10, outputTokens: 2 }, 'p-1'), turnUpdate({ inputTokens: 20, outputTokens: 4 }, 'p-2')],
    )

    const records = grokHistoryToJsonl(path)
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(records.map((record) => record.type)).toEqual([
      'user',
      'assistant',
      'turn_completed',
      'user',
      'assistant',
      'turn_completed',
    ])
    expect(records[2]).toMatchObject({ prompt_index: 0, prompt_id: 'p-1', usage: { inputTokens: 10 } })
    expect(records[5]).toMatchObject({ prompt_index: 1, prompt_id: 'p-2', usage: { inputTokens: 20 } })
  })

  it('ignores updates that carry no usage', () => {
    const path = writeSession(
      [{ type: 'user', prompt_index: 0 }],
      [{ params: { update: { sessionUpdate: 'agent_message_chunk' } } }, { params: { update: { sessionUpdate: 'turn_completed' } } }],
    )
    expect(grokHistoryToJsonl(path)).toBe('{"type":"user","prompt_index":0}')
  })
})
