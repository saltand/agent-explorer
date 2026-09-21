import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

const STORAGE_KEY = 'agent-explorer-library-width'
const DEFAULT_WIDTH = 300
const MIN_WIDTH = 220
const MAX_WIDTH = 520
const HANDLE_WIDTH = 6

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_WIDTH
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_WIDTH
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed))
  } catch {
    return DEFAULT_WIDTH
  }
}

interface LibrarySidebarProps {
  open: boolean
  children: ReactNode
}

/** Resizable left sidebar that hosts the session library. */
export function LibrarySidebar({ open, children }: LibrarySidebarProps) {
  const [width, setWidth] = useState(readStoredWidth)
  const [dragging, setDragging] = useState(false)
  const startRef = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(width))
    } catch {
      // Persistence is best-effort.
    }
  }, [width])

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const start = startRef.current
    if (!start) return
    const next = start.width + (event.clientX - start.x)
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
  }, [])

  const handlePointerUp = useCallback(() => {
    startRef.current = null
    setDragging(false)
  }, [])

  useEffect(() => {
    if (!dragging) return
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [dragging, handlePointerMove, handlePointerUp])

  if (!open) return null

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      <div className="h-full min-w-0 flex-1 border-r border-separator">{children}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize library sidebar"
        className={`split-handle ${dragging ? 'split-handle-active' : ''}`}
        style={{ left: width - HANDLE_WIDTH / 2, width: HANDLE_WIDTH }}
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          startRef.current = { x: event.clientX, width }
          setDragging(true)
        }}
      />
    </div>
  )
}
