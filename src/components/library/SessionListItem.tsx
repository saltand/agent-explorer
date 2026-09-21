import type { RemoteSessionSummary } from '../../core/serverApi'
import { selectedRing } from '../../styles/uiClasses'
import { formatBytes, formatProject, formatRelativeTime } from './formatters'

interface SessionListItemProps {
  session: RemoteSessionSummary
  selected: boolean
  stale: boolean
  onSelect: (id: string) => void
}

export function SessionListItem({ session, selected, stale, onSelect }: SessionListItemProps) {
  const project = formatProject(session.cwd)
  const title = session.title ?? project ?? session.fileName

  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      aria-current={selected ? 'true' : undefined}
      className={`w-full border-b border-separator px-3 py-2 text-left hover:bg-overlay ${
        selected ? `bg-overlay-emphasized ${selectedRing}` : ''
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-overlay px-1.5 py-0.5 text-[10px] font-medium text-secondary">
          {session.agent}
        </span>
        {stale && (
          <span
            className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
            title="This file changed on disk"
          >
            updated
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-tertiary">
          {formatRelativeTime(session.mtimeMs)}
        </span>
      </div>

      <div className="mt-1 line-clamp-2 text-xs text-primary">{title}</div>

      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-tertiary">
        {project && <span className="truncate">{project}</span>}
        <span className="ml-auto shrink-0">{formatBytes(session.size)}</span>
      </div>
    </button>
  )
}
