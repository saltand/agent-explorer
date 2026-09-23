/** Identifies tool calls whose arguments carry executable code. */

export type CodeLanguage = 'shell' | 'javascript' | 'python' | 'diff' | 'text'

export interface CodeExecSource {
  /** The recorded code text, exactly as the tool received it. */
  code: string
  language: CodeLanguage
  /** The argument field the code was read from. */
  field: string
}

const SHELL_TOOLS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'powershell', 'exec', 'exec_command',
  'run_command', 'run_shell_command', 'terminal', 'write_stdin', 'process',
])
const JS_TOOLS = new Set(['js', 'javascript', 'node', 'deno'])
const PYTHON_TOOLS = new Set(['python', 'python3', 'ipython'])
const DIFF_TOOLS = new Set(['apply_patch', 'patch', 'apply_diff'])

/** Fields that can carry code, in the order they are tried. */
const CODE_FIELDS = [
  'cmd', 'command', 'code', 'chars', 'script', 'source', 'input',
  'patch', 'content', 'text',
]

function codeField(input: Record<string, unknown>): [string, string] | undefined {
  for (const field of CODE_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.length > 0) return [field, value]
  }
  return undefined
}

/**
 * Extract the code a tool call executes, only for tool names known to run
 * code. Returns undefined for everything else so non-exec calls never get a
 * code view by accident.
 */
export function codeExecSource(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): CodeExecSource | undefined {
  if (!toolName || !toolInput) return undefined
  const name = toolName.toLowerCase()
  let language: CodeLanguage
  if (SHELL_TOOLS.has(name)) language = 'shell'
  else if (JS_TOOLS.has(name)) language = 'javascript'
  else if (PYTHON_TOOLS.has(name)) language = 'python'
  else if (DIFF_TOOLS.has(name)) language = 'diff'
  else return undefined

  const found = codeField(toolInput)
  if (!found) return undefined
  const [field, code] = found
  return { code, language, field }
}
