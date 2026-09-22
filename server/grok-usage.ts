import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isGrokHistoryPath(path: string): boolean {
  return basename(path) === 'chat_history.jsonl'
}

function usagePath(historyPath: string): string {
  return join(dirname(historyPath), 'updates.jsonl')
}

/**
 * Grok keeps per-turn token counts in a sibling `updates.jsonl` rather than in
 * the conversation log, so the two files are joined here and the counts are
 * keyed by the `prompt_index` that `chat_history.jsonl` already records.
 */
function readTurnUsage(historyPath: string): Record<string, unknown>[] {
  let text: string
  try {
    text = readFileSync(usagePath(historyPath), 'utf8')
  } catch {
    return []
  }

  const turns: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const params = parsed.params
    if (!isRecord(params)) continue
    const update = params.update
    if (!isRecord(update)) continue
    if (update.sessionUpdate !== 'turn_completed') continue
    if (!isRecord(update.usage)) continue

    turns.push({
      type: 'turn_completed',
      prompt_index: turns.length,
      prompt_id: update.prompt_id,
      stop_reason: update.stop_reason,
      elapsed_ms: update.elapsed_ms,
      usage: update.usage,
      timestamp: parsed.timestamp,
    })
  }
  return turns
}

/**
 * Splices each turn's usage record in after the lines belonging to that turn,
 * so the counts appear in the timeline where the turn ended.
 */
export function grokHistoryToJsonl(historyPath: string): string {
  const text = readFileSync(historyPath, 'utf8')
  const turns = readTurnUsage(historyPath)
  if (turns.length === 0) return text

  const lines = text.split('\n').filter((line) => line.length > 0)
  const output: string[] = []
  let nextTurn = 0

  for (const line of lines) {
    let promptIndex: unknown
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) promptIndex = parsed.prompt_index
    } catch {
      // Keep malformed lines so the viewer can still surface them.
    }

    // A new prompt means the previous turn is over; emit its counts first.
    if (typeof promptIndex === 'number' && promptIndex > nextTurn) {
      while (nextTurn < promptIndex && nextTurn < turns.length) {
        output.push(JSON.stringify(turns[nextTurn]))
        nextTurn += 1
      }
    }
    output.push(line)
  }

  while (nextTurn < turns.length) {
    output.push(JSON.stringify(turns[nextTurn]))
    nextTurn += 1
  }
  return output.join('\n')
}

