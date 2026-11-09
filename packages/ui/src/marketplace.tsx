import { useEffect, useState, type FormEvent } from 'react'
import type { ModUse } from '@kotharhq/mod-api'
import {
  changesUrl,
  MOD_USES,
  previewOf,
  type ClientMessage,
  type InstalledItem,
  type MarketEntry,
  type MarketKind,
  type ModInfo,
  type ThemeFile,
  type ThemePreview,
} from '@kotharhq/core/shared'
import { Button, confirm, ErrorText, GROUP, Hint } from './controls.tsx'
import { marketKey, type State } from './state.ts'
import { chooseAppearance, useAppearance } from './themes.tsx'

export type Market = Pick<State, 'catalog' | 'themes' | 'installed' | 'marketFailures'> &
  Partial<Pick<State, 'mods' | 'localInstall'>>

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
  uses?: ModUse[]
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
  const { marketFailures, installed, catalog } = market
  // Installs sent and not yet answered, with how many failures the item had when it was sent.
  const [pending, setPending] = useState<Record<string, number>>({})
  useEffect(() => {
    setPending((was) => {
      const still = Object.entries(was).filter(([key, failures]) => {
        const [kind, id] = key.split(':') as [MarketKind, string]
        const row = rowsOf(market, kind).find((r) => r.id === id)
        const done = row?.installed && !outdated(row)
        return !done && (marketFailures[key]?.count ?? 0) === failures
      })
      return still.length === Object.keys(was).length ? was : Object.fromEntries(still)
    })
  }, [installed, marketFailures, catalog])
  const start = (key: string) => setPending((was) => ({ ...was, [key]: marketFailures[key]?.count ?? 0 }))
  return { pending, start }
}

// Uses that reach beyond Kothar itself: shown in amber.
const REACHING: ModUse[] = ['run', 'setup', 'mcpServers', 'permissions', 'sendMessages', 'accounts']

// What a community mod says it uses through the mod API, in plain words.
export function UsesList({ uses }: { uses: readonly ModUse[] }) {
  if (!uses.length) return <span className="text-sm text-muted">Uses nothing through the mod API</span>
  return (
    <ul className="flex flex-wrap gap-x-12 gap-y-2 text-sm" aria-label="Uses">
      {uses.map((use) => (
        <li key={use} className={REACHING.includes(use) ? 'text-amber' : 'text-muted'}>
          {MOD_USES[use]}
        </li>
      ))}
    </ul>
  )
}

// Whether an installed mod is on and running, as one quiet line.
export function ModStatus({ info }: { info?: ModInfo }) {
  const status = modStatus(info)
  return status ? <span className="text-sm text-faint">{status}</span> : null
}

export function modStatus(info?: ModInfo) {
  if (!info?.community) return undefined
  const { version, running } = info.community
  if (!info.enabled) return running ? 'Off. Its code stays loaded until Kothar restarts.' : 'Off. Turn it on in Community mods.'
  if (info.loadError) return undefined
  if (!running) return 'On from the next start of Kothar.'
  if (running !== version) return `Running ${running}. Restart Kothar to run ${version}.`
  return undefined
}

export const MOD_WARNING =
  'A community mod runs code on your computer with your permissions. Kothar holds it to what it lists, but it could ' +
  'still read your files or reach the network on its own. Turn on only mods you trust.'

const usesText = (uses: readonly ModUse[]) => uses.map((use) => `• ${MOD_USES[use]}`).join('\n')

const LOCAL_HINT =
  'Installs a mod (a folder with manifest.json and a built main.mjs) or themes (<id>.json files) from this computer, ' +
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
            placeholder="/path/to/my-mod"
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
          {shown.kind === 'mod' ? '. Turn it on in Community mods.' : '.'}
        </span>
      )}
    </div>
  )
}

export function MarketplacePage({ market, connected, send, pickFolder }: Props) {
  const { catalog } = market
  const { pending, start } = usePending(market)

  useEffect(() => {
    if (connected) send({ type: 'marketplace.list' })
  }, [connected, send])

  const install = async (row: Row) => {
    if (row.kind === 'mod' && !row.installed) {
      const ok = await confirm(
        `Install ${row.name}? It stays off until you turn it on in Community mods.\n\n` +
          (row.uses?.length ? `It says it:\n${usesText(row.uses)}` : 'It says it uses nothing through the mod API.'),
      )
      if (!ok) return
    }
    start(marketKey(row.kind, row.id))
    send({ type: 'market.install', kind: row.kind, id: row.id })
  }

  return (
    <>
      <InstallFromFolder {...{ market, connected, send, pickFolder }} />
      {catalog === undefined && <p className="pb-12 text-sm text-muted">Loading the marketplace…</p>}
      {catalog?.error && (
        <div className="flex flex-wrap items-center gap-x-12 gap-y-6 pb-12">
          <ErrorText>{catalog.error}</ErrorText>
          <Button disabled={!connected} onClick={() => send({ type: 'marketplace.list' })}>
            Try again
          </Button>
        </div>
      )}
      <Section
        title="Themes"
        rows={rowsOf(market, 'theme')}
        empty={catalog?.entries ? 'No themes in the marketplace yet.' : undefined}
        {...{ market, pending, connected, send, install }}
      />
      <Section
        title="Mods"
        rows={rowsOf(market, 'mod')}
        empty={catalog?.entries ? 'No mods in the marketplace yet.' : undefined}
        warning={MOD_WARNING}
        {...{ market, pending, connected, send, install }}
      />
    </>
  )
}

type SectionProps = {
  title: string
  rows: Row[]
  empty?: string
  warning?: string
  market: Market
  pending: Record<string, number>
  connected: boolean
  send: (m: ClientMessage) => void
  install: (row: Row) => void
}

function Section({ title, rows, empty, warning, market, pending, connected, send, install }: SectionProps) {
  const { theme: inUse } = useAppearance()
  return (
    <section className="pb-16">
      <div className="pb-8 font-semibold">{title}</div>
      {warning && <p className="pb-8 text-sm text-amber">{warning}</p>}
      {!rows.length && empty && <p className="text-sm text-muted">{empty}</p>}
      {rows.length > 0 && (
        <div className={GROUP} aria-label={`Marketplace ${title.toLowerCase()}`} role="list">
          {rows.map((row) => {
            const key = marketKey(row.kind, row.id)
            const busy = key in pending
            const failure = market.marketFailures[key]
            const update = outdated(row)
            const canInstall = row.listed && row.latest !== undefined
            return (
              <div
                key={key}
                role="listitem"
                aria-label={row.name}
                className="flex flex-wrap items-center gap-x-16 gap-y-8 py-12 not-first:border-t"
              >
                <Swatches preview={row.preview} name={row.name} />
                <div className="flex min-w-200 flex-1 flex-col gap-2 wrap-anywhere">
                  <span className="flex flex-wrap items-baseline gap-x-8">
                    <span>{row.name}</span>
                    {row.author && <span className="text-xs text-faint">by {row.author}</span>}
                    {row.installed && <Source item={row.installed} />}
                    {!row.installed && row.latest && <span className="text-xs text-faint">{row.latest}</span>}
                  </span>
                  {row.description && <span className="text-sm text-muted">{row.description}</span>}
                  {row.repo && (
                    <a
                      className="w-fit text-xs text-faint underline-offset-2 hover:underline"
                      href={`https://github.com/${row.repo}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.repo}
                    </a>
                  )}
                  {!row.listed && row.installed?.source === 'marketplace' && catalog(market) && (
                    <span className="text-sm text-faint">No longer in the marketplace</span>
                  )}
                  {row.kind === 'mod' && row.uses && <UsesList uses={row.uses} />}
                  {row.kind === 'mod' && row.installed && <ModStatus info={market.mods?.find((m) => m.id === row.id)} />}
                  {row.problem && <span className="text-sm text-amber">{row.problem}</span>}
                </div>
                <div className="flex items-center gap-6">
                  {row.kind === 'theme' && row.theme && (
                    <Button
                      variant={inUse === row.id ? 'default' : 'primary'}
                      disabled={inUse === row.id}
                      onClick={() => chooseAppearance({ theme: row.id })}
                    >
                      {inUse === row.id ? 'In use' : 'Use'}
                    </Button>
                  )}
                  {canInstall && update && <SeeChanges row={row} />}
                  {canInstall && (!row.installed || update) && (
                    <Button
                      variant={row.installed ? 'default' : 'primary'}
                      disabled={!connected || busy}
                      onClick={() => void install(row)}
                    >
                      {busy
                        ? row.installed
                          ? 'Updating…'
                          : 'Installing…'
                        : row.installed
                          ? `Update to ${row.latest}`
                          : 'Install'}
                    </Button>
                  )}
                  {row.installed?.source === 'local' && row.installed.path && (
                    <Button
                      disabled={!connected}
                      onClick={() => send({ type: 'market.installLocal', path: row.installed!.path! })}
                    >
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
                {failure && !busy && (
                  <div className="basis-full">
                    <ErrorText>{failure.error}</ErrorText>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

const catalog = (market: Market) => market.catalog?.entries !== undefined
