import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import {
  AGENT_KINDS,
  AGENT_LABELS,
  createAgentRoot,
  defaultAgentRoots,
  isAgentKind,
  type AgentKind,
  type AgentRoot,
} from './agents'
import { createAppServer } from './http'
import { SessionIndex } from './index-db'

export interface CliOptions {
  port: number
  host: string
  open: boolean
  watch: boolean
  agents?: AgentKind[]
  extraRoots: AgentRoot[]
  dbPath: string
  help: boolean
  version: boolean
}

const DEFAULT_PORT = 4317

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    open: true,
    watch: true,
    extraRoots: [],
    dbPath: resolve(homedir(), '.agent-explorer', 'index.db'),
    help: false,
    version: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const next = () => argv[++i]

    switch (arg) {
      case '-p':
      case '--port': {
        const value = Number(next())
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          throw new Error('--port expects an integer between 1 and 65535')
        }
        options.port = value
        break
      }
      case '-H':
      case '--host':
        options.host = next() ?? options.host
        break
      case '--no-open':
        options.open = false
        break
      case '--no-watch':
        options.watch = false
        break
      case '--db':
        options.dbPath = resolve(next() ?? options.dbPath)
        break
      case '--agent': {
        const value = next()
        if (!value) throw new Error('--agent expects a comma-separated list')
        const parsed = value.split(',').map((part) => part.trim().toLowerCase())
        for (const item of parsed) {
          if (!isAgentKind(item)) {
            throw new Error(`Unknown agent "${item}". Known: ${AGENT_KINDS.join(', ')}`)
          }
        }
        // Repeatable: each occurrence adds to the allow-list.
        options.agents = [...new Set([...(options.agents ?? []), ...parsed])]
        break
      }
      case '--dir': {
        const value = next()
        if (!value) throw new Error('--dir expects <agent>:<path>')
        const separator = value.indexOf(':')
        if (separator === -1) throw new Error('--dir expects <agent>:<path>')
        const agent = value.slice(0, separator).trim().toLowerCase()
        const dir = value.slice(separator + 1).trim()
        if (!isAgentKind(agent)) {
          throw new Error(`Unknown agent "${agent}". Known: ${AGENT_KINDS.join(', ')}`)
        }
        options.extraRoots.push(createAgentRoot(agent, resolve(dir)))
        break
      }
      case '-h':
      case '--help':
        options.help = true
        break
      case '-v':
      case '--version':
        options.version = true
        break
      default:
        throw new Error(`Unknown argument "${arg}". Run with --help for usage.`)
    }
  }

  return options
}

function printHelp(): void {
  process.stdout.write(`agent-explorer — browse local agent session logs in your browser

Usage
  npx agent-explorer [options]

Options
  -p, --port <n>          Port to listen on (default ${DEFAULT_PORT}, falls back if busy)
  -H, --host <host>       Host to bind (default 127.0.0.1)
      --db <path>         Index location (default ~/.agent-explorer/index.db)
      --dir <agent>:<p>   Add an extra session directory for an agent
      --agent <list>      Limit to agents: ${AGENT_KINDS.join(', ')} (repeatable)
      --no-open           Do not open the browser automatically
      --no-watch          Do not watch session directories for changes
  -h, --help              Show this help
  -v, --version           Show version

Everything stays on your machine: the server binds to loopback by default and
never uploads session contents.
`)
}

/** Finds a free port starting at the requested one. */
async function findAvailablePort(host: string, start: number): Promise<number> {
  for (let port = start; port < start + 50; port += 1) {
    const free = await new Promise<boolean>((resolvePromise) => {
      const probe = createServer()
      probe.once('error', () => resolvePromise(false))
      probe.once('listening', () => probe.close(() => resolvePromise(true)))
      probe.listen(port, host)
    })
    if (free) return port
  }
  throw new Error(`No free port found near ${start}`)
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    child.unref()
  } catch {
    // Opening a browser is a convenience, not a requirement.
  }
}

function resolveStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, 'client'), resolve(here, '..', 'dist')]
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html')))
}

async function readVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const { readFile } = await import('node:fs/promises')
    for (const candidate of [
      resolve(here, '..', 'package.json'),
      resolve(here, '..', '..', 'package.json'),
    ]) {
      try {
        const raw = await readFile(candidate, 'utf8')
        const parsed = JSON.parse(raw) as { name?: string; version?: string }
        if (parsed.name === 'agent-explorer' && parsed.version) return parsed.version
      } catch {
        continue
      }
    }
  } catch {
    // Fall through.
  }
  return '0.0.0'
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }

  if (options.help) {
    printHelp()
    return
  }
  if (options.version) {
    process.stdout.write(`${await readVersion()}\n`)
    return
  }

  const roots = [
    ...defaultAgentRoots().filter(
      (root) => !options.agents || options.agents.includes(root.agent),
    ),
    ...options.extraRoots,
  ]

  const index = new SessionIndex(options.dbPath)
  const staticDir = resolveStaticDir()
  const port = await findAvailablePort(options.host, options.port)

  const app = createAppServer({
    roots,
    index,
    staticDir,
    host: options.host,
    port,
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    app.server.once('error', rejectPromise)
    app.server.listen(port, options.host, resolvePromise)
  })

  const url = `http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}`
  process.stdout.write(`agent-explorer listening on ${url}\n`)
  if (options.host !== '127.0.0.1' && options.host !== 'localhost') {
    process.stdout.write(
      `warning: bound to ${options.host}, which may be reachable from your network. ` +
        `There is no authentication, so anyone who can reach this port can read your session logs.\n`,
    )
  }
  for (const root of roots) {
    process.stdout.write(`  ${AGENT_LABELS[root.agent].padEnd(14)} ${root.dir}\n`)
  }

  process.stdout.write('scanning sessions…\n')
  const started = Date.now()
  const { scanned, indexed } = await app.rescan()
  process.stdout.write(
    `indexed ${indexed} new/changed of ${scanned} sessions in ${Date.now() - started}ms ` +
      `(${index.countMessages()} messages)\n`,
  )

  if (options.watch) {
    app.startWatching()
  } else {
    process.stdout.write('file watching disabled\n')
  }

  if (options.open) await openBrowser(url)

  const shutdown = () => {
    process.stdout.write('\nshutting down…\n')
    app.close()
    index.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
