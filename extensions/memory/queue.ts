// The job queue both compactors (the summary tree's and the rolling summary's) run on. It knows nothing about
// summaries: it keeps the chats that changed, runs one job at a time for the latest touched chat that has work,
// backs a chat off exponentially when its job fails, and tells waiters when nothing is left to do.

// What a job's commit step reports. 'done': it worked (the chat's backoff is cleared). 'drop': give up on this chat
// until it's touched again (e.g. its storage couldn't be written). { failed }: retry the chat later, with backoff.
export type JobOutcome = 'done' | 'drop' | { failed: string }

export type Timers = {
  set(run: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (run, delayMs) => setTimeout(run, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type JobQueueOptions<Job> = {
  // The chat's next job, or undefined when it has none (the chat then leaves the queue until touched again).
  find(chatId: string): Job | undefined
  // Does the slow part (a model call) and returns a commit step. The commit runs only if the queue is still open,
  // so nothing is written after close().
  work(chatId: string, job: Job): Promise<() => JobOutcome>
  // Called with the first failure's reason after a success (or at the start), not on every retry.
  onFailure?(reason: string): void
  debounceMs: number
  retryBaseMs: number
  retryMaxMs: number
  now?(): number
  timers?: Timers
}

export function openJobQueue<Job>(options: JobQueueOptions<Job>) {
  const { debounceMs, retryBaseMs, retryMaxMs, now = () => Date.now(), timers = realTimers } = options
  // Insertion order is touch order, so the newest touched chat is last.
  const touched = new Set<string>()
  const backoffs = new Map<string, { failures: number; retryAtMs: number }>()
  let timer: unknown
  let running = false
  let closed = false
  let failing = false
  const idleWaiters: (() => void)[] = []

  const settleIdle = () => {
    if (closed || (!running && timer === undefined && !touched.size)) idleWaiters.splice(0).forEach((done) => done())
  }

  const schedule = (delayMs: number) => {
    if (closed) return
    if (timer !== undefined) timers.clear(timer)
    timer = timers.set(() => {
      timer = undefined
      void run()
    }, delayMs)
  }

  const nextJob = () => {
    for (const chatId of [...touched].reverse()) {
      if ((backoffs.get(chatId)?.retryAtMs ?? 0) > now()) continue
      const job = options.find(chatId)
      if (job !== undefined) return { chatId, job }
      touched.delete(chatId)
    }
  }

  const fail = (chatId: string, reason: string) => {
    const failures = (backoffs.get(chatId)?.failures ?? 0) + 1
    backoffs.set(chatId, { failures, retryAtMs: now() + Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1)) })
    if (!failing) options.onFailure?.(reason)
    failing = true
  }

  async function run() {
    if (running || closed) return
    running = true
    try {
      for (let next = nextJob(); next && !closed; next = nextJob()) {
        const commit = await options.work(next.chatId, next.job)
        if (closed) return
        const outcome = commit()
        if (outcome === 'drop') {
          touched.delete(next.chatId)
        } else if (outcome === 'done') {
          backoffs.delete(next.chatId)
          failing = false
        } else {
          fail(next.chatId, outcome.failed)
        }
      }
    } finally {
      running = false
    }
    // Chats still touched are backing off: wake for the earliest retry.
    const retryAtMs = Math.min(...[...touched].map((chatId) => backoffs.get(chatId)?.retryAtMs ?? Infinity))
    if (retryAtMs < Infinity) schedule(retryAtMs - now())
    settleIdle()
  }

  return {
    // Marks a chat as changed; work starts debounceMs after the last touch.
    touch(chatId: string) {
      touched.delete(chatId)
      touched.add(chatId)
      schedule(debounceMs)
    },
    // Resolves once no touched chat has work left (a failing one keeps it waiting), or the queue is closed.
    whenIdle() {
      const done = new Promise<void>((resolve) => idleWaiters.push(resolve))
      settleIdle()
      return done
    },
    close() {
      closed = true
      if (timer !== undefined) timers.clear(timer)
      settleIdle()
    },
  }
}
