// Settings → Extensions → MCP servers: the user's servers (status, on/off, what each runs, who may call its tools
// without asking, which spaces, its secrets, Test connection) and the catalog to add more from, or a custom server.
// What the page is showing (a search, a picked entry, an open server) lives here between renders.
import type { ExtensionAction, ExtensionHost, ExtensionListItem, ExtensionMenuItem, ExtensionTone, ExtensionView } from '@kothar/extension-api'
import { searched, serverFromEntry, serverFromForm, type CatalogEntry } from './catalog.ts'
import type { Clients, State } from './clients.ts'
import { hint, type Approval, type AuthKind, type ServerConfig, type Store } from './store.ts'

// Past this many tools across the servers that are on, the page warns: each is sent to the model every message.
export const MANY_TOOLS = 60

export type PageState = {
  query: string
  open?: string
  adding?: { entry: string; auth: AuthKind }
  custom?: boolean
  message?: { tone: ExtensionTone; text: string }
  busy?: string
}

export type PageDeps = {
  store: Store
  clients: Clients
  catalog: () => CatalogEntry[]
  host: ExtensionHost
  // Signs a remote server in with OAuth (oauth.ts), if Kothar can.
  signIn?: (server: ServerConfig) => Promise<void>
}

const TONES: Record<State, ExtensionTone> = { connected: 'success', starting: 'accent', stopped: 'faint', failed: 'error', 'needs-sign-in': 'warning' }
const WORDS: Record<State, string> = { connected: 'Running', starting: 'Starting', stopped: 'Starts when needed', failed: 'Failed', 'needs-sign-in': 'Needs sign-in' }
const APPROVALS: { value: Approval; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask each time', hint: 'Every call shows the permission card in the chat' },
  { value: 'reads', label: 'Allow read-only tools', hint: 'Tools the server marks read-only run without asking; the rest ask' },
  { value: 'all', label: 'Allow all its tools', hint: 'Nothing asks. Only for a server you trust with everything it can do' },
]

const act = (name: string, value?: ExtensionAction['value']): ExtensionAction => (value === undefined ? { name } : { name, value })
const spacesOf = (host: ExtensionHost) => host.chats().filter((chat) => !chat.parentId && !chat.extension && !chat.archived)

export function renderPage(state: PageState, deps: PageDeps): ExtensionView {
  const { store, clients } = deps
  const servers = store.servers()
  const children: ExtensionView[] = []
  if (state.message) children.push({ type: 'text', text: state.message.text, tone: state.message.tone })
  children.push({
    type: 'text',
    small: true,
    tone: 'muted',
    text:
      'Kothar connects to these servers itself and offers their tools to agents on every engine as its own, so your keys never reach an engine. ' +
      'Changes count from a chat’s next message; a tool switched off is refused at once.',
  })

  const on = servers.filter((server) => server.enabled)
  const tools = on.reduce((sum, server) => sum + clients.tools(server.id).length, 0)
  if (tools > MANY_TOOLS) {
    children.push({
      type: 'text',
      tone: 'warning',
      text: `${tools} tools from ${on.length} servers are offered to every chat that has them, and each tool's description is sent with every message. Switch off servers a space doesn't need, or limit them to some spaces, to save tokens.`,
    })
  }

  children.push({ type: 'heading', text: 'Your servers' })
  children.push({
    type: 'list',
    empty: 'None yet. Add one from the catalog below.',
    items: servers.map((server): ExtensionListItem => {
      const status = clients.status(server.id)
      const count = clients.tools(server.id).length
      const scope = server.spaces === 'all' ? 'all spaces' : `${server.spaces.length} space${server.spaces.length === 1 ? '' : 's'}`
      return {
        key: server.id,
        label: server.name,
        dot: server.enabled ? TONES[status.state] : 'faint',
        detail: server.enabled ? `${WORDS[status.state]} · ${count} tools · ${scope}` : `Off · ${count} tools`,
        badges: [{ text: server.official ? 'Official' : 'Community', tone: server.official ? 'success' : 'warning' }],
        selected: state.open === server.id,
        action: act(state.open === server.id ? 'close' : 'open', server.id),
      }
    }),
  })
  const open = servers.find((server) => server.id === state.open)
  if (open) children.push(serverCard(open, state, deps))

  children.push({ type: 'divider' })
  children.push({ type: 'heading', text: 'Add a server' })
  children.push({ type: 'search', key: 'catalog', value: state.query, placeholder: 'Search GitHub, Linear, Notion…', action: 'search', label: 'Search the catalog' })
  const adding = state.adding && deps.catalog().find((entry) => entry.id === state.adding!.entry)
  if (adding) children.push(addCard(adding, state.adding!.auth, deps))
  children.push({
    type: 'list',
    label: 'Catalog',
    empty: 'Nothing matches.',
    items: searched(deps.catalog(), state.query).map((entry) => ({
      key: entry.id,
      label: entry.name,
      detail: entry.description,
      badges: [
        { text: entry.publisher, tone: 'muted' },
        { text: entry.transport === 'stdio' ? 'Runs on your Mac' : 'Remote', tone: 'faint' },
        ...(entry.auth.kinds.includes('oauth') && !entry.auth.kinds.includes('token') ? [{ text: 'Sign-in', tone: 'faint' as const }] : []),
      ],
      selected: state.adding?.entry === entry.id,
      button: { label: 'Add', action: act('pick', entry.id) },
      ...(entry.docs && { link: { text: 'Docs', url: entry.docs } }),
    })),
  })
  children.push(
    state.custom
      ? customForm()
      : { type: 'button', label: 'Add a custom server', variant: 'ghost', action: act('custom') },
  )
  return { type: 'stack', children }
}

function serverCard(server: ServerConfig, state: PageState, deps: PageDeps): ExtensionView {
  const { clients, store, host } = deps
  const status = clients.status(server.id)
  const tools = clients.tools(server.id)
  const local = server.transport === 'stdio'
  const what = clients.describe(server)
  const secrets = store.secrets(server.id)
  const busy = state.busy === server.id
  const children: ExtensionView[] = [
    {
      type: 'row',
      children: [
        { type: 'badge', text: `${server.publisher ?? 'Unknown'} · ${server.official ? 'official' : 'community'}`, tone: server.official ? 'success' : 'warning' },
        { type: 'badge', text: server.enabled ? WORDS[status.state] : 'Off', tone: server.enabled ? TONES[status.state] : 'faint' },
      ],
    },
    { type: 'text', text: local ? 'Runs on your Mac, as you:' : 'Reaches:', small: true, tone: 'muted' },
    { type: 'code', text: what, maxLines: 4 },
  ]
  if (status.error) children.push({ type: 'text', text: status.error, tone: status.state === 'needs-sign-in' ? 'warning' : 'error', small: true })
  if (status.state === 'needs-sign-in' && server.auth === 'oauth' && !deps.signIn) {
    children.push({ type: 'text', small: true, tone: 'warning', text: 'Signing in to remote servers isn’t in Kothar yet. Use a token instead, if this server takes one.' })
  }
  const toggle: ExtensionView = server.enabled
    ? { type: 'button', label: 'Turn off', action: act('disable', server.id) }
    : {
        type: 'button',
        label: 'Turn on',
        variant: 'primary',
        action: act('enable', server.id),
        ...(local && {
          confirm: {
            text: `Run ${server.name} on your Mac?`,
            body: `Kothar will run this, as you, whenever an agent uses one of its tools:\n\n${what}\n\nPublisher: ${server.publisher ?? 'unknown'} (${server.official ? 'official' : 'community: not checked by its maker'}). Only turn on servers you trust.`,
            ok: 'Turn on',
          },
        }),
      }
  children.push({
    type: 'row',
    children: [
      toggle,
      { type: 'button', label: busy ? 'Testing…' : 'Test connection', disabled: busy, action: act('test', server.id) },
      ...(server.auth === 'oauth' && deps.signIn ? [{ type: 'button' as const, label: secrets.oauth ? 'Sign in again' : 'Sign in', action: act('signin', server.id) }] : []),
      ...(clients.running(server.id) ? [{ type: 'button' as const, label: 'Stop', variant: 'ghost' as const, action: act('stop', server.id) }] : []),
      ...(status.crashes > 0 || status.state === 'failed' ? [{ type: 'button' as const, label: 'Restart', variant: 'ghost' as const, action: act('restart', server.id) }] : []),
      {
        type: 'menu',
        label: `More for ${server.name}`,
        items: [
          ...APPROVALS.map((a): ExtensionMenuItem => ({ label: a.label, hint: a.hint, checked: server.approval === a.value, action: act('approval', { id: server.id, value: a.value }) })),
          { type: 'divider' },
          { label: 'All spaces', checked: server.spaces === 'all', action: act('scope', { id: server.id, space: '' }) },
          ...spacesOf(host).map((space): ExtensionMenuItem => ({
            label: space.name,
            checked: server.spaces !== 'all' && server.spaces.includes(space.id),
            action: act('scope', { id: server.id, space: space.id }),
          })),
          { type: 'divider' },
          {
            label: 'Remove',
            danger: true,
            action: act('remove', server.id),
            confirm: { text: `Remove ${server.name}?`, body: 'Its settings and saved keys are deleted.', ok: 'Remove', danger: true },
          },
        ],
      },
    ],
  })
  children.push({
    type: 'text',
    small: true,
    tone: 'muted',
    text: `${APPROVALS.find((a) => a.value === server.approval)!.label} · ${server.spaces === 'all' ? 'all spaces' : `only ${spacesOf(host).filter((s) => (server.spaces as string[]).includes(s.id)).map((s) => s.name).join(', ') || 'no spaces'}`} (change these in ⋯)`,
  })
  const secretNames = [...(server.secretEnv ?? []), ...(server.secretHeaders ?? [])]
  if (secretNames.length) {
    children.push({
      type: 'form',
      key: `secrets-${server.id}`,
      fields: secretNames.map((name) => ({
        name,
        label: name,
        placeholder: hint(secrets.env?.[name] ?? secrets.headers?.[name]) || 'Not set',
        hint: 'Leave blank to keep the saved one. Kept in a file only you can read, never sent to an engine.',
        mono: true,
      })),
      submit: { label: 'Save keys', action: `secrets:${server.id}` },
    })
  }
  if (tools.length) {
    children.push({
      type: 'card',
      title: `${tools.length} tools`,
      open: false,
      children: [
        {
          type: 'list',
          items: tools.map((tool) => ({
            key: tool.name,
            label: tool.name,
            mono: true,
            detail: tool.description?.split('\n')[0] ?? '',
            ...(tool.annotations?.readOnlyHint && { badges: [{ text: 'read-only', tone: 'muted' as const }] }),
          })),
        },
      ],
    })
  }
  return { type: 'card', title: server.name, open: true, children }
}

function addCard(entry: CatalogEntry, auth: AuthKind, deps: PageDeps): ExtensionView {
  const children: ExtensionView[] = [
    { type: 'row', children: [{ type: 'badge', text: `${entry.publisher} · ${entry.official ? 'official' : 'community'}`, tone: entry.official ? 'success' : 'warning' }] },
    { type: 'text', text: entry.description },
    {
      type: 'code',
      text: entry.transport === 'stdio' ? [entry.command, ...(entry.args ?? []), ...(entry.folders ? ['<your folders>'] : [])].join(' ') : `${entry.transport.toUpperCase()} ${entry.url}`,
      maxLines: 3,
    },
  ]
  if (entry.auth.kinds.length > 1) {
    children.push({
      type: 'row',
      children: entry.auth.kinds.map((kind) => ({
        type: 'button' as const,
        label: { none: 'No key', token: entry.auth.token?.label ?? 'Key', oauth: 'Sign in' }[kind],
        variant: kind === auth ? ('primary' as const) : ('normal' as const),
        action: act('auth', kind),
      })),
    })
  }
  if (auth === 'oauth' && !deps.signIn) {
    children.push({ type: 'text', tone: 'warning', small: true, text: 'Signing in to remote servers isn’t in Kothar yet, so this one will say it needs sign-in.' })
  }
  const fields = [
    ...(auth === 'token' && entry.auth.token
      ? [{ name: 'token', label: entry.auth.token.label, placeholder: 'Paste it here', mono: true, ...(entry.auth.token.help && { hint: entry.auth.token.help }) }]
      : []),
    ...(entry.folders ? [{ name: 'folders', label: 'Folders it may use (one path a line)', rows: 3, mono: true, placeholder: '/Users/you/Documents/notes' }] : []),
  ]
  children.push({
    type: 'form',
    key: `add-${entry.id}-${auth}`,
    fields,
    submit: { label: 'Add (off until you turn it on)', action: 'add' },
    cancel: { label: 'Cancel', action: act('cancelAdd') },
  })
  return { type: 'card', title: `Add ${entry.name}`, open: true, children }
}

const customForm = (): ExtensionView => ({
  type: 'card',
  title: 'Add a custom server',
  open: true,
  children: [
    {
      type: 'text',
      small: true,
      tone: 'muted',
      text: 'A command to run on your Mac (such as npx -y some-mcp-server), or the https address of a remote server (ending in /sse for an SSE one).',
    },
    {
      type: 'form',
      key: 'custom',
      fields: [
        { name: 'name', label: 'Name', placeholder: 'My server' },
        { name: 'target', label: 'Command or address', mono: true, placeholder: 'npx -y my-mcp-server   or   https://example.com/mcp' },
        { name: 'args', label: 'More arguments (one a line)', rows: 2, mono: true },
        { name: 'env', label: 'Environment (KEY=value a line)', rows: 2, mono: true },
        { name: 'secretEnv', label: 'Secret environment (KEY=value a line)', rows: 2, mono: true, hint: 'Kept in the secrets file' },
        { name: 'headers', label: 'Headers (Name: value a line)', rows: 2, mono: true },
        { name: 'secretHeaders', label: 'Secret headers (Name: value a line)', rows: 2, mono: true, hint: 'Such as Authorization: Bearer …' },
      ],
      submit: { label: 'Add (off until you turn it on)', action: 'addCustom' },
      cancel: { label: 'Cancel', action: act('cancelCustom') },
    },
  ],
})

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What each action on the page does. Returns once done; the caller draws the page again.
export async function pageAction(action: ExtensionAction, state: PageState, deps: PageDeps) {
  const { store, clients, host } = deps
  const value = action.value
  const id = typeof value === 'string' ? value : undefined
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  state.message = undefined
  const test = async (server: ServerConfig) => {
    state.busy = server.id
    host.refresh()
    try {
      const { tools } = await clients.test(server)
      state.message = { tone: 'success', text: `${server.name} answered with ${tools.length} tools: ${tools.slice(0, 8).map((t) => t.name).join(', ')}${tools.length > 8 ? '…' : ''}` }
    } catch (error) {
      state.message = { tone: 'error', text: `${server.name}: ${errorText(error)}` }
    } finally {
      state.busy = undefined
    }
  }
  const change = async (server: ServerConfig, update: Partial<ServerConfig>) => {
    store.put({ ...server, ...update })
    if (clients.running(server.id)) await clients.reset(server.id)
  }
  const named = (key: string | undefined) => (key ? store.server(key) : undefined)

  switch (action.name) {
    case 'search':
      state.query = typeof value === 'string' ? value : ''
      return
    case 'open':
      state.open = id
      return
    case 'close':
      state.open = undefined
      return
    case 'pick': {
      const entry = deps.catalog().find((e) => e.id === id)
      if (entry) state.adding = { entry: entry.id, auth: entry.auth.kinds[0]! }
      return
    }
    case 'auth':
      if (state.adding && (value === 'none' || value === 'token' || value === 'oauth')) state.adding.auth = value
      return
    case 'cancelAdd':
      state.adding = undefined
      return
    case 'custom':
      state.custom = true
      return
    case 'cancelCustom':
      state.custom = false
      return
    case 'add': {
      const entry = state.adding && deps.catalog().find((e) => e.id === state.adding!.entry)
      if (!entry) return
      try {
        const folders = String(record.folders ?? '').split('\n').map((f) => f.trim()).filter(Boolean)
        const made = serverFromEntry(entry, { auth: state.adding!.auth, token: String(record.token ?? ''), folders }, store.servers().map((s) => s.id), host.now())
        store.put(made.server)
        if (made.secrets) store.setSecrets(made.server.id, made.secrets)
        state.adding = undefined
        state.open = made.server.id
        state.message = { tone: 'normal', text: `Added ${made.server.name}. It's off until you turn it on.` }
        if (made.server.transport !== 'stdio' && made.server.auth !== 'oauth') await test(made.server)
      } catch (error) {
        state.message = { tone: 'error', text: errorText(error) }
      }
      return
    }
    case 'addCustom':
      try {
        const made = serverFromForm(record as Record<string, string>, store.servers().map((s) => s.id), host.now())
        store.put(made.server)
        store.setSecrets(made.server.id, made.secrets)
        state.custom = false
        state.open = made.server.id
        state.message = { tone: 'normal', text: `Added ${made.server.name}. Check what it runs, then turn it on.` }
      } catch (error) {
        state.message = { tone: 'error', text: errorText(error) }
      }
      return
    case 'enable':
    case 'disable': {
      const server = named(id)
      if (!server) return
      await change(server, { enabled: action.name === 'enable' })
      if (action.name === 'enable' && !clients.tools(server.id).length && server.auth !== 'oauth') await test({ ...server, enabled: true })
      return
    }
    case 'test': {
      const server = named(id)
      if (server) await test(server)
      return
    }
    case 'stop':
      if (id) await clients.stop(id)
      return
    case 'restart':
      if (id) await clients.reset(id)
      return
    case 'signin': {
      const server = named(id)
      if (!server || !deps.signIn) return
      try {
        await deps.signIn(server)
        await clients.reset(server.id)
        await test(server)
      } catch (error) {
        state.message = { tone: 'error', text: `Signing in to ${server.name} failed: ${errorText(error)}` }
      }
      return
    }
    case 'approval': {
      const server = named(String(record.id ?? ''))
      const approval = record.value
      if (server && (approval === 'ask' || approval === 'reads' || approval === 'all')) store.put({ ...server, approval })
      return
    }
    case 'scope': {
      const server = named(String(record.id ?? ''))
      const space = String(record.space ?? '')
      if (!server) return
      if (!space) return store.put({ ...server, spaces: 'all' })
      const now = server.spaces === 'all' ? [] : server.spaces
      const next = now.includes(space) ? now.filter((s) => s !== space) : [...now, space]
      store.put({ ...server, spaces: next })
      return
    }
    case 'remove':
      if (!id) return
      await clients.reset(id)
      store.remove(id)
      if (state.open === id) state.open = undefined
      return
    default:
      if (action.name.startsWith('secrets:')) {
        const server = named(action.name.slice('secrets:'.length))
        if (!server) return
        const given = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
        const env = Object.fromEntries(given.filter(([name]) => server.secretEnv?.includes(name)).map(([n, v]) => [n, v.trim()]))
        const headers = Object.fromEntries(given.filter(([name]) => server.secretHeaders?.includes(name)).map(([n, v]) => [n, v.trim()]))
        const saved = store.secrets(server.id)
        store.setSecrets(server.id, { env: { ...saved.env, ...env }, headers: { ...saved.headers, ...headers } })
        if (clients.running(server.id)) await clients.reset(server.id)
        state.message = { tone: 'success', text: given.length ? `Saved ${given.length} key${given.length === 1 ? '' : 's'} for ${server.name}.` : 'Nothing changed.' }
      }
  }
}
