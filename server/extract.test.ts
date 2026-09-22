import { describe, expect, it } from 'vitest'
import { extractMessages, isDeadRecordLine } from './extract'

describe('extractMessages', () => {
  it('extracts Claude user text from message.content', () => {
    const result = extractMessages({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    })
    expect(result).toEqual([{ role: 'user', text: 'hello world' }])
  })

  it('extracts Pi assistant text nested under message', () => {
    const result = extractMessages({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
    })
    expect(result).toEqual([{ role: 'assistant', text: 'the answer' }])
  })

  it('unwraps Codex response_item envelopes', () => {
    const result = extractMessages({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] },
    })
    expect(result).toEqual([{ role: 'user', text: 'ping' }])
  })

  it('indexes reasoning summaries as thinking', () => {
    const result = extractMessages({
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'considering options' }],
      },
    })
    expect(result).toEqual([{ role: 'thinking', text: 'considering options' }])
  })

  it('skips tool output, which dominates log size without aiding search', () => {
    expect(extractMessages({ type: 'function_call', name: 'shell' })).toEqual([])
    expect(
      extractMessages({ type: 'response_item', payload: { type: 'function_call_output' } }),
    ).toEqual([])
    expect(
      extractMessages({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'stdout' }] },
      }),
    ).toEqual([])
  })

  it("skips Pi's tool output roles", () => {
    for (const role of ['toolResult', 'bashExecution', 'custom']) {
      expect(
        extractMessages({
          type: 'message',
          message: { role, content: [{ type: 'text', text: 'total 256 drwxr-xr-x' }] },
        }),
      ).toEqual([])
    }
  })

  it('skips injected context blocks posing as user turns', () => {
    const result = extractMessages({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp</cwd>\n' }],
      },
    })
    expect(result).toEqual([])
  })

  it('skips system and developer scaffolding', () => {
    expect(
      extractMessages({
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ text: 'instructions' }] },
      }),
    ).toEqual([])
    expect(
      extractMessages({ type: 'message', message: { role: 'system', content: 'be helpful' } }),
    ).toEqual([])
  })

  it('indexes Grok user_query text and skips synthetic reminders', () => {
    expect(
      extractMessages({
        type: 'user',
        content: [
          {
            type: 'text',
            text: '<user_info>\nWorkspace Path: /tmp\n</user_info>\n<user_query>\nlist files\n</user_query>',
          },
        ],
      }),
    ).toEqual([{ role: 'user', text: 'list files' }])
    expect(
      extractMessages({
        type: 'user',
        synthetic_reason: 'system_reminder',
        content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }],
      }),
    ).toEqual([])
  })

  it('indexes Grok reasoning summaries', () => {
    expect(
      extractMessages({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'need to list files' }],
      }),
    ).toEqual([{ role: 'thinking', text: 'need to list files' }])
  })

  it('indexes Cursor Agent user_query text nested under message', () => {
    expect(
      extractMessages({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>now</timestamp>\n<user_query>\ninspect the repo\n</user_query>',
            },
          ],
        },
      }),
    ).toEqual([{ role: 'user', text: 'inspect the repo' }])
  })

  it('ignores event_msg envelopes and malformed records', () => {
    expect(extractMessages({ type: 'event_msg', payload: { type: 'token_count' } })).toEqual([])
    expect(extractMessages(null)).toEqual([])
    expect(extractMessages('nope')).toEqual([])
    expect(extractMessages({ type: 'session', id: 'x' })).toEqual([])
  })
})

describe('isDeadRecordLine', () => {
  const dead = [
    '{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"item_completed"}}',
    '{"type":"response_item","payload":{"type":"function_call_output","output":"x"}}',
    '{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"x"}}',
    '{"type":"tool_result","content":"x"}',
  ]

  it('rejects tool and lifecycle records without parsing', () => {
    for (const line of dead) expect(isDeadRecordLine(line)).toBe(true)
  })

  it('agrees with extractMessages on every line it rejects', () => {
    for (const line of dead) expect(extractMessages(JSON.parse(line))).toEqual([])
  })

  it('keeps real conversation records', () => {
    const live = [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"yo"}]}}',
      '{"type":"reasoning","summary":[{"type":"summary_text","summary":"thinking"}]}',
    ]
    for (const line of live) expect(isDeadRecordLine(line)).toBe(false)
  })

  it('does not match a marker quoted inside message text', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'what does {"type":"event_msg"} mean?' }] },
    })
    expect(isDeadRecordLine(line)).toBe(false)
    expect(extractMessages(JSON.parse(line))).toHaveLength(1)
  })

  it('ignores markers past the head window', () => {
    const padded = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${'a'.repeat(500)}"}]}}`
    expect(isDeadRecordLine(padded)).toBe(false)
  })
})
