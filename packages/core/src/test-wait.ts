// One polling wait for tests, in the core and in extensions (`@kothar/core/test-wait`). Prefer an awaited event or a
// fake clock where a test has one; this is for the rest, where the only signal is state that changes later.

export type WaitOptions = {
  // How many times to check before giving up (default 400). Ignored when timeoutMs is set.
  tries?: number
  // How long to sleep between checks (default 5 ms).
  everyMs?: number
  // Give up after this long by the clock instead of after a number of tries.
  timeoutMs?: number
  // What the test is waiting for, put in the timeout message.
  what?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Resolves once `check` returns true, checking again `everyMs` apart; throws if it still hasn't after the last try or
// once `timeoutMs` has passed. `check` may be async.
export async function until(
  check: () => boolean | Promise<boolean>,
  { tries = 400, everyMs = 5, timeoutMs, what }: WaitOptions = {},
): Promise<void> {
  const start = performance.now()
  const more = (tried: number) => (timeoutMs === undefined ? tried < tries : performance.now() - start <= timeoutMs)
  for (let tried = 0; more(tried); tried++) {
    if (await check()) return
    await sleep(everyMs)
  }
  if (await check()) return
  const limit = timeoutMs === undefined ? `${tries} checks ${everyMs} ms apart` : `${timeoutMs} ms`
  throw new Error(`Timed out after ${limit}${what ? ` waiting for ${what}` : ''}`)
}
