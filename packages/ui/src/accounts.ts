// How an engine's saved accounts are named and listed in the account pickers.
import type { Account, EngineAccounts } from '@kothar/core/shared'

/** An account's name in a picker, with who it's signed in as, or why it can't be used. */
export function accountLabel(account: Account) {
  if (account.id === 'default') return (account.signedIn && account.label) || 'Not signed in'
  const missing = account.kind === 'apiKey' ? 'key file missing' : 'signed out'
  if (account.signedIn === false) return `${account.name} (${missing})`
  return account.label ? `${account.name} (${account.label})` : account.name
}

export function listedAccounts({ active, accounts }: EngineAccounts) {
  const own = accounts.find((a) => a.id === 'default')
  // A label names the person signed in, except on engines with providers, where it names the provider.
  const sameLogin = (a: Account) =>
    a !== own && a.kind === 'login' && !a.provider && a.signedIn && a.label === own?.label
  const twin = own?.signedIn && own.label && accounts.find(sameLogin)
  if (!own || !twin) return { active, accounts }
  return { active: active === own.id ? twin.id : active, accounts: accounts.filter((a) => a !== own) }
}
