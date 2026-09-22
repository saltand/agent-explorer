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

  it('detects tool-heavy transcripts where user and assistant rows are sparse', () => {
    const samples = [
      line({ role: 'system', message: { content: [{ type: 'text', text: 'You are an AI coding assistant' }] } }, 0),
      line({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>go</user_query>' }] } }, 1),
      line({ role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }, 2),
      ...Array.from({ length: 17 }, (_, index) =>
        line({ role: 'tool', message: { content: [{ type: 'tool-result', toolName: 'Read', result: 'x' }] } }, index + 3),
      ),
    ]
    expect(cursorAgentAdapter.detect(samples)).toBe(1)
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

describe('cursorAgentAdapter.parse with ACP store shapes', () => {
  it('reads hyphenated tool-call and tool-result parts', () => {
    const lines = [
      line({
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'Read',
              args: { path: '/tmp/a.scss', limit: 40 },
            },
          ],
        },
      }, 0),
      line({
        role: 'tool',
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'Read',
              result: '@forward "./theme.scss";',
            },
          ],
        },
      }, 1),
    ]

    const session = cursorAgentAdapter.parse(lines, 'store.db')
    const call = session.conversationItems.find((item) => item.role === 'tool_call')
    expect(call?.block?.toolName).toBe('Read')
    expect(call?.block?.toolCallId).toBe('call-1')
    expect(call?.block?.toolInput).toEqual({ path: '/tmp/a.scss', limit: 40 })

    const result = session.conversationItems.find((item) => item.role === 'tool_result')
    expect(result?.block?.text).toContain('@forward "./theme.scss";')
  })
})

describe('detectAndParse with Cursor Agent sessions', () => {
  it('selects the Cursor adapter for agent transcripts', () => {
    const session = detectAndParse(sampleText, 'session.jsonl')
    expect(session.fileType).toBe('Cursor Agent')
  })
})
