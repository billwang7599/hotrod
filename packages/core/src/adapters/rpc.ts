import type { EngineProcess } from '../shared.ts'
import { onJsonLines } from './jsonl.ts'

export type RpcError = { code: number; message: string; data?: unknown }

// The client half of JSON-RPC over an engine's stdio, one message a line: request ids, answers, notifications and the
// engine's own requests. ACP speaks JSON-RPC 2.0 (`jsonrpc: true`: every message carries "jsonrpc": "2.0", and a line
// without it isn't JSON-RPC); Codex's app-server leaves the field out (`jsonrpc: false`: every JSON line is a message).
// Lines that aren't messages go to onOther. Call flush when the engine exits, then abandon what's still waiting.
export function rpcClient(
  proc: EngineProcess,
  options: {
    jsonrpc: boolean
    onRequest(id: string | number, method: string, params: any): void
    onNotification(method: string, params: any): void
    onOther?(line: string): void
    // The rejection's message for an error answer.
    errorText(error: any): string
  },
) {
  const pending = new Map<string | number, { resolve(result: any): void; reject(error: Error): void }>()
  let nextId = 1
  const write = (message: object) =>
    proc.write(JSON.stringify(options.jsonrpc ? { jsonrpc: '2.0', ...message } : message) + '\n')

  const handle = (msg: any) => {
    if (msg === null || typeof msg !== 'object') return false
    if (options.jsonrpc && msg.jsonrpc !== '2.0') return false
    if (msg.method !== undefined && msg.id !== undefined) options.onRequest(msg.id, msg.method, msg.params)
    else if (msg.method !== undefined) options.onNotification(msg.method, msg.params)
    else if (msg.id !== undefined) {
      const waiting = pending.get(msg.id)
      if (!waiting) return true
      pending.delete(msg.id)
      if (msg.error) waiting.reject(new Error(options.errorText(msg.error)))
      else waiting.resolve(msg.result)
    }
    return true
  }

  const lines = onJsonLines(
    proc,
    (msg, line) => {
      if (!handle(msg)) options.onOther?.(line)
    },
    options.onOther,
  )

  return {
    request(method: string, params: unknown): Promise<any> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        write({ id, method, params })
      })
    },
    // A notification without params leaves the field out.
    notify: (method: string, params?: unknown) => write({ method, ...(params !== undefined && { params }) }),
    respond: (id: unknown, result: unknown) => write({ id, result }),
    fail: (id: unknown, error: RpcError) => write({ id, error }),
    flush: lines.flush,
    // Requests still waiting when the engine exits never get an answer.
    abandon(reason: string) {
      for (const waiting of pending.values()) waiting.reject(new Error(reason))
      pending.clear()
    },
  }
}
