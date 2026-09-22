import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildTimingSpans, type TimingSpan, type TimingSpanKind } from '../../core/timingSpans'
import type { ExplorerSession } from '../../core/types'
import { useSessionStore } from '../../store/sessionStore'
import { useSettingsStore } from '../../store/settingsStore'
import { chipActive, chipInactive, emptyStateXs } from '../../styles/uiClasses'

const ROW_H = 22
const BAR_H = 14
const LANE_TITLE: Record<TimingSpanKind, string> = {
  request: 'Requests',
  tool: 'Tools',
  turn: 'Turns',
}
const LANE_ORDER: TimingSpanKind[] = ['request', 'tool', 'turn']

function barClass(span: TimingSpan): string {
  if (span.status === 'failed') return 'bg-danger'
  if (span.status === 'running') return 'bg-warning'
  if (span.status === 'pending') return 'bg-role-meta'
  if (span.kind === 'request') return 'bg-role-assistant'
  if (span.kind === 'tool') return 'bg-role-tool'
  return 'bg-role-system'
}

function formatTick(ms: number, withMs: boolean): string {
  const d = new Date(ms)
  const base = d.toLocaleTimeString('en-GB', { hour12: false })
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, '0')}` : base
}

function niceStep(spanMs: number, targetTicks: number): number {
  const steps = [50, 100, 250, 500, 1000, 5000, 15000, 30000, 60000, 300000, 900000, 1800000, 3600000]
  const raw = spanMs / targetTicks
  return steps.find((s) => s >= raw) ?? 7200000
}

function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 0)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

export function TimingChart({ session }: { session: ExplorerSession }) {
  const selection = useSessionStore((s) => s.selection)
  const revealEvent = useSessionStore((s) => s.revealEvent)
  const timeRange = useSettingsStore((s) => s.timeRange)
  const setTimeRange = useSettingsStore((s) => s.setTimeRange)

  const [mode, setMode] = useState<'duration' | 'uniform'>('duration')
  const [view, setView] = useState<[number, number] | null>(null)
  const [slotZoom, setSlotZoom] = useState(1)
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null)
  const [trackRef, trackW] = useContainerWidth()

  const spans = useMemo(() => buildTimingSpans(session), [session])
  const extent = useMemo(() => {
    if (spans.length === 0) return null
    let min = Infinity
    let max = -Infinity
    for (const span of spans) {
      if (span.start < min) min = span.start
      if (span.end > max) max = span.end
    }
    if (max <= min) max = min + 1
    return [min, max] as const
  }, [spans])

  const lanes = useMemo(() => {
    const grouped = new Map<TimingSpanKind, TimingSpan[]>()
    for (const span of spans) {
      const lane = grouped.get(span.kind) ?? []
      lane.push(span)
      grouped.set(span.kind, lane)
    }
    return LANE_ORDER.filter((kind) => grouped.has(kind)).map((kind) => ({
      kind,
      title: LANE_TITLE[kind],
      spans: grouped.get(kind)!,
    }))
  }, [spans])

  const viewStart = view?.[0] ?? extent?.[0] ?? 0
  const viewEnd = view?.[1] ?? extent?.[1] ?? 1
  const pxPerMs = trackW / Math.max(1, viewEnd - viewStart)
  const slotW = 14 * slotZoom

  const zoomView = useCallback(
    (factor: number) => {
      if (!extent) return
      const [s, e] = view ?? extent
      const center = (s + e) / 2
      const half = Math.min((e - s) * factor, extent[1] - extent[0]) / 2
      setView([center - half, center + half])
    },
    [view, extent],
  )

  // Lane-local x mapping: duration uses the shared time window, uniform uses
  // the span's ordinal index inside its lane.
  const barX = useCallback(
    (span: TimingSpan, index: number) =>
      mode === 'duration'
        ? (span.start - viewStart) * pxPerMs
        : index * slotW,
    [mode, viewStart, pxPerMs, slotW],
  )
  const barW = useCallback(
    (span: TimingSpan) =>
      mode === 'duration'
        ? Math.max(3, (span.end - span.start) * pxPerMs)
        : slotW * 0.7,
    [mode, pxPerMs, slotW],
  )

  const selectInterval = useCallback(
    (x0: number, x1: number, lane: TimingSpan[]) => {
      if (mode === 'duration') {
        const t0 = viewStart + Math.min(x0, x1) / pxPerMs
        const t1 = viewStart + Math.max(x0, x1) / pxPerMs
        setTimeRange([t0, t1])
        setView([t0, t1])
      } else {
        const i0 = Math.max(0, Math.floor(Math.min(x0, x1) / slotW))
        const i1 = Math.min(lane.length - 1, Math.floor(Math.max(x0, x1) / slotW))
        if (i1 < i0) return
        const chosen = lane.slice(i0, i1 + 1)
        const t0 = Math.min(...chosen.map((s) => s.start))
        const t1 = Math.max(...chosen.map((s) => s.end))
        setTimeRange([t0, t1])
      }
    },
    [mode, viewStart, pxPerMs, slotW, setTimeRange],
  )

  const inRange = useCallback(
    (span: TimingSpan) =>
      timeRange ? span.end >= timeRange[0] && span.start <= timeRange[1] : false,
    [timeRange],
  )

  // Reveal the selected event's bar when the selection came from elsewhere.
  useEffect(() => {
    if (!selection?.event) return
    document
      .querySelector(`[data-span-event="${CSS.escape(selection.event.id)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selection])

  if (!extent) {
    return (
      <div className={`flex h-full items-center justify-center p-4 ${emptyStateXs}`}>
        This session records no timestamps to chart.
      </div>
    )
  }

  const step = niceStep(viewEnd - viewStart, 6)
  const ticks: number[] = []
  for (let t = Math.ceil(viewStart / step) * step; t <= viewEnd; t += step) ticks.push(t)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-separator px-3 py-1.5 text-[11px]">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMode('duration')}
            className={`rounded px-2 py-0.5 font-medium ${mode === 'duration' ? chipActive : chipInactive}`}
          >
            Duration
          </button>
          <button
            type="button"
            onClick={() => setMode('uniform')}
            className={`rounded px-2 py-0.5 font-medium ${mode === 'uniform' ? chipActive : chipInactive}`}
          >
            Uniform
          </button>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            className={`rounded px-2 py-0.5 ${chipInactive}`}
            onClick={() => (mode === 'duration' ? zoomView(0.5) : setSlotZoom((z) => z * 1.5))}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            className={`rounded px-2 py-0.5 ${chipInactive}`}
            onClick={() => (mode === 'duration' ? zoomView(2) : setSlotZoom((z) => Math.max(0.3, z / 1.5)))}
          >
            −
          </button>
          <button
            type="button"
            className={`rounded px-2 py-0.5 ${chipInactive}`}
            onClick={() => {
              setView(null)
              setSlotZoom(1)
            }}
          >
            Fit
          </button>
        </div>
        <span className="ml-auto text-tertiary">
          {spans.length} spans · drag to select an interval
        </span>
      </div>

      <div ref={trackRef} className="relative flex-1 overflow-auto">
        {mode === 'duration' && trackW > 0 && (
          <div className="sticky top-0 z-10 h-5 border-b border-separator bg-background">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute top-0.5 -translate-x-1/2 font-mono text-[10px] text-tertiary"
                style={{ left: (t - viewStart) * pxPerMs }}
              >
                {formatTick(t, step < 1000)}
              </span>
            ))}
          </div>
        )}

        {lanes.map((lane) => (
          <div key={lane.kind} className="border-b border-separator">
            <div className="sticky left-0 z-10 inline-block bg-background/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-tertiary backdrop-blur-sm">
              {lane.title} · {lane.spans.length}
            </div>
            <div
              className="relative"
              style={{
                height: lane.spans.length * ROW_H,
                width: mode === 'uniform' ? lane.spans.length * slotW : '100%',
              }}
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest('[data-span-event]')) return
                const rect = event.currentTarget.getBoundingClientRect()
                const x = event.clientX - rect.left
                event.currentTarget.setPointerCapture(event.pointerId)
                setDrag({ x0: x, x1: x })
              }}
              onPointerMove={(event) => {
                if (!drag) return
                const rect = event.currentTarget.getBoundingClientRect()
                setDrag({ x0: drag.x0, x1: event.clientX - rect.left })
              }}
              onPointerUp={(event) => {
                if (!drag) return
                const rect = event.currentTarget.getBoundingClientRect()
                const x1 = event.clientX - rect.left
                setDrag(null)
                if (Math.abs(x1 - drag.x0) >= 4) selectInterval(drag.x0, x1, lane.spans)
              }}
            >
              {timeRange && mode === 'duration' && (
                <div
                  className="absolute top-0 bottom-0 bg-accent/10 border-x border-accent/30"
                  style={{
                    left: (timeRange[0] - viewStart) * pxPerMs,
                    width: Math.max(1, (timeRange[1] - timeRange[0]) * pxPerMs),
                  }}
                />
              )}
              {drag && (
                <div
                  className="absolute top-0 bottom-0 bg-accent/15 border-x border-accent/40"
                  style={{ left: Math.min(drag.x0, drag.x1), width: Math.abs(drag.x1 - drag.x0) }}
                />
              )}
              {lane.spans.map((span, index) => {
                const selected = selection?.event?.id === span.event.id
                return (
                  <div
                    key={span.id}
                    data-span-event={span.event.id}
                    role="button"
                    tabIndex={0}
                    title={`${span.label} · ${formatTick(span.start, true)} → ${formatTick(span.end, true)} · ${span.basis}`}
                    onClick={() => revealEvent(span.event)}
                    onKeyDown={(e) => e.key === 'Enter' && revealEvent(span.event)}
                    className={`absolute cursor-pointer rounded-sm ${barClass(span)} ${
                      selected ? 'ring-2 ring-accent' : ''
                    } ${timeRange && !inRange(span) ? 'opacity-30' : ''}`}
                    style={{
                      left: barX(span, index),
                      width: barW(span),
                      top: index * ROW_H + (ROW_H - BAR_H) / 2,
                      height: BAR_H,
                    }}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
