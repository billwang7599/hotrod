import { randomUUID } from 'node:crypto'
import type { Adapter, EngineEvent, ToolKind } from '../types.ts'

export type FakeStep =
  | EngineEvent
  | { type: 'permission'; toolId: string; name: string; kind: ToolKind; summary: string; input: unknown; output: string }

const demoReply = (text: string): FakeStep[] => [
  ...text.split(/(?<= )/).map((word): FakeStep => ({ type: 'text.delta', text: word })),
  { type: 'text.completed', text },
]

const demoThinking = (text: string): FakeStep[] =>
  text.split(/(?<= )/).map((word): FakeStep => ({ type: 'thinking.delta', text: word }))

const demoScript: FakeStep[] = [
  ...demoThinking('The user wants to know what is here. Listing the folder is the quickest way to find out.'),
  ...demoReply("I'll look at what's in this folder first."),
  { type: 'tool.started', toolId: 'demo-ls', name: 'Bash', kind: 'shell', summary: 'ls -la', input: { command: 'ls -la' } },
  {
    type: 'permission',
    toolId: 'demo-ls',
    name: 'Bash',
    kind: 'shell',
    summary: 'ls -la',
    input: { command: 'ls -la' },
    output: 'total 16\n-rw-r--r--  1 you  staff  120 README.md\ndrwxr-xr-x  4 you  staff  128 src',
  },
  ...demoThinking('A README and a src directory. I will describe both briefly.'),
  ...demoReply(
    'This folder has:\n\n- a `README.md`\n- a `src` directory\n\nTo list it yourself:\n\n```sh\nls -la\n```\n\n' +
      'This reply came from the **fake engine**.',
  ),
]

export function createFakeAdapter(script: FakeStep[] = demoScript, delayMs = 40): Adapter {
  return {
    id: 'fake',
    detect: async () => ({ installed: true, signedIn: true }),
    start(_machine, _options, emit) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let pending: { requestId: string; toolId: string; output: string; rest: FakeStep[] } | undefined
      let active = false

      const stop = () => {
        active = false
        clearTimeout(timer)
        pending = undefined
      }
      const play = (steps: FakeStep[]) => {
        timer = setTimeout(() => {
          if (!active) return
          const [step, ...rest] = steps
          if (!step) {
            active = false
            return emit({ type: 'turn.completed' })
          }
          if (step.type !== 'permission') {
            emit(step)
            return play(rest)
          }
          const { toolId, name, kind, summary, input, output } = step
          const requestId = `perm-${toolId}`
          pending = { requestId, toolId, output, rest }
          emit({ type: 'permission.requested', requestId, toolId, name, kind, summary, input })
        }, delayMs)
      }

      return {
        prompt() {
          active = true
          emit({ type: 'turn.started' })
          // Each message is a new session and the log outlives the core, so a counter would repeat ids.
          const suffix = randomUUID().slice(0, 8)
          play(script.map((step) => ('toolId' in step ? { ...step, toolId: `${step.toolId}-${suffix}` } : step)))
        },
        respond(requestId, allow) {
          if (!pending || pending.requestId !== requestId) return
          const { toolId, output, rest } = pending
          pending = undefined
          const result = allow ? output : 'The user denied this tool call.'
          emit({ type: 'tool.completed', toolId, output: result, isError: !allow })
          play(rest)
        },
        interrupt() {
          if (!active) return
          stop()
          emit({ type: 'turn.completed', error: 'Interrupted' })
        },
        close: stop,
      }
    },
  }
}
