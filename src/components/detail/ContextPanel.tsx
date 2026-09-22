import { useMemo } from 'react'
import { inspectContext, type ContextFieldChange } from '../../core/contextInspection'
import { lineDiff } from '../../core/lineDiff'
import type { ExplorerSession } from '../../core/types'
import { useSessionStore } from '../../store/sessionStore'
import { ExpandablePre } from '../shared/ExpandablePre'
import { SummaryRow } from './SummaryRow'

function diffValue(change: ContextFieldChange): string {
  if (change.before === undefined) return `added: ${change.after ?? ''}`
  if (change.after === undefined) return `removed: ${change.before}`
  if (change.before.length + change.after!.length < 120) {
    return `${change.before} → ${change.after}`
  }
  return `${change.before.length} → ${change.after!.length} chars`
}

function FieldChange({ change }: { change: ContextFieldChange }) {
  const multiline =
    change.before !== undefined &&
    change.after !== undefined &&
    (change.before.includes('\n') || change.after.includes('\n'))
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[120px_1fr] gap-2 text-xs">
        <span className="text-secondary">{change.field}</span>
        <span className="break-all font-mono text-primary">{diffValue(change)}</span>
      </div>
      {multiline && (
        <pre className="max-h-64 overflow-auto rounded bg-overlay p-2 font-mono text-[11px] leading-relaxed">
          {lineDiff(change.before!, change.after!).map((line, i) => (
            <div
              key={i}
              className={
                line.type === 'add'
                  ? 'text-success'
                  : line.type === 'del'
                    ? 'text-danger'
                    : 'text-tertiary'
              }
            >
              {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
              {line.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

/**
 * Recorded context state: the session's system prompt, per-turn context
 * changes, and compression events. Entries reveal their source record.
 */
export function ContextPanel({ session }: { session: ExplorerSession }) {
  const revealEvent = useSessionStore((s) => s.revealEvent)
  const inspection = useMemo(() => inspectContext(session), [session])

  const { systemPrompts, snapshots, compactions } = inspection
  const changed = snapshots.filter((s) => s.status === 'changed')
  if (systemPrompts.length === 0 && snapshots.length === 0 && compactions.length === 0) {
    return <p className="text-xs text-secondary">This session records no context or compaction details.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {systemPrompts.map((prompt, i) => (
        <section key={prompt.event.id} className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => revealEvent(prompt.event)}
            className="text-left text-xs font-semibold text-primary hover:text-accent"
            title="Reveal the record that carries this prompt"
          >
            System prompt{systemPrompts.length > 1 ? ` ${i + 1}` : ''}
            {prompt.provenance ? ` · ${prompt.provenance}` : ''}
          </button>
          <ExpandablePre text={prompt.text} />
        </section>
      ))}

      {snapshots.length > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-primary">
            Turn context · {changed.length} of {snapshots.length} changed
          </h4>
          {snapshots.map((snapshot) => (
            <details key={snapshot.event.id} className="text-xs">
              <summary className="cursor-pointer rounded px-1 py-0.5 hover:bg-overlay">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    revealEvent(snapshot.event)
                  }}
                  className="text-secondary hover:text-accent"
                  title="Reveal this turn_context record"
                >
                  Turn {snapshot.event.turnIndex ?? '?'}
                </button>{' '}
                <span className="text-tertiary">
                  {snapshot.status === 'initial'
                    ? 'initial context'
                    : snapshot.status === 'unchanged'
                      ? 'unchanged'
                      : snapshot.changes.map((c) => c.field).join(', ')}
                </span>
              </summary>
              {snapshot.changes.length > 0 && (
                <div className="ml-3 flex flex-col gap-1.5 border-l border-separator pl-2 pt-1">
                  {snapshot.changes.map((change) => (
                    <FieldChange key={change.field} change={change} />
                  ))}
                </div>
              )}
            </details>
          ))}
        </section>
      )}

      {compactions.length > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-primary">
            Compactions · {compactions.length}
          </h4>
          {compactions.map((entry) => (
            <details key={entry.event.id} className="text-xs">
              <summary className="cursor-pointer rounded px-1 py-0.5 hover:bg-overlay">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    revealEvent(entry.event)
                  }}
                  className="text-secondary hover:text-accent"
                  title="Reveal this compaction record"
                >
                  {entry.event.kind}
                </button>{' '}
                <span className="text-tertiary">
                  {[
                    entry.event.turnIndex !== undefined ? `turn ${entry.event.turnIndex}` : undefined,
                    entry.event.timestampLabel,
                    entry.tokensBefore !== undefined
                      ? `${entry.tokensBefore.toLocaleString()} tokens before`
                      : undefined,
                    entry.replacedRecords !== undefined
                      ? `replaced ${entry.replacedRecords} records`
                      : undefined,
                    entry.usage?.totalInputTokens !== undefined ||
                    entry.usage?.outputTokens !== undefined
                      ? `compaction used ${(entry.usage?.outputTokens ?? 0).toLocaleString()} output tokens`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </summary>
              <div className="ml-3 flex flex-col gap-1.5 border-l border-separator pl-2 pt-1">
                {entry.summary && <ExpandablePre text={entry.summary} mono={false} />}
                {entry.readFiles.length > 0 && (
                  <SummaryRow label="Files read" value={entry.readFiles.join(', ')} />
                )}
                {entry.modifiedFiles.length > 0 && (
                  <SummaryRow label="Files modified" value={entry.modifiedFiles.join(', ')} />
                )}
              </div>
            </details>
          ))}
        </section>
      )}
    </div>
  )
}
