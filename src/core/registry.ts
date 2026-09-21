import { claudeTranscriptAdapter } from '../adapters/claude-transcript'
import { codexRolloutAdapter } from '../adapters/codex-rollout'
import { cursorAgentAdapter } from '../adapters/cursor-agent'
import { grokBuildAdapter } from '../adapters/grok-build'
import { piSessionAdapter } from '../adapters/pi-session'
import type { SessionAdapter } from '../adapters/types'
import { parseJsonlText } from './jsonl'
import type { ExplorerSession } from './types'

const adapters: SessionAdapter[] = [
  claudeTranscriptAdapter,
  codexRolloutAdapter,
  piSessionAdapter,
  cursorAgentAdapter,
  grokBuildAdapter,
]

export function getAdapters(): SessionAdapter[] {
  return adapters
}

export function detectAndParse(text: string, fileName: string): ExplorerSession {
  const { lines, warnings } = parseJsonlText(text)
  const samples = lines.slice(0, Math.min(20, lines.length))

  let best = adapters[0]!
  let bestScore = 0

  for (const adapter of adapters) {
    const score = adapter.detect(samples)
    if (score > bestScore) {
      bestScore = score
      best = adapter
    }
  }

  if (bestScore < 0.5) {
    throw new Error(
      'Unrecognized JSONL format. Supported formats: Claude Code transcripts, Codex rollout logs, Pi sessions, Cursor Agent transcripts, and Grok Build sessions.',
    )
  }

  const session = best.parse(lines, fileName)
  session.parseWarnings.push(...warnings)
  return session
}