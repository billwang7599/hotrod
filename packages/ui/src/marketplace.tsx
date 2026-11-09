import { useEffect, useState } from 'react'
import {
  previewOf,
  type ClientMessage,
  type InstalledItem,
  type MarketEntry,
  type MarketKind,
  type ThemeFile,
  type ThemePreview,
} from '@kotharhq/core/shared'
import { Button, ErrorText, GROUP, Hint } from './controls.tsx'
import { marketKey, type State } from './state.ts'
import { chooseAppearance, useAppearance } from './themes.tsx'

export type Market = Pick<State, 'catalog' | 'themes' | 'installed' | 'marketFailures'>

type Props = { market: Market; connected: boolean; send: (m: ClientMessage) => void }

type Row = {
  kind: MarketKind
  id: string
  name: string
  author?: string
  description?: string
  repo?: string
  // The version the author's latest release carries, and why it couldn't be read.
  latest?: string
  problem?: string
  preview?: ThemePreview
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
        ...(latest && { latest: latest.version, preview: latest.preview }),
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

export function MarketplacePage({ market, connected, send }: Props) {
  const { catalog } = market
  const { pending, start } = usePending(market)

  useEffect(() => {
    if (connected) send({ type: 'marketplace.list' })
  }, [connected, send])

  const install = (row: Row) => {
    start(marketKey(row.kind, row.id))
    send({ type: 'market.install', kind: row.kind, id: row.id })
  }

  return (
    <>
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
    </>
  )
}

type SectionProps = {
  title: string
  rows: Row[]
  empty?: string
  market: Market
  pending: Record<string, number>
  connected: boolean
  send: (m: ClientMessage) => void
  install: (row: Row) => void
}

function Section({ title, rows, empty, market, pending, connected, send, install }: SectionProps) {
  const { theme: inUse } = useAppearance()
  return (
    <section className="pb-16">
      <div className="pb-8 font-semibold">{title}</div>
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
                  {canInstall && (!row.installed || update) && (
                    <Button
                      variant={row.installed ? 'default' : 'primary'}
                      disabled={!connected || busy}
                      onClick={() => install(row)}
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
