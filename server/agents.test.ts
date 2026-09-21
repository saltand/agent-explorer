import { describe, expect, it } from 'vitest'
import { defaultAgentRoots, resolveOwningRoot, type AgentRoot } from './agents'

describe('defaultAgentRoots', () => {
  it('covers the three supported agents', () => {
    const roots = defaultAgentRoots({} as NodeJS.ProcessEnv)
    expect(roots.map((root) => root.agent)).toEqual(['claude', 'codex', 'pi'])
  })

  it('honours environment overrides', () => {
    const roots = defaultAgentRoots({ CODEX_HOME: '/custom/codex' } as NodeJS.ProcessEnv)
    const codex = roots.find((root) => root.agent === 'codex')
    expect(codex?.dir).toBe('/custom/codex/sessions')
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
