import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog } from 'radix-ui'
import type { ExtensionUse } from '@kothar/extension-api'
import {
  changesUrl,
  EXTENSION_USES,
  previewOf,
  type ClientMessage,
  type InstalledItem,
  type MarketEntry,
  type MarketKind,
  type ExtensionInfo,
  type ThemeFile,
  type ThemePreview,
} from '@kothar/core/shared'
import { Button, confirm, ErrorText, Hint, MOTION, Select, useReturnFocus } from './controls.tsx'
import { marketKey, type State } from './state.ts'
import { chooseAppearance, useAppearance } from './themes.tsx'

export type Market = Pick<State, 'catalog' | 'themes' | 'installed' | 'marketFailures'> &
  Partial<Pick<State, 'extensions' | 'localInstall' | 'communityExtensions'>>

type Props = {
  market: Market
  connected: boolean
  send: (m: ClientMessage) => void
  // The desktop app's folder picker; a browser tab types a path instead.
  pickFolder?: (title?: string) => Promise<string | null>
}

type Row = {
  kind: MarketKind
  id: string
  name: string
  author?: string
  description?: string
  repo?: string
  // The version the author's latest release carries, its tag and notes, and why it couldn't be read.
  latest?: string
  latestTag?: string
  notes?: string
  problem?: string
  preview?: ThemePreview
  uses?: ExtensionUse[]
  listed: boolean
  installed?: InstalledItem
  theme?: ThemeFile
}

// Catalog entries of the kind first, in its order, then what's installed that the catalog doesn't list (or can't, while
// offline).
function rowsOf({ catalog, themes = [], installed = [] }: Market, kind: MarketKind): Row[] {
  const items = new Map(installed.filter((i) => i.kind === kind).map((item) => [item.id, item]))
  const themeFiles = new Map(themes.map((theme) => [theme.id, theme]))
  const listed = (catalog?.entries ?? [])
    .filter((entry) => entry.kind === kind)
    .map((entry: MarketEntry): Row => {
      const { id, name, author, description, repo, latest, problem } = entry
      return {
        kind,
        id,
        name,
        author,
        description,
        repo,
        ...(latest && {
          latest: latest.version,
          latestTag: latest.tag,
          notes: latest.notes,
          preview: latest.preview,
          uses: latest.uses,
        }),
        ...(problem && { problem }),
        listed: true,
        installed: items.get(id),
        theme: themeFiles.get(id),
      }
    })
  const listedIds = new Set(listed.map((row) => row.id))
  const extra = [...items.values()]
    .filter((item) => !listedIds.has(item.id))
    .map((item): Row => {
      const theme = themeFiles.get(item.id)
      return {
        kind,
        id: item.id,
        name: item.name,
        ...(theme && { author: theme.author, description: theme.description, preview: previewOf(theme), theme }),
        ...(item.repo && { repo: item.repo }),
        listed: false,
        installed: item,
      }
    })
  return [...listed, ...extra]
}

// An installed item the marketplace has a different version of. Local installs follow their folder, not a release.
const outdated = (row: Row) =>
  row.installed !== undefined && row.installed.source !== 'local' && row.latest !== undefined && row.latest !== row.installed.version

// Beside Update: GitHub's compare view from the installed release to the latest, with the latest's notes on hover.
function SeeChanges({ row }: { row: Row }) {
  const href = row.installed && row.repo && row.latestTag && changesUrl(row.installed, row.repo, row.latestTag)
  if (!href) return null
  const hint = row.notes
    ? `${row.latest}: ${row.notes}`
    : `What changed from ${row.installed!.tag} to ${row.latestTag}, on GitHub. Updates are never reviewed by Kothar.`
  return (
    <Hint text={hint} align="end">
      <a className="px-6 text-sm text-accent underline-offset-2 hover:underline" href={href} target="_blank" rel="noreferrer">
        See changes
      </a>
    </Hint>
  )
}

function Swatches({ preview, name }: { preview?: ThemePreview; name: string }) {
  if (!preview) return null
  return (
    <div className="flex shrink-0 gap-6" role="img" aria-label={`${name} colours`}>
      {(['dark', 'light'] as const).map((scheme) => {
        const { bg, panel, text, accent } = preview[scheme]
        return (
          <span
            key={scheme}
            className="flex h-32 w-44 overflow-hidden rounded border"
            style={{ background: bg }}
            data-scheme={scheme}
          >
            <span className="w-12" style={{ background: panel }} />
            <span className="flex flex-1 flex-col justify-center gap-4 px-5">
              <span className="h-3 rounded-full" style={{ background: text }} />
              <span className="h-5 w-3/4 rounded-full" style={{ background: accent }} />
            </span>
          </span>
        )
      })}
    </div>
  )
}

function Source({ item }: { item: InstalledItem }) {
  if (item.source === 'local') {
    return (
      <Hint text={`Installed from ${item.path ?? 'a folder'}`}>
        <span className="text-xs text-amber">Local</span>
      </Hint>
    )
  }
  return <span className="text-xs text-green">Installed {item.version}</span>
}

// Sends installs and keeps each one's button busy until the core answers: installed at the latest version, or failed.
function usePending(market: Market) {
  const { marketFailures } = market
  // Installs sent and not yet answered, with how many failures the item had when it was sent.
  const [pending, setPending] = useState<Record<string, number>>({})
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- drops installs the core has answered; deriving it instead would bring a finished install back as pending once it's outdated again
    setPending((was) => {
      const still = Object.entries(was).filter(([key, failures]) => {
        const [kind, id] = key.split(':') as [MarketKind, string]
        const row = rowsOf(market, kind).find((r) => r.id === id)
        const done = row?.installed && !outdated(row)
        return !done && (marketFailures[key]?.count ?? 0) === failures
      })
      return still.length === Object.keys(was).length ? was : Object.fromEntries(still)
    })
  }, [market, marketFailures])
  const start = (key: string) => setPending((was) => ({ ...was, [key]: marketFailures[key]?.count ?? 0 }))
  return { pending, start }
}

// Uses that reach beyond Kothar itself: shown in amber.
const REACHING: ExtensionUse[] = ['run', 'setup', 'mcpServers', 'permissions', 'sendMessages', 'accounts']

// What a community extension says it uses through the extension API, in plain words.
export function UsesList({ uses }: { uses: readonly ExtensionUse[] }) {
  if (!uses.length) return <span className="text-sm text-muted">Uses nothing through the extension API</span>
  return (
    <ul className="flex flex-wrap gap-x-12 gap-y-2 text-sm" aria-label="Uses">
      {uses.map((use) => (
        <li key={use} className={REACHING.includes(use) ? 'text-amber' : 'text-muted'}>
          {EXTENSION_USES[use]}
        </li>
      ))}
    </ul>
  )
}

// Whether an installed extension is on and running, as one quiet line.
export function ExtensionStatus({ info, communityExtensions }: { info?: ExtensionInfo; communityExtensions: boolean }) {
  const status = extensionStatus(info, communityExtensions)
  return status ? <span className="text-sm text-faint">{status}</span> : null
}

// communityExtensions: the master switch; an extension runs only while it and the extension's own switch are on.
export function extensionStatus(info: ExtensionInfo | undefined, communityExtensions: boolean) {
  if (!info?.community) return undefined
  const { version, running, held } = info.community
  const stays = running ? ' Its code stays loaded until Kothar restarts.' : ''
  if (!info.enabled && held) return `Off: ${held}. Turn it on again to run ${version}.`
  if (!info.enabled) return `Off.${stays || ' Turn it on in Community hub.'}`
  if (!communityExtensions) return `Off while community extensions are off.${stays}`
  if (info.loadError) return undefined
  if (!running) return 'Starts when Kothar restarts.'
  if (running !== version) return `Running ${running}. Restart Kothar to run ${version}.`
  return undefined
}

// What changed since the version the user last turned on, for the popup that turns it on again; undefined when it's the
// same version or was never on.
export function changesSinceApproved(info: ExtensionInfo): string | undefined {
  const { version, uses, approved, repo, tag, held } = info.community ?? {}
  if (!approved || !version || !uses) return undefined
  if (approved.version === version && !held) return undefined
  const added = uses.filter((use) => !approved.uses.includes(use))
  const dropped = approved.uses.filter((use) => !uses.includes(use))
  const lines = [
    approved.version === version
      ? `Its files changed since you turned on ${version}.`
      : `Changed since you turned it on: ${approved.version} → ${version}.`,
  ]
  if (added.length) lines.push(`It now also says it:\n${usesText(added)}`)
  if (dropped.length) lines.push(`It no longer says it:\n${usesText(dropped)}`)
  if (!added.length && !dropped.length) lines.push('It lists the same uses as before.')
  if (repo && approved.tag && tag && approved.tag !== tag) {
    const compare = `${encodeURIComponent(approved.tag)}...${encodeURIComponent(tag)}`
    lines.push(`Read the changes:\nhttps://github.com/${repo}/compare/${compare}`)
  }
  return lines.join('\n\n')
}

export const EXTENSION_WARNING =
  'A community extension runs code on your computer with your permissions. Kothar holds it to what it lists, but it could ' +
  'still read your files or reach the network on its own. Turn on only extensions you trust.'

const usesText = (uses: readonly ExtensionUse[]) => uses.map((use) => `• ${EXTENSION_USES[use]}`).join('\n')

const LOCAL_HINT =
  'Installs an extension (a folder with manifest.json and a built main.mjs) or themes (<id>.json files) from this computer, ' +
  "without publishing. It's marked Local; Reinstall copies it again after you change it."

// Installs a folder an author is working on. In the desktop app the system picker comes first and typing is the
// fallback, as in the Context panel; a browser tab can only type.
function InstallFromFolder({ market, connected, send, pickFolder }: Props) {
  const [path, setPath] = useState('')
  const [typing, setTyping] = useState(!pickFolder)
  const [sent, setSent] = useState<{ path: string; count: number }>()
  const answer = market.localInstall
  const waiting = sent !== undefined && (answer?.count ?? 0) === sent.count
  const shown = sent !== undefined && !waiting && answer?.path === sent.path ? answer : undefined
  const install = (path: string) => {
    setSent({ path, count: answer?.count ?? 0 })
    send({ type: 'market.installLocal', path })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!connected || !path.trim()) return
    install(path.trim())
  }
  const pick = async () => {
    const picked = await pickFolder?.('Install from folder')
    if (picked) install(picked)
  }
  const names = (ids: string[]) =>
    ids.map((id) => market.installed?.find((item) => item.id === id)?.name ?? id).join(', ')
  return (
    <div className="flex flex-col gap-6 pb-16">
      <div className="flex flex-wrap items-center gap-6">
        {pickFolder && (
          <Hint text={LOCAL_HINT} align="start">
            <Button type="button" disabled={!connected || waiting} onClick={() => void pick()}>
              Install from folder…
            </Button>
          </Hint>
        )}
        {pickFolder && (
          <Button
            type="button"
            variant="ghost"
            size="small"
            className="text-muted"
            aria-expanded={typing}
            disabled={!connected}
            onClick={() => setTyping(!typing)}
          >
            Type a path
          </Button>
        )}
      </div>
      {typing && (
        <form className="flex gap-6" onSubmit={submit}>
          <input
            className="min-w-0 flex-1 font-mono text-sm"
            aria-label="Install from a folder by path"
            placeholder="/path/to/my-extension"
            value={path}
            spellCheck={false}
            disabled={!connected}
            autoFocus={!!pickFolder}
            onChange={(e) => setPath(e.target.value)}
          />
          <Hint text={LOCAL_HINT} align="end">
            <Button disabled={!connected || waiting || !path.trim()}>{pickFolder ? 'Install' : 'Install from folder'}</Button>
          </Hint>
        </form>
      )}
      {waiting && <span className="text-sm text-muted">Installing…</span>}
      {shown && 'error' in shown && <ErrorText>{shown.error}</ErrorText>}
      {shown && 'ids' in shown && (
        <span className="text-sm text-green">
          Installed {names(shown.ids)} from {shown.path}
          {shown.kind === 'extension' ? '. Turn it on in Community hub.' : '.'}
        </span>
      )}
    </div>
  )
}

export type MarketKindFilter = 'all' | MarketKind
type ShowFilter = 'all' | 'installed' | 'updates'

const KIND_FILTERS: { value: MarketKindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'theme', label: 'Themes' },
  { value: 'extension', label: 'Extensions' },
]
const SHOW_FILTERS: { value: ShowFilter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'installed', label: 'Installed' },
  { value: 'updates', label: 'Updates available' },
]
const SKELETON_ROWS = 6

// How the list draws its entries: rows with a description beside the details (List), cards that fill the window
// (Grid), or one line each (Compact). The choice is kept in localStorage.
export type MarketView = 'list' | 'grid' | 'compact'
const VIEW_KEY = 'kothar.marketplaceView'
const VIEWS: { value: MarketView; label: string; hint: string }[] = [
  { value: 'list', label: 'List', hint: 'Each entry with its description, in a column beside the details' },
  { value: 'grid', label: 'Grid', hint: 'Cards side by side, to browse many at once' },
  { value: 'compact', label: 'Compact', hint: 'One line per entry, to see the most at a time' },
]

function savedView(): MarketView {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    return VIEWS.some((v) => v.value === saved) ? (saved as MarketView) : 'list'
  } catch {
    return 'list'
  }
}

function saveView(view: MarketView) {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // Kept for this window only.
  }
}

// How many cards sit in the grid's first row: what ArrowUp and ArrowDown step by.
function gridColumns(list: HTMLElement | null) {
  const options = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
  const top = options[0]?.offsetTop
  return Math.max(1, options.filter((o) => o.offsetTop === top).length)
}

const matches = (row: Row, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const text = [row.name, row.author, row.description, row.repo, row.id].join(' ').toLowerCase()
  return words.every((word) => text.includes(word))
}

// What the list shows: catalog entries and installed items of the kinds picked, that pass the filter and the search.
export function shownRows(market: Market, kind: MarketKindFilter, show: ShowFilter, query: string): Row[] {
  const kinds: MarketKind[] = kind === 'all' ? ['theme', 'extension'] : [kind]
  return kinds
    .flatMap((k) => rowsOf(market, k))
    .filter((row) => (show === 'installed' ? !!row.installed : show === 'updates' ? outdated(row) && row.listed : true))
    .filter((row) => matches(row, query))
}

type DialogProps = Props & {
  open: boolean
  close: () => void
}

// The Marketplace: its own window over the app, like Obsidian's community plugin browser. A searchable list on the
// left, the picked entry on the right. It always opens on All, wherever it's opened from.
export function MarketplaceDialog({ open, close, market, connected, send, pickFolder }: DialogProps) {
  const focus = useReturnFocus()
  const { catalog } = market
  const { pending, start } = usePending(market)
  const [kind, setKind] = useState<MarketKindFilter>('all')
  const [show, setShow] = useState<ShowFilter>('all')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string>()
  const [view, setView] = useState<MarketView>(savedView)
  const listRef = useRef<HTMLDivElement>(null)
  const chooseView = (next: MarketView) => {
    setView(next)
    saveView(next)
  }
  // The catalog answer being replaced by a fresh one, while it's asked for again.
  const [asked, setAsked] = useState<Market['catalog'] | null>(null)
  const loading = catalog === undefined || asked === catalog
  const list = useCallback(() => {
    setAsked(catalog)
    send({ type: 'marketplace.list' })
  }, [catalog, send])

  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setKind('all')
      setShow('all')
      setQuery('')
      setPicked(undefined)
    }
  }
  // Each time it opens: asked once, and again after a failure.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- asking marks the shown catalog as being replaced, once per open or reconnect
    if (open && connected && (catalog === undefined || catalog.error)) list()
    // oxlint-disable-next-line react/exhaustive-deps -- with catalog or list as deps, each failed answer would ask again, in a loop
  }, [open, connected])

  const rows = shownRows(market, kind, show, query)
  const selected = rows.find((row) => marketKey(row.kind, row.id) === picked) ?? rows[0]
  const updates = shownRows(market, kind, 'updates', '').length

  const install = async (row: Row) => {
    const info = market.extensions?.find((m) => m.id === row.id)
    if (row.kind === 'extension' && row.installed && info?.enabled) {
      const href = row.repo && row.latestTag && changesUrl(row.installed, row.repo, row.latestTag)
      const ok = await confirm({
        text: `Update ${row.name} to ${row.latest}?`,
        body:
          'It turns off until you turn it on again in Community hub, so code you haven\'t reviewed never runs.' +
          (href ? `\n\nRead the changes first:\n${href}` : ''),
        ok: 'Update',
      })
      if (!ok) return
    }
    if (row.kind === 'extension' && !row.installed) {
      const ok = await confirm({
        text: `Install ${row.name}?`,
        body:
          'It stays off until you turn it on in Community hub.\n\n' +
          (row.uses?.length ? `It says it:\n${usesText(row.uses)}` : 'It says it uses nothing through the extension API.'),
        ok: 'Install',
      })
      if (!ok) return
    }
    start(marketKey(row.kind, row.id))
    send({ type: 'market.install', kind: row.kind, id: row.id })
  }

  // Up and Down step through the list; in the grid they move a row of cards, and Left and Right (on the list itself,
  // not in the search box) move one card. Past the end of the grid, nothing moves.
  const move = (e: KeyboardEvent<HTMLElement>) => {
    const grid = view === 'grid'
    const sideways = grid && e.currentTarget === listRef.current && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && !sideways) return
    e.preventDefault()
    const at = selected ? rows.indexOf(selected) : -1
    const step = sideways ? 1 : grid ? gridColumns(listRef.current) : 1
    const by = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? step : -step
    const to = grid && at >= 0 && (at + by < 0 || at + by >= rows.length) ? at : at + by
    const next = rows[Math.min(rows.length - 1, Math.max(0, to))]
    if (!next) return
    setPicked(marketKey(next.kind, next.id))
    document.getElementById(optionId(next))?.scrollIntoView?.({ block: 'nearest' })
  }

  return (
    <Dialog.Root open={open} onOpenChange={(open) => open || close()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-0 m-auto flex h-[min(680px,calc(100vh-32px))] w-[min(980px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border bg-bg text-text shadow-overlay"
                {...MOTION.pop}
              >
                <header className="flex shrink-0 flex-wrap items-center gap-x-12 gap-y-8 border-b py-10 pr-48 pl-16">
                  <Dialog.Title className="text-[16px] font-semibold">Marketplace</Dialog.Title>
                  <input
                    type="search"
                    className="h-control min-w-160 flex-1 rounded border bg-panel px-8"
                    placeholder="Search themes and extensions"
                    aria-label="Search the marketplace"
                    value={query}
                    autoFocus
                    spellCheck={false}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={move}
                  />
                  <div className="flex rounded border bg-panel p-2" role="group" aria-label="Kind">
                    {KIND_FILTERS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        aria-pressed={kind === f.value}
                        className="h-22 rounded-sm px-10 text-sm text-muted transition-colors hover:text-text aria-pressed:bg-raised aria-pressed:text-text aria-pressed:shadow-raised"
                        onClick={() => setKind(f.value)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex rounded border bg-panel p-2" role="group" aria-label="View">
                    {VIEWS.map((v) => (
                      <Hint key={v.value} text={v.hint}>
                        <button
                          type="button"
                          aria-pressed={view === v.value}
                          className="h-22 rounded-sm px-10 text-sm text-muted transition-colors hover:text-text aria-pressed:bg-raised aria-pressed:text-text aria-pressed:shadow-raised"
                          onClick={() => chooseView(v.value)}
                        >
                          {v.label}
                        </button>
                      </Hint>
                    ))}
                  </div>
                  <Select
                    label="Show"
                    value={show}
                    options={SHOW_FILTERS.map((f) =>
                      f.value === 'updates' && updates ? { ...f, label: `${f.label} (${updates})` } : f,
                    )}
                    onChange={(value) => setShow(value as ShowFilter)}
                  />
                  <Hint text="Check the marketplace again">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Refresh"
                      className="grid place-items-center"
                      disabled={!connected || loading}
                      onClick={list}
                    >
                      ↻
                    </Button>
                  </Hint>
                </header>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="icon" aria-label="Close" className="absolute top-12 right-12">
                    ×
                  </Button>
                </Dialog.Close>
                <div className="flex min-h-0 flex-1 max-[720px]:flex-col">
                  <div
                    className={`flex shrink-0 flex-col border-r bg-panel max-[720px]:max-h-[45%] max-[720px]:w-auto max-[720px]:border-r-0 max-[720px]:border-b ${view === 'grid' ? 'min-w-0 flex-1 max-[720px]:max-h-[60%]' : 'w-320'}`}
                  >
                    {catalog?.error && !loading && (
                      <div className="flex flex-col items-start gap-8 border-b px-14 py-12" role="alert">
                        <ErrorText>{catalog.error}</ErrorText>
                        <Button size="small" disabled={!connected} onClick={list}>
                          Retry
                        </Button>
                      </div>
                    )}
                    <div
                      ref={listRef}
                      className={`min-h-0 flex-1 scroll-inset overflow-y-auto py-6 pl-6 ${view === 'grid' ? 'grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(180px,1fr))] content-start gap-8 pr-6' : ''}`}
                      role="listbox"
                      aria-label="Marketplace"
                      aria-busy={loading}
                      data-view={view}
                      tabIndex={-1}
                      onKeyDown={move}
                    >
                      {rows.map((row) => (
                        <ListRow
                          key={marketKey(row.kind, row.id)}
                          view={view}
                          row={row}
                          selected={row === selected}
                          busy={marketKey(row.kind, row.id) in pending}
                          pick={() => setPicked(marketKey(row.kind, row.id))}
                        />
                      ))}
                      {loading &&
                        Array.from({ length: rows.length ? 2 : SKELETON_ROWS }, (_, i) => <SkeletonRow key={i} view={view} />)}
                      {!loading && !rows.length && (
                        <p className="col-span-full px-8 py-12 text-sm text-muted">
                          {emptyText(query, kind, show, catalog?.entries !== undefined)}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 border-t px-12 pt-10">
                      <InstallFromFolder {...{ market, connected, send, pickFolder }} />
                    </div>
                  </div>
                  <div
                    className={`min-h-0 min-w-0 scroll-inset overflow-y-auto pt-20 pr-10 pb-24 pl-24 max-[720px]:pr-2 max-[720px]:pl-16 ${view === 'grid' ? 'w-360 shrink-0 max-[720px]:w-auto max-[720px]:flex-1' : 'flex-1'}`}
                  >
                    {selected ? (
                      <Detail
                        key={marketKey(selected.kind, selected.id)}
                        {...{ market, connected, send, install }}
                        row={selected}
                        busy={marketKey(selected.kind, selected.id) in pending}
                      />
                    ) : loading ? (
                      <p className="text-sm text-muted">Loading the marketplace…</p>
                    ) : null}
                  </div>
                </div>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

const optionId = (row: Row) => `market-${row.kind}-${row.id}`

function emptyText(query: string, kind: MarketKindFilter, show: ShowFilter, listed: boolean) {
  const what = kind === 'theme' ? 'themes' : kind === 'extension' ? 'extensions' : 'themes or extensions'
  if (query.trim()) return `Nothing matches “${query.trim()}”.`
  if (show === 'updates') return 'Everything installed is up to date.'
  if (show === 'installed') return `No ${what} installed.`
  return listed ? `No ${what} in the marketplace yet.` : `No ${what} to show.`
}

function SkeletonRow({ view }: { view: MarketView }) {
  return (
    <div
      className={`flex flex-col gap-6 rounded px-8 ${view === 'compact' ? 'py-6' : 'py-10'} ${view === 'grid' ? 'h-128 border' : ''}`}
      aria-hidden="true"
      data-skeleton=""
    >
      <span className="h-10 w-1/2 rounded-full bg-hover motion-safe:animate-blink" />
      {view !== 'compact' && <span className="h-8 w-5/6 rounded-full bg-hover motion-safe:animate-blink" />}
    </div>
  )
}

// A card's picture: a theme's colours, or an extension's first letter.
function Icon({ row }: { row: Row }) {
  if (row.kind === 'theme' && row.preview) {
    const { bg, panel, accent } = row.preview.dark
    return (
      <span className="flex size-32 shrink-0 overflow-hidden rounded border" style={{ background: bg }} aria-hidden="true">
        <span className="w-10" style={{ background: panel }} />
        <span className="m-auto size-10 rounded-full" style={{ background: accent }} />
      </span>
    )
  }
  return (
    <span
      className="grid size-32 shrink-0 place-items-center rounded border bg-raised text-sm font-semibold text-muted"
      aria-hidden="true"
    >
      {row.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

function Badge({ row }: { row: Row }) {
  if (outdated(row)) return <span className="text-xs text-accent">Update</span>
  if (row.installed?.source === 'local') return <span className="text-xs text-amber">Local</span>
  if (row.installed) return <span className="text-xs text-green">Installed</span>
  return null
}

type RowProps = { row: Row; view: MarketView; selected: boolean; busy: boolean; pick: () => void }

function ListRow({ row, view, selected, busy, pick }: RowProps) {
  const kindLabel = <span className="text-xs text-faint">{row.kind === 'theme' ? 'Theme' : 'Extension'}</span>
  const state = busy ? <span className="text-xs text-muted">Installing…</span> : <Badge row={row} />
  if (view === 'grid') {
    return (
      <div
        id={optionId(row)}
        role="option"
        aria-selected={selected}
        aria-label={row.name}
        className="flex h-128 cursor-default flex-col gap-6 rounded border bg-bg p-10 transition-colors hover:bg-raised aria-selected:border-accent aria-selected:bg-raised"
        onClick={pick}
      >
        <span className="flex items-center gap-8">
          <Icon row={row} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{row.name}</span>
            {row.author ? <span className="truncate text-xs text-faint">by {row.author}</span> : kindLabel}
          </span>
        </span>
        {row.description && <span className="line-clamp-2 text-sm text-muted">{row.description}</span>}
        <span className="mt-auto flex items-baseline gap-8">
          {kindLabel}
          <span className="ml-auto shrink-0">{state}</span>
        </span>
      </div>
    )
  }
  if (view === 'compact') {
    return (
      <div
        id={optionId(row)}
        role="option"
        aria-selected={selected}
        aria-label={row.name}
        className="flex cursor-default items-baseline gap-8 rounded px-8 py-4 transition-colors hover:bg-raised aria-selected:bg-raised"
        onClick={pick}
      >
        <span className="min-w-0 truncate">{row.name}</span>
        {kindLabel}
        <span className="ml-auto shrink-0">{state}</span>
      </div>
    )
  }
  return (
    <div
      id={optionId(row)}
      role="option"
      aria-selected={selected}
      aria-label={row.name}
      className="flex cursor-default flex-col gap-2 rounded px-8 py-8 transition-colors hover:bg-raised aria-selected:bg-raised"
      onClick={pick}
    >
      <span className="flex items-baseline gap-8">
        <span className="min-w-0 truncate">{row.name}</span>
        {kindLabel}
        <span className="ml-auto shrink-0">{state}</span>
      </span>
      {row.description && <span className="truncate text-sm text-muted">{row.description}</span>}
      {row.author && <span className="text-xs text-faint">by {row.author}</span>}
    </div>
  )
}

type DetailProps = {
  row: Row
  busy: boolean
  market: Market
  connected: boolean
  send: (m: ClientMessage) => void
  install: (row: Row) => void
}

function Detail({ row, busy, market, connected, send, install }: DetailProps) {
  const { theme: inUse } = useAppearance()
  const failure = market.marketFailures[marketKey(row.kind, row.id)]
  const update = outdated(row)
  const canInstall = row.listed && row.latest !== undefined
  const info = market.extensions?.find((m) => m.id === row.id)
  return (
    <article className="flex max-w-[64ch] flex-col gap-14" aria-label={row.name}>
      <div className="flex flex-col gap-4">
        <h3 className="flex flex-wrap items-baseline gap-x-10 text-[18px] font-semibold">
          {row.name}
          <span className="text-sm font-normal text-faint">{row.kind === 'theme' ? 'Theme' : 'Extension'}</span>
        </h3>
        <span className="flex flex-wrap items-baseline gap-x-10 text-sm text-muted">
          {row.author && <span>by {row.author}</span>}
          {row.repo && (
            <a
              className="text-faint underline-offset-2 hover:underline"
              href={`https://github.com/${row.repo}`}
              target="_blank"
              rel="noreferrer"
            >
              github.com/{row.repo}
            </a>
          )}
        </span>
        <span className="flex flex-wrap gap-x-12 text-sm">
          {row.latest && <span className="text-muted">Latest {row.latest}</span>}
          {row.installed && <Source item={row.installed} />}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        {row.kind === 'theme' && row.theme && (
          <Button
            variant={inUse === row.id ? 'default' : 'primary'}
            disabled={inUse === row.id}
            onClick={() => chooseAppearance({ theme: row.id })}
          >
            {inUse === row.id ? 'In use' : 'Use'}
          </Button>
        )}
        {canInstall && (!row.installed || update) && (
          <Button variant={row.installed ? 'default' : 'primary'} disabled={!connected || busy} onClick={() => void install(row)}>
            {busy ? (row.installed ? 'Updating…' : 'Installing…') : row.installed ? `Update to ${row.latest}` : 'Install'}
          </Button>
        )}
        {canInstall && update && <SeeChanges row={row} />}
        {row.installed?.source === 'local' && row.installed.path && (
          <Button disabled={!connected} onClick={() => send({ type: 'market.installLocal', path: row.installed!.path! })}>
            Reinstall
          </Button>
        )}
        {row.installed && (
          <Button
            variant="ghost"
            disabled={!connected || busy}
            onClick={() => send({ type: 'market.uninstall', kind: row.kind, id: row.id })}
          >
            Uninstall
          </Button>
        )}
      </div>
      {busy && <Progress label={row.installed ? `Updating ${row.name}` : `Installing ${row.name}`} />}
      {failure && !busy && <ErrorText>{failure.error}</ErrorText>}
      {row.problem && <p className="text-sm text-amber">{row.problem}</p>}
      {!row.listed && row.installed?.source === 'marketplace' && market.catalog?.entries && (
        <p className="text-sm text-faint">No longer in the marketplace</p>
      )}
      {row.kind === 'extension' && row.installed && <ExtensionStatus info={info} communityExtensions={market.communityExtensions ?? false} />}
      {row.description && <p className="text-body leading-[1.5]">{row.description}</p>}
      {row.kind === 'theme' && <Swatches preview={row.preview} name={row.name} />}
      {row.kind === 'extension' && row.uses && (
        <section className="flex flex-col gap-6">
          <h4 className="text-sm font-semibold">What it says it uses</h4>
          <UsesList uses={row.uses} />
          <p className="text-sm text-amber">{EXTENSION_WARNING}</p>
        </section>
      )}
      {row.notes && (
        <section className="flex flex-col gap-6">
          <h4 className="text-sm font-semibold">Release notes{row.latest && `, ${row.latest}`}</h4>
          <p className="text-sm leading-[1.5] whitespace-pre-line text-muted">{row.notes}</p>
        </section>
      )}
    </article>
  )
}

// An install has no steps to count, so the bar only says it's under way.
function Progress({ label }: { label: string }) {
  return (
    <div role="progressbar" aria-label={label} className="h-3 w-full max-w-240 overflow-hidden rounded-full bg-hover">
      <div className="indeterminate h-full w-1/3 rounded-full bg-accent" />
    </div>
  )
}
