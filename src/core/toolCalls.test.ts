import { describe, expect, it } from 'vitest'
import { buildToolCallIndex, inspectToolCall } from './toolCalls'
import type { ConversationListItem, TimelineEvent } from './types'

function event(lineIndex: number, raw: unknown, timestamp?: number): TimelineEvent {
  return { id: `line-${lineIndex}`, lineIndex, category: 'tool', kind: 'tool', label: '', preview: '', timestamp, raw }
}

function call(id: string, name: string, input: Record<string, unknown>, lineIndex: number, timestamp?: number): ConversationListItem {
  return {
    id: `conv-${lineIndex}-call`,
    event: event(lineIndex, {}, timestamp),
    role: 'tool_call',
    block: { type: 'tool_use', text: JSON.stringify(input), toolName: name, toolInput: input, toolCallId: id, status: 'pending' },
  }
}

function result(callId: string, raw: unknown, lineIndex: number, timestamp?: number, status: 'completed' | 'failed' = 'completed'): ConversationListItem {
  return {
    id: `conv-${lineIndex}-result`,
    event: event(lineIndex, raw, timestamp),
    role: 'tool_result',
    block: { type: 'text', text: '', toolCallId: callId, status },
  }
}

const codexOutput = (output: string) => ({ type: 'response_item', payload: { type: 'function_call_output', output } })

describe('buildToolCallIndex', () => {
  it('pairs calls and results by call id', () => {
    const items = [
      call('c1', 'bash', { command: 'ls' }, 1),
      result('c1', codexOutput('done'), 2),
      call('c2', 'read', {}, 3),
    ]
    const index = buildToolCallIndex(items)
    expect(index.get('c1')?.call?.id).toBe('conv-1-call')
    expect(index.get('c1')?.result?.id).toBe('conv-2-result')
    expect(index.get('c2')?.result).toBeUndefined()
  })
})

describe('inspectToolCall', () => {
  it('reports status, timing, and error details of a failed call', () => {
    const items = [
      call('c1', 'exec_command', { cmd: 'false' }, 1, 1000),
      result('c1', codexOutput('Chunk ID: ab\nWall time: 0.5 seconds\nProcess exited with code 3\nOutput:'), 2, 2500, 'failed'),
    ]
    const info = inspectToolCall(items, items[0]!)!
    expect(info.status).toBe('failed')
    expect(info.toolName).toBe('exec_command')
    expect(info.eventSpanMs).toBe(1500)
    expect(info.reportedDurationMs).toBe(500)
    expect(info.exitCode).toBe(3)
    expect(info.errors).toEqual([])
  })

  it('marks a call without a result as pending', () => {
    const items = [call('c1', 'bash', {}, 1, 1000)]
    const info = inspectToolCall(items, items[0]!)!
    expect(info.status).toBe('pending')
    expect(info.eventSpanMs).toBeUndefined()
    expect(info.children).toEqual([])
  })

  it('nests calls that target a spawned agent path', () => {
    const items = [
      call('s1', 'spawn_agent', { task_name: 'worker' }, 1),
      result('s1', codexOutput('{"task_name":"/root/worker"}'), 2),
      call('m1', 'send_message', { target: '/root/worker', message: 'hi' }, 3),
      call('m2', 'send_message', { target: '/root/other', message: 'hi' }, 4),
    ]
    const spawn = inspectToolCall(items, items[0]!)!
    expect(spawn.children.map((c) => c.item.id)).toEqual(['conv-3-call'])
    expect(spawn.children[0]?.relation).toBe('targets /root/worker')

    const nested = inspectToolCall(items, items[2]!)!
    expect(nested.parent?.item.id).toBe('conv-1-call')
    expect(nested.parent?.relation).toBe('spawned /root/worker')
  })

  it('nests a deeper spawn under the nearest ancestor agent', () => {
    const items = [
      call('s1', 'spawn_agent', { task_name: 'a' }, 1),
      result('s1', codexOutput('{"task_name":"/root/a"}'), 2),
      call('s2', 'spawn_agent', { task_name: 'b' }, 3),
      result('s2', codexOutput('{"task_name":"/root/a/b"}'), 4),
    ]
    const outer = inspectToolCall(items, items[0]!)!
    expect(outer.children.map((c) => c.item.id)).toEqual(['conv-3-call'])
    expect(outer.children[0]?.relation).toBe('spawned /root/a/b')

    const inner = inspectToolCall(items, items[2]!)!
    expect(inner.parent?.item.id).toBe('conv-1-call')
  })

  it('nests write_stdin under the exec that opened the session', () => {
    const items = [
      call('e1', 'exec_command', { cmd: 'npm run dev' }, 1),
      result('e1', codexOutput('Wall time: 10.0 seconds\nProcess running with session ID 9127\nOutput:'), 2),
      call('w1', 'write_stdin', { session_id: 9127, chars: 'q' }, 3),
      call('w2', 'write_stdin', { session_id: 4000, chars: 'x' }, 4),
    ]
    const exec = inspectToolCall(items, items[0]!)!
    expect(exec.children.map((c) => c.item.id)).toEqual(['conv-3-call'])
    expect(exec.children[0]?.relation).toBe('writes to session 9127')

    const stdin = inspectToolCall(items, items[2]!)!
    expect(stdin.parent?.item.id).toBe('conv-1-call')
    expect(stdin.parent?.relation).toBe('opened session 9127')
  })

  it('treats /root as the main agent with no parent', () => {
    const items = [
      call('s1', 'spawn_agent', { task_name: 'a' }, 1),
      result('s1', codexOutput('{"task_name":"/root/a"}'), 2),
      call('m1', 'send_message', { target: '/root', message: 'done' }, 3),
    ]
    const info = inspectToolCall(items, items[2]!)!
    expect(info.parent).toBeUndefined()
  })

  it('flags claude-style is_error results', () => {
    const raw = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] } }
    const items = [call('t1', 'Bash', { command: 'x' }, 1), result('t1', raw, 2, undefined, 'failed')]
    const info = inspectToolCall(items, items[1]!)!
    expect(info.status).toBe('failed')
    expect(info.errors).toContainEqual({ label: 'Error flag', value: 'Result is marked as an error' })
  })

  it('returns undefined for non-tool items', () => {
    const item: ConversationListItem = { id: 'x', event: event(1, {}), role: 'assistant' }
    expect(inspectToolCall([item], item)).toBeUndefined()
  })
})
