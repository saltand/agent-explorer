import { describe, expect, it } from 'vitest'
import { formatBytes, formatProject, formatRelativeTime } from './formatters'

describe('formatBytes', () => {
  it('scales units and keeps output compact', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(2048)).toBe('2.0KB')
    expect(formatBytes(1024 * 1024 * 165)).toBe('165MB')
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.0GB')
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-01-10T12:00:00.000Z')

  it('describes recent timestamps relatively', () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe('3m ago')
    expect(formatRelativeTime(now - 5 * 3_600_000, now)).toBe('5h ago')
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d ago')
  })

  it('falls back to a date for old timestamps', () => {
    const old = Date.parse('2025-01-01T00:00:00.000Z')
    expect(formatRelativeTime(old, now)).toBe(new Date(old).toLocaleDateString())
  })

  it('does not report negative ages for clock skew', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now')
  })
})

describe('formatProject', () => {
  it('uses the last path segment', () => {
    expect(formatProject('/Users/me/Code/agent-explorer')).toBe('agent-explorer')
    expect(formatProject('/Users/me/Code/agent-explorer/')).toBe('agent-explorer')
  })

  it('returns undefined without a cwd', () => {
    expect(formatProject(undefined)).toBeUndefined()
  })
})
