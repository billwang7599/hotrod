import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, Adapter, CoreMessage, EngineAccounts, LoginFlow, Machine } from './shared.ts'

const DEFAULT_ID = 'default'
const MAX_NAME_CHARS = 60

type Engine = {
  adapter: Adapter & { accounts: NonNullable<Adapter['accounts']> }
  state: EngineAccounts
  login?: { flow?: LoginFlow; dir: string }
}

export function openAccounts(options: {
  garage: string
  adapters: Adapter[]
  machine: Machine
  broadcast: (message: CoreMessage) => void
  isBusy: (engine: string) => boolean
}) {
  const { garage, machine, broadcast, isBusy } = options
  const root = join(garage, 'accounts')
  const savedFile = (engine: string) => join(root, `${engine}.json`)
  const dirOf = (engine: string, id: string) => join(root, engine, id)
  const keyFile = (dir: string) => join(dir, 'api-key')
  const engines = new Map<string, Engine>()

  for (const adapter of options.adapters) {
    if (!adapter.accounts) continue
    const file = savedFile(adapter.id)
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { active: DEFAULT_ID, accounts: [] }
    const accounts: Account[] = [{ id: DEFAULT_ID, name: 'Default', kind: 'login' }, ...saved.accounts]
    const active = accounts.some((a) => a.id === saved.active) ? saved.active : DEFAULT_ID
    const state = { engine: adapter.id, active, apiKeys: adapter.accounts.apiKeys === true, accounts }
    engines.set(adapter.id, { adapter: { ...adapter, accounts: adapter.accounts }, state })
  }

  const update = (engine: Engine, change: Partial<EngineAccounts>, persist = false) => {
    engine.state = { ...engine.state, ...change }
    if (persist) {
      mkdirSync(root, { recursive: true })
      const accounts = engine.state.accounts
        .filter((a) => a.id !== DEFAULT_ID)
        .map(({ id, name, kind, label }) => ({ id, name, kind, label }))
      const saved = { active: engine.state.active, accounts }
      writeFileSync(savedFile(engine.state.engine), JSON.stringify(saved, null, 2) + '\n')
    }
    broadcast({ type: 'accounts.updated', accounts: engine.state })
  }

  const engineFor = (id: string) => {
    const engine = engines.get(id)
    if (!engine) throw new Error(`Engine "${id}" has no accounts`)
    return engine
  }

  const accountFor = (engine: Engine, id: string) => {
    const account = engine.state.accounts.find((a) => a.id === id)
    if (!account) throw new Error(`Unknown account "${id}"`)
    return account
  }

  const checkIdle = (engine: Engine) => {
    if (isBusy(engine.state.engine)) throw new Error('Wait for the running turn to end before switching accounts')
  }

  const newAccountDir = (engine: Engine, rawName: string) => {
    const name = rawName.trim().slice(0, MAX_NAME_CHARS)
    if (!name) throw new Error('Give the account a name')
    const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '') || 'account'
    const engineDir = join(root, engine.state.engine)
    mkdirSync(engineDir, { recursive: true })
    const ids = [...engine.state.accounts.map((a) => a.id), ...readdirSync(engineDir)]
    const taken = new Set(ids.map((id) => id.toLowerCase()))
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    const dir = dirOf(engine.state.engine, id)
    mkdirSync(dir, { mode: 0o700 })
    return { id, name, dir }
  }

  const login = (engine: Engine, rawName: string) => {
    if (!rawName.trim()) throw new Error('Give the account a name')
    if (engine.login?.flow) throw new Error('A sign-in is already running for this engine')
    if (engine.login) cancelLogin(engine)
    const { id, name, dir } = newAccountDir(engine, rawName)

    const attempt: NonNullable<Engine['login']> = { dir }
    const current = () => engine.login === attempt && attempt.flow !== undefined
    const fail = (error: string) => {
      attempt.flow = undefined
      rmSync(dir, { recursive: true, force: true })
      update(engine, { login: { ...engine.state.login!, error } })
    }
    engine.login = attempt
    update(engine, { login: { name } })
    attempt.flow = engine.adapter.accounts.login(machine, dir, (event) => {
      if (!current()) return
      if (event.type === 'url') return update(engine, { login: { ...engine.state.login!, url: event.url } })
      if (event.type === 'failed') return fail(event.error)
      void engine.adapter.accounts
        .status(machine, dir)
        .catch(() => ({ signedIn: false }) as const)
        .then((status) => {
          if (!current()) return
          if (!status.signedIn) return fail('The sign-in finished, but the account is not signed in')
          engine.login = undefined
          const label = status.label && { label: status.label }
          const account: Account = { id, name, kind: 'login', ...label, signedIn: true }
          update(engine, { accounts: [...engine.state.accounts, account], login: undefined }, true)
        })
    })
  }

  const addApiKey = (engine: Engine, rawName: string, rawKey: string) => {
    if (!engine.state.apiKeys) throw new Error(`${engine.state.engine} doesn't take API keys`)
    const key = rawKey.trim()
    if (!key) throw new Error('Paste the API key')
    if (/\s/.test(key)) throw new Error('An API key has no spaces or line breaks')
    const { id, name, dir } = newAccountDir(engine, rawName)
    writeFileSync(keyFile(dir), key, { mode: 0o600 })
    const account: Account = { id, name, kind: 'apiKey', label: `API key ••••${key.slice(-4)}`, signedIn: true }
    update(engine, { accounts: [...engine.state.accounts, account] }, true)
  }

  const cancelLogin = (engine: Engine) => {
    const attempt = engine.login
    if (!attempt) return
    engine.login = undefined
    attempt.flow?.cancel()
    rmSync(attempt.dir, { recursive: true, force: true })
    update(engine, { login: undefined })
  }

  const remove = (engine: Engine, id: string, reply: (message: CoreMessage) => void) => {
    if (id === DEFAULT_ID) throw new Error("The default account is the engine's own login and can't be removed here")
    const account = accountFor(engine, id)
    if (engine.state.active === id) checkIdle(engine)
    const dir = dirOf(engine.state.engine, id)
    const logout = account.kind === 'apiKey' ? Promise.resolve() : engine.adapter.accounts.logout(machine, dir)
    void logout
      .catch((error) => reply({ type: 'error', message: `Could not sign out of "${id}": ${error}` }))
      .finally(() => {
        rmSync(dir, { recursive: true, force: true })
        const active = engine.state.active === id ? DEFAULT_ID : engine.state.active
        update(engine, { active, accounts: engine.state.accounts.filter((a) => a.id !== id) }, true)
      })
  }

  return {
    list: () => [...engines.values()].map((engine) => engine.state),
    sessionFor(engine: string): { accountDir?: string; apiKey?: string } {
      const state = engines.get(engine)?.state
      const account = state?.accounts.find((a) => a.id === state.active)
      if (!account || account.id === DEFAULT_ID) return {}
      const accountDir = dirOf(engine, account.id)
      if (account.kind !== 'apiKey') return { accountDir }
      return { accountDir, apiKey: readFileSync(keyFile(accountDir), 'utf8') }
    },
    async refresh() {
      await Promise.all(
        [...engines.values()].map(async (engine) => {
          const statuses = new Map(
            await Promise.all(
              engine.state.accounts.map(async (account) => {
                const dir = account.id === DEFAULT_ID ? undefined : dirOf(engine.state.engine, account.id)
                if (account.kind === 'apiKey') return [account.id, { signedIn: existsSync(keyFile(dir!)) }] as const
                const status = await engine.adapter.accounts.status(machine, dir).catch(() => ({ signedIn: false }))
                return [account.id, status] as const
              }),
            ),
          )
          update(engine, { accounts: engine.state.accounts.map((a) => ({ ...a, ...statuses.get(a.id) })) })
        }),
      )
    },
    login: (engine: string, name: string) => login(engineFor(engine), name),
    submitCode(engine: string, code: string) {
      const flow = engineFor(engine).login?.flow
      if (!flow) throw new Error('No sign-in is waiting for a code')
      if (!code.trim()) throw new Error('Paste the code from the sign-in page')
      flow.submitCode(code)
    },
    addApiKey: (engine: string, name: string, key: string) => addApiKey(engineFor(engine), name, key),
    cancelLogin: (engine: string) => cancelLogin(engineFor(engine)),
    use(engineId: string, id: string) {
      const engine = engineFor(engineId)
      accountFor(engine, id)
      if (engine.state.active === id) return
      checkIdle(engine)
      update(engine, { active: id }, true)
    },
    remove: (engine: string, id: string, reply: (message: CoreMessage) => void) => remove(engineFor(engine), id, reply),
  }
}
