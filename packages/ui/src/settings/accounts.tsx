// The Accounts page: each engine's saved accounts, signing in, and API keys.
import { useState, type FormEvent } from 'react'
import type { Account, ClientMessage, EngineAccounts } from '@kothar/core/shared'
import { Button, confirm, ErrorText, GROUP, Select } from '../controls.tsx'
import { accountLabel, listedAccounts } from '../accounts.ts'
import { SettingRow } from './rows.tsx'

type EngineAccountsProps = { accounts: EngineAccounts; connected: boolean; send: (m: ClientMessage) => void }

export function EngineAccountsSection({ accounts, connected, send }: EngineAccountsProps) {
  const id = accounts.engine
  const login = accounts.login
  const listed = listedAccounts(accounts)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [keyName, setKeyName] = useState('')
  const [key, setKey] = useState('')
  const startLogin = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    send({ type: 'account.login', engine: id, name: name.trim() })
    setName('')
  }
  const submitCode = (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim()) return
    send({ type: 'account.code', engine: id, code: code.trim() })
    setCode('')
  }
  const addKey = (e: FormEvent) => {
    e.preventDefault()
    if (!keyName.trim() || !key.trim()) return
    send({ type: 'account.addApiKey', engine: id, name: keyName.trim(), key })
    setKeyName('')
    setKey('')
  }
  const remove = async (account: Account) => {
    const question =
      account.kind === 'apiKey'
        ? `Remove ${account.name} and delete its saved API key?`
        : `Sign out of ${account.name} and remove it from Kothar?`
    if (!(await confirm(question))) return
    send({ type: 'account.remove', engine: id, accountId: account.id })
  }
  const cancelLogin = (
    <Button disabled={!connected} onClick={() => send({ type: 'account.cancelLogin', engine: id })}>
      Cancel
    </Button>
  )

  return (
    <section className="flex flex-col not-first:pt-24" aria-label={`${id} accounts`}>
      <h3 className="pb-8 font-mono font-semibold">{id}</h3>
      <div className={GROUP}>
        {listed.accounts.map((a) => (
          <SettingRow
            key={a.id}
            name={accountLabel(a)}
            description={
              a.note ??
              (a.id === 'default' && (a.signedIn ? `Signed in through ${id} itself` : `No one is signed in to ${id} itself`))
            }
          >
            {a.id === listed.active ? (
              <span className="rounded-full bg-green/14 px-8 py-2 text-xs text-green">Active</span>
            ) : (
              <Button
                size="small"
                disabled={!connected}
                onClick={() => send({ type: 'account.use', engine: id, accountId: a.id })}
              >
                Use
              </Button>
            )}
            {a.id !== 'default' && (
              <Button size="small" variant="danger" disabled={!connected} onClick={() => remove(a)}>
                Remove
              </Button>
            )}
          </SettingRow>
        ))}
        {!login && accounts.providers ? (
          <ProviderAccountForm accounts={accounts} connected={connected} send={send} />
        ) : !login ? (
          <SettingRow name="Add account">
            <form className="flex min-w-0 gap-6" onSubmit={startLogin}>
              <input
                className="w-160"
                value={name}
                placeholder="Name, e.g. Work"
                onChange={(e) => setName(e.target.value)}
              />
              <Button variant="primary" disabled={!connected || !name.trim()}>
                Sign in…
              </Button>
            </form>
          </SettingRow>
        ) : login.error ? (
          <SettingRow name={<ErrorText>{login.error}</ErrorText>}>
            <Button onClick={() => send({ type: 'account.cancelLogin', engine: id })}>Dismiss</Button>
          </SettingRow>
        ) : login.adding ? (
          <SettingRow name={`Adding “${login.name}”…`}>{cancelLogin}</SettingRow>
        ) : accounts.providers ? (
          <SettingRow
            name={`Signing in “${login.name}”`}
            description={
              login.url && (
                <>
                  Open{' '}
                  <a className="text-accent underline" href={login.url} target="_blank" rel="noreferrer">
                    the sign-in page
                  </a>
                  {login.instructions ? ` and ${login.instructions.replace(/^Enter/, 'enter')}` : ''}
                </>
              )
            }
          >
            {cancelLogin}
          </SettingRow>
        ) : (
          <>
            <SettingRow name={`Signing in “${login.name}”`} description="Finish in the browser window that opened.">
              {!login.url && cancelLogin}
            </SettingRow>
            {login.url && login.noCode && (
              <SettingRow
                name={
                  <>
                    No window?{' '}
                    <a className="text-accent underline" href={login.url} target="_blank" rel="noreferrer">
                      Open the sign-in link
                    </a>
                  </>
                }
              >
                {cancelLogin}
              </SettingRow>
            )}
            {login.url && !login.noCode && (
              <SettingRow
                name="Paste a code"
                description={
                  <>
                    No window, or it is signed in to another account? Open{' '}
                    <a className="text-accent underline" href={login.url} target="_blank" rel="noreferrer">
                      this sign-in link
                    </a>{' '}
                    (a private window lets you pick the account), then paste the code it shows.
                  </>
                }
              >
                <form className="flex min-w-0 gap-6" onSubmit={submitCode}>
                  <input
                    className="w-120"
                    value={code}
                    placeholder="Code"
                    spellCheck={false}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <Button variant="primary" disabled={!connected || !code.trim()}>
                    Submit code
                  </Button>
                </form>
                {cancelLogin}
              </SettingRow>
            )}
          </>
        )}
        {accounts.apiKeys && !accounts.providers && (
          <SettingRow name="Add API key">
            <form className="flex min-w-0 gap-6" onSubmit={addKey}>
              <input
                className="w-120"
                value={keyName}
                placeholder="API key name"
                onChange={(e) => setKeyName(e.target.value)}
              />
              <input
                className="w-140"
                type="password"
                value={key}
                placeholder="API key"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button disabled={!connected || !keyName.trim() || !key.trim()}>Add</Button>
            </form>
          </SettingRow>
        )}
      </div>
    </section>
  )
}

// For engines that sign in to many providers: a name, the provider, how (when it offers more than one way), then a
// key or a browser sign-in.
function ProviderAccountForm({ accounts, connected, send }: EngineAccountsProps) {
  const id = accounts.engine
  const providers = accounts.providers ?? []
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState('')
  const [methodId, setMethodId] = useState('')
  const [key, setKey] = useState('')
  const provider = providers.find((p) => p.id === providerId)
  const methods = provider?.methods ?? []
  const method = methods.length === 1 ? methods[0] : methods.find((m) => m.id === methodId)
  const pickProvider = (value: string) => {
    setProviderId(value)
    setMethodId('')
  }
  const ready = connected && name.trim() !== '' && provider !== undefined && method !== undefined
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    const choice = { engine: id, name: name.trim(), provider: provider.id, method: method.id }
    if (method.kind === 'apiKey') {
      if (!key.trim()) return
      send({ type: 'account.addApiKey', ...choice, key })
    } else send({ type: 'account.login', ...choice })
    setName('')
    setKey('')
  }
  return (
    <SettingRow name="Add account">
      <form className="flex min-w-0 flex-wrap gap-6" onSubmit={submit}>
        <input className="w-140" value={name} placeholder="Name, e.g. Work" onChange={(e) => setName(e.target.value)} />
        <Select
          label="Provider"
          value={providerId}
          placeholder="Provider…"
          hint="The model provider this account signs in to"
          disabled={!connected || !providers.length}
          options={providers.map((p) => ({ value: p.id, label: p.name, group: p.group }))}
          onChange={pickProvider}
        />
        {methods.length > 1 && (
          <Select
            label="Sign-in method"
            value={methodId}
            placeholder="How…"
            disabled={!connected}
            options={methods.map((m) => ({ value: m.id, label: m.kind === 'apiKey' ? 'API key' : m.label }))}
            onChange={setMethodId}
          />
        )}
        {method?.kind === 'apiKey' && (
          <input
            className="w-140"
            type="password"
            value={key}
            placeholder="API key"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
          />
        )}
        <Button variant="primary" disabled={!ready || (method.kind === 'apiKey' && !key.trim())}>
          {method?.kind === 'apiKey' ? 'Add' : 'Sign in…'}
        </Button>
      </form>
    </SettingRow>
  )
}
