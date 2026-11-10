import { describe, expect, it } from 'vitest'
import { rpcClient } from './rpc.ts'
import { fakeProc } from './test-machine.ts'

function client(jsonrpc: boolean) {
  const fake = fakeProc()
  const requests: unknown[][] = []
  const notifications: unknown[][] = []
  const others: string[] = []
  const rpc = rpcClient(fake.proc, {
    jsonrpc,
    errorText: (error) => `refused: ${error.message}`,
    onRequest: (...args) => requests.push(args),
    onNotification: (...args) => notifications.push(args),
    onOther: (line) => others.push(line),
  })
  const sent = () => fake.written.join('').split('\n').filter(Boolean)
  return { ...fake, rpc, requests, notifications, others, sent }
}

describe('rpcClient', () => {
  it('numbers requests from 1 and resolves each by its id', async () => {
    const c = client(true)
    const first = c.rpc.request('initialize', { v: 1 })
    const second = c.rpc.request('session/new', {})
    expect(c.sent()).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"v":1}}',
      '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}',
    ])
    c.stdout('{"jsonrpc":"2.0","id":2,"result":{"s":"b"}}\n{"jsonrpc":"2.0","id":1,"result":"a"}\n')
    expect(await first).toBe('a')
    expect(await second).toEqual({ s: 'b' })
  })

  it('rejects an error answer with errorText, and ignores answers nobody waits on', async () => {
    const c = client(true)
    const asked = c.rpc.request('x', {})
    c.stdout('{"jsonrpc":"2.0","id":9,"result":1}\n{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"no"}}\n')
    await expect(asked).rejects.toThrow('refused: no')
    c.stdout('{"jsonrpc":"2.0","id":1,"result":1}\n')
    expect(c.others).toEqual([])
  })

  it("passes the engine's requests and notifications on", () => {
    const c = client(true)
    c.stdout('{"jsonrpc":"2.0","id":"r1","method":"ask","params":{"q":1}}\n{"jsonrpc":"2.0","method":"update","params":2}\n')
    expect(c.requests).toEqual([['r1', 'ask', { q: 1 }]])
    expect(c.notifications).toEqual([['update', 2]])
  })

  it('writes notifications, answers and refusals, leaving out params when there are none', () => {
    const c = client(true)
    c.rpc.notify('session/cancel', { s: 1 })
    c.rpc.notify('initialized')
    c.rpc.respond('r1', { ok: true })
    c.rpc.fail(7, { code: -32601, message: 'Method not found' })
    expect(c.sent()).toEqual([
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"s":1}}',
      '{"jsonrpc":"2.0","method":"initialized"}',
      '{"jsonrpc":"2.0","id":"r1","result":{"ok":true}}',
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}',
    ])
  })

  it('with jsonrpc on, sends JSON without the field to onOther, as it does lines that are not JSON', () => {
    const c = client(true)
    c.stdout('{"id":1,"result":1}\nINFO starting\n5\nnull\n')
    expect(c.others).toEqual(['{"id":1,"result":1}', 'INFO starting', '5', 'null'])
  })

  it('with jsonrpc off, leaves the field out and reads messages without it', async () => {
    const c = client(false)
    const asked = c.rpc.request('model/list', { cursor: 'a' })
    c.rpc.notify('initialized')
    expect(c.sent()).toEqual(['{"id":1,"method":"model/list","params":{"cursor":"a"}}', '{"method":"initialized"}'])
    c.stdout('{"method":"turn/started","params":{}}\n{"id":5,"method":"item/x/requestApproval","params":{}}\n')
    c.stdout('{"id":1,"result":{"data":[]}}\n')
    expect(await asked).toEqual({ data: [] })
    expect(c.notifications).toEqual([['turn/started', {}]])
    expect(c.requests).toEqual([[5, 'item/x/requestApproval', {}]])
  })

  it('abandon rejects what still waits; flush reads a last line without its \\n', async () => {
    const c = client(false)
    const answered = c.rpc.request('a', {})
    const lost = c.rpc.request('b', {})
    c.stdout('{"id":1,"result":"yes"}')
    c.rpc.flush()
    c.rpc.abandon('Engine has stopped')
    expect(await answered).toBe('yes')
    await expect(lost).rejects.toThrow('Engine has stopped')
  })
})
