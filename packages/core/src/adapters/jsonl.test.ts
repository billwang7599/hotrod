import { describe, expect, it } from 'vitest'
import { onJsonLines } from './jsonl.ts'
import { fakeProc } from './test-machine.ts'

function read() {
  const fake = fakeProc()
  const messages: unknown[] = []
  const others: string[] = []
  const lines = onJsonLines(fake.proc, (msg) => messages.push(msg), (line) => others.push(line))
  return { ...fake, messages, others, flush: lines.flush }
}

describe('onJsonLines', () => {
  it('reads messages split across chunks, and several in one chunk', () => {
    const r = read()
    r.stdout('{"a":')
    expect(r.messages).toEqual([])
    r.stdout('1}\n{"b":2}\n{"c"')
    expect(r.messages).toEqual([{ a: 1 }, { b: 2 }])
    r.stdout(':3}\n')
    expect(r.messages).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('keeps U+2028 and U+2029 inside a string, splitting on \\n only', () => {
    const r = read()
    r.stdout(`${JSON.stringify({ text: 'one two three' })}\n`)
    expect(r.messages).toEqual([{ text: 'one two three' }])
    expect(r.others).toEqual([])
  })

  it('drops a \\r before the \\n, and skips blank lines', () => {
    const r = read()
    r.stdout('{"a":1}\r\n\r\n   \n{"b":2}\n')
    expect(r.messages).toEqual([{ a: 1 }, { b: 2 }])
    r.stdout('log line\r\n')
    expect(r.others).toEqual(['log line'])
  })

  it('passes lines that are not JSON to onOther, and the line to handle', () => {
    const fake = fakeProc()
    const seen: [unknown, string][] = []
    const others: string[] = []
    onJsonLines(fake.proc, (msg, line) => seen.push([msg, line]), (line) => others.push(line))
    fake.stdout('Starting up\n{"ok":true}\n{broken\n')
    expect(seen).toEqual([[{ ok: true }, '{"ok":true}']])
    expect(others).toEqual(['Starting up', '{broken'])
  })

  it('ignores lines that are not JSON without onOther', () => {
    const fake = fakeProc()
    const messages: unknown[] = []
    onJsonLines(fake.proc, (msg) => messages.push(msg))
    fake.stdout('noise\n{"a":1}\n')
    expect(messages).toEqual([{ a: 1 }])
  })

  it('reads a last line without its \\n on flush, once', () => {
    const r = read()
    r.stdout('{"a":1}\n{"b":2}')
    expect(r.messages).toEqual([{ a: 1 }])
    r.flush()
    r.flush()
    expect(r.messages).toEqual([{ a: 1 }, { b: 2 }])
  })
})
