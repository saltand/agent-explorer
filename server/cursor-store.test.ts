import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cursorStoreRecords, cursorStoreToJsonl, summarizeCursorStore } from './cursor-store'
import { detectAndParse } from '../src/core/registry'

function sha(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

describe('cursor store conversion', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-explorer-acp-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks the blob tree and emits Cursor transcript JSONL', () => {
    const sessionDir = join(dir, 'session-id')
    mkdirSync(sessionDir)
    const storePath = join(sessionDir, 'store.db')

    const system = Buffer.from(JSON.stringify({ role: 'system', content: 'You are Cursor.' }))
    const context = Buffer.from(
      JSON.stringify({ role: 'user', content: '<user_info>\nWorkspace Path: /tmp/proj\n</user_info>' }),
    )
    const user = Buffer.from(
      JSON.stringify({
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<timestamp>now</timestamp>\n<user_query>\nhi\n</user_query>',
          },
        ],
      }),
    )
    const assistant = Buffer.from(
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Greet the user.' },
          { type: 'text', text: '你好。' },
        ],
      }),
    )

    const systemId = sha(system)
    const contextId = sha(context)
    const userId = sha(user)
    const assistantId = sha(assistant)
    const root = Buffer.concat([
      Buffer.from([0x0a, 0x20]),
      Buffer.from(systemId, 'hex'),
      Buffer.from([0x0a, 0x20]),
      Buffer.from(contextId, 'hex'),
      Buffer.from([0x0a, 0x20]),
      Buffer.from(userId, 'hex'),
      Buffer.from([0x0a, 0x20]),
      Buffer.from(assistantId, 'hex'),
    ])
    const rootId = sha(root)

    const db = new DatabaseSync(storePath)
    db.exec('create table blobs (id text primary key, data blob); create table meta (key text primary key, value text);')
    const insert = db.prepare('insert into blobs (id, data) values (?, ?)')
    for (const [id, data] of [
      [systemId, system],
      [contextId, context],
      [userId, user],
      [assistantId, assistant],
      [rootId, root],
    ] as const) {
      insert.run(id, data)
    }
    db.prepare('insert into meta (key, value) values (?, ?)').run(
      '0',
      Buffer.from(
        JSON.stringify({ agentId: 'session-id', latestRootBlobId: rootId, name: 'New Agent' }),
      ).toString('hex'),
    )
    db.close()

    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, cwd: '/tmp/proj', title: 'Lody MCP Tools' }),
    )

    const records = cursorStoreRecords(storePath)
    expect(records.map((record) => record.role)).toEqual(['system', 'user', 'user', 'assistant'])
    expect(records[2]).toMatchObject({
      role: 'user',
      message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nhi\n</user_query>' }] },
    })
    expect(records[3]).toMatchObject({
      role: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'Greet the user.' }, { type: 'text', text: '你好。' }],
      },
    })

    const summary = summarizeCursorStore(storePath)
    expect(summary).toMatchObject({ cwd: '/tmp/proj', title: 'Lody MCP Tools' })

    const session = detectAndParse(cursorStoreToJsonl(storePath), 'session-id')
    expect(session.fileType).toBe('Cursor Agent')
    expect(session.conversationItems.map((item) => item.role)).toEqual(['user', 'thinking', 'assistant'])
    expect(session.conversationItems[0]?.block?.text).toBe('hi')
  })
})
