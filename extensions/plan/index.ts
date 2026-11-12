// Plan: plan first, then build, the same on every engine. A "Plan first" chip in the composer makes the chat's turns read
// only (TurnOptions, enforced by Kothar's sandbox and permission answers) and runs them on the Planning model list. The
// agent hands in a structured plan with submit_plan; the amber bar asks the user to approve, edit or cancel it.
// Approving turns the chip off and carries the turn on with the chat's usual permissions and the plan in the agent's
// instructions, and the agent ticks steps off with update_plan_step as the Plan tab follows along.
// Only the public extension API. Each chat's plan is in its chat storage, so it goes when the chat (or its space) does.
import type {
  ChatDetail,
  ChatSummary,
  Extension,
  ExtensionContext,
  ExtensionHost,
  ExtensionView,
  TurnOptions,
} from '@kothar/extension-api'

export const PLAN_FILE = 'plan.json'
export const TOGGLE = 'plan'
export const TAB = 'plan'

export type StepStatus = 'todo' | 'done' | 'skipped'
export type PlanStep = { text: string; status: StepStatus; note?: string }
// proposed: handed in, waiting for the user. approved: being carried out. cancelled: the user said no.
export type PlanStatus = 'proposed' | 'approved' | 'cancelled'
export type Plan = {
  goal: string
  files: string[]
  steps: PlanStep[]
  risks: string[]
  tests: string
  status: PlanStatus
  createdAt: string
  approvedAt?: string
}

export const READ_ONLY_REASON =
  'Plan first is on, so this turn is read only: read and search to understand the change, then hand in a plan with ' +
  'submit_plan. Nothing can be edited until the user approves it.'

export const APPROVED_PROMPT =
  'The user approved your plan (it is in your instructions). Carry it out now, step by step, with your usual ' +
  'permissions. After each step, call update_plan_step with its number and done or skipped, and a short note.'

const STATUSES: StepStatus[] = ['todo', 'done', 'skipped']
const isText = (value: unknown): value is string => typeof value === 'string'
const lines = (value: unknown): string[] =>
  (Array.isArray(value) ? value : isText(value) ? value.split('\n') : [])
    .filter(isText)
    .map((line) => line.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+|\[[ x]\]\s+)/i, '').trim())
    .filter(Boolean)

/** The plan in a plan.json, or undefined for a missing or broken one. */
export function parsePlan(text: string | undefined): Plan | undefined {
  if (!text) return undefined
  try {
    const raw = JSON.parse(text) as Partial<Plan>
    if (!isText(raw.goal) || !Array.isArray(raw.steps) || !isText(raw.createdAt)) return undefined
    const steps = raw.steps.flatMap((step): PlanStep[] =>
      step && isText(step.text)
        ? [{ text: step.text, status: STATUSES.includes(step.status) ? step.status : 'todo', ...(isText(step.note) && step.note && { note: step.note }) }]
        : [],
    )
    const status: PlanStatus = raw.status === 'approved' || raw.status === 'cancelled' ? raw.status : 'proposed'
    return {
      goal: raw.goal,
      files: lines(raw.files),
      steps,
      risks: lines(raw.risks),
      tests: isText(raw.tests) ? raw.tests : '',
      status,
      createdAt: raw.createdAt,
      ...(isText(raw.approvedAt) && { approvedAt: raw.approvedAt }),
    }
  } catch {
    return undefined
  }
}

/**
 * A plan from submit_plan's input (or the edit form's), or why it isn't one. Steps keep the status of a step with the
 * same text in `before`, so editing a plan doesn't untick what's done.
 */
export function planFrom(
  input: Record<string, unknown>,
  options: { requireTests: boolean; now: Date; before?: Plan },
): Plan | { error: string } {
  const goal = isText(input.goal) ? input.goal.trim() : ''
  if (!goal) return { error: 'A plan needs a goal: one or two sentences on what the change is for.' }
  const texts = lines(input.steps)
  if (!texts.length) return { error: 'A plan needs at least one step.' }
  const tests = isText(input.tests) ? input.tests.trim() : lines(input.tests).join('\n')
  if (options.requireTests && !tests) {
    return { error: 'A plan needs a tests step: say how the change will be tested (which tests to add or run, and what to check by hand).' }
  }
  const kept = new Map(options.before?.steps.map((step) => [step.text, step]))
  const steps = texts.map((text): PlanStep => {
    const old = kept.get(text)
    return old ? { ...old } : { text, status: 'todo' }
  })
  const before = options.before
  return {
    goal,
    files: lines(input.files),
    steps,
    risks: lines(input.risks),
    tests,
    status: before?.status ?? 'proposed',
    createdAt: before?.createdAt ?? options.now.toISOString(),
    ...(before?.approvedAt && { approvedAt: before.approvedAt }),
  }
}

export const doneCount = (plan: Plan) => plan.steps.filter((step) => step.status !== 'todo').length
export const progressOf = (plan: Plan) => `${doneCount(plan)} of ${plan.steps.length}`

const MARKS: Record<StepStatus, string> = { todo: '[ ]', done: '[x]', skipped: '[~]' }

/** The plan as Markdown, for the agent's instructions, read_plan and Copy. */
export function planMarkdown(plan: Plan): string {
  const parts = [`# Plan: ${plan.goal}`, `Status: ${plan.status}, ${progressOf(plan)} steps done or skipped.`]
  if (plan.files.length) parts.push(`## Files\n${plan.files.map((f) => `- ${f}`).join('\n')}`)
  const step = (s: PlanStep, i: number) =>
    `${i + 1}. ${MARKS[s.status]} ${s.text}${s.status === 'skipped' ? ' (skipped)' : ''}${s.note ? ` — ${s.note}` : ''}`
  parts.push(`## Steps\n${plan.steps.map(step).join('\n')}`)
  if (plan.risks.length) parts.push(`## Risks\n${plan.risks.map((r) => `- ${r}`).join('\n')}`)
  if (plan.tests) parts.push(`## Tests\n${plan.tests}`)
  return parts.join('\n\n')
}

// A worker works on its lead's plan; everyone else on their own.
const ownerOf = (chat: Pick<ChatSummary, 'id' | 'parentId'>) => chat.parentId ?? chat.id

function store(host: ExtensionHost, chatId: string) {
  const storage = host.chatStorage(chatId)
  return {
    read: () => parsePlan(storage.read(PLAN_FILE)),
    write: (plan: Plan) => storage.write(PLAN_FILE, JSON.stringify(plan, null, 2) + '\n'),
    remove: () => storage.remove(PLAN_FILE),
  }
}

const planOn = (host: ExtensionHost, chatId: string) => {
  try {
    return host.toggled(chatId, TOGGLE)
  } catch {
    return false
  }
}

// Only chats the user types in: not an extension's own chat (Home), not workers.
const isUsersChat = (chat: Pick<ChatDetail, 'extension' | 'worker'>) => !chat.extension && !chat.worker

const waitText = (plan: Plan) =>
  `Plan ready: ${plan.goal.length > 90 ? plan.goal.slice(0, 89) + '…' : plan.goal} (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}), in the Plan tab. Approve it?`

export function createPlanExtension(): Extension {
  // Chats whose turn handed in a plan, so its end shows the bar.
  const handedIn = new Set<string>()
  // Chats whose Plan tab shows the edit form. As in Deep Research, Edit closes the bar: the plan then waits in the tab
  // (Approve / Edit / Cancel), and the form's submit approves it.
  const editing = new Set<string>()

  const showWait = (host: ExtensionHost, chatId: string, plan: Plan) =>
    host.wait(chatId, {
      text: waitText(plan),
      buttons: [
        { id: 'approve', label: 'Approve', primary: true, closes: true, hint: 'Turn Plan first off and start the work with this plan' },
        { id: 'edit', label: 'Edit', closes: true, hint: 'Change the plan in the Plan tab, then approve it' },
        { id: 'cancel', label: 'Cancel', closes: true, hint: 'Drop this plan; Plan first stays on' },
      ],
    })

  const approve = (host: ExtensionHost, chatId: string) => {
    const plans = store(host, chatId)
    const plan = plans.read()
    if (!plan || plan.status !== 'proposed') return
    plans.write({ ...plan, status: 'approved', approvedAt: host.now().toISOString() })
    editing.delete(chatId)
    host.setToggle(chatId, TOGGLE, false)
    host.endWait(chatId)
    host.refresh(chatId)
    try {
      host.continue(chatId, APPROVED_PROMPT)
    } catch {
      // The chat moved on (a queued message started): that turn runs with the plan in its instructions anyway.
      host.note(chatId, 'Plan approved. The next turn carries it out.', { panel: TAB })
    }
  }

  const cancel = (host: ExtensionHost, chatId: string) => {
    const plans = store(host, chatId)
    const plan = plans.read()
    if (plan?.status === 'proposed') plans.write({ ...plan, status: 'cancelled' })
    editing.delete(chatId)
    host.endWait(chatId)
    host.refresh(chatId)
  }

  const view = (chat: ChatDetail, { host, values }: ExtensionContext): ExtensionView => {
    const owner = ownerOf(chat)
    const plan = store(host, owner).read()
    if (!plan) {
      return {
        type: 'empty',
        text: chat.worker
          ? 'Your lead has no plan.'
          : 'No plan yet. Turn on Plan first beside the message box, then ask for a change: the agent reads the code and proposes a plan for you to approve.',
      }
    }
    if (editing.has(owner) && !chat.worker) {
      const proposed = plan.status === 'proposed'
      return {
        type: 'stack',
        children: [
          { type: 'heading', text: 'Edit plan' },
          {
            type: 'form',
            key: `plan-${plan.createdAt}`,
            fields: [
              { name: 'goal', label: 'Goal', value: plan.goal, rows: 2 },
              { name: 'steps', label: 'Steps, one per line', value: plan.steps.map((s) => s.text).join('\n'), rows: 8 },
              { name: 'files', label: 'Files, one per line', value: plan.files.join('\n'), rows: 4, mono: true },
              { name: 'risks', label: 'Risks, one per line', value: plan.risks.join('\n'), rows: 3 },
              {
                name: 'tests',
                label: 'How it will be tested',
                value: plan.tests,
                rows: 3,
                ...(values.requireTests !== false && { hint: 'Required' }),
              },
            ],
            // A plan waiting for the user: the form's submit approves it, as Deep Research's starts it. Cancel drops it.
            submit: proposed ? { label: 'Approve and start', action: 'save' } : { label: 'Save', action: 'save' },
            cancel: proposed ? { label: 'Cancel plan', action: { name: 'cancel' } } : { label: 'Back', action: { name: 'stopEditing' } },
          },
        ],
      }
    }
    const statusBadge: Record<PlanStatus, { text: string; tone: 'accent' | 'warning' | 'muted' | 'success' }> = {
      proposed: { text: 'Waiting for you', tone: 'warning' },
      approved: { text: doneCount(plan) === plan.steps.length ? 'Done' : 'Approved', tone: doneCount(plan) === plan.steps.length ? 'success' : 'accent' },
      cancelled: { text: 'Cancelled', tone: 'muted' },
    }
    const header: ExtensionView = {
      type: 'row',
      justify: 'between',
      children: [
        { type: 'badge', ...statusBadge[plan.status] },
        { type: 'text', text: `${progressOf(plan)} done`, tone: 'muted', small: true },
        ...(chat.worker
          ? []
          : [
              {
                type: 'menu' as const,
                label: 'More for this plan',
                items: [
                  ...(plan.status === 'proposed' ? [] : [{ label: 'Edit plan', action: { name: 'edit' } }]),
                  {
                    label: 'Clear plan',
                    action: { name: 'clear' },
                    danger: true,
                    confirm: { text: 'Clear this plan?', body: 'The plan and its ticks are removed from this chat.', ok: 'Clear', danger: true },
                  },
                ],
              },
            ]),
      ],
    }
    const steps: ExtensionView = {
      type: 'list',
      label: 'Steps',
      items: plan.steps.map((step, i) => ({
        key: `${i}`,
        label: `${i + 1}. ${step.text}`,
        dot: step.status === 'done' ? 'success' : step.status === 'skipped' ? 'muted' : 'faint',
        ...(step.status === 'skipped' && { badges: [{ text: 'Skipped', tone: 'muted' as const }] }),
        ...(step.note && { detail: step.note }),
        hint: step.status === 'todo' ? 'Not done yet' : step.status === 'done' ? 'Done' : 'Skipped',
      })),
    }
    const details: ExtensionView[] = [
      ...(plan.files.length ? [{ type: 'card' as const, title: `Files (${plan.files.length})`, children: plan.files.map((f): ExtensionView => ({ type: 'text', text: f, mono: true, small: true })) }] : []),
      ...(plan.risks.length ? [{ type: 'card' as const, title: `Risks (${plan.risks.length})`, children: [{ type: 'markdown' as const, text: plan.risks.map((r) => `- ${r}`).join('\n') }] }] : []),
      ...(plan.tests ? [{ type: 'card' as const, title: 'Tests', children: [{ type: 'markdown' as const, text: plan.tests }] }] : []),
    ]
    // The same three choices as the bar (and as Deep Research's plan), for when the bar was closed with Edit.
    const approveButton: ExtensionView[] =
      plan.status === 'proposed' && !chat.worker
        ? [
            {
              type: 'row',
              children: [
                { type: 'button', label: 'Approve', variant: 'primary', action: { name: 'approve' }, hint: 'Turn Plan first off and start the work with this plan' },
                { type: 'button', label: 'Edit', action: { name: 'edit' }, hint: 'Change the plan, then approve it' },
                { type: 'button', label: 'Cancel', variant: 'ghost', action: { name: 'cancel' }, hint: 'Drop this plan; Plan first stays on' },
              ],
            },
          ]
        : []
    return {
      type: 'stack',
      children: [header, { type: 'heading', text: plan.goal }, ...approveButton, steps, ...details],
    }
  }

  const extension: Extension = {
    id: 'plan',
    name: 'Plan',
    description:
      'Plan first, then build, on every engine. Turn on Plan first beside the message box: the agent can only read ' +
      'while it works out a plan, then you approve, edit or cancel it, and the Plan tab ticks off its steps as the ' +
      'work goes on.',
    enabledByDefault: true,
    settings: [
      {
        key: 'showToggle',
        label: 'Show Plan first toggle',
        description: 'The Plan first chip beside the message box. Agents can still read and update a plan without it.',
        type: 'boolean',
        default: true,
      },
      {
        key: 'requireTests',
        label: 'Require tests step',
        description: 'Turn away plans that don’t say how the change will be tested.',
        type: 'boolean',
        default: true,
      },
    ],
    composerToggles: [
      {
        id: TOGGLE,
        label: 'Plan first',
        icon: 'book',
        hint: 'Plan first: the agent only reads and proposes a plan for you to approve',
        activeHint: 'On: read only until you approve a plan',
        shown: (chat, { values }) => values.showToggle !== false && isUsersChat(chat),
      },
    ],

    turnOptions(chat, { host }): TurnOptions | undefined {
      // A worker started while its lead plans is read only too.
      if (!planOn(host, ownerOf(chat))) return undefined
      return { readOnly: true, reason: READ_ONLY_REASON, role: 'planning' }
    },

    instructions({ chat, tools }, { host }) {
      const owner = ownerOf(chat)
      if (planOn(host, owner)) {
        if (chat.worker) return 'Your lead is planning, so this turn is read only. Read and report what you find; change nothing.'
        return [
          'Plan first is on. This turn is read only: Kothar refuses edits and commands that change anything, so don’t try them.',
          'Read and search the code to understand the change, then hand in a plan' +
            (tools ? ' by calling submit_plan once' : '') +
            ': the goal, the files you will touch, ordered steps, the risks, and how you will test it.',
          'Keep your reply short: the user reviews the plan itself and approves, edits or cancels it.',
        ].join('\n')
      }
      const plan = store(host, owner).read()
      if (!plan || plan.status !== 'approved' || doneCount(plan) === plan.steps.length) return undefined
      const how = tools
        ? 'After each step, call update_plan_step with its number and done or skipped (with a short note). If you lose track, read_plan shows it.'
        : ''
      if (chat.worker) {
        return `Your lead is working through this approved plan. Do the step or steps your task names, and nothing else of it.\n${how}\n\n${planMarkdown(plan)}`
      }
      return `The user approved this plan. Carry it out in order.\n${how}\n\n${planMarkdown(plan)}`
    },

    tools: [
      {
        name: 'submit_plan',
        description:
          'Hand in your plan for the user to approve, while Plan first is on. Structured: goal, files you will touch, ' +
          'ordered steps, risks, and how you will test the change. The user approves, edits or cancels it; on approval ' +
          'the work starts with your usual permissions. Call it once per plan; calling it again replaces the plan.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'What the change is for, in one or two sentences.' },
            files: { type: 'array', items: { type: 'string' }, description: 'Paths you expect to create or change.' },
            steps: { type: 'array', items: { type: 'string' }, description: 'Ordered steps, each one short and checkable.' },
            risks: { type: 'array', items: { type: 'string' }, description: 'What could go wrong, and anything you’re unsure of.' },
            tests: { type: 'string', description: 'How you will test it: tests to add or run, and anything to check by hand.' },
          },
          required: ['goal', 'steps', 'tests'],
        },
        offered: (caller) => !caller.worker,
        run(input, { caller, values, host }) {
          if (!planOn(host, caller.id)) {
            throw new Error('Plan first is off in this chat, so there is nothing to hand a plan in to. Carry on with the work.')
          }
          const plans = store(host, caller.id)
          const plan = planFrom(input, { requireTests: values.requireTests !== false, now: host.now() })
          if ('error' in plan) throw new Error(plan.error)
          plans.write(plan)
          editing.delete(caller.id)
          handedIn.add(caller.id)
          host.refresh(caller.id)
          host.showPanel(caller.id, TAB)
          return `Plan handed in (${plan.steps.length} steps). The user will approve, edit or cancel it once your turn ends. End your turn now with a short summary.`
        },
      },
      {
        name: 'update_plan_step',
        description:
          'Tick a step of the approved plan off: done or skipped, with a short note (what changed, or why it was ' +
          'skipped). todo un-ticks it. Steps are numbered from 1, as read_plan shows them.',
        inputSchema: {
          type: 'object',
          properties: {
            step: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['done', 'skipped', 'todo'] },
            note: { type: 'string' },
          },
          required: ['step', 'status'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const owner = ownerOf(caller)
          const plans = store(host, owner)
          const plan = plans.read()
          if (!plan) throw new Error('This chat has no plan.')
          if (plan.status !== 'approved') throw new Error('The plan isn’t approved yet, so there are no steps to tick.')
          const index = Number(input.step) - 1
          const step = plan.steps[index]
          if (!Number.isInteger(index) || !step) throw new Error(`No step ${String(input.step)}: the plan has ${plan.steps.length}.`)
          const status = input.status as StepStatus
          if (!STATUSES.includes(status)) throw new Error('status is done, skipped or todo.')
          const note = isText(input.note) && input.note.trim() ? input.note.trim().slice(0, 500) : undefined
          plan.steps[index] = { text: step.text, status, ...(note && { note }) }
          plans.write(plan)
          host.refresh(owner)
          if (caller.id !== owner) host.refresh(caller.id)
          return `Step ${index + 1} ${status}. ${progressOf(plan)} steps done or skipped.`
        },
      },
      {
        name: 'read_plan',
        description:
          'The chat’s plan as it stands: goal, files, numbered steps with which are done or skipped, risks and tests. ' +
          'For a worker, its lead’s plan.',
        inputSchema: { type: 'object', properties: {} },
        offered: () => true,
        run(_input, { caller, host }) {
          const plan = store(host, ownerOf(caller)).read()
          return plan ? planMarkdown(plan) : 'This chat has no plan.'
        },
      },
    ],

    panels: [
      {
        id: TAB,
        title: 'Plan',
        shown: (chat) => !chat.extension,
        render: view,
        onAction(action, chat, { host, values }) {
          if (chat.worker) return
          const owner = chat.id
          if (action.name === 'approve') return approve(host, owner)
          if (action.name === 'cancel') return cancel(host, owner)
          if (action.name === 'edit') {
            editing.add(owner)
            return host.refresh(owner)
          }
          if (action.name === 'stopEditing') {
            editing.delete(owner)
            return host.refresh(owner)
          }
          if (action.name === 'clear') {
            store(host, owner).remove()
            editing.delete(owner)
            host.endWait(owner)
            return host.refresh(owner)
          }
          if (action.name === 'save') {
            const plans = store(host, owner)
            const before = plans.read()
            if (!before) return
            const value = (action.value ?? {}) as Record<string, unknown>
            const next = planFrom(value, { requireTests: values.requireTests !== false, now: host.now(), before })
            if ('error' in next) return host.error(next.error)
            plans.write(next)
            editing.delete(owner)
            // A waiting plan's form submits as Approve and start.
            if (next.status === 'proposed') return approve(host, owner)
            return host.refresh(owner)
          }
        },
      },
    ],

    onTurnCompleted(turn, { host }) {
      const chatId = turn.chat.id
      if (!handedIn.delete(chatId)) return
      const plan = store(host, chatId).read()
      if (!plan || plan.status !== 'proposed' || turn.errorKind === 'interrupted') return
      // Synchronously, so the chat is held after its turn until the user answers.
      showWait(host, chatId, plan)
    },

    onWaitAction(chat, answer, { host }) {
      if ('message' in answer) {
        // The user wrote back instead: their message goes to the agent, which can hand in a revised plan.
        host.endWait(chat.id)
        return
      }
      if (answer.button === 'approve') return approve(host, chat.id)
      if (answer.button === 'cancel') return cancel(host, chat.id)
      if (answer.button === 'edit') {
        editing.add(chat.id)
        host.refresh(chat.id)
        host.showPanel(chat.id, TAB)
      }
    },

    onChatRemoved(chat) {
      // Its chat storage (plan.json) went with the chat's folder; only memory is left to forget.
      handedIn.delete(chat.id)
      editing.delete(chat.id)
    },

    onStop() {
      handedIn.clear()
      editing.clear()
    },
  }
  return extension
}

export default createPlanExtension()
