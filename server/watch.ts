import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { AgentRoot } from './agents'
import { isIndexedSessionFile, resolveOwningRoot } from './agents'

export interface FileChange {
  path: string
  agent: string
}

/**
 * Watches every agent root recursively and reports changed JSONL files.
 *
 * Events are debounced per file because a single agent write produces several
 * filesystem notifications, and re-indexing on each one would be wasteful.
 */
export class SessionWatcher {
  readonly #roots: AgentRoot[]
  readonly #onChange: (change: FileChange) => void
  readonly #debounceMs: number
  readonly #watchers: FSWatcher[] = []
  readonly #pending = new Map<string, NodeJS.Timeout>()
  #closed = false

  constructor(
    roots: AgentRoot[],
    onChange: (change: FileChange) => void,
    debounceMs = 250,
  ) {
    this.#roots = roots
    this.#onChange = onChange
    this.#debounceMs = debounceMs
  }

  start(): void {
    for (const root of this.#roots) {
      try {
        const watcher = watch(
          root.dir,
          { recursive: true, persistent: true },
          (_event, fileName) => {
            if (!fileName) return
            const name = fileName.toString()
            const base = basename(name)
            if (root.fileName === 'store.db') {
              if (base === 'store.db-wal' || base === 'store.db-shm' || base === 'meta.json') {
                this.#schedule(resolve(root.dir, dirname(name), 'store.db'))
                return
              }
              if (base !== 'store.db') return
              this.#schedule(resolve(root.dir, name))
              return
            }
            if (!name.endsWith('.jsonl')) return
            if (root.fileName && base !== root.fileName) return
            this.#schedule(resolve(root.dir, name))
          },
        )
        watcher.on('error', () => {
          // A missing or unreadable root should not take the server down.
        })
        this.#watchers.push(watcher)
      } catch {
        // Root does not exist yet; nothing to watch.
      }
    }
  }

  #schedule(path: string): void {
    if (this.#closed) return

    const existing = this.#pending.get(path)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.#pending.delete(path)
      // Resolve against the deepest root so nested agent homes are attributed
      // to the right agent.
      const root = resolveOwningRoot(path, this.#roots)
      if (!root || !isIndexedSessionFile(path, root)) return
      this.#onChange({ path, agent: root.agent })
    }, this.#debounceMs)

    // Timers must not hold the process open on shutdown.
    timer.unref?.()
    this.#pending.set(path, timer)
  }

  close(): void {
    this.#closed = true
    for (const timer of this.#pending.values()) clearTimeout(timer)
    this.#pending.clear()
    for (const watcher of this.#watchers) {
      try {
        watcher.close()
      } catch {
        // Already closed.
      }
    }
    this.#watchers.length = 0
  }
}
