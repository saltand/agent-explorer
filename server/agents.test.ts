import { describe, expect, it } from 'vitest'
import { defaultAgentRoots, resolveOwningRoot, type AgentRoot } from './agents'

describe('defaultAgentRoots', () => {
  it('covers the supported agents', () => {
    const roots = defaultAgentRoots({} as NodeJS.ProcessEnv)
    expect(roots.map((root) => root.agent)).toEqual([
      'claude',
      'codex',
      'pi',
      'cursor',
      'cursor',
      'grok',
    ])
  })

  it('honours environment overrides', () => {
    const roots = defaultAgentRoots({
      CODEX_HOME: '/custom/codex',
      CURSOR_CONFIG_DIR: '/custom/cursor',
      GROK_HOME: '/custom/grok',
    } as NodeJS.ProcessEnv)
    const codex = roots.find((root) => root.agent === 'codex')
    const cursorRoots = roots.filter((root) => root.agent === 'cursor')
    const grok = roots.find((root) => root.agent === 'grok')
    expect(codex?.dir).toBe('/custom/codex/sessions')
    expect(cursorRoots).toEqual([
      { agent: 'cursor', dir: '/custom/cursor/projects' },
      { agent: 'cursor', dir: '/custom/cursor/acp-sessions', fileName: 'store.db' },
    ])
    expect(grok).toMatchObject({
      dir: '/custom/grok/sessions',
      fileName: 'chat_history.jsonl',
    })
  })
})

describe('resolveOwningRoot', () => {
  const roots: AgentRoot[] = [
    { agent: 'codex', dir: '/home/u/.codex/sessions' },
    // A relocated home nested inside another agent's tree.
    { agent: 'pi', dir: '/home/u/.codex/sessions/pi/agent/sessions' },
  ]

  it('prefers the deepest matching root so agents are not mislabelled', () => {
    const owner = resolveOwningRoot('/home/u/.codex/sessions/pi/agent/sessions/a.jsonl', roots)
    expect(owner?.agent).toBe('pi')
  })

  it('attributes other files to the outer root', () => {
    const owner = resolveOwningRoot('/home/u/.codex/sessions/2026/a.jsonl', roots)
    expect(owner?.agent).toBe('codex')
  })

  it('rejects paths outside every root', () => {
    expect(resolveOwningRoot('/etc/passwd', roots)).toBeUndefined()
    // A sibling directory sharing a name prefix must not match.
    expect(resolveOwningRoot('/home/u/.codex/sessions-backup/a.jsonl', roots)).toBeUndefined()
  })
})
