import { describe, expect, it } from 'vitest'
import { codeExecSource } from './codeExec'
import { highlightCode } from './codeHighlight'

describe('codeExecSource', () => {
  it('extracts shell commands from exec_command and bash', () => {
    expect(codeExecSource('exec_command', { cmd: 'ls -la' })).toEqual({
      code: 'ls -la',
      language: 'shell',
      field: 'cmd',
    })
    expect(codeExecSource('Bash', { command: 'echo hi' })?.language).toBe('shell')
    expect(codeExecSource('write_stdin', { chars: 'q\n', session_id: 1 })?.field).toBe('chars')
  })

  it('extracts js/python code and patch diffs', () => {
    expect(codeExecSource('js', { code: 'x + 1' })?.language).toBe('javascript')
    expect(codeExecSource('python', { code: 'print(1)' })?.language).toBe('python')
    expect(codeExecSource('apply_patch', { patch: '+a\n-b' })?.language).toBe('diff')
  })

  it('rejects non-exec tools and missing code fields', () => {
    expect(codeExecSource('read', { path: '/a' })).toBeUndefined()
    expect(codeExecSource('exec_command', {})).toBeUndefined()
    expect(codeExecSource(undefined, { cmd: 'x' })).toBeUndefined()
    expect(codeExecSource('edit', { path: '/a', newText: 'x' })).toBeUndefined()
  })
})

describe('highlightCode', () => {
  it('marks shell comments, strings, variables, and flags', () => {
    const [line] = highlightCode("echo 'hi' $VAR --flag # done", 'shell')
    const roles = line!.filter((t) => t.role).map((t) => [t.text, t.role])
    expect(roles).toContainEqual(["'hi'", 'string'])
    expect(roles).toContainEqual(['$VAR', 'variable'])
    expect(roles).toContainEqual(['--flag', 'flag'])
    expect(roles).toContainEqual(['# done', 'comment'])
  })

  it('marks diff lines by prefix', () => {
    const lines = highlightCode('@@ -1 +1 @@\n-old\n+new\n ctx', 'diff')
    expect(lines.map((l) => l[0]!.role)).toEqual(['hunk', 'del', 'add', undefined])
  })

  it('returns plain lines for unknown languages', () => {
    expect(highlightCode('a\nb', 'text')).toEqual([[{ text: 'a' }], [{ text: 'b' }]])
  })
})
