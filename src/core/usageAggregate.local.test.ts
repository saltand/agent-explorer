import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectAndParse } from './registry'
import { computeSessionUsage } from './sessionUsage'

/**
 * Reconciles aggregation against real Codex logs when this machine has them.
 * The fixtures are too small to exercise resumed sessions, requests that record
 * no usage, or the volume of repeated snapshots a long session produces, so the
 * dedup and baseline rules are checked against the local corpus instead.
 */
function findRollouts(limit: number): string[] {
  const root = join(homedir(), '.codex', 'sessions')
  const found: string[] = []

  function walk(dir: string): void {
    if (found.length >= limit) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const path = join(dir, entry)
      let isDirectory: boolean
      try {
        isDirectory = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) walk(path)
      else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) found.push(path)
    }
  }

  walk(root)
  return found
}

describe('session usage against local Codex logs', () => {
  const files = findRollouts(120)

  it.runIf(files.length > 0)('never counts more tokens than the log reports', () => {
    let reconciled = 0
    let withGap = 0

    for (const file of files) {
      const session = detectAndParse(readFileSync(file, 'utf8'), 'rollout.jsonl')
      const usage = computeSessionUsage(session)
      const summed = usage.summedTotalTokens
      const reported = usage.reportedSessionTotalTokens
      if (summed === undefined || reported === undefined) continue

      // Overcounting is the failure that matters: it would mean repeated
      // snapshots of one request were summed, inflating the session.
      expect(summed).toBeLessThanOrEqual(reported)

      if (summed === reported) reconciled += 1
      else {
        withGap += 1
        // A shortfall must be disclosed rather than presented as the total.
        expect(usage.incomplete).toBe(true)
        expect(usage.issues.join(' ')).toContain('recorded no usage')
      }
    }

    // Most sessions should reconcile exactly; otherwise the dedup rule drifted.
    expect(reconciled).toBeGreaterThan(withGap)
  })
})
