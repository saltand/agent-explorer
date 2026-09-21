import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectAndParse } from '../core/registry'
import { parseJsonlText } from '../core/jsonl'
import { cursorAgentAdapter } from './cursor-agent'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const sampleText = readFileSync(join(fixtureDir, 'cursor-agent.sample.jsonl'), 'utf8')

function line(data: Record<string, unknown>, lineIndex = 1) {
  return {
    lineIndex,
    raw: JSON.stringify(data),
    data,
  }
}

describe('cursorAgentAdapter.detect', () => {
  it('returns high confidence for Cursor Agent samples', () => {
    const { lines } = parseJsonlText(sampleText)
    expect(cursorAgentAdapter.detect(lines)).toBe(1)
  })

  it('returns zero for Claude transcripts that carry uuids', () => {
    expect(
      cursorAgentAdapter.detect([
        line({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'hello' },
        }),
      ]),
    ).toBe(0)
  })
})

describe('cursorAgentAdapter.parse', () => {
  it('unwraps user_query text and flattens tool_use blocks', () => {
    const { lines } = parseJsonlText(sampleText)
    const session = cursorAgentAdapter.parse(lines, 'session.jsonl')

    expect(session.fileType).toBe('Cursor Agent')
    expect(session.meta).toMatchObject({
      eventCount: 4,
      turnCount: 1,
    })
    expect(session.conversationItems.map((item) => item.role)).toEqual([
      'user',
      'assistant',
      'tool_call',
      'assistant',
    ])
    expect(session.conversationItems[0]?.block?.text).toBe('Inspect the project')
    expect(session.conversationItems.find((item) => item.role === 'tool_call')?.block).toMatchObject({
      toolName: 'Glob',
      toolInput: { glob_pattern: '**/*.ts' },
    })
    expect(session.events.at(-1)).toMatchObject({
      kind: 'turn_ended',
      category: 'meta',
      preview: 'success',
    })
  })
})

describe('detectAndParse with Cursor Agent sessions', () => {
  it('selects the Cursor adapter for agent transcripts', () => {
    const session = detectAndParse(sampleText, 'session.jsonl')
    expect(session.fileType).toBe('Cursor Agent')
  })
})
