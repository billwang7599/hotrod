import type { Extension, ExtensionAccount } from '@kothar/extension-api'

// Sent when the turn had already done some of the work, so the new account picks up instead of starting over.
export const CONTINUE_PROMPT =
  'Your previous turn stopped because the account hit its usage limit, and Kothar switched accounts. Check what ' +
  'you already finished (files, commands, replies above) and continue the task from where you left off. Don’t redo ' +
  'finished work.'

// How long an account counts as limited when its engine doesn't say when the limit resets.
export const UNKNOWN_RESET_MS = 60 * 60_000

export const resetText = (at: number, now: number) => {
  const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time
  return `${new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`
}

// Names or ids, one per line or comma-separated, in the order to rotate through. Blank: every account, as listed.
function ringOf(accounts: ExtensionAccount[], picked: string) {
  const wanted = picked.split(/[\n,]/).map((name) => name.trim().toLowerCase()).filter(Boolean)
  const signedIn = accounts.filter((account) => account.signedIn !== false)
  if (!wanted.length) return signedIn
  const named = wanted.map((want) => signedIn.find((a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want))
  return [...new Set(named.filter((account) => account !== undefined))]
}

export function createAccountRotation(now = () => Date.now()): Extension {
  // `${engine}\n${account}` → when its limit lifts, in ms.
  const limitedUntil = new Map<string, number>()
  const keyOf = (engine: string, account: string) => `${engine}\n${account}`

  return {
    id: 'account-rotation',
    name: 'Account rotation',
    description:
      'When a turn hits its account’s usage limit, switch the engine to the next saved account and carry on: the ' +
      'agent continues from where it stopped, or gets the message again if it hadn’t started. Accounts that hit their limit are skipped until it resets. The switch is for every chat.',
    enabledByDefault: false,
    settings: [
      {
        key: 'accounts',
        label: 'Accounts to rotate through',
        description:
          'Account names from Settings → Accounts, one per line, in the order to try them. Blank: every signed-in ' +
          'account, in the order listed there.',
        type: 'text',
        default: '',
        rows: 3,
      },
    ],
    onLimitReached({ account: limitedId, ...limit }, { values, host }) {
      const saved = host.accounts(limit.engine)
      if (!saved || limitedId === undefined) return
      // Narrowed for the closures below.
      const account = limitedId
      const at = now()
      const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
      limitedUntil.set(keyOf(limit.engine, account), Number.isFinite(resets) ? resets : at + UNKNOWN_RESET_MS)
      const until = (account: ExtensionAccount) => limitedUntil.get(keyOf(limit.engine, account.id)) ?? 0
      const free = (account: ExtensionAccount) => until(account) <= at
      const nameOf = (id: string) => saved.accounts.find((a) => a.id === id)?.name ?? id
      // On engines with providers, only an account of the same provider can run the chat's model. One whose provider
      // isn't known (the engine's own login) may hold any.
      const provider = saved.accounts.find((a) => a.id === account)?.provider
      const runs = (a: ExtensionAccount) => a.id === account || !provider || !a.provider || a.provider === provider
      const ring = ringOf(saved.accounts, String(values.accounts ?? '')).filter(runs)
      const chatId = limit.chat.id

      // Another chat may have switched already; then this one follows.
      const active = ring.find((a) => a.id === saved.active)
      const from = ring.findIndex((a) => a.id === account)
      const next =
        active && active.id !== account && free(active)
          ? active
          : ring.map((_, i) => ring[(from + 1 + i) % ring.length]!).find((a) => a.id !== account && free(a))
      if (!next) {
        const others = ring.filter((a) => a.id !== account)
        const limited = `${nameOf(account)} hit its usage limit`
        if (!others.length) return host.note(chatId, `${limited}, and there's no other account to switch to`)
        const first = Math.min(...[account, ...others.map((a) => a.id)].map((id) => until({ id, name: id })))
        return host.note(
          chatId,
          `Every account in the rotation has hit its usage limit. The first resets at ${resetText(first, at)}.`,
        )
      }
      if (next.id !== saved.active) host.useAccount(limit.engine, next.id)
      const switched = `${nameOf(account)} hit its usage limit, switched to ${next.name}`
      if (!limit.output) {
        host.note(chatId, switched)
        return host.retry(chatId)
      }
      host.note(chatId, `${switched} and continued`)
      host.continue(chatId, CONTINUE_PROMPT)
    },
  }
}

export default createAccountRotation()
