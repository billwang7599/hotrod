// Types for agent.js, which runs untyped in Chrome, for the tests that run it with a fake chrome.
export declare const PROTOCOL: number
export declare function parseCode(code: unknown): { port: number; token: string } | undefined
export declare function errorText(error: unknown): string
export type Agent = {
  call(method: string, params: Record<string, unknown>): Promise<any>
  connect(): Promise<void>
  pair(code: string): Promise<void>
  unpair(): Promise<void>
  events: {
    onTabCreated(tab: any): void
    onTabUpdated(tabId: number, change: any): void
    onTabRemoved(tabId: number): void
    onGroupRemoved(group: any): void
    onDebuggerEvent(source: { tabId?: number; sessionId?: string }, method: string, params?: unknown): void
    onDebuggerDetach(source: { tabId?: number }, reason: string): void
  }
  readonly status: string
}
export declare function createAgent(options: {
  chrome: any
  WebSocket: any
  setTimer?: (run: () => void, ms: number) => unknown
}): Agent
