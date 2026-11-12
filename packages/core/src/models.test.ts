import { describe, expect, it } from 'vitest'
import type { Chat } from './chat.ts'
import { followModels, nameModels } from './models.ts'
import type { ChatInfo, Run } from './shared.ts'

describe('nameModels', () => {
  it('names Claude models, drops dated snapshots and keeps each provider together, newest first', () => {
    const named = nameModels({
      installed: true,
      signedIn: true,
      models: ['claude-sonnet-4-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'other/model', 'claude-opus-4'],
      defaultModel: 'claude-haiku-4-5-20251001',
    })
    expect(named.models?.map((m) => m.label)).toEqual(['Opus 5.5', 'Opus 4', 'Sonnet 4.5', 'other/model'])
    // A default that was dropped falls back to the first model.
    expect(named.defaultModel).toBe('claude-opus-5-5')
  })
})

describe('followModels', () => {
  const chatOf = (info: Partial<ChatInfo>, status: Chat['status'] = 'idle', shownRun?: string) =>
    ({ info: { id: 'c', name: 'c', folders: [], files: [], engine: 'a', archived: false, createdAt: '', ...info }, status, shownRun }) as Chat

  it('moves an idle chat that follows its list to the engine the list picks, and reshows any other whose run changed', () => {
    const run: Run = { engine: 'b', model: 'm' }
    const moved: string[] = []
    const shown: string[] = []
    const deps = {
      runOf: () => run,
      setEngine: (chat: Chat, engine: string) => void moved.push(`${chat.info.name}->${engine}`),
      showRun: (chat: Chat) => void shown.push(chat.info.name),
    }
    followModels(
      [
        chatOf({ name: 'follows' }),
        chatOf({ name: 'pinned', model: 'x' }),
        chatOf({ name: 'busy' }, 'running'),
        chatOf({ name: 'same', model: 'x' }, 'idle', JSON.stringify(run)),
      ],
      deps,
    )
    expect(moved).toEqual(['follows->b'])
    expect(shown).toEqual(['pinned', 'busy'])
  })
})
