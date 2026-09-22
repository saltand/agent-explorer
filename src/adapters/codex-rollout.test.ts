import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectAndParse } from '../core/registry'
import { parseJsonlText } from '../core/jsonl'
import { BLOCK_TEXT_LIMIT } from '../core/text'
import { codexRolloutAdapter } from './codex-rollout'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const sampleText = readFileSync(join(fixtureDir, 'codex-rollout.sample.jsonl'), 'utf8')
const largeSamplePath =
  '/Users/cyandev/Downloads/ktiays-codex-2026/04/03/rollout-2026-04-03T13-30-19-019d51d2-2328-7f31-b4dd-812ff6a13aae.jsonl'

function line(data: Record<string, unknown>, lineIndex = 1) {
  return {
    lineIndex,
    raw: JSON.stringify(data),
    data,
  }
}

describe('codexRolloutAdapter with legacy flat rollouts', () => {
  const legacy = [
    { id: 'sess-1', timestamp: '2025-09-10T06:56:22.662Z', instructions: null },
    { record_type: 'state' },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello legacy' }],
    },
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'thinking about it' }],
    },
    {
      type: 'function_call',
      name: 'shell',
      arguments: '{"command":["ls"]}',
      call_id: 'call-1',
    },
  ]

  const text = legacy.map((entry) => JSON.stringify(entry)).join('\n')

  it('detects rollouts written without the payload envelope', () => {
    const { lines } = parseJsonlText(text)
    expect(codexRolloutAdapter.detect(lines)).toBeGreaterThanOrEqual(0.5)
  })

  it('ignores record_type bookkeeping lines when scoring confidence', () => {
    const sparse = [
      { id: 'sess-2', timestamp: '2025-08-22T11:48:18.878Z', instructions: null },
      { record_type: 'state' },
      { type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { record_type: 'state' },
      { record_type: 'state' },
      { record_type: 'state' },
    ]
    const sparseText = sparse.map((entry) => JSON.stringify(entry)).join('\n')
    const { lines } = parseJsonlText(sparseText)
    expect(codexRolloutAdapter.detect(lines)).toBe(1)
    expect(detectAndParse(sparseText, 'rollout-sparse.jsonl').fileType).toBe('Codex')
  })

  it('parses legacy lines and keeps the original line in raw', () => {
    const session = detectAndParse(text, 'rollout-legacy.jsonl')
    expect(session.fileType).toBe('Codex')
    expect(session.meta.sessionId).toBe('sess-1')

    const kinds = session.events.map((event) => event.kind)
    expect(kinds).toContain('message')
    expect(kinds).toContain('reasoning')
    expect(kinds).toContain('function_call')

    const message = session.events.find((event) => event.kind === 'message')
    expect(message?.raw).not.toHaveProperty('payload')
    expect(message?.raw).toMatchObject({ type: 'message', role: 'user' })
  })
})

describe('codexRolloutAdapter.detect', () => {
  it('returns high confidence for Codex rollout samples', () => {
    const { lines } = parseJsonlText(sampleText)
    expect(codexRolloutAdapter.detect(lines)).toBe(1)
  })

  it('returns zero for Claude transcript samples', () => {
    const claudeSample = readFileSync(
      join(fixtureDir, 'claude-transcript.sample.jsonl'),
      'utf8',
    )
    const { lines } = parseJsonlText(claudeSample)
    expect(codexRolloutAdapter.detect(lines)).toBe(0)
  })
})

describe('codexRolloutAdapter.parse', () => {
  it('parses session metadata and turn context from the guardian sample', () => {
    const { lines } = parseJsonlText(sampleText)
    const session = codexRolloutAdapter.parse(lines, 'guardian.jsonl')

    expect(session.fileType).toBe('Codex')
    expect(session.meta.sessionId).toBe('019e9d2d-3639-75b2-b26e-be6650102fea')
    expect(session.meta.cwd).toContain('youdesktop')
    expect(session.meta.version).toBe('0.137.0-alpha.4')
    expect(session.meta.model).toBe('codex-auto-review')
    expect(session.meta.turnCount).toBe(1)
    expect(session.events).toHaveLength(12)
  })

  it('maps response_item messages and reasoning into conversation items', () => {
    const session = codexRolloutAdapter.parse(
      [
        line({
          timestamp: '2026-06-06T13:44:06.581Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-1',
          },
        }),
        line(
          {
            timestamp: '2026-06-06T13:44:07.964Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Archive tracked files only' }],
            },
          },
          2,
        ),
        line(
          {
            timestamp: '2026-06-06T13:44:12.824Z',
            type: 'response_item',
            payload: {
              type: 'reasoning',
              summary: [{ text: 'Assess archive risk as low.' }],
            },
          },
          3,
        ),
        line(
          {
            timestamp: '2026-06-06T13:44:13.027Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"outcome":"allow"}' }],
            },
          },
          4,
        ),
      ],
      'mini.jsonl',
    )

    expect(session.conversationItems.map((item) => item.role)).toEqual([
      'user',
      'thinking',
      'assistant',
    ])
    expect(session.events[1]?.category).toBe('user')
    expect(session.events[1]?.conversationItem?.id).toBe('conv-2-user')
    expect(session.events[2]?.category).toBe('thinking')
    expect(session.conversationItems[1]?.block?.text).toContain('Assess archive risk')
    expect(session.events[1]?.preview).toContain('Archive tracked files')
  })

  it('links function_call and function_call_output by tool call id', () => {
    const callId = 'call_rdg6jvibCi1HZNzPAIISkZC9'
    const session = codexRolloutAdapter.parse(
      [
        line({
          timestamp: '2026-04-03T13:30:19.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-1' },
        }),
        line(
          {
            timestamp: '2026-04-03T13:30:20.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: 'rg --files' }),
              call_id: callId,
            },
          },
          2,
        ),
        line(
          {
            timestamp: '2026-04-03T13:30:21.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: callId,
              output: 'file.txt\n',
            },
          },
          3,
        ),
      ],
      'tools.jsonl',
    )

    const toolCall = session.conversationItems.find((item) => item.role === 'tool_call')
    const toolResult = session.conversationItems.find((item) => item.role === 'tool_result')

    expect(toolCall?.block?.toolCallId).toBe(callId)
    expect(toolCall?.block?.toolName).toBe('exec_command')
    expect(toolCall?.block?.status).toBe('pending')
    expect(toolResult?.block?.toolCallId).toBe(callId)
    expect(toolResult?.block?.status).toBe('completed')
    expect(toolResult?.block?.text).toContain('file.txt')
    expect(session.events[1]?.label).toBe('tool_use exec_command')
    expect(session.events[1]?.conversationItem?.id).toBe('conv-2-tool-call')
    expect(session.events[2]?.category).toBe('tool')
  })

  it('truncates very large reasoning blocks at parse time', () => {
    const longReasoning = 'z'.repeat(BLOCK_TEXT_LIMIT + 500)
    const session = codexRolloutAdapter.parse(
      [
        line({
          timestamp: '2026-06-06T13:44:06.581Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-1' },
        }),
        line(
          {
            timestamp: '2026-06-06T13:44:12.824Z',
            type: 'response_item',
            payload: {
              type: 'reasoning',
              summary: [{ text: longReasoning }],
            },
          },
          2,
        ),
      ],
      'reasoning.jsonl',
    )

    const thinking = session.conversationItems.find((item) => item.role === 'thinking')
    expect(thinking?.block?.text.endsWith('… [truncated]')).toBe(true)
    expect(thinking?.block?.text.length).toBeLessThan(longReasoning.length)
  })

  it('parses a real rollout file with custom tool calls when available locally', () => {
    try {
      readFileSync(largeSamplePath, 'utf8')
    } catch {
      return
    }

    const text = readFileSync(largeSamplePath, 'utf8')
    const session = detectAndParse(text, 'rollout.jsonl')

    expect(session.fileType).toBe('Codex')
    expect(session.meta.turnCount).toBeGreaterThanOrEqual(2)
    expect(session.conversationItems.some((item) => item.role === 'tool_call')).toBe(true)
    expect(session.conversationItems.some((item) => item.role === 'tool_result')).toBe(true)
    expect(session.conversationItems.some((item) => item.role === 'thinking')).toBe(true)
  })
})

describe('Codex token_count usage', () => {
  it('maps per-request counts and derives ordinary input', () => {
    const session = codexRolloutAdapter.parse(parseJsonlText(sampleText).lines, 'rollout.jsonl')
    const usage = session.events.find((event) => event.kind === 'token_count')?.usage
    expect(usage).toBeDefined()
    // input_tokens is inclusive, so it becomes the total and input is derived.
    expect(usage?.totalInputTokens).toBe(24010)
    expect(usage?.cacheReadInputTokens).toBe(7040)
    expect(usage?.inputTokens).toBeUndefined()
    expect(usage?.outputTokens).toBe(137)
    expect(usage?.reasoningOutputTokens).toBe(119)
    expect(usage?.contentOutputTokens).toBe(18)
    expect(usage?.issues).toEqual([])
    expect(usage?.sources.totalInputTokens).toEqual([
      'payload.info.last_token_usage.input_tokens',
    ])
  })
})

describe('detectAndParse with Codex rollout', () => {
  it('selects the Codex adapter for rollout files', () => {
    const session = detectAndParse(sampleText, 'rollout.jsonl')
    expect(session.fileType).toBe('Codex')
    expect(session.events.length).toBeGreaterThan(0)
  })
})