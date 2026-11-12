import { describe, expect, it } from 'vitest'
import { type JobOutcome, openJobQueue, type Timers } from './queue.ts'

// A clock the test moves by hand: timers fire only inside advance(), in order of when they're due.
function fakeClock() {
  let nowMs = 0
  let nextId = 0
  const pending = new Map<number, { atMs: number; run: () => void }>()
  const timers: Timers = {
    set(run, delayMs) {
      const id = nextId++
      pending.set(id, { atMs: nowMs + Math.max(0, delayMs), run })
      return id
    },
    clear: (handle) => void pending.delete(handle as number),
  }
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    now: () => nowMs,
    timers,
    pendingCount: () => pending.size,
    async advance(ms: number) {
      const until = nowMs + ms
      for (;;) {
        await settle()
        const due = [...pending].filter(([, t]) => t.atMs <= until).sort(([, a], [, b]) => a.atMs - b.atMs)[0]
        if (!due) break
        pending.delete(due[0])
        nowMs = due[1].atMs
        due[1].run()
      }
      nowMs = until
      await settle()
    },
  }
}

type Script = Record<string, JobOutcome[]>

// A queue whose chats have work while their script has outcomes left; each job consumes one outcome.
function scriptedQueue(script: Script, options: { debounceMs?: number; retryBaseMs?: number; retryMaxMs?: number } = {}) {
  const clock = fakeClock()
  const ran: { chatId: string; atMs: number }[] = []
  const failures: string[] = []
  const queue = openJobQueue<JobOutcome>({
    find: (chatId) => script[chatId]?.[0],
    async work(chatId, outcome) {
      ran.push({ chatId, atMs: clock.now() })
      return () => {
        script[chatId]!.shift()
        return outcome
      }
    },
    onFailure: (reason) => failures.push(reason),
    debounceMs: options.debounceMs ?? 100,
    retryBaseMs: options.retryBaseMs ?? 1_000,
    retryMaxMs: options.retryMaxMs ?? 10_000,
    now: clock.now,
    timers: clock.timers,
  })
  return { clock, queue, ran, failures }
}

describe('openJobQueue', () => {
  it('waits debounceMs after the last touch, then runs every job', async () => {
    const { clock, queue, ran } = scriptedQueue({ a: ['done', 'done'] })
    queue.touch('a')
    await clock.advance(60)
    queue.touch('a')
    await clock.advance(99)
    expect(ran).toEqual([])
    await clock.advance(1)
    expect(ran).toEqual([
      { chatId: 'a', atMs: 160 },
      { chatId: 'a', atMs: 160 },
    ])
  })

  it('runs the latest touched chat first', async () => {
    const { clock, queue, ran } = scriptedQueue({ a: ['done'], b: ['done'], c: ['done'] })
    queue.touch('a')
    queue.touch('b')
    queue.touch('c')
    queue.touch('a')
    await clock.advance(100)
    expect(ran.map((r) => r.chatId)).toEqual(['a', 'c', 'b'])
  })

  it('backs a failing chat off exponentially up to retryMaxMs, and reports only the first failure', async () => {
    const { clock, queue, ran, failures } = scriptedQueue(
      { a: [{ failed: 'one' }, { failed: 'two' }, { failed: 'three' }, { failed: 'four' }, 'done'] },
      { debounceMs: 0, retryBaseMs: 1_000, retryMaxMs: 3_000 },
    )
    queue.touch('a')
    await clock.advance(20_000)
    expect(ran.map((r) => r.atMs)).toEqual([0, 1_000, 3_000, 6_000, 9_000])
    expect(failures).toEqual(['one'])
  })

  it('reports a new failure again after a success', async () => {
    const { clock, queue, failures } = scriptedQueue(
      { a: [{ failed: 'first' }, 'done', { failed: 'again' }, 'done'] },
      { debounceMs: 0, retryBaseMs: 10 },
    )
    queue.touch('a')
    await clock.advance(1_000)
    expect(failures).toEqual(['first', 'again'])
  })

  it('works on other chats while one backs off', async () => {
    const { clock, queue, ran } = scriptedQueue({ a: [{ failed: 'down' }, 'done'], b: ['done'] }, { debounceMs: 0 })
    queue.touch('b')
    queue.touch('a')
    await clock.advance(0)
    expect(ran).toEqual([
      { chatId: 'a', atMs: 0 },
      { chatId: 'b', atMs: 0 },
    ])
    await clock.advance(1_000)
    expect(ran.at(-1)).toEqual({ chatId: 'a', atMs: 1_000 })
  })

  it('drops a chat until it is touched again', async () => {
    const script: Script = { a: ['drop', 'done'] }
    const { clock, queue, ran } = scriptedQueue(script, { debounceMs: 0 })
    queue.touch('a')
    await clock.advance(10_000)
    expect(ran).toHaveLength(1)
    queue.touch('a')
    await clock.advance(0)
    expect(ran).toHaveLength(2)
    expect(script.a).toEqual([])
  })

  it('resolves whenIdle once no touched chat has work, but not while one backs off', async () => {
    const { clock, queue } = scriptedQueue({ a: [{ failed: 'down' }, 'done'] }, { debounceMs: 0 })
    let idle = false
    await queue.whenIdle()
    queue.touch('a')
    void queue.whenIdle().then(() => (idle = true))
    await clock.advance(500)
    expect(idle).toBe(false)
    await clock.advance(500)
    expect(idle).toBe(true)
  })

  it('never commits after close, and close releases waiters and timers', async () => {
    const clock = fakeClock()
    let finish = () => {}
    let committed = false
    const queue = openJobQueue<string>({
      find: () => 'job',
      work: () => new Promise((resolve) => (finish = () => resolve(() => ((committed = true), 'done')))),
      debounceMs: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
      now: clock.now,
      timers: clock.timers,
    })
    queue.touch('a')
    await clock.advance(0)
    const idle = queue.whenIdle()
    queue.close()
    await idle
    finish()
    await clock.advance(10)
    expect(committed).toBe(false)
    queue.touch('a')
    expect(clock.pendingCount()).toBe(0)
  })
})
