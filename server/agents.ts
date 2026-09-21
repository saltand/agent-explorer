import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

export type AgentKind = 'claude' | 'codex' | 'pi'

export interface AgentRoot {
  agent: AgentKind
  /** Absolute, normalized directory that holds session JSONL files. */
  dir: string
}

export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2))
  return isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input)
}

/**
 * Candidate session directories per agent. Environment overrides win because
 * users can relocate these homes (CODEX_HOME is the common case).
 */
export function defaultAgentRoots(env: NodeJS.ProcessEnv = process.env): AgentRoot[] {
  const home = homedir()
  const roots: AgentRoot[] = []

  const claudeHome = env.CLAUDE_CONFIG_DIR ?? resolve(home, '.claude')
  roots.push({ agent: 'claude', dir: resolve(expandHome(claudeHome), 'projects') })

  const codexHome = env.CODEX_HOME ?? resolve(home, '.codex')
  roots.push({ agent: 'codex', dir: resolve(expandHome(codexHome), 'sessions') })

  const piHome = env.PI_CONFIG_DIR ?? resolve(home, '.pi')
  roots.push({ agent: 'pi', dir: resolve(expandHome(piHome), 'agent', 'sessions') })

  return roots
}

/**
 * Picks the root that owns a path, preferring the deepest match. An agent home
 * may be relocated inside another agent's tree, and attributing a file to the
 * shallower root would label it with the wrong agent.
 */
export function resolveOwningRoot(filePath: string, roots: AgentRoot[]): AgentRoot | undefined {
  let best: AgentRoot | undefined
  for (const root of roots) {
    const prefix = root.dir.endsWith('/') ? root.dir : `${root.dir}/`
    if (!filePath.startsWith(prefix)) continue
    if (!best || root.dir.length > best.dir.length) best = root
  }
  return best
}
