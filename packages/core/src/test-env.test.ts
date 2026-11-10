import type { TestContext } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { needs } from './test-env.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

// A stand-in context that records what it was asked to skip.
const contextOf = () => {
  const skipped: (string | undefined)[] = []
  const context = { skip: (reason?: string) => void skipped.push(reason) } as unknown as TestContext
  return { context, skipped }
}

describe('needs', () => {
  it('does nothing when every check passed', () => {
    vi.stubEnv('CI', 'true')
    const { context, skipped } = contextOf()
    expect(() => needs(context, undefined, undefined)).not.toThrow()
    expect(skipped).toEqual([])
  })

  it('skips with every reason off CI', () => {
    vi.stubEnv('CI', '')
    const { context, skipped } = contextOf()
    needs(context, "ps can't run here", undefined, "/tmp isn't writable here")
    expect(skipped).toEqual(["ps can't run here; /tmp isn't writable here"])
  })

  it('fails with the reason on CI instead of skipping', () => {
    vi.stubEnv('CI', 'true')
    const { context, skipped } = contextOf()
    expect(() => needs(context, "ps can't run here")).toThrow("This test can't run on CI: ps can't run here")
    expect(skipped).toEqual([])
  })
})
