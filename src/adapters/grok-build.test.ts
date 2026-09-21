import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectAndParse } from '../core/registry'
import { parseJsonlText } from '../core/jsonl'
import { grokBuildAdapter } from './grok-build'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const sampleText = readFileSync(join(fixtureDir, 'grok-build.sample.jsonl'), 'utf8')

function line(data: Record<string, unknown>, lineIndex = 1) {
  return {
    lineIndex,
    raw: JSON.stringify(data),
    data,
  }
}

describe('grokBuildAdapter.detect', () => {
  it('returns high confidence for Grok Build samples', () => {
    const { lines } = parseJsonlText(sampleText)
    expect(grokBuildAdapter.detect(lines)).toBe(1)
  })

  it('returns zero for Claude-style nested messages', () => {
    expect(
      grokBuildAdapter.detect([
        line({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'hello' },
        }),
      ]),
    ).toBe(0)
  })
})

describe('grokBuildAdapter.parse', () => {
  it('parses user queries, reasoning, tool calls, and results', () => {
    const { lines } = parseJsonlText(sampleText)
    const session = grokBuildAdapter.parse(lines, 'chat_history.jsonl')

    expect(session.fileType).toBe('Grok Build')
    expect(session.meta).toMatchObject({
      model: 'grok-4.6',
      eventCount: 7,
      turnCount: 1,
    })
    expect(session.conversationItems.map((item) => item.role)).toEqual([
      'user',
      'thinking',
      'assistant',
      'tool_call',
      'tool_result',
      'assistant',
    ])
    expect(session.conversationItems[0]?.block?.text).toBe('List the files')
    expect(session.conversationItems.find((item) => item.role === 'tool_call')?.block).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'bash',
      toolInput: { command: 'ls' },
    })
    expect(session.events.some((event) => event.label === 'system_reminder')).toBe(true)
  })
})

describe('detectAndParse with Grok Build sessions', () => {
  it('selects the Grok adapter for chat_history files', () => {
    const session = detectAndParse(sampleText, 'chat_history.jsonl')
    expect(session.fileType).toBe('Grok Build')
  })
})
