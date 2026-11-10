import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatDetail, ChatSummary, Extension, ExtensionAction, ExtensionHost, ExtensionListItem, ExtensionView } from '@kothar/extension-api'

// HTML an agent makes for the user: pages, mockups, small interactive apps, charts, diagrams. Notes are the user's own
// documents; artifacts are what agents build to be looked at. Agents make and update them with tools (nothing about
// artifacts goes into their prompts), and every update is a new version, the old ones kept.
//
// They're plain files in the space's chat folder, <garage>/chats/<space id>/artifacts/<slug>/: v1.html, v2.html… and
// artifact.json (title, kind, description, versions), so any of them opens in a browser outside Kothar. They show in a
// popup over the chat (⌘⇧A, or Artifacts in the sidebar), drawn in a sandboxed frame (the html panel view): scripts
// run, but the page can't reach Kothar, its token or the network.

export const KINDS = ['page', 'mockup', 'app', 'chart', 'diagram', 'other'] as const
export type ArtifactKind = (typeof KINDS)[number]
export type ArtifactVersion = { n: number; at: string; change?: string }
export type Artifact = {
  slug: string
  title: string
  kind: ArtifactKind
  description: string
  createdAt: string
  versions: ArtifactVersion[]
  // The space it belongs to, and its folder.
  spaceId: string
  dir: string
}

const DIR = 'artifacts'
const META = 'artifact.json'
const MAX_TITLE = 80
const MAX_DESCRIPTION = 200
// An artifact is one self-contained page; this keeps a runaway one from filling the disk or the panel.
export const MAX_HTML_BYTES = 2_000_000
// How many source lines the Source view shows.
const MAX_SOURCE_LINES = 20_000

const oneLine = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim()

export const slugOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

// A chat's space: the top of its chain (workers share their space's artifacts). An extension's own chat (Home) keeps
// no files, so it has none.
function spaceOf(host: ExtensionHost, chatId: string): ChatDetail | undefined {
  let chat = host.chat(chatId)
  for (let i = 0; chat?.parentId !== undefined && i < 32; i++) chat = host.chat(chat.parentId)
  return chat && !chat.extension ? chat : undefined
}

const rootOf = (host: ExtensionHost, spaceId: string) => join(host.chatStorage(spaceId).dir, DIR)

const fileOf = (version: number) => `v${version}.html`

function readMeta(dir: string, slug: string, spaceId: string): Artifact | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, META), 'utf8')) as Partial<Artifact>
    const versions = (Array.isArray(meta.versions) ? meta.versions : []).filter(
      (v): v is ArtifactVersion => typeof v?.n === 'number' && existsSync(join(dir, fileOf(v.n))),
    )
    if (!versions.length) return undefined
    return {
      slug,
      title: oneLine(meta.title) || slug,
      kind: KINDS.includes(meta.kind as ArtifactKind) ? (meta.kind as ArtifactKind) : 'other',
      description: oneLine(meta.description),
      createdAt: String(meta.createdAt ?? versions[0]!.at),
      versions: versions.sort((a, b) => a.n - b.n),
      spaceId,
      dir,
    }
  } catch {
    return undefined
  }
}

/** A space's artifacts, the latest changed first. */
export function artifactsIn(host: ExtensionHost, spaceId: string): Artifact[] {
  const root = rootOf(host, spaceId)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap((entry) => readMeta(join(root, entry.name), entry.name, spaceId) ?? [])
    .sort((a, b) => latest(b).at.localeCompare(latest(a).at) || a.title.localeCompare(b.title))
}

export const latest = (artifact: Artifact) => artifact.versions.at(-1)!

export const htmlOf = (artifact: Artifact, version = latest(artifact).n) => readFileSync(join(artifact.dir, fileOf(version)), 'utf8')

const writeMeta = (host: ExtensionHost, artifact: Artifact) => {
  const { title, kind, description, createdAt, versions } = artifact
  host.chatStorage(artifact.spaceId).write(`${DIR}/${artifact.slug}/${META}`, `${JSON.stringify({ title, kind, description, createdAt, versions }, null, 2)}\n`)
}

const checkHtml = (html: unknown) => {
  if (typeof html !== 'string' || !html.trim()) throw new Error('An artifact needs its html')
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error(`An artifact is at most ${MAX_HTML_BYTES / 1_000_000} MB of HTML`)
  return html
}

const needSpace = (host: ExtensionHost, chatId: string) => {
  const space = spaceOf(host, chatId)
  if (!space) throw new Error('Artifacts belong to a space, and this chat keeps none; make it in a space')
  return space
}

/** The artifact a tool names, by its name (slug) or its title, letter case aside. */
export function findArtifact(artifacts: Artifact[], name: unknown): Artifact {
  const wanted = oneLine(name).toLowerCase()
  const bySlug = artifacts.find((a) => a.slug === wanted)
  if (bySlug) return bySlug
  // Titles can repeat; a title that more than one has is refused rather than guessed.
  const titled = artifacts.filter((a) => a.title.toLowerCase() === wanted)
  if (titled.length > 1) throw new Error(`${titled.length} artifacts are titled "${oneLine(name)}": name one of ${titled.map((a) => a.slug).sort().join(', ')}`)
  const found = titled[0] ?? artifacts.find((a) => a.slug === slugOf(wanted))
  if (!found) throw new Error(`No artifact "${oneLine(name)}" in this space; list_artifacts lists them`)
  return found
}

export function createArtifact(
  host: ExtensionHost,
  chatId: string,
  input: { title?: unknown; html?: unknown; kind?: unknown; description?: unknown },
  now = new Date(),
): Artifact {
  const space = needSpace(host, chatId)
  const title = oneLine(input.title)
  if (!title) throw new Error('An artifact needs a title')
  if (title.length > MAX_TITLE) throw new Error(`An artifact's title is at most ${MAX_TITLE} characters`)
  const description = oneLine(input.description)
  if (description.length > MAX_DESCRIPTION) throw new Error(`An artifact's description is one line of at most ${MAX_DESCRIPTION} characters`)
  const html = checkHtml(input.html)
  const kind: ArtifactKind = KINDS.includes(input.kind as ArtifactKind) ? (input.kind as ArtifactKind) : 'other'
  // Two artifacts may share a title; each gets a folder of its own.
  const taken = new Set(artifactsIn(host, space.id).map((a) => a.slug))
  const root = rootOf(host, space.id)
  const base = slugOf(title) || 'artifact'
  let slug = base
  for (let i = 2; taken.has(slug) || existsSync(join(root, slug)); i++) slug = `${base}-${i}`
  const at = now.toISOString()
  const artifact: Artifact = { slug, title, kind, description, createdAt: at, versions: [{ n: 1, at }], spaceId: space.id, dir: join(root, slug) }
  host.chatStorage(space.id).write(`${DIR}/${slug}/${fileOf(1)}`, html)
  writeMeta(host, artifact)
  return artifact
}

export function updateArtifact(
  host: ExtensionHost,
  chatId: string,
  input: { artifact?: unknown; html?: unknown; change?: unknown },
  now = new Date(),
): Artifact {
  const space = needSpace(host, chatId)
  const artifact = findArtifact(artifactsIn(host, space.id), input.artifact)
  const html = checkHtml(input.html)
  const n = latest(artifact).n + 1
  const change = oneLine(input.change).slice(0, MAX_DESCRIPTION)
  host.chatStorage(space.id).write(`${DIR}/${artifact.slug}/${fileOf(n)}`, html)
  const updated = { ...artifact, versions: [...artifact.versions, { n, at: now.toISOString(), ...(change && { change }) }] }
  writeMeta(host, updated)
  return updated
}

export function removeArtifact(artifact: Artifact) {
  rmSync(artifact.dir, { recursive: true, force: true })
}

const listed = (artifact: Artifact) => ({
  name: artifact.slug,
  title: artifact.title,
  kind: artifact.kind,
  description: artifact.description,
  version: latest(artifact).n,
  updatedAt: latest(artifact).at,
  path: join(artifact.dir, fileOf(latest(artifact).n)),
})

// The command that opens a file in the user's default app (a browser, for .html).
export const openerFor = (platform: string, path: string): [string, string[]] =>
  platform === 'darwin' ? ['open', [path]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', path]] : ['xdg-open', [path]]

// What the popup shows per chat: the open artifact, the version picked (latest when absent) and how.
type PopupState = { open?: string; version?: number; source?: boolean }

const KIND_LABEL: Record<ArtifactKind, string> = { page: 'Page', mockup: 'Mockup', app: 'App', chart: 'Chart', diagram: 'Diagram', other: 'HTML' }

const toolDescription = {
  create:
    'Makes an artifact: a self-contained HTML page the user views in Kothar’s Artifacts window, such as a page, ' +
    'mockup, small interactive app, chart or diagram. Use it when the user asks for something to look at or play with, ' +
    'rather than pasting HTML into the reply. It runs in a sandbox: scripts work, but it has no network (no fetch, ' +
    'XHR or WebSocket) and, unless the user lets the space load from the web, no external scripts, styles, images or ' +
    'fonts, so inline all CSS and JS and use inline SVG or data: URLs. It can’t reach the user’s files or Kothar. ' +
    'Make one artifact per thing; change it later with update_artifact, which keeps the old versions. Returns its name.',
  update:
    'Saves a new version of an artifact in this space, by name (or title), with the whole new HTML; the earlier ' +
    'versions stay for the user to compare. change: one optional line on what changed. Same sandbox rules as ' +
    'create_artifact.',
  list: 'Lists this space’s artifacts: name, title, kind, description, latest version and its file.',
  read: 'Reads an artifact’s HTML, by name (or title): the latest version, or version.',
}

export function createArtifactsExtension({ platform = process.platform }: { platform?: string } = {}): Extension {
  const states = new Map<string, PopupState>()
  const stateOf = (chatId: string) => {
    let state = states.get(chatId)
    if (!state) states.set(chatId, (state = {}))
    return state
  }
  // A made or updated artifact is what the popup opens to, in the chat whose agent made it and in its space.
  const showNext = (host: ExtensionHost, chatId: string, artifact: Artifact) => {
    for (const id of new Set([chatId, artifact.spaceId])) states.set(id, { open: artifact.slug })
    host.refresh()
  }

  const row = (artifact: Artifact, open: string | undefined): ExtensionListItem => ({
    key: artifact.slug,
    label: artifact.title,
    detail: `v${latest(artifact).n}`,
    badges: [{ text: KIND_LABEL[artifact.kind], tone: 'muted' }],
    selected: artifact.slug === open,
    action: { name: 'open', value: artifact.slug },
    ...(artifact.description && { hint: artifact.description }),
  })

  const side = (artifacts: Artifact[], state: PopupState): ExtensionView => ({
    type: 'stack',
    gap: 'normal',
    children: [
      { type: 'heading', text: 'This space', hint: 'Made by this space’s agents; kept in its folder, gone when the space is' },
      {
        type: 'list',
        label: 'Artifacts',
        items: artifacts.map((a) => row(a, state.open)),
        empty: 'No artifacts yet. Ask an agent for a page, chart, mockup or small app.',
      },
      { type: 'divider' },
      {
        type: 'switch',
        setting: 'web',
        hint: 'Lets this space’s artifacts load scripts, styles, images and fonts from https: sites, such as a chart library. They still can’t fetch or send data.',
      },
    ],
  })

  const main = (artifact: Artifact | undefined, state: PopupState, web: boolean): ExtensionView => {
    if (!artifact) return { type: 'empty', text: 'Pick an artifact' }
    const shown = artifact.versions.find((v) => v.n === state.version) ?? latest(artifact)
    const path = join(artifact.dir, fileOf(shown.n))
    const html = htmlOf(artifact, shown.n)
    const versions: ExtensionView[] =
      artifact.versions.length > 1
        ? [
            {
              type: 'row',
              children: [
                { type: 'text', text: 'Version', tone: 'muted', small: true },
                ...artifact.versions.map(
                  (v): ExtensionView => ({
                    type: 'button',
                    label: `v${v.n}`,
                    variant: v.n === shown.n ? 'primary' : 'ghost',
                    action: { name: 'version', value: v.n },
                    hint: `${v.change ? `${v.change} · ` : ''}${new Date(v.at).toLocaleString()}`,
                  }),
                ),
              ],
            },
          ]
        : []
    return {
      type: 'stack',
      gap: 'normal',
      children: [
        {
          type: 'row',
          justify: 'between',
          children: [
            {
              type: 'row',
              children: [
                { type: 'heading', text: artifact.title, ...(artifact.description && { hint: artifact.description }) },
                { type: 'badge', text: KIND_LABEL[artifact.kind], tone: 'muted' },
              ],
            },
            {
              type: 'row',
              children: [
                { type: 'button', label: 'Preview', variant: state.source ? 'ghost' : 'primary', action: { name: 'mode', value: 'preview' } },
                { type: 'button', label: 'Source', variant: state.source ? 'primary' : 'ghost', action: { name: 'mode', value: 'source' } },
                {
                  type: 'button',
                  label: 'Open in browser',
                  variant: 'ghost',
                  action: { name: 'browser' },
                  hint: 'Opens this version’s file in your browser, outside Kothar’s sandbox: there it can reach the web',
                },
                { type: 'copy', text: html, label: 'Copy HTML' },
                { type: 'download', text: html, filename: `${artifact.slug}-v${shown.n}.html`, mimeType: 'text/html', label: 'Download' },
                {
                  type: 'button',
                  label: 'Delete',
                  variant: 'ghost',
                  action: { name: 'delete', value: artifact.slug },
                  confirm: {
                    text: `Delete the artifact "${artifact.title}"?`,
                    body: `All ${artifact.versions.length === 1 ? 'of it goes' : `${artifact.versions.length} versions go`}, for this space.`,
                    ok: 'Delete',
                    danger: true,
                  },
                },
              ],
            },
          ],
        },
        ...versions,
        { type: 'text', text: path, mono: true, small: true, tone: 'faint', copy: true, reveal: true },
        state.source
          ? { type: 'code', text: html, language: 'html', maxLines: MAX_SOURCE_LINES }
          : { type: 'html', html, label: artifact.title, web },
      ],
    }
  }

  return {
    id: 'artifacts',
    name: 'Artifacts',
    description:
      'HTML that agents make for you, such as pages, mockups, small apps, charts and diagrams, kept per space with every ' +
      'version and shown in a sandboxed window over the chat (⌘⇧A). Agents make them with tools; nothing goes into ' +
      'their prompts.',
    enabledByDefault: true,
    spaceSettings: [{ key: 'web', label: 'Load from the web', type: 'boolean', default: false }],
    tools: [
      {
        name: 'create_artifact',
        description: toolDescription.create,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: MAX_TITLE },
            html: { type: 'string', minLength: 1, description: 'A whole HTML document, self-contained' },
            kind: { type: 'string', enum: [...KINDS] },
            description: { type: 'string', maxLength: MAX_DESCRIPTION },
          },
          required: ['title', 'html'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const artifact = createArtifact(host, caller.id, input)
          host.note(caller.id, `Made the artifact “${artifact.title}”`, { panel: 'artifacts' })
          showNext(host, caller.id, artifact)
          return listed(artifact)
        },
      },
      {
        name: 'update_artifact',
        description: toolDescription.update,
        inputSchema: {
          type: 'object',
          properties: {
            artifact: { type: 'string', minLength: 1, description: 'Its name, as create_artifact or list_artifacts gave it' },
            html: { type: 'string', minLength: 1 },
            change: { type: 'string', maxLength: MAX_DESCRIPTION },
          },
          required: ['artifact', 'html'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const artifact = updateArtifact(host, caller.id, input)
          host.note(caller.id, `Updated the artifact “${artifact.title}” to v${latest(artifact).n}`, { panel: 'artifacts' })
          showNext(host, caller.id, artifact)
          return listed(artifact)
        },
      },
      {
        name: 'list_artifacts',
        description: toolDescription.list,
        inputSchema: { type: 'object', properties: {} },
        offered: () => true,
        run: (_input, { caller, host }) => artifactsIn(host, needSpace(host, caller.id).id).map(listed),
      },
      {
        name: 'read_artifact',
        description: toolDescription.read,
        inputSchema: {
          type: 'object',
          properties: { artifact: { type: 'string', minLength: 1 }, version: { type: 'integer', minimum: 1 } },
          required: ['artifact'],
        },
        offered: () => true,
        run({ artifact: name, version }, { caller, host }) {
          const artifact = findArtifact(artifactsIn(host, needSpace(host, caller.id).id), name)
          const n = version === undefined ? latest(artifact).n : Number(version)
          if (!artifact.versions.some((v) => v.n === n)) throw new Error(`"${artifact.title}" has versions 1 to ${latest(artifact).n}`)
          return `${artifact.title} (${artifact.slug}), v${n} of ${latest(artifact).n}\n\n${htmlOf(artifact, n)}`
        },
      },
    ],
    panels: [
      {
        id: 'artifacts',
        title: 'Artifacts',
        placement: 'popup',
        shortcut: 'Mod+Shift+A',
        sidebar: true,
        // Home keeps no files, so it has no artifacts.
        shown: (chat, { host }) => !!spaceOf(host, chat.id),
        render(chat, { host }) {
          const space = spaceOf(host, chat.id)
          if (!space) return { type: 'empty', text: 'Artifacts belong to a space' }
          const artifacts = artifactsIn(host, space.id)
          const state = stateOf(chat.id)
          // The newest opens first; one deleted elsewhere closes.
          const open = artifacts.find((a) => a.slug === state.open) ?? artifacts[0]
          if (open?.slug !== state.open) {
            state.open = open?.slug
            delete state.version
          }
          const web = host.spaceValues(chat.id).web === true
          return { type: 'split', side: side(artifacts, state), main: main(open, state, web) }
        },
        async onAction(action: ExtensionAction, chat, { host }) {
          const space = needSpace(host, chat.id)
          const state = stateOf(chat.id)
          const artifacts = artifactsIn(host, space.id)
          const named = (slug: unknown) => {
            const found = artifacts.find((a) => a.slug === slug)
            if (!found) throw new Error('That artifact is gone')
            return found
          }
          switch (action.name) {
            case 'open':
              state.open = named(action.value).slug
              delete state.version
              return
            case 'version':
              state.version = Number(action.value)
              return
            case 'mode':
              state.source = action.value === 'source'
              return
            case 'browser': {
              const artifact = named(state.open)
              const n = artifact.versions.find((v) => v.n === state.version)?.n ?? latest(artifact).n
              const [command, args] = openerFor(platform, join(artifact.dir, fileOf(n)))
              const { code, stderr } = await host.run(command, args, { timeoutMs: 10_000 })
              if (code !== 0) throw new Error(`Couldn’t open it in a browser${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
              return
            }
            case 'delete':
              removeArtifact(named(action.value))
              if (state.open === action.value) {
                delete state.open
                delete state.version
              }
              // Every chat of the space showing it draws again.
              host.refresh()
              return
            default:
              throw new Error(`Unknown action "${action.name}"`)
          }
        },
      },
    ],
    onChatRemoved(chat: ChatSummary) {
      states.delete(chat.id)
    },
  }
}

export default createArtifactsExtension()
