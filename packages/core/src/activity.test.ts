import type { ActivityEvent, Extension } from '@kothar/extension-api'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_SECTION_CHARS, checkedActivity, openActivity } from './activity.ts'
import { openExtensionHosts, type HostChat, type HostDeps } from './extension-host.ts'

const watcher: Extension = { id: 'w', name: 'Watcher', description: '', enabledByDefault: true, onActivity: () => {} }
const doer: Extension = { id: 'doer', name: 'Doer', description: '', enabledByDefault: true }

describe('the activity stream', () => {
  it('builds nothing when no extension watches, and stamps what it hands on', () => {
    const got: ActivityEvent[] = []
    let watching = false
    const chat = { info: { id: 'c1' }, sentTurn: 't1', status: 'running' }
    const activity = openActivity({
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      chat: (id) => (id === 'c1' ? chat : undefined),
      watchers: () => (watching ? [watcher] : []),
      deliver: (_extension, event) => got.push(event),
    })
    let built = 0
    activity.emit('c1', () => (built++, { kind: 'other', title: 'x' }))
    expect(built).toBe(0)
    expect(activity.listening('c1')).toBe(false)

    watching = true
    activity.emit('c1', () => ({ kind: 'model', title: 'Called', by: doer, sections: [{ label: 'Prompt', text: 'p'.repeat(ACTIVITY_SECTION_CHARS + 5) }] }))
    expect(got[0]).toMatchObject({ chatId: 'c1', turn: 't1', at: '2026-01-02T03:04:05.000Z', by: { extension: 'doer', name: 'Doer' }, kind: 'model' })
    expect(got[0]!.sections![0]!.text).toContain('(5 more characters)')
    activity.emit(undefined, () => ({ kind: 'account', title: 'Switched' }))
    expect(got[1]).toMatchObject({ by: { name: 'Kothar' } })
    expect(got[1]!.chatId).toBeUndefined()
  })

  it('checks an extension’s own event', () => {
    expect(() => checkedActivity({ kind: 'model', title: ' ' })).toThrow('needs a title')
    expect(() => checkedActivity({ kind: 'x' as ActivityEvent['kind'], title: 't' })).toThrow('Unknown activity kind')
  })

  it('lists an account switch an extension makes', () => {
    const emitted: { chatId?: string; title: string; by?: string }[] = []
    const used: string[] = []
    const unused = () => {
      throw new Error('not used')
    }
    const deps = new Proxy({} as HostDeps<HostChat>, {
      get: (_target, key) => {
        if (key === 'accounts') return { list: () => [], use: (engine: string, id: string) => used.push(`${engine}:${id}`) }
        if (key === 'activity')
          return {
            listening: () => true,
            emit: (chatId: string | undefined, build: () => { title: string; by?: Extension }) => {
              const event = build()
              emitted.push({ ...(chatId && { chatId }), title: event.title, ...(event.by && { by: event.by.id }) })
            },
          }
        if (key === 'garage') return '/tmp/nowhere'
        if (key === 'usesOf') return () => undefined
        if (key === 'run') return () => unused
        return unused
      },
    })
    const host = openExtensionHosts(deps).hostFor(doer)
    host.useAccount('claude-code', 'second')
    expect(used).toEqual(['claude-code:second'])
    expect(emitted).toEqual([{ title: 'Switched claude-code to the account second', by: 'doer' }])
  })
})
