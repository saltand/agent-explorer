import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'

export const AGENT_KINDS = ['claude', 'codex', 'pi', 'cursor', 'grok'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export interface AgentRoot {
  agent: AgentKind
  /** Absolute, normalized directory that holds session JSONL files. */
  dir: string
  /**
   * When set, only files with this basename are indexed. Grok sessions store
   * several JSONL sidecars next to the conversation log.
   */
  fileName?: string
}

export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  cursor: 'Cursor Agent',
  grok: 'Grok Build',
}

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(value)
}

/** Applies per-agent indexing defaults such as Grok's conversation filename. */
export function createAgentRoot(agent: AgentKind, dir: string, fileName?: string): AgentRoot {
  const root: AgentRoot = { agent, dir }
  if (fileName) {
    root.fileName = fileName
  } else if (agent === 'grok') {
    root.fileName = 'chat_history.jsonl'
  } else if (
    agent === 'cursor' &&
    (dir.endsWith('/acp-sessions') || dir.endsWith('/chats') || dir.endsWith('\\acp-sessions') || dir.endsWith('\\chats'))
  ) {
    root.fileName = 'store.db'
  }
  return root
}

export function isIndexedSessionFile(filePath: string, root: AgentRoot): boolean {
  const name = basename(filePath)
  if (root.fileName) return name === root.fileName
  return name.endsWith('.jsonl')
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
  roots.push(createAgentRoot('claude', resolve(expandHome(claudeHome), 'projects')))

  const codexHome = env.CODEX_HOME ?? resolve(home, '.codex')
  roots.push(createAgentRoot('codex', resolve(expandHome(codexHome), 'sessions')))

  const piHome = env.PI_CONFIG_DIR ?? resolve(home, '.pi')
  roots.push(createAgentRoot('pi', resolve(expandHome(piHome), 'agent', 'sessions')))

  const cursorHome = env.CURSOR_CONFIG_DIR ?? resolve(home, '.cursor')
  const cursorRoot = expandHome(cursorHome)
  roots.push(createAgentRoot('cursor', resolve(cursorRoot, 'projects')))
  roots.push(createAgentRoot('cursor', resolve(cursorRoot, 'acp-sessions'), 'store.db'))

  const grokHome = env.GROK_HOME ?? resolve(home, '.grok')
  roots.push(createAgentRoot('grok', resolve(expandHome(grokHome), 'sessions')))

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
