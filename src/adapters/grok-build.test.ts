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
      eventCount: 8,
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

describe('Grok turn_completed usage', () => {
  it('maps spliced turn counts and derives ordinary input', () => {
    const session = grokBuildAdapter.parse(parseJsonlText(sampleText).lines, 'chat_history.jsonl')
    const event = session.events.find((item) => item.kind === 'turn_completed')
    expect(event?.category).toBe('meta')
    expect(event?.preview).toContain('24,147 tokens')
    // inputTokens is inclusive, so it becomes the total and input is derived.
    expect(event?.usage?.totalInputTokens).toBe(24010)
    expect(event?.usage?.cacheReadInputTokens).toBe(7040)
    expect(event?.usage?.cacheCreationInputTokens).toBe(0)
    expect(event?.usage?.inputTokens).toBe(16970)
    expect(event?.usage?.outputTokens).toBe(137)
    expect(event?.usage?.reasoningOutputTokens).toBe(119)
    expect(event?.usage?.contentOutputTokens).toBe(18)
    expect(event?.usage?.issues).toEqual([])
  })
})

describe('detectAndParse with Grok Build sessions', () => {
  it('selects the Grok adapter for chat_history files', () => {
    const session = detectAndParse(sampleText, 'chat_history.jsonl')
    expect(session.fileType).toBe('Grok Build')
  })
})
