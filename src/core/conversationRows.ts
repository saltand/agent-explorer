import type { ConversationListItem } from './types'

export type ConversationRow =
  | { kind: 'turn'; turnIndex: number; key: string; itemCount: number; collapsed: boolean }
  | { kind: 'item'; key: string; itemIndex: number }

/**
 * Flattens conversation items into virtualizer rows, inserting a header before
 * each turn. Items of a collapsed turn are omitted, but its header stays so the
 * turn can be reopened. The header carries the turn's item count for a summary.
 */
export function buildConversationRows(
  items: ConversationListItem[],
  collapsedTurns: ReadonlySet<number>,
): ConversationRow[] {
  const result: ConversationRow[] = []

  // A turn's item count is needed on its header, which is emitted before the
  // items are seen, so count each run of a turn up front.
  let index = 0
  while (index < items.length) {
    const turnIndex = items[index]?.event?.turnIndex ?? 0
    let end = index
    while (end < items.length && (items[end]?.event?.turnIndex ?? 0) === turnIndex) end += 1

    const collapsed = collapsedTurns.has(turnIndex)
    result.push({
      kind: 'turn',
      turnIndex,
      key: `turn-${turnIndex}`,
      itemCount: end - index,
      collapsed,
    })
    if (!collapsed) {
      for (let i = index; i < end; i += 1) {
        result.push({ kind: 'item', key: items[i]!.id, itemIndex: i })
      }
    }
    index = end
  }

  return result
}

/** Every distinct turn index present in the items, in first-seen order. */
export function listTurnIndexes(items: ConversationListItem[]): number[] {
  const seen = new Set<number>()
  const order: number[] = []
  for (const item of items) {
    const turnIndex = item.event?.turnIndex ?? 0
    if (!seen.has(turnIndex)) {
      seen.add(turnIndex)
      order.push(turnIndex)
    }
  }
  return order
}
