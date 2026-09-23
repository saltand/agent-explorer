import type { CodeLanguage } from './codeExec'

export interface CodeToken {
  text: string
  /** Token role mapped to theme classes in the component. */
  role?: 'comment' | 'string' | 'number' | 'keyword' | 'operator' | 'variable' | 'flag' | 'add' | 'del' | 'hunk'
}

type Role = CodeToken['role']

interface Lexer {
  re: RegExp
  /** Role of each capture group, in order. */
  roles: Role[]
}

const SHELL: Lexer = {
  re: /(#.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\$\{[^}]*\}|\$[A-Za-z_][\w]*|\$[\d@#?$!*-])|(--?[A-Za-z][\w-]*|\B-[\w.]+)|(&&|\|\||[|;><])|(\b\d+(?:\.\d+)?\b)|\b(if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|export|local|readonly|return|echo|cd|sudo|set|source|eval|exec)\b/g,
  roles: ['comment', 'string', 'variable', 'flag', 'operator', 'number', 'keyword'],
}

const KEYWORDS: Lexer = {
  re: /(\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?(?:n|e[+-]?\d+)?\b)|\b(const|let|var|function|return|if|else|elif|for|while|do|switch|case|break|continue|import|export|from|default|class|extends|new|await|async|try|except|catch|finally|throw|raise|typeof|instanceof|in|of|null|undefined|None|true|false|True|False|this|yield|static|get|set|def|self|pass|with|as|lambda|and|or|not|is|assert|del|print)\b/g,
  roles: ['comment', 'string', 'number', 'keyword'],
}

const LEXERS: Partial<Record<CodeLanguage, Lexer>> = {
  shell: SHELL,
  javascript: KEYWORDS,
  python: KEYWORDS,
}

function tokenizeLine(line: string, lexer: Lexer): CodeToken[] {
  const tokens: CodeToken[] = []
  let last = 0
  lexer.re.lastIndex = 0
  for (let match = lexer.re.exec(line); match; match = lexer.re.exec(line)) {
    if (match.index > last) tokens.push({ text: line.slice(last, match.index) })
    const groupIndex = match.slice(1).findIndex((group) => group !== undefined)
    tokens.push({ text: match[0], role: lexer.roles[groupIndex] })
    last = match.index + match[0].length
    if (match[0].length === 0) lexer.re.lastIndex++
  }
  if (last < line.length) tokens.push({ text: line.slice(last) })
  return tokens
}

/** Tokenize code per line for display. `diff` marks whole lines by prefix. */
export function highlightCode(code: string, language: CodeLanguage): CodeToken[][] {
  const lines = code.split('\n')
  if (language === 'diff') {
    return lines.map((line) => [
      {
        text: line,
        role: line.startsWith('+')
          ? 'add'
          : line.startsWith('-')
            ? 'del'
            : line.startsWith('@')
              ? 'hunk'
              : undefined,
      },
    ])
  }
  const lexer = LEXERS[language]
  if (!lexer) return lines.map((line) => [{ text: line }])
  return lines.map((line) => tokenizeLine(line, lexer))
}
