export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/**
 * Line-based LCS diff. Inputs here are recorded context fields (kilobytes at
 * most), so the O(n·m) table is acceptable; larger inputs bail to a
 * before/after split rather than blocking the UI.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  if (before === after) return before === '' ? [] : [{ type: 'same', text: before }]
  if (before === '') return after.split('\n').map((text) => ({ type: 'add' as const, text }))
  if (after === '') return before.split('\n').map((text) => ({ type: 'del' as const, text }))
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text): DiffLine => ({ type: 'del', text })),
      ...b.map((text): DiffLine => ({ type: 'add', text })),
    ]
  }

  // table[i][j] = LCS length of a[i:] and b[j:]
  const table: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! })
      i++
    } else {
      out.push({ type: 'add', text: b[j]! })
      j++
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++]! })
  while (j < b.length) out.push({ type: 'add', text: b[j++]! })
  return out
}
