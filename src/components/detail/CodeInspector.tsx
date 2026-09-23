import { useMemo, useState } from 'react'
import { Check, Copy, WrapText } from 'lucide-react'
import { highlightCode, type CodeToken } from '../../core/codeHighlight'
import type { CodeExecSource } from '../../core/codeExec'
import { chipActive, chipInactive } from '../../styles/uiClasses'
import { ToolbarButton } from '../shared/ToolbarButton'

type CodeTab = 'source' | 'arguments' | 'output'

const TOKEN_CLASS: Record<NonNullable<CodeToken['role']>, string> = {
  comment: 'text-tertiary italic',
  string: 'text-success',
  number: 'text-warning-text',
  keyword: 'text-accent',
  operator: 'text-danger',
  variable: 'text-accent',
  flag: 'text-warning-text',
  add: 'text-success',
  del: 'text-danger',
  hunk: 'text-accent',
}

function CodeView({
  code,
  language,
  wrap,
}: {
  code: string
  language: CodeExecSource['language']
  wrap: boolean
}) {
  const lines = useMemo(() => highlightCode(code, language), [code, language])
  return (
    <div className="max-h-80 overflow-auto rounded border border-separator bg-background">
      <pre
        className={`flex min-w-max px-0 py-1 font-mono text-[11px] leading-relaxed ${
          wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : ''
        }`}
      >
        <code className="flex-1">
          {lines.map((tokens, i) => (
            <div key={i} className="flex">
              <span className="w-8 shrink-0 select-none pr-2 text-right text-tertiary">
                {i + 1}
              </span>
              <span className="flex-1 pr-3">
                {tokens.map((token, j) => (
                  <span key={j} className={token.role ? TOKEN_CLASS[token.role] : undefined}>
                    {token.text}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}

/**
 * Code-oriented view of a tool call: the recorded command with line numbers
 * and highlighting, plus raw arguments and output as alternate views.
 */
export function CodeInspector({
  source,
  argsJson,
  output,
}: {
  source: CodeExecSource
  argsJson: string | undefined
  output: string | undefined
}) {
  const tabs: Array<{ id: CodeTab; label: string; text: string }> = [
    { id: 'source', label: 'Source', text: source.code },
    ...(argsJson !== undefined ? [{ id: 'arguments' as const, label: 'Arguments', text: argsJson }] : []),
    ...(output !== undefined ? [{ id: 'output' as const, label: 'Output', text: output }] : []),
  ]
  const [tab, setTab] = useState<CodeTab>('source')
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)

  const active = tabs.find((t) => t.id === tab) ?? tabs[0]!

  async function handleCopy() {
    await navigator.clipboard.writeText(active.text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                tab === t.id ? chipActive : chipInactive
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <ToolbarButton
          onClick={() => setWrap((w) => !w)}
          aria-label={wrap ? 'Disable line wrap' : 'Wrap lines'}
          aria-pressed={wrap}
          title={wrap ? 'Disable line wrap' : 'Wrap lines'}
        >
          <WrapText size={14} strokeWidth={1.75} aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : `Copy ${active.label.toLowerCase()}`}
          title={copied ? 'Copied' : `Copy ${active.label.toLowerCase()} as recorded`}
        >
          {copied ? (
            <Check size={14} strokeWidth={1.75} aria-hidden />
          ) : (
            <Copy size={14} strokeWidth={1.75} aria-hidden />
          )}
        </ToolbarButton>
      </div>

      {active.id === 'source' ? (
        <CodeView code={source.code} language={source.language} wrap={wrap} />
      ) : (
        <div className="max-h-80 overflow-auto rounded border border-separator bg-background px-3 py-2">
          <pre
            className={`font-mono text-[11px] leading-relaxed text-secondary ${
              wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'
            }`}
          >
            {active.text}
          </pre>
        </div>
      )}
    </div>
  )
}
