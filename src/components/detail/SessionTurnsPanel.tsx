import { useMemo } from 'react'
import { computeSessionTurns } from '../../core/sessionTurns'
import type { ExplorerSession, TimelineEvent } from '../../core/types'
import { useSessionStore } from '../../store/sessionStore'

function formatTokens(value: number | undefined): string {
  return value === undefined ? 'Not reported' : `${value.toLocaleString()} tokens`
}

/**
 * Per-turn token totals and a ranking of the heaviest requests. Each row can
 * reveal the originating record in every panel so a costly request is easy to
 * find. Both lists cover only records that carry per-request usage.
 */
export function SessionTurnsPanel({ session }: { session: ExplorerSession }) {
  const revealEvent = useSessionStore((s) => s.revealEvent)
  const breakdown = useMemo(() => computeSessionTurns(session, { topRequestLimit: 5 }), [session])

  const eventByLine = useMemo(() => {
    const map = new Map<number, TimelineEvent>()
    for (const event of session.events) map.set(event.lineIndex, event)
    return map
  }, [session])

  function locate(lineIndex: number | undefined) {
    if (lineIndex === undefined) return
    const event = eventByLine.get(lineIndex)
    if (event) revealEvent(event)
  }

  if (breakdown.turns.length === 0 && breakdown.topRequests.length === 0) {
    return <p className="text-xs text-secondary">No per-turn usage recorded for this session.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {breakdown.turns.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-primary">Per turn</h4>
          <div className="flex flex-col">
            {breakdown.turns.map((turn) => (
              <button
                key={turn.turnIndex}
                type="button"
                onClick={() => locate(turn.firstLineIndex)}
                disabled={turn.firstLineIndex === undefined}
                className="grid grid-cols-[80px_1fr_auto] items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-overlay disabled:cursor-default disabled:hover:bg-transparent"
                title={turn.firstLineIndex === undefined ? undefined : 'Reveal this turn'}
              >
                <span className="text-secondary">
                  {turn.turnIndex === 0 ? 'No turn' : `Turn ${turn.turnIndex}`}
                </span>
                <span className="font-mono text-primary">{formatTokens(turn.totalTokens)}</span>
                <span className="text-tertiary">{turn.usage.requestCount} req</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {breakdown.topRequests.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-primary">Largest requests</h4>
          <div className="flex flex-col">
            {breakdown.topRequests.map((request) => (
              <button
                key={request.lineIndex}
                type="button"
                onClick={() => locate(request.lineIndex)}
                className="grid grid-cols-[80px_1fr_auto] items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-overlay"
                title="Reveal this request"
              >
                <span className="text-secondary">
                  {request.turnIndex === undefined ? 'No turn' : `Turn ${request.turnIndex}`}
                </span>
                <span className="font-mono text-primary">{formatTokens(request.totalTokens)}</span>
                <span className="text-tertiary">#{request.lineIndex + 1}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-secondary">
        Totals cover records that report per-request usage. Cumulative snapshots
        are excluded so the same tokens are not counted twice. Select a row to
        reveal its record in the timeline and conversation.
      </p>
    </div>
  )
}
