import type { RemoteSearchHit } from '../../core/serverApi'
import { selectedRing } from '../../styles/uiClasses'
import { formatProject, formatRelativeTime } from './formatters'

interface SearchHitItemProps {
  hit: RemoteSearchHit
  selected: boolean
  onSelect: (hit: RemoteSearchHit) => void
}

export function SearchHitItem({ hit, selected, onSelect }: SearchHitItemProps) {
  const project = formatProject(hit.cwd)

  return (
    <button
      type="button"
      onClick={() => onSelect(hit)}
      className={`w-full border-b border-separator px-3 py-2 text-left hover:bg-overlay ${
        selected ? `bg-overlay-emphasized ${selectedRing}` : ''
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-overlay px-1.5 py-0.5 text-[10px] font-medium text-secondary">
          {hit.agent}
        </span>
        <span className="text-[10px] text-tertiary">{hit.role}</span>
        <span className="ml-auto shrink-0 text-[10px] text-tertiary">
          {formatRelativeTime(hit.mtimeMs)}
        </span>
      </div>

      <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-secondary">
        {hit.snippet.map((part, index) =>
          part.match ? (
            <mark key={index} className="rounded bg-accent/25 px-0.5 text-primary">
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </div>

      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-tertiary">
        <span className="truncate">{project ?? hit.fileName}</span>
        <span className="ml-auto shrink-0">line {hit.lineIndex + 1}</span>
      </div>
    </button>
  )
}
