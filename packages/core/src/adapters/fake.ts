import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Adapter, EngineEvent, Question, SessionOptions, ToolKind } from '../shared.ts'

export type FakeStep =
  | EngineEvent
  | {
      type: 'permission'
      toolId: string
      name: string
      kind: ToolKind
      summary: string
      path?: string
      command?: string
      input: unknown
      output: string
    }
  | { type: 'question'; toolId?: string; questions: Question[] }

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
  ...demoReply('Before I describe it, two quick questions.'),
  {
    type: 'tool.started',
    toolId: 'demo-ask',
    name: 'AskUserQuestion',
    kind: 'other',
    summary: 'How much detail do you want?',
    input: {},
  },
  {
    type: 'question',
    toolId: 'demo-ask',
    questions: [
      {
        header: 'Detail',
        question: 'How much detail do you want?',
        options: [
          { label: 'Brief', description: 'One line per item' },
          { label: 'Thorough', description: 'What each item is for, with examples' },
        ],
        multiSelect: false,
      },
      {
        header: 'Parts',
        question: 'Which parts should I cover?',
        options: [
          { label: 'README.md', description: 'The project overview' },
          { label: 'src', description: 'The source code' },
        ],
        multiSelect: true,
      },
    ],
  },
  ...demoThinking('A README and a src directory. I will describe both briefly.'),
  ...demoReply(
    'This folder has:\n\n- a `README.md`\n- a `src` directory\n\nTo list it yourself:\n\n```sh\nls -la\n```\n\n' +
      'This reply came from the **fake engine**.',
  ),
]

export const FAKE_MODELS = ['fake-large', 'fake-small']
export const FAKE_THINKING = ['low', 'high']
export const FAKE_DEFAULTS = { defaultModel: 'fake-small', defaultThinking: 'high' }

// A script can depend on the session, such as which account it runs on (options.accountDir). With steering, a
// steered message lands after the next tool result, like Claude Code's and pi's; one still waiting when the script
// ends is returned.
export function createFakeAdapter(
  script: FakeStep[] | ((options: SessionOptions) => FakeStep[]) = demoScript,
  delayMs = 40,
  { steering = false }: { steering?: boolean } = {},
): Adapter {
  return {
    id: 'fake',
    imageInput: true,
    ...(steering && { steering }),
    async complete(_machine, { prompt }) {
      const keys = [...prompt.matchAll(/<item key="([^"]+)"/g)].map(([, key]) => key)
      return JSON.stringify({ summaries: keys.map((key) => ({ key, text: `summary of ${key}` })) })
    },
    detect: async () => ({
      installed: true,
      signedIn: true,
      models: FAKE_MODELS,
      thinking: FAKE_THINKING,
      ...FAKE_DEFAULTS,
    }),
    accounts: {
      status: async (_machine, accountDir) => ({
        signedIn: true,
        label: `${accountDir ? basename(accountDir) : 'default'}@fake.test`,
      }),
      login(_machine, _accountDir, emit) {
        let open = true
        const timer = setTimeout(() => emit({ type: 'url', url: 'https://example.com/fake-sign-in' }), delayMs)
        return {
          submitCode(code) {
            if (!open) return
            open = false
            const error = 'Login failed: the fake engine refused that code.'
            emit(code.trim() === 'fail' ? { type: 'failed', error } : { type: 'done' })
          },
          cancel() {
            open = false
            clearTimeout(timer)
          },
        }
      },
      logout: async () => {},
      apiKeys: true,
    },
    start(_machine, options, emit) {
      const steps = typeof script === 'function' ? script(options) : script
      let timer: ReturnType<typeof setTimeout> | undefined
      let pending: { requestId: string; toolId?: string; output: string; rest: FakeStep[] } | undefined
      let active = false
      let steers: string[] = []

      const stop = () => {
        active = false
        clearTimeout(timer)
        pending = undefined
      }
      const settleSteers = (type: 'steer.landed' | 'steer.returned') => {
        const ids = steers
        steers = []
        for (const id of ids) emit({ type, id })
      }
      const completeTool = (event: Extract<EngineEvent, { type: 'tool.completed' }>) => {
        emit(event)
        settleSteers('steer.landed')
      }
      const play = (steps: FakeStep[]) => {
        timer = setTimeout(() => {
          if (!active) return
          const [step, ...rest] = steps
          if (!step) {
            active = false
            settleSteers('steer.returned')
            return emit({ type: 'turn.completed' })
          }
          if (step.type === 'question') {
            const { type, ...asked } = step
            const requestId = `ask-${step.toolId ?? randomUUID().slice(0, 8)}`
            pending = { requestId, toolId: step.toolId, output: '', rest }
            return emit({ type: 'question.asked', requestId, ...asked })
          }
          if (step.type !== 'permission') {
            if (step.type === 'tool.completed') completeTool(step)
            else emit(step)
            return play(rest)
          }
          const { type, output, ...request } = step
          const requestId = `perm-${step.toolId}`
          pending = { requestId, toolId: step.toolId, output, rest }
          emit({ type: 'permission.requested', requestId, ...request })
        }, delayMs)
      }

      return {
        prompt() {
          active = true
          emit({ type: 'turn.started' })
          // Each message is a new session and the log outlives the core, so a counter would repeat ids.
          const suffix = randomUUID().slice(0, 8)
          play(steps.map((step) => ('toolId' in step ? { ...step, toolId: `${step.toolId}-${suffix}` } : step)))
        },
        respond(requestId, allow, message = 'The user denied this tool call.') {
          if (!pending || pending.requestId !== requestId) return
          const { toolId, output, rest } = pending
          pending = undefined
          if (toolId) completeTool({ type: 'tool.completed', toolId, output: allow ? output : message, isError: !allow })
          play(rest)
        },
        answer(requestId, answers) {
          if (!pending || pending.requestId !== requestId) return
          const { toolId, rest } = pending
          pending = undefined
          const output = answers
            ? Object.entries(answers).map(([question, picked]) => `${question} ${picked.join(', ')}`).join('\n')
            : 'The user declined to answer.'
          if (toolId) completeTool({ type: 'tool.completed', toolId, output, isError: !answers })
          play(rest)
        },
        interrupt() {
          if (!active) return
          stop()
          settleSteers('steer.returned')
          emit({ type: 'turn.completed', error: 'Interrupted' })
        },
        close: stop,
        ...(steering && {
          steer(id: string) {
            if (active) steers.push(id)
            else emit({ type: 'steer.returned', id })
          },
        }),
      }
    },
  }
}
