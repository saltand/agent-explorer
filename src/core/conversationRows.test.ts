import { describe, expect, it } from 'vitest'
import { buildConversationRows, listTurnIndexes } from './conversationRows'
import type { ConversationListItem, TimelineEvent } from './types'

function item(id: string, turnIndex: number): ConversationListItem {
  const event = { turnIndex } as TimelineEvent
  return { id, event, role: 'assistant' }
}

const items = [
  item('a', 1),
  item('b', 1),
  item('c', 2),
  item('d', 3),
  item('e', 3),
]

describe('buildConversationRows', () => {
  it('inserts a header before each turn and lists its items when open', () => {
    const rows = buildConversationRows(items, new Set())
    expect(rows.map((r) => r.kind)).toEqual([
      'turn', 'item', 'item', 'turn', 'item', 'turn', 'item', 'item',
    ])
    const firstTurn = rows[0]
    expect(firstTurn.kind === 'turn' && firstTurn.itemCount).toBe(2)
  })

  it('omits the items of a collapsed turn but keeps its header', () => {
    const rows = buildConversationRows(items, new Set([1]))
    const turn1 = rows.find((r) => r.kind === 'turn' && r.turnIndex === 1)!
    expect(turn1.kind === 'turn' && turn1.collapsed).toBe(true)
    // Turn 1's two items are gone; turns 2 and 3 keep theirs.
    expect(rows.filter((r) => r.kind === 'item')).toHaveLength(3)
  })

  it('can collapse every turn, leaving only headers', () => {
    const rows = buildConversationRows(items, new Set([1, 2, 3]))
    expect(rows.every((r) => r.kind === 'turn')).toBe(true)
    expect(rows).toHaveLength(3)
  })
})

describe('listTurnIndexes', () => {
  it('returns each turn once in first-seen order', () => {
    expect(listTurnIndexes(items)).toEqual([1, 2, 3])
  })
})
