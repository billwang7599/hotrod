import { expect, it } from 'vitest'
import { until } from './test-wait.ts'

it('resolves once the check holds, sync or async', async () => {
  let calls = 0
  await until(() => ++calls === 3)
  expect(calls).toBe(3)
  let asyncCalls = 0
  await until(async () => ++asyncCalls === 2, { everyMs: 1 })
  expect(asyncCalls).toBe(2)
})

it('says what it waited for and for how long when it gives up', async () => {
  await expect(until(() => false, { tries: 3, everyMs: 1, what: 'the reply' })).rejects.toThrow(
    'Timed out after 3 checks 1 ms apart waiting for the reply',
  )
  await expect(until(() => false, { timeoutMs: 20, everyMs: 5 })).rejects.toThrow('Timed out after 20 ms')
})
