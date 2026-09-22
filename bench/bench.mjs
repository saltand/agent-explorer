/**
 * Benchmarks the server's three hot paths against the real local session corpus:
 *   scan    — stat + head/tail probe of every session file (runs on every start)
 *   index   — full parse + FTS insert of a sampled subset (first-run cost)
 *   search  — FTS/LIKE queries against the built index (per keystroke)
 *
 * Usage: node --import ./bench/ts-resolve-register.mjs bench/bench.mjs [--sample N] [--label NAME]
 */
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { defaultAgentRoots } from '../server/agents.ts'
import { scanSessions } from '../server/scan.ts'
import { SessionIndex } from '../server/index-db.ts'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const SAMPLE = Number(flag('sample', 120))
const LABEL = flag('label', 'run')
const REPEAT = Number(flag('repeat', 3))

const QUERIES = [
  'function', 'performance', 'benchmark', 'index', '测试',
  'async function', 'error handling', 'sqlite', 'refactor', 'useEffect',
]

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  }
}

const fmt = (n) => (n < 10 ? n.toFixed(2) : n.toFixed(1))

async function main() {
  const roots = defaultAgentRoots()
  const results = {}

  // ---- scan (cold: nothing reusable, every file probed) --------------------
  const scanTimes = []
  let summaries = []
  for (let i = 0; i < REPEAT; i += 1) {
    const t0 = performance.now()
    summaries = await scanSessions(roots)
    scanTimes.push(performance.now() - t0)
  }
  const totalBytes = summaries.reduce((a, s) => a + s.size, 0)
  results.scan = {
    ...stats(scanTimes),
    files: summaries.length,
    totalMB: totalBytes / 1024 / 1024,
  }

  // ---- scan (warm: reuse hook satisfies unchanged files) -------------------
  // Mirrors a restart against an already-populated index, which is the common
  // case. `scanSessions` only accepts a reuse hook after the optimization, so
  // fall back to the cold number on the baseline build.
  const byPath = new Map(summaries.map((s) => [s.path, s]))
  const makeReuse = (counter) => (c) => {
    const hit = byPath.get(c.path)
    if (!hit || hit.size !== c.size || hit.mtimeMs !== c.mtimeMs) return undefined
    counter.n += 1
    return hit
  }

  // Probe support: the baseline build ignores the second argument entirely.
  const probe = { n: 0 }
  await scanSessions(roots, { reuse: makeReuse(probe) })
  const reuseSupported = probe.n > 0

  const warmTimes = []
  for (let i = 0; i < REPEAT; i += 1) {
    const t0 = performance.now()
    await scanSessions(roots, { reuse: makeReuse({ n: 0 }) })
    warmTimes.push(performance.now() - t0)
  }
  results.scanWarm = { ...stats(warmTimes), supported: reuseSupported }

  // ---- index ---------------------------------------------------------------
  // Deterministic sample spread across the corpus by size so the mix of tiny
  // and huge sessions is representative rather than all-recent.
  const bySize = [...summaries].sort((a, b) => a.path.localeCompare(b.path))
  const step = Math.max(1, Math.floor(bySize.length / SAMPLE))
  const sample = []
  for (let i = 0; i < bySize.length && sample.length < SAMPLE; i += step) sample.push(bySize[i])

  const dir = mkdtempSync(join(tmpdir(), 'ae-bench-'))
  const dbPath = join(dir, 'index.db')
  const index = new SessionIndex(dbPath)

  const sampleBytes = sample.reduce((a, s) => a + s.size, 0)
  const t1 = performance.now()
  let messages = 0
  for (const summary of sample) {
    try {
      messages += await index.indexSession(summary)
    } catch {
      // Skip unreadable files, same as the server does.
    }
  }
  const indexMs = performance.now() - t1
  results.index = {
    ms: indexMs,
    files: sample.length,
    MB: sampleBytes / 1024 / 1024,
    messages,
    mbPerSec: sampleBytes / 1024 / 1024 / (indexMs / 1000),
  }

  // ---- search --------------------------------------------------------------
  const searchTimes = []
  const perQuery = {}
  for (const q of QUERIES) {
    const qt = []
    for (let i = 0; i < REPEAT + 2; i += 1) {
      const t = performance.now()
      const hits = index.search({ query: q, limit: 100 })
      const ms = performance.now() - t
      qt.push(ms)
      if (i === 0) perQuery[q] = { hits: hits.length }
    }
    // Drop the first (cold) sample.
    qt.shift()
    perQuery[q].ms = stats(qt).p50
    searchTimes.push(...qt)
  }
  results.search = { ...stats(searchTimes), perQuery }

  // ---- listSessions --------------------------------------------------------
  const listTimes = []
  for (let i = 0; i < 20; i += 1) {
    const t = performance.now()
    index.listSessions({ limit: 300 })
    listTimes.push(performance.now() - t)
  }
  results.list = stats(listTimes)

  results.dbBytes = (await import('node:fs/promises')).then
  const { statSync } = await import('node:fs')
  let dbSize = 0
  for (const suffix of ['', '-wal']) {
    try { dbSize += statSync(dbPath + suffix).size } catch {}
  }
  results.dbBytes = dbSize

  index.close()
  rmSync(dir, { recursive: true, force: true })

  // ---- report --------------------------------------------------------------
  const out = { label: LABEL, node: process.version, at: new Date().toISOString(), results }
  console.log(`\n=== ${LABEL} ===`)
  console.log(
    `scan    ${fmt(results.scan.p50)}ms p50  (${results.scan.files} files, ` +
      `${results.scan.totalMB.toFixed(0)}MB)  min ${fmt(results.scan.min)} max ${fmt(results.scan.max)}`,
  )
  console.log(
    `rescan  ${fmt(results.scanWarm.p50)}ms p50  (warm, unchanged files reused` +
      `${results.scanWarm.supported ? '' : ' — unsupported on this build'})`,
  )
  console.log(
    `index   ${fmt(results.index.ms)}ms  (${results.index.files} files, ` +
      `${results.index.MB.toFixed(1)}MB, ${results.index.messages} msgs)  ` +
      `${results.index.mbPerSec.toFixed(2)} MB/s`,
  )
  console.log(
    `search  ${fmt(results.search.p50)}ms p50  p95 ${fmt(results.search.p95)}  ` +
      `max ${fmt(results.search.max)}`,
  )
  console.log(`list    ${fmt(results.list.p50)}ms p50`)
  console.log(`db      ${(results.dbBytes / 1024 / 1024).toFixed(1)}MB`)
  console.log('\nper-query p50:')
  for (const [q, v] of Object.entries(results.search.perQuery)) {
    console.log(`  ${q.padEnd(16)} ${fmt(v.ms).padStart(8)}ms  ${v.hits} hits`)
  }

  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync('bench/results', { recursive: true })
  writeFileSync(`bench/results/${LABEL}.json`, JSON.stringify(out, null, 2))
}

await main()
