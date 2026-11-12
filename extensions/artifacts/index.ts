import type {
  ChatDetail,
  ChatSummary,
  Extension,
  ExtensionAction,
  ExtensionHost,
  ExtensionListItem,
  ExtensionView,
} from '@kothar/extension-api'
import { diffLines } from './diff.ts'
import { opensInBrowser, previewOf, sourceLanguage } from './preview.ts'
import {
  addVersion,
  artifactsIn,
  contentOf,
  createArtifact,
  extensionOf,
  findArtifact,
  latest,
  MAX_DESCRIPTION,
  MAX_TITLE,
  MIME,
  needSpace,
  pathOf,
  removeArtifact,
  renameArtifact,
  spaceOf,
  TYPE_LABEL,
  TYPES,
  updateArtifact,
  type Artifact,
  type ArtifactVersion,
} from './store.ts'

// What agents make for the user to look at, use or keep, as Claude's artifacts are: web pages and small apps, React
// components, SVGs, Mermaid diagrams, Markdown documents and code files. Notes are the user's own documents; artifacts
// are what agents build. Every change is a new version, the old ones kept. A space's show in a panel docked beside the
// chat (and as a tab in the right sidebar), which opens by itself when an agent makes or changes one, and as a card in
// the transcript; every space's are in the library, a popup (⌘⇧A, or Artifacts in the sidebar). Pages draw in Kothar's sandboxed frame: scripts run, but nothing reaches Kothar, its token or the network.
// Everything is local: no links to share.

export { applyEdits, MAX_CONTENT_BYTES, slugOf } from './store.ts'
export { diffLines } from './diff.ts'

// Runtime errors a page reports, per version, kept until fixed, dismissed or Kothar restarts.
const MAX_ERRORS_KEPT = 200

// The command that opens a file in the user's default app (a browser, for .html).
export const openerFor = (platform: string, path: string): [string, string[]] =>
  platform === 'darwin' ? ['open', [path]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', path]] : ['xdg-open', [path]]

type Tab = 'preview' | 'code' | 'changes'

// What a view of artifacts shows: an artifact (by space and name) at a version (the latest when absent) and a tab, the
// search, and whether its title is being edited. The dock beside a chat keeps one per chat, with list: showing the
// space's list rather than an artifact. The library popup keeps one for every chat, with space: the space it's showing
// (all of them when absent).
type ViewState = {
  open?: { space: string; slug: string }
  version?: number
  tab: Tab
  query: string
  renaming: boolean
}
type DockState = ViewState & { list: boolean }
type LibraryState = ViewState & { space?: string }

const keyOf = (artifact: Pick<Artifact, 'spaceId' | 'slug'>) => `${artifact.spaceId}/${artifact.slug}`
const errorKey = (artifact: Artifact, n: number) => `${keyOf(artifact)}@${n}`
const isOpen = (state: ViewState, artifact: Artifact) => state.open !== undefined && keyOf(artifact) === `${state.open.space}/${state.open.slug}`

/** How long ago, briefly: just now, 5m, 3h, 2d, or the date. */
export function ago(at: string, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`
  return new Date(at).toLocaleDateString()
}

const toolDescription = {
  create:
    'Shows the user something to look at, use or keep in Kothar’s Artifacts panel beside the chat. Make one for ' +
    'self-contained content of more than about 15 lines that the user will view, change or reuse: a web page or small ' +
    'app, a React component, an SVG, a diagram, a document, or a whole code file. Reply inline instead for short ' +
    'answers, explanations and snippets. One artifact per thing; change it later with update_artifact (old versions are ' +
    'kept). type: html (a whole page; inline all CSS and JS), react (one component file whose default export is the ' +
    'app; only react can be imported; Tailwind classes work), svg, mermaid (the diagram source alone), markdown, or ' +
    'code (with language). It runs offline in a sandbox: no fetch or other network, and no external scripts, styles, ' +
    'images or fonts (use inline SVG or data: URLs). Returns its name.',
  update:
    'Saves a new version of an artifact in this space, by name (or title); the earlier ones stay. For a small change ' +
    'send edits: exact replacements { old, new }, each old text appearing once in the latest version. Otherwise send ' +
    'the whole new content. change: one short line on what changed. Same rules as create_artifact.',
  list: 'Lists this space’s artifacts: name, title, type, description, latest version and its file.',
  read: 'Reads an artifact’s content, by name (or title): the latest version, or version.',
}

const INSTRUCTIONS =
  'Artifacts: when the user wants something to look at, run or keep (a page, app, component, diagram, document or ' +
  'file of more than about 15 lines), make it with create_artifact rather than pasting it into your reply, then say ' +
  'in a line or two what you made. Change it with update_artifact, using edits for small changes. Short answers and ' +
  'snippets stay in the reply.'

// What the space's web switch allows, as html-frame.tsx's frameCsp does: https: joins the sources a page may load
// scripts, styles, images, fonts and media from; connect-src stays 'none'.
const WEB_HINT =
  'Lets artifact previews load scripts, styles, fonts, images and media from https: sites, such as a library from a ' +
  'CDN. They still can’t fetch data or open WebSockets, but each site they load from sees the request, and a page’s ' +
  'script could put data in the addresses it loads.'

const fresh = (): ViewState => ({ tab: 'preview', query: '', renaming: false })

export function createArtifactsExtension({ platform = process.platform }: { platform?: string } = {}): Extension {
  const docks = new Map<string, DockState>()
  const dockOf = (chatId: string) => {
    let state = docks.get(chatId)
    if (!state) docks.set(chatId, (state = { ...fresh(), list: false }))
    return state
  }
  // One library for every chat: it opens where the user left it, whichever chat they're in.
  const library: LibraryState = fresh()
  // Errors pages reported, by artifact and version, and the ones sent back to an agent to fix.
  const errors = new Map<string, string>()
  const sent = new Set<string>()
  const keepError = (key: string, error: string) => {
    if (errors.get(key) === error) return false
    errors.delete(key)
    errors.set(key, error)
    for (const old of [...errors.keys()].slice(0, Math.max(0, errors.size - MAX_ERRORS_KEPT))) errors.delete(old)
    return true
  }

  // Every space that can hold artifacts, for the library. Home keeps none, so it isn't one.
  const spaces = (host: ExtensionHost) => host.chats().filter((c) => c.parentId === undefined && !c.extension && !c.archived)

  // A made or updated artifact is what the dock opens to, in the chat whose agent made it and in its space, and the
  // dock slides in beside those chats, if the user is looking.
  const showNext = (host: ExtensionHost, chatId: string, artifact: Artifact) => {
    for (const id of new Set([chatId, artifact.spaceId])) {
      const state = dockOf(id)
      Object.assign(state, { open: { space: artifact.spaceId, slug: artifact.slug }, tab: 'preview', list: false, renaming: false })
      delete state.version
    }
    host.refresh()
    for (const id of new Set([chatId, artifact.spaceId])) host.showPanel(id, 'artifacts')
  }

  const noteFor = (host: ExtensionHost, chatId: string, artifact: Artifact, text: string) =>
    host.note(chatId, text, {
      panel: 'artifacts',
      action: { name: 'open', value: { space: artifact.spaceId, slug: artifact.slug, version: latest(artifact).n } },
      card: {
        title: artifact.title,
        badge: artifact.type === 'code' ? (artifact.language ?? 'Code') : TYPE_LABEL[artifact.type],
        detail: `v${latest(artifact).n}`,
      },
    })

  const badgeOf = (artifact: Artifact) => (artifact.type === 'code' && artifact.language ? artifact.language : TYPE_LABEL[artifact.type])

  // Artifacts in these spaces matching the search, the latest changed first.
  const matching = (host: ExtensionHost, where: { id: string }[], query: string) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return where
      .flatMap((s) => artifactsIn(host, s.id))
      .filter((a) => words.every((w) => `${a.title} ${a.description} ${a.type} ${a.language ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => latest(b).at.localeCompare(latest(a).at))
  }

  // badge: its type, where the list has room for it (the library's narrow column hasn't; the open one's header says).
  const itemOf = (artifact: Artifact, state: ViewState, detail: string, badge = true): ExtensionListItem => ({
    key: keyOf(artifact),
    label: artifact.title,
    detail,
    ...(badge && { badges: [{ text: badgeOf(artifact), tone: 'muted' as const }] }),
    selected: isOpen(state, artifact),
    action: { name: 'open', value: { space: artifact.spaceId, slug: artifact.slug } },
    ...(artifact.description && { hint: artifact.description }),
  })

  // The dock's list: this space's artifacts, searched. Every space's are in the library.
  const spaceList = (host: ExtensionHost, space: ChatDetail, state: DockState): ExtensionView => {
    const found = matching(host, [space], state.query)
    const empty = state.query.trim()
      ? 'Nothing matches.'
      : 'No artifacts in this space yet. Ask an agent for a page, app, chart, diagram or document, and it opens here.'
    return {
      type: 'stack',
      gap: 'normal',
      children: [
        {
          type: 'row',
          justify: 'between',
          children: [
            { type: 'heading', text: 'This space', hint: 'Every space’s artifacts are in the Artifacts library, in the sidebar' },
            ...(state.open ? [{ type: 'button', label: 'Back', variant: 'ghost', action: { name: 'list', value: false } } as ExtensionView] : []),
          ],
        },
        { type: 'search', key: space.id, value: state.query, placeholder: 'Search this space', action: 'search' },
        { type: 'list', label: 'Artifacts', items: found.map((a) => itemOf(a, state, `v${latest(a).n} · ${ago(latest(a).at)}`)), empty },
        { type: 'divider' },
        {
          type: 'switch',
          setting: 'web',
          hint: WEB_HINT,
        },
      ],
    }
  }

  // One artifact: its title and version, the tabs and a ⋯ menu, then the preview, its source or what changed. back: the
  // button before the title, if the view has a list to go back to. beside: offer to open it in the dock beside chat.
  const artifactView = (
    host: ExtensionHost,
    artifact: Artifact,
    state: ViewState,
    { back, beside }: { back?: ExtensionView; beside?: boolean },
  ): ExtensionView => {
    const newest = latest(artifact)
    const shown = artifact.versions.find((v) => v.n === state.version) ?? newest
    const index = artifact.versions.indexOf(shown)
    const content = contentOf(artifact, shown.n)
    const before = artifact.versions[index - 1]
    const tab: Tab = state.tab === 'changes' && !before ? 'preview' : artifact.type === 'code' && state.tab === 'code' ? 'preview' : state.tab
    // The artifact's own space says whether its pages may load from the web, wherever it's shown.
    const web = host.spaceValues(artifact.spaceId).web === true
    const ext = extensionOf(artifact)
    const errorAt = errorKey(artifact, shown.n)
    const error = errors.get(errorAt)
    const versionHint = (v: ArtifactVersion) =>
      [v.restored !== undefined ? `Restored from v${v.restored}` : v.change, new Date(v.at).toLocaleString()].filter(Boolean).join(' · ')

    // The rarer actions, out of sight until asked for.
    const more: ExtensionView = {
      type: 'menu',
      label: `More for ${artifact.title}`,
      items: [
        ...(beside ? [{ label: 'Open beside chat', action: { name: 'beside', value: { space: artifact.spaceId, slug: artifact.slug } } }] : []),
        ...(opensInBrowser(artifact)
          ? [
              {
                label: 'Open in browser',
                action: { name: 'browser' },
                hint: 'Opens this version’s file in your browser, outside Kothar’s sandbox: there it can reach the web',
              },
            ]
          : []),
        { label: 'Rename', action: { name: 'renaming', value: true } },
        { type: 'divider' as const },
        {
          label: 'Delete',
          action: { name: 'delete', value: keyOf(artifact) },
          danger: true,
          confirm: {
            text: `Delete the artifact "${artifact.title}"?`,
            body: `${artifact.versions.length === 1 ? 'It goes' : `All ${artifact.versions.length} versions go`}, with its files in its space.`,
            ok: 'Delete',
            danger: true,
          },
        },
      ],
    }

    const header: ExtensionView = {
      type: 'row',
      justify: 'between',
      children: [
        {
          type: 'row',
          children: [
            ...(back ? [back] : []),
            { type: 'heading', text: artifact.title, ...(artifact.description && { hint: artifact.description }) },
            { type: 'badge', text: badgeOf(artifact), tone: 'muted' },
          ],
        },
        {
          type: 'row',
          children: [
            { type: 'button', label: '‹', variant: 'ghost', disabled: index === 0, action: { name: 'version', value: shown.n - 1 }, hint: 'Earlier version' },
            { type: 'text', text: `v${shown.n} of ${newest.n}`, mono: true, small: true, tone: 'muted', hint: versionHint(shown) },
            {
              type: 'button',
              label: '›',
              variant: 'ghost',
              disabled: shown === newest,
              action: { name: 'version', value: artifact.versions[index + 1]?.n ?? newest.n },
              hint: 'Later version',
            },
            more,
          ],
        },
      ],
    }

    const tabs: ExtensionView[] = [
      { type: 'button', label: artifact.type === 'code' ? 'Code' : 'Preview', variant: tab === 'preview' ? 'primary' : 'ghost', action: { name: 'tab', value: 'preview' } },
      ...(artifact.type === 'code'
        ? []
        : [{ type: 'button', label: 'Code', variant: tab === 'code' ? 'primary' : 'ghost', action: { name: 'tab', value: 'code' } } as ExtensionView]),
      ...(before
        ? [
            {
              type: 'button',
              label: 'Changes',
              variant: tab === 'changes' ? 'primary' : 'ghost',
              action: { name: 'tab', value: 'changes' },
              hint: `What changed from v${before.n}`,
            } as ExtensionView,
          ]
        : []),
    ]
    const actions: ExtensionView[] = [
      { type: 'copy', text: content, label: 'Copy' },
      { type: 'download', text: content, filename: `${artifact.slug}-v${shown.n}.${ext}`, mimeType: MIME[ext] ?? 'text/plain', label: 'Download' },
    ]

    const rename: ExtensionView[] = state.renaming
      ? [
          {
            type: 'form',
            key: `rename:${keyOf(artifact)}`,
            fields: [{ name: 'title', label: 'Title', value: artifact.title, placeholder: 'Title' }],
            submit: { label: 'Rename', action: 'rename' },
            cancel: { label: 'Cancel', action: { name: 'renaming', value: false } },
          },
        ]
      : []

    // Looking back: a line saying so, and a way to make this version the latest again.
    const old: ExtensionView[] =
      shown === newest
        ? []
        : [
            {
              type: 'row',
              justify: 'between',
              children: [
                { type: 'text', text: `An earlier version${shown.change ? `: ${shown.change}` : ''}`, tone: 'warning', small: true },
                {
                  type: 'row',
                  children: [
                    { type: 'button', label: 'Latest', variant: 'ghost', action: { name: 'version', value: newest.n } },
                    {
                      type: 'button',
                      label: 'Restore this version',
                      variant: 'normal',
                      action: { name: 'restore', value: shown.n },
                      hint: `Saves it as v${newest.n + 1}; v${newest.n} stays`,
                    },
                  ],
                },
              ],
            },
          ]

    const problem: ExtensionView[] = error
      ? [
          {
            type: 'card',
            title: sent.has(errorAt) ? 'Sent to the agent to fix' : 'This page hit an error',
            badges: [{ text: `v${shown.n}`, tone: 'muted' }],
            children: [
              { type: 'code', text: error, maxLines: 12 },
              {
                type: 'row',
                children: [
                  ...(sent.has(errorAt)
                    ? []
                    : [
                        {
                          type: 'button',
                          label: 'Fix',
                          variant: 'primary',
                          action: { name: 'fix', value: shown.n },
                          hint: 'Sends the error to the agent that made this version, to fix it',
                        } as ExtensionView,
                      ]),
                  { type: 'button', label: 'Dismiss', variant: 'ghost', action: { name: 'dismiss', value: shown.n } },
                ],
              },
            ],
          },
        ]
      : []

    let body: ExtensionView
    if (tab === 'code') {
      body = { type: 'code', text: content, language: sourceLanguage(artifact), lineNumbers: true, fill: true, maxLines: 20_000 }
    } else if (tab === 'changes' && before) {
      const diff = diffLines(contentOf(artifact, before.n), content)
      body =
        'tooBig' in diff
          ? { type: 'empty', text: 'Too many lines changed to compare here. Download both versions to compare them.' }
          : {
              type: 'stack',
              gap: 'tight',
              children: [
                { type: 'text', text: `v${before.n} → v${shown.n}: ${diff.added} added, ${diff.removed} removed`, small: true, tone: 'muted' },
                diff.text ? { type: 'code', text: diff.text, language: 'diff', fill: true, maxLines: 20_000 } : { type: 'empty', text: 'No changes.' },
              ],
            }
    } else {
      body = previewOf(artifact, content, { web, errors: `error:${keyOf(artifact)}@${shown.n}` })
    }

    // The lines that come and go sit in stacks of their own, so the preview keeps its place among the children and its
    // page isn't reloaded when one shows.
    return {
      type: 'stack',
      gap: 'normal',
      children: [
        header,
        // One tab alone (a code file's) needs no switch.
        { type: 'row', justify: 'between', children: [{ type: 'row', children: tabs.length > 1 ? tabs : [] }, { type: 'row', children: actions }] },
        { type: 'stack', gap: 'normal', children: [...rename, ...old, ...problem] },
        body,
      ],
    }
  }

  // The library: every space's artifacts (or one space's), searched, beside the one open.
  const libraryView = (host: ExtensionHost, chat: ChatDetail): ExtensionView => {
    const all = spaces(host)
    // A space that's gone or archived since: back to all of them.
    if (library.space && !all.some((s) => s.id === library.space)) delete library.space
    const where = library.space ? all.filter((s) => s.id === library.space) : all
    const names = new Map(all.map((s) => [s.id, s.name]))
    const found = matching(host, where, library.query)
    const open = library.open && found.find((a) => isOpen(library, a))
    const artifact = open ?? (library.query.trim() ? undefined : found[0])
    if (!open) {
      delete library.version
      library.renaming = false
      if (artifact) library.open = { space: artifact.spaceId, slug: artifact.slug }
      else delete library.open
    }
    const scope = library.space ? (names.get(library.space) ?? 'This space') : 'All spaces'
    const filter: ExtensionView = {
      type: 'menu',
      label: 'Show artifacts from',
      items: [
        { label: 'All spaces', action: { name: 'space', value: null }, checked: !library.space },
        ...(all.length ? [{ type: 'divider' as const }] : []),
        ...all.map((s) => ({ label: s.name, action: { name: 'space', value: s.id }, checked: library.space === s.id })),
      ],
    }
    const side: ExtensionView = {
      type: 'stack',
      gap: 'normal',
      children: [
        { type: 'row', justify: 'between', children: [{ type: 'heading', text: scope, hint: 'Which space’s artifacts show: ⋯ picks' }, filter] },
        {
          type: 'search',
          key: library.space ?? 'all',
          value: library.query,
          placeholder: 'Search artifacts',
          action: 'search',
          submit: 'go',
          autofocus: true,
        },
        {
          type: 'list',
          label: 'Artifacts',
          items: found.map((a) => itemOf(a, library, [!library.space && names.get(a.spaceId), ago(latest(a).at)].filter(Boolean).join(' · '), false)),
          empty: library.query.trim() ? 'Nothing matches.' : library.space ? 'No artifacts in this space yet.' : 'No artifacts yet.',
        },
      ],
    }
    const main: ExtensionView = artifact
      ? artifactView(host, artifact, library, { beside: !!spaceOf(host, chat.id) })
      : {
          type: 'empty',
          text: found.length || library.query.trim() ? 'Pick an artifact.' : 'Ask an agent in a space for a page, app, chart, diagram or document, and it shows here.',
        }
    return { type: 'split', side, main }
  }

  // The chat the Fix goes to: the one that made that version, if it's still there; else the space.
  const fixerOf = (host: ExtensionHost, artifact: Artifact, version: ArtifactVersion) => {
    const maker = version.chatId === undefined ? undefined : host.chat(version.chatId)
    return maker && !maker.archived ? maker.id : artifact.spaceId
  }

  const named = (host: ExtensionHost, value: unknown) => {
    const { space, slug } = (value ?? {}) as { space?: unknown; slug?: unknown }
    if (typeof space !== 'string' || typeof slug !== 'string') throw new Error('That artifact is gone')
    if (!host.chat(space)) throw new Error('That artifact’s space is gone')
    const found = artifactsIn(host, space).find((a) => a.slug === slug)
    if (!found) throw new Error('That artifact is gone')
    return found
  }

  const openIn = (state: ViewState, artifact: Artifact, version?: unknown) => {
    Object.assign(state, { open: { space: artifact.spaceId, slug: artifact.slug }, renaming: false, tab: 'preview' })
    if (typeof version === 'number' && version !== latest(artifact).n && artifact.versions.some((v) => v.n === version)) state.version = version
    else delete state.version
  }

  // What an artifact's view does, in the dock or the library. True when the action was one of these.
  const act = async (host: ExtensionHost, chat: ChatDetail, state: ViewState, action: ExtensionAction): Promise<boolean> => {
    const current = () => named(host, state.open)
    const shownOf = (artifact: Artifact, n: unknown) => artifact.versions.find((v) => v.n === Number(n))
    if (action.name.startsWith('error:')) {
      // From a page's frame: error:<space>/<slug>@<version>.
      if (typeof action.value === 'string' && keepError(action.name.slice('error:'.length), action.value)) host.refresh(chat.id)
      return true
    }
    switch (action.name) {
      case 'search':
        state.query = String(action.value ?? '').slice(0, 200)
        return true
      case 'tab':
        state.tab = action.value === 'code' || action.value === 'changes' ? action.value : 'preview'
        return true
      case 'version': {
        const artifact = current()
        const found = shownOf(artifact, action.value)
        if (!found) return true
        if (found === latest(artifact)) delete state.version
        else state.version = found.n
        return true
      }
      case 'restore': {
        const artifact = current()
        const found = shownOf(artifact, action.value)
        if (!found) throw new Error('That version is gone')
        const restored = addVersion(host, artifact, contentOf(artifact, found.n), { restored: found.n })
        delete state.version
        host.note(artifact.spaceId, `Restored v${found.n} as v${latest(restored).n}`, {
          panel: 'artifacts',
          action: { name: 'open', value: { space: restored.spaceId, slug: restored.slug } },
          card: { title: restored.title, badge: badgeOf(restored), detail: `v${latest(restored).n}` },
        })
        host.refresh()
        return true
      }
      case 'renaming':
        state.renaming = action.value === true
        return true
      case 'rename': {
        const { title } = (action.value ?? {}) as { title?: unknown }
        renameArtifact(host, current(), title)
        state.renaming = false
        host.refresh()
        return true
      }
      case 'fix': {
        const artifact = current()
        const found = shownOf(artifact, action.value)
        const key = found && errorKey(artifact, found.n)
        const error = key && errors.get(key)
        if (!found || !key || !error) return true
        const to = fixerOf(host, artifact, found)
        host.send(
          to,
          `The artifact “${artifact.title}” (${artifact.slug}, v${found.n}) hits this error in Kothar’s preview:\n\n` +
            `\`\`\`\n${error}\n\`\`\`\n\nFix it with update_artifact.`,
        )
        sent.add(key)
        return true
      }
      case 'dismiss': {
        const artifact = current()
        errors.delete(errorKey(artifact, Number(action.value)))
        return true
      }
      case 'browser': {
        const artifact = current()
        const n = shownOf(artifact, state.version)?.n ?? latest(artifact).n
        const [command, args] = openerFor(platform, pathOf(artifact, n))
        const { code, stderr } = await host.run(command, args, { timeoutMs: 10_000 })
        if (code !== 0) throw new Error(`Couldn’t open it in a browser${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
        return true
      }
      case 'delete': {
        const [space, slug] = String(action.value ?? '').split('/')
        removeArtifact(named(host, { space, slug }))
        // Wherever it's open, it closes.
        for (const view of [library, ...docks.values()]) {
          if (view.open?.space === space && view.open?.slug === slug) {
            delete view.open
            delete view.version
          }
        }
        // Every chat showing it draws again.
        host.refresh()
        return true
      }
      default:
        return false
    }
  }

  return {
    id: 'artifacts',
    name: 'Artifacts',
    description:
      'What agents make for you to look at, use or keep: pages and small apps, React components, SVGs, diagrams, ' +
      'documents and code files. Kept per space with every version, shown beside the chat, all of them in a library ' +
      '(⌘⇧A), and run in a sandbox, offline.',
    enabledByDefault: true,
    // Saved as web, its name before; the key stays so saved values carry over.
    spaceSettings: [{ key: 'web', label: 'Load files from the internet', type: 'boolean', default: false, description: WEB_HINT }],
    instructions: ({ chat, tools }, { host }) => (tools && spaceOf(host, chat.id) ? INSTRUCTIONS : undefined),
    tools: [
      {
        name: 'create_artifact',
        description: toolDescription.create,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: MAX_TITLE },
            type: { type: 'string', enum: [...TYPES] },
            content: { type: 'string', minLength: 1, description: 'The whole artifact: a page, a component file, an SVG, diagram source, Markdown or code' },
            language: { type: 'string', description: 'For type code: its language, such as python' },
            description: { type: 'string', maxLength: MAX_DESCRIPTION, description: 'One line on what it is' },
          },
          required: ['title', 'type', 'content'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const artifact = createArtifact(host, caller.id, input)
          noteFor(host, caller.id, artifact, artifact.description || 'Made an artifact')
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
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: { old: { type: 'string', minLength: 1 }, new: { type: 'string' } },
                required: ['old', 'new'],
              },
            },
            content: { type: 'string', minLength: 1, description: 'The whole new content, instead of edits' },
            change: { type: 'string', maxLength: MAX_DESCRIPTION },
          },
          required: ['artifact'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const artifact = updateArtifact(host, caller.id, input)
          noteFor(host, caller.id, artifact, latest(artifact).change || 'Updated it')
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
          const kind = artifact.type === 'code' ? `code, ${artifact.language}` : artifact.type
          return `${artifact.title} (${artifact.slug}, ${kind}), v${n} of ${latest(artifact).n}\n\n${contentOf(artifact, n)}`
        },
      },
    ],
    panels: [
      {
        // This space's artifacts, beside the chat and as a tab in the right sidebar. It slides in when an agent makes or
        // changes one.
        id: 'artifacts',
        title: 'Artifacts',
        placement: 'dock',
        // Home keeps no files, so it has no artifacts.
        shown: (chat, { host }) => !!spaceOf(host, chat.id),
        render(chat, { host }) {
          const space = spaceOf(host, chat.id)
          if (!space) return { type: 'empty', text: 'Artifacts belong to a space' }
          const state = dockOf(chat.id)
          // The one open (one from another space, opened beside the chat from the library, stays), else this space's
          // newest; one deleted elsewhere falls back the same way.
          const open = state.open && host.chat(state.open.space) ? artifactsIn(host, state.open.space).find((a) => a.slug === state.open!.slug) : undefined
          const artifact = open ?? artifactsIn(host, space.id)[0]
          if (!open) {
            delete state.version
            state.renaming = false
            if (artifact) state.open = { space: artifact.spaceId, slug: artifact.slug }
            else delete state.open
          }
          if (state.list || !artifact) return spaceList(host, space, state)
          const back: ExtensionView = { type: 'button', label: '‹', variant: 'ghost', action: { name: 'list', value: true }, hint: 'This space’s artifacts' }
          return artifactView(host, artifact, state, { back })
        },
        async onAction(action: ExtensionAction, chat, { host }) {
          const state = dockOf(chat.id)
          if (action.name === 'open') {
            openIn(state, named(host, action.value), ((action.value ?? {}) as { version?: unknown }).version)
            state.list = false
            return
          }
          if (action.name === 'list') {
            state.list = action.value === true
            return
          }
          if (!(await act(host, chat, state, action))) throw new Error(`Unknown action "${action.name}"`)
        },
      },
      {
        // Every space's artifacts, in a popup over the chat: from the sidebar's launcher or ⌘⇧A, in any chat.
        id: 'library',
        title: 'Artifacts',
        placement: 'popup',
        shortcut: 'Mod+Shift+A',
        launcher: true,
        render: (chat, { host }) => libraryView(host, chat),
        async onAction(action: ExtensionAction, chat, { host }) {
          switch (action.name) {
            case 'open':
              openIn(library, named(host, action.value))
              return
            case 'go': {
              // Enter in the search: the best match opens.
              const all = spaces(host)
              const first = matching(host, library.space ? all.filter((s) => s.id === library.space) : all, String(action.value ?? ''))[0]
              if (first) openIn(library, first)
              return
            }
            case 'space': {
              const id = typeof action.value === 'string' && spaces(host).some((s) => s.id === action.value) ? action.value : undefined
              if (id) library.space = id
              else delete library.space
              return
            }
            case 'beside': {
              // Into the dock beside this chat, at the version the library shows; the library closes.
              const artifact = named(host, action.value)
              if (!spaceOf(host, chat.id)) throw new Error('Artifacts open beside a chat in a space')
              const dock = dockOf(chat.id)
              openIn(dock, artifact, library.version)
              dock.tab = library.tab
              dock.list = false
              host.closePanel(chat.id, 'library')
              host.refresh(chat.id)
              host.showPanel(chat.id, 'artifacts')
              return
            }
          }
          if (!(await act(host, chat, library, action))) throw new Error(`Unknown action "${action.name}"`)
        },
      },
    ],
    onChatRemoved(chat: ChatSummary) {
      docks.delete(chat.id)
      if (library.space === chat.id) delete library.space
    },
  }
}

const listed = (artifact: Artifact) => ({
  name: artifact.slug,
  title: artifact.title,
  type: artifact.type,
  ...(artifact.language && { language: artifact.language }),
  description: artifact.description,
  version: latest(artifact).n,
  updatedAt: latest(artifact).at,
  path: pathOf(artifact),
})

export default createArtifactsExtension()
