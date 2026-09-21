import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from './cli'

describe('parseArgs', () => {
  it('applies loopback-only defaults', () => {
    const options = parseArgs([])
    expect(options.host).toBe('127.0.0.1')
    expect(options.port).toBe(4317)
    expect(options.open).toBe(true)
    expect(options.watch).toBe(true)
    expect(options.agents).toBeUndefined()
    expect(options.dbPath).toBe(resolve(homedir(), '.agent-explorer', 'index.db'))
  })

  it('accepts both short and long host flags', () => {
    expect(parseArgs(['-H', '0.0.0.0']).host).toBe('0.0.0.0')
    expect(parseArgs(['--host', 'localhost']).host).toBe('localhost')
  })

  it('accepts both short and long port flags', () => {
    expect(parseArgs(['-p', '8080']).port).toBe(8080)
    expect(parseArgs(['--port', '9090']).port).toBe(9090)
  })

  it('rejects ports outside the valid range', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(/between 1 and 65535/)
    expect(() => parseArgs(['--port', '70000'])).toThrow(/between 1 and 65535/)
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/between 1 and 65535/)
  })

  it('turns off browser opening and watching', () => {
    const options = parseArgs(['--no-open', '--no-watch'])
    expect(options.open).toBe(false)
    expect(options.watch).toBe(false)
  })

  it('accumulates repeated --agent flags', () => {
    expect(parseArgs(['--agent', 'codex', '--agent', 'pi']).agents).toEqual(['codex', 'pi'])
  })

  it('accepts a comma-separated agent list and dedupes', () => {
    expect(parseArgs(['--agent', 'codex,pi', '--agent', 'pi']).agents).toEqual(['codex', 'pi'])
  })

  it('rejects unknown agents', () => {
    expect(() => parseArgs(['--agent', 'nope'])).toThrow(/Unknown agent "nope"/)
  })

  it('resolves --dir into an absolute root', () => {
    const options = parseArgs(['--dir', 'codex:/tmp/sessions'])
    expect(options.extraRoots).toEqual([{ agent: 'codex', dir: '/tmp/sessions' }])
  })

  it('keeps path separators in --dir values after the first colon', () => {
    const options = parseArgs(['--dir', 'pi:/tmp/a:b/sessions'])
    expect(options.extraRoots).toEqual([{ agent: 'pi', dir: '/tmp/a:b/sessions' }])
  })

  it('rejects malformed --dir values', () => {
    expect(() => parseArgs(['--dir', '/tmp/sessions'])).toThrow(/<agent>:<path>/)
    expect(() => parseArgs(['--dir', 'nope:/tmp'])).toThrow(/Unknown agent "nope"/)
  })

  it('rejects unknown arguments instead of ignoring them', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(/Unknown argument/)
  })

  it('recognizes help and version flags', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--version']).version).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })
})
