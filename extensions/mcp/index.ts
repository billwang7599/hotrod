// MCP servers: connects the user's MCP servers (GitHub, Linear, a local filesystem server, …) to their chats, on every
// engine, with Kothar as the only MCP client. Each server's tools are relayed through Kothar's own MCP server, named
// <server>__<tool>, so engines see only Kothar's server: pi works as the others do, secrets stay in Kothar, and
// every call is checked (Kothar's permission card, or the server's "allow" setting) and recorded in the Activity.
//
// Which servers a chat gets: those switched on, on for its space (all spaces or chosen ones), and not switched off for
// the chat. A change counts from the chat's next message, since each message's session lists its tools once.
import type { ChatDetail, ChatSummary, Extension, ExtensionContext, ExtensionHost, ExtensionTool, ExtensionView, McpToolResult } from '@kothar/extension-api'
import { mergedCatalog, parseCatalog, type CatalogEntry } from './catalog.ts'
import { openClients, type Clients } from './clients.ts'
import { relayedName } from './names.ts'
import { pageAction, renderPage, type PageState } from './settings-view.ts'
import { openStore, type CachedTool, type ServerConfig, type Store } from './store.ts'

export const EXTENSION_ID = 'mcp'
// Each chat's servers switched off for it alone, in its own folder (so it goes with the chat).
export const CHAT_OFF_FILE = 'servers-off.json'
// What a permission request for a relayed tool is called, as the card shows it: MCP <server id>/<tool>.
const REQUEST = /^MCP ([a-z0-9][a-z0-9_-]*)\/(.+)$/

export type McpOptions = { shell?: string; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch }

export type McpExtension = Extension & {
  state(): { store?: Store; clients?: Clients }
  // Switches servers off for one chat alone (the chat's MCP tab), from its next message.
  setChatOff(chatId: string, serverIds: string[]): void
}

export function createMcpExtension(options: McpOptions = {}): McpExtension {
  let host: ExtensionHost | undefined
  let store: Store | undefined
  let clients: Clients | undefined
  let values: ExtensionContext['values'] = {}
  // What the Settings page shows between renders, and the remote catalog's entries once read.
  const page: PageState = { query: '' }
  let remote: CatalogEntry[] = []
  let remoteFrom = ''
  // Servers being listed for the first time, so each starts once.
  const warming = new Set<string>()

  const open = (context: ExtensionContext) => {
    host = context.host
    values = context.values
    void loadRemote(context.values)
    if (store) return
    store = openStore(context.host.storage.dir)
    clients = openClients({
      store,
      now: () => context.host.now().getTime(),
      record: (event) => host?.activity(event),
      idleMs: () => Math.max(1, Number(values.idleMinutes ?? 10)) * 60_000,
      shell: options.shell ?? process.env.SHELL ?? '/bin/zsh',
      ...(options.sleep && { sleep: options.sleep }),
      toolsChanged: () => host?.refresh(),
      statusChanged: () => host?.refresh(),
    })
  }

  // The remote catalog (the Catalog address setting), read once per address; a bad one adds nothing.
  const loadRemote = async (settings: ExtensionContext['values']) => {
    const address = String(settings.catalogUrl ?? '').trim()
    if (address === remoteFrom) return
    remoteFrom = address
    remote = []
    if (!/^https:\/\//.test(address)) return
    try {
      const response = await (options.fetch ?? fetch)(address, { signal: AbortSignal.timeout(15_000) })
      if (response.ok) remote = parseCatalog(await response.text())
    } catch {
      // The bundled catalog still shows.
    }
    host?.refresh()
  }
  const catalog = () => mergedCatalog(remote)
  const pageDeps = () => ({ store: store!, clients: clients!, catalog, host: host! })

  const spaceIdOf = (chatId: string) => {
    try {
      return host?.space(chatId)?.id
    } catch {
      return undefined
    }
  }
  const offFor = (chatId: string): string[] => {
    try {
      const saved: unknown = JSON.parse(host?.chatStorage(chatId).read(CHAT_OFF_FILE) ?? '[]')
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }
  // A worker follows its lead's per-chat switches as well as its own.
  const chatOff = (chat: ChatSummary) => [...offFor(chat.id), ...(chat.parentId ? offFor(chat.parentId) : [])]
  const onInSpace = (server: ServerConfig, spaceId: string | undefined) =>
    server.spaces === 'all' || (spaceId !== undefined && server.spaces.includes(spaceId))
  const serversFor = (chat: ChatSummary) => {
    if (!store) return []
    const off = chatOff(chat)
    const spaceId = spaceIdOf(chat.id)
    return store.servers().filter((server) => server.enabled && onInSpace(server, spaceId) && !off.includes(server.id))
  }

  const setOff = (chatId: string, serverIds: string[]) =>
    host?.chatStorage(chatId).write(CHAT_OFF_FILE, `${JSON.stringify([...new Set(serverIds)])}\n`)
  // The servers on for the chat's space, whether or not the chat switched them off.
  const serversInSpace = (chat: ChatSummary) => {
    const spaceId = spaceIdOf(chat.id)
    return store?.servers().filter((server) => server.enabled && onInSpace(server, spaceId)) ?? []
  }
  // The chat's MCP tab: each server on for its space, with a switch for this chat alone.
  const chatTab = (chat: ChatDetail): ExtensionView => {
    const off = chatOff(chat)
    return {
      type: 'stack',
      children: [
        {
          type: 'list',
          items: serversInSpace(chat).map((server) => {
            const isOff = off.includes(server.id)
            const status = clients!.status(server.id)
            return {
              key: server.id,
              label: server.name,
              dot: isOff ? ('faint' as const) : status.state === 'failed' ? ('error' as const) : status.state === 'needs-sign-in' ? ('warning' as const) : ('success' as const),
              detail: isOff ? 'Off for this chat' : `${clients!.tools(server.id).length} tools${status.state === 'needs-sign-in' ? ' · needs sign-in' : status.state === 'failed' ? ' · failed' : ''}`,
              button: isOff ? { label: 'Turn on here', action: { name: 'on', value: server.id } } : { label: 'Turn off here', action: { name: 'off', value: server.id } },
            }
          }),
        },
        {
          type: 'text',
          small: true,
          tone: 'muted',
          text: 'Counts from your next message; a tool switched off is refused at once. Add servers and keys in Settings → Extensions → MCP servers.',
        },
      ],
    }
  }

  const deny = (text: string): McpToolResult => ({ content: [{ type: 'text', text }], isError: true })

  const relayed = (server: ServerConfig, tool: CachedTool): ExtensionTool => ({
    name: relayedName(server.id, tool.name),
    description: `[${server.name}] ${tool.description ?? tool.annotations?.title ?? tool.name}`,
    inputSchema: tool.inputSchema,
    offered: () => true,
    result: 'mcp',
    async run(input, { caller }) {
      // Read again, so a server switched off or changed mid-turn isn't called with old settings.
      const current = store?.server(server.id)
      if (!current?.enabled || !serversFor(caller).some((s) => s.id === server.id)) {
        return deny(`${server.name} is switched off for this chat`)
      }
      const reads = tool.annotations?.readOnlyHint === true
      const answer = await host!.requestPermission(
        caller.id,
        { name: `MCP ${server.id}/${tool.name}`, summary: `${server.name}: ${tool.annotations?.title ?? tool.name}`, kind: 'mcp', input },
        { changes: !reads },
      )
      if (!answer.allow) return deny(answer.message ?? `The user didn't allow ${tool.name} on ${server.name}`)
      return clients!.call(current, tool.name, input, caller.id)
    },
  })

  return {
    id: EXTENSION_ID,
    name: 'MCP servers',
    description: 'Connect MCP servers (GitHub, Linear, a filesystem, …) to your chats, on every engine, through Kothar.',
    enabledByDefault: true,
    settings: [
      {
        key: 'idleMinutes',
        label: 'Stop an idle server after (minutes)',
        description: 'A server Kothar started stops when nothing has called it for this long, and starts again when needed.',
        type: 'number',
        default: 10,
        min: 1,
        max: 240,
        integer: true,
      },
      {
        key: 'catalogUrl',
        label: 'Catalog address',
        description: 'An https address of a catalog in the same JSON format as the built-in one, added to it. Leave blank for the built-in catalog only.',
        type: 'text',
        default: '',
      },
    ],
    settingsView: {
      render(context) {
        open(context)
        return renderPage(page, pageDeps())
      },
      async onAction(action, context) {
        open(context)
        await pageAction(action, page, pageDeps())
        context.host.refresh()
      },
    },
    panels: [
      {
        id: 'servers',
        title: 'MCP',
        shown: (chat) => !!store && serversInSpace(chat).length > 0,
        render: (chat) => chatTab(chat),
        onAction(action, chat, context) {
          open(context)
          const id = String(action.value ?? '')
          const off = offFor(chat.id)
          if (action.name === 'off') setOff(chat.id, [...off, id])
          if (action.name === 'on') setOff(chat.id, off.filter((other) => other !== id))
          context.host.refresh(chat.id)
        },
      },
    ],
    state: () => ({ store, clients }),
    setChatOff: (chatId, serverIds) => setOff(chatId, serverIds),

    onStart(context) {
      open(context)
    },
    onSettingsChanged(_changed, context) {
      values = context.values
      void loadRemote(context.values)
    },
    async onStop() {
      await clients?.stopAll()
    },
    onChatCreated(_chat, context) {
      open(context)
    },

    // Tools from the servers on for this chat, as each last listed them. A server never listed yet starts now, in
    // the background, so its tools are there from the chat's next message.
    toolsFor(caller, context) {
      open(context)
      return serversFor(caller).flatMap((server) => {
        const tools = clients!.tools(server.id)
        if (!tools.length && !warming.has(server.id) && !clients!.running(server.id) && clients!.status(server.id).state === 'stopped') {
          warming.add(server.id)
          void clients!
            .test(server)
            .catch(() => {})
            .finally(() => warming.delete(server.id))
        }
        return tools.map((tool) => relayed(server, tool))
      })
    },

    // A server's "allow" setting answers its own tools' requests: all of them, or the ones it marks read-only.
    onPermissionRequested(request) {
      const match = REQUEST.exec(request.name)
      const server = match && store?.server(match[1]!)
      if (!server || server.approval === 'ask') return undefined
      if (server.approval === 'all') return { allow: true }
      const tool = clients!.tools(server.id).find((t) => t.name === match![2])
      return tool?.annotations?.readOnlyHint === true ? { allow: true } : undefined
    },
  }
}

export default createMcpExtension()
