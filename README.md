# Agent Explorer

A browser-based explorer for agent session logs. Open a JSONL file and browse the full session across three linked views: a chronological timeline, a conversation view, and an event detail inspector.

Run `npx agent-explorer` to browse every session already on your machine, or open the static build and drop in a file by hand. Either way parsing stays local — nothing is uploaded.

## Quick start

```bash
npx agent-explorer
```

This starts a local server on `127.0.0.1`, indexes the session logs it finds under your home directory, and opens the app in your browser. The first run of a large history takes a few seconds; later runs only index files that changed.

## Features

- **Session library** — every local session in one list, grouped by agent, updating live as agents write new turns
- **Cross-session search** — full-text search over all indexed sessions, including CJK and code fragments; a hit opens the session and jumps to the matching message
- **Flexible layout** — resizable timeline, conversation, and detail views
- **Auto-detecting parsers** — automatically select the most sensible parser for the opened file
- **Timeline** — filter by category, search, keyboard navigation (↑/↓), and optional highlighting of events that share the same request
- **Conversation** — virtualized message list with user/assistant bubbles, thinking blocks, and expandable tool call / result cards with pair highlighting
- **Detail panel** — session metadata, event summary, token usage & estimated cost, and raw JSON viewer
- **Theme** — light / dark mode with system preference support

## CLI

```
npx agent-explorer [options]

  -p, --port <n>          Port to listen on (default 4317, falls back if busy)
  -H, --host <host>       Host to bind (default 127.0.0.1)
      --db <file>         Index location (default ~/.agent-explorer/index.db)
      --dir <agent:path>  Add or override a session directory
      --agent <name>      Limit to specific agents (repeatable)
      --no-open           Do not open a browser
      --no-watch          Disable live file watching
  -h, --help              Show help
  -v, --version           Show version
```

By default the server scans these locations:

| Agent | Directory |
|-------|-----------|
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions` |
| Pi | `~/.pi/agent/sessions` |

### Where data lives

Session files are only ever read, never modified. The search index is a SQLite
database at `~/.agent-explorer/index.db`; delete it to force a full reindex.

The server has no authentication, so it binds to loopback only. Passing
`--host 0.0.0.0` exposes your session logs to anyone who can reach the port, and
prints a warning for that reason.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 23+
- [pnpm](https://pnpm.io/) 10+

### Install

```bash
pnpm install
```

### Run

```bash
pnpm dev:server   # terminal 1: CLI server with the API
pnpm dev          # terminal 2: Vite dev server, proxies /api to the CLI
```

Open the URL printed by Vite (typically `http://localhost:5173`). Running
`pnpm dev` alone also works; the library panel simply reports that no local
server is available.

### Other scripts

```bash
pnpm build    # client + server production build
pnpm start    # run the built server
pnpm preview  # preview the static client build
pnpm test     # run tests
pnpm lint     # run oxlint
```

## Supported file formats

The app inspects the first lines of a JSONL file and picks the best-matching adapter. If no format scores above the detection threshold, loading fails with an error.

| Format | Description |
|--------|-------------|
| Claude Code transcript | Per-line `user` / `assistant` events with `message.content` blocks |
| Codex rollout | Envelope records such as `session_meta`, `turn_context`, `event_msg`, and `response_item` |
| Pi session | Tree-structured Pi agent sessions with messages, tool calls/results, model changes, compactions, branch summaries, and extension entries |

Support of more file formats is on the way.

## License

MIT — see [LICENSE](LICENSE).
