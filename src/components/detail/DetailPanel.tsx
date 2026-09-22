import { useEffect, useState, type ReactNode } from 'react'
import {
  chipActive,
  chipInactive,
  emptyState,
  sectionDivider,
} from '../../styles/uiClasses'
import { useSessionStore } from '../../store/sessionStore'
import { CollapsibleJson } from './CollapsibleJson'
import { EventSummary } from './EventSummary'
import { RequestMetricsPanel } from './RequestMetricsPanel'
import { SessionMetaPanel } from './SessionMetaPanel'
import { SessionTurnsPanel } from './SessionTurnsPanel'
import { SessionUsagePanel } from './SessionUsagePanel'
import { ToolCallInspector } from './ToolCallInspector'
import { selectedToolItem } from '../../core/toolCalls'
import { UsagePanel } from './UsagePanel'

type DetailTab = 'session' | 'summary' | 'usage' | 'raw'

export function DetailPanel() {
  const session = useSessionStore((s) => s.session)
  const selection = useSessionStore((s) => s.selection)
  const [lastSelectedEventId, setLastSelectedEventId] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<DetailTab>('session')

  const selectedEventId = selection?.event?.id
  const hasEvent = !!(selection?.event)
  const hasUsage = !!(selection?.event?.usage)
  const hasToolCall = !!(selection && selectedToolItem(selection))

  // FIXME: we don't need these `useEffect` hooks maybe.
  useEffect(() => {
    setLastSelectedEventId(selectedEventId)
    if (hasEvent || hasToolCall) {
      if (tab === 'session' && lastSelectedEventId !== selectedEventId) {
        setTab('summary');
      }
    } else {
      if (tab === 'summary' || tab === 'raw') {
        setTab('session')
      }
    }
  }, [lastSelectedEventId, setLastSelectedEventId, tab, selectedEventId, hasEvent, hasToolCall])

  if (!session) {
    return (
      <div className={`flex h-full items-center justify-center p-4 ${emptyState}`}>
        No session loaded
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className={`flex items-center gap-1 px-1 ${sectionDivider}`}>
        <TabButton active={tab === 'session'} onClick={() => setTab('session')}>
          Session
        </TabButton>
        <TabButton
          active={tab === 'summary'}
          onClick={() => setTab('summary')}
          disabled={!hasEvent && !hasToolCall}
        >
          Summary
        </TabButton>
        <TabButton active={tab === 'usage'} onClick={() => setTab('usage')}>
          Usage
        </TabButton>
        <TabButton
          active={tab === 'raw'}
          onClick={() => setTab('raw')}
          disabled={!hasEvent}
        >
          Raw JSON
        </TabButton>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {tab === 'session' && <SessionMetaPanel session={session} />}
        {tab === 'summary' && (hasEvent || hasToolCall) && (
          <div className="flex flex-col gap-3">
            <ToolCallInspector session={session} selection={selection} />
            <EventSummary selection={selection} />
            <RequestMetricsPanel session={session} selection={selection} />
          </div>
        )}
        {tab === 'usage' && (
          <div className="flex flex-col gap-4">
            <UsageSection title="Session total">
              <SessionUsagePanel session={session} />
            </UsageSection>
            <UsageSection title="Turns & largest requests">
              <SessionTurnsPanel session={session} />
            </UsageSection>
            <UsageSection title="Selected request">
              {hasUsage && selection ? (
                <UsagePanel selection={selection} />
              ) : (
                <p className="text-xs text-secondary">
                  {hasEvent
                    ? 'The selected record reports no token usage.'
                    : 'Select a record to see its usage.'}
                </p>
              )}
            </UsageSection>
          </div>
        )}
        {tab === 'raw' && selection?.event && <CollapsibleJson value={selection.event.raw} />}
      </div>
    </div>
  )
}

function UsageSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-primary">{title}</h3>
      {children}
    </section>
  )
}

function TabButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`my-1 rounded px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? chipActive : chipInactive
      }`}
    >
      {children}
    </button>
  )
}
