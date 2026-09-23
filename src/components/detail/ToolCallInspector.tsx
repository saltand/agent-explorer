import { useMemo } from 'react'
import { codeExecSource } from '../../core/codeExec'
import { inspectToolCall, selectedToolItem } from '../../core/toolCalls'
import type { ConversationListItem, ExplorerSession, Selection } from '../../core/types'
import { useSessionStore } from '../../store/sessionStore'
import { CodeInspector } from './CodeInspector'
import { CollapsibleJson } from './CollapsibleJson'
import { ExpandablePre } from '../shared/ExpandablePre'
import { SummaryRow } from './SummaryRow'

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} m ${Math.round(seconds % 60)} s`
}

function formatTimestamp(item: ConversationListItem | undefined): string | undefined {
  if (!item) return undefined
  return item.event.timestampLabel ?? (item.event.timestamp !== undefined ? new Date(item.event.timestamp).toISOString() : undefined)
}

function statusLabel(status: 'pending' | 'running' | 'completed' | 'failed', sessionId?: number): string {
  if (status === 'failed') return 'Failed'
  if (status === 'completed') return 'Completed'
  if (status === 'running') return `Still running · session ${sessionId}`
  return 'No result recorded'
}

export function ToolCallInspector({
  session,
  selection,
}: {
  session: ExplorerSession
  selection: Selection
}) {
  const item = selectedToolItem(selection)
  const revealEvent = useSessionStore((s) => s.revealEvent)
  const info = useMemo(
    () => (item ? inspectToolCall(session.conversationItems, item) : undefined),
    [session.conversationItems, item],
  )
  if (!info) return null

  const codeSource = codeExecSource(
    info.call?.block?.toolName,
    info.call?.block?.toolInput,
  )
  const argsJson = info.call?.block?.toolInput
    ? JSON.stringify(info.call.block.toolInput, null, 2)
    : undefined

  const statusTone =
    info.status === 'failed'
      ? 'text-danger'
      : info.status === 'completed'
        ? 'text-success'
        : 'text-warning-text'

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-separator bg-under-page-background p-3">
      <h3 className="text-xs font-semibold text-primary">Tool call</h3>
      <div className="flex flex-col gap-2">
        {info.toolName && <SummaryRow label="Tool" value={info.toolName} />}
        {info.callId && <SummaryRow label="Call ID" value={info.callId} />}
        <div className="grid grid-cols-[120px_1fr] gap-2 text-xs">
          <span className="text-secondary">Status</span>
          <span className={`font-mono ${statusTone}`}>{statusLabel(info.status, info.sessionId)}</span>
        </div>
        {formatTimestamp(info.call) && (
          <SummaryRow label="Call recorded" value={formatTimestamp(info.call)!} />
        )}
        {formatTimestamp(info.result) && (
          <SummaryRow label="Result recorded" value={formatTimestamp(info.result)!} />
        )}
        {info.reportedDurationMs !== undefined && (
          <SummaryRow
            label="Duration"
            value={`${formatMs(info.reportedDurationMs)} · reported by the tool result`}
          />
        )}
        {info.eventSpanMs !== undefined && (
          <SummaryRow
            label="Call → result"
            value={`${formatMs(info.eventSpanMs)} · between the two records`}
          />
        )}
        {info.exitCode !== undefined && (
          <SummaryRow label="Exit code" value={String(info.exitCode)} />
        )}
      </div>

      {info.errors.length > 0 && (
        <div role="note" className="flex flex-col gap-1 text-xs text-danger">
          {info.errors.map((error) => (
            <p key={error.label}>
              {error.label}: {error.value}
            </p>
          ))}
        </div>
      )}

      {info.parent && (
        <div className="text-xs">
          <span className="text-secondary">Nested under: </span>
          <button
            type="button"
            onClick={() => revealEvent(info.parent!.item.event)}
            className="font-mono text-accent hover:underline"
          >
            {info.parent.item.block?.toolName ?? 'tool'} · {info.parent.relation}
          </button>
        </div>
      )}

      {info.children.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-secondary">
            Nested calls · {info.children.length}
          </h4>
          <ul className="flex flex-col gap-0.5">
            {info.children.map((child) => (
              <li key={child.item.id}>
                <button
                  type="button"
                  onClick={() => revealEvent(child.item.event)}
                  className="w-full truncate rounded px-1 py-0.5 text-left font-mono text-xs text-primary hover:bg-overlay"
                  title={child.item.event.preview}
                >
                  {child.item.block?.toolName ?? 'tool'} · {child.relation}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {codeSource ? (
        <CodeInspector
          source={codeSource}
          argsJson={argsJson}
          output={info.result?.block?.text}
        />
      ) : (
        <>
          {info.call?.block?.toolInput && Object.keys(info.call.block.toolInput).length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-secondary">Arguments</h4>
              <CollapsibleJson value={info.call.block.toolInput} />
            </div>
          )}

          {info.result?.block?.text && (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-secondary">Result</h4>
              <ExpandablePre text={info.result.block.text} className="rounded border border-separator bg-background px-3 py-2" />
            </div>
          )}
        </>
      )}
    </section>
  )
}
