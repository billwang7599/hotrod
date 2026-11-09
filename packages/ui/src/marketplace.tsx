import { useEffect, useState } from 'react'
import { previewOf, type CatalogEntry, type ClientMessage, type ThemeFile, type ThemePreview } from '@kotharhq/core/shared'
import { Button, ErrorText, GROUP } from './controls.tsx'
import type { State } from './state.ts'
import { chooseAppearance, useAppearance } from './themes.tsx'

export type Market = Pick<State, 'catalog' | 'themes' | 'themeFailures'>

type Props = { market: Market; connected: boolean; send: (m: ClientMessage) => void }

type Row = {
  id: string
  name: string
  author: string
  description: string
  version: string
  preview?: ThemePreview
  listed: boolean
  installed?: ThemeFile
}

// Catalog entries first, in its order, then installed themes the catalog doesn't list (or can't, while offline).
function rowsOf({ catalog, themes = [] }: Market): Row[] {
  const byId = new Map(themes.map((theme) => [theme.id, theme]))
  const listed = (catalog?.entries ?? []).map((entry: CatalogEntry): Row => ({ ...entry, listed: true, installed: byId.get(entry.id) }))
  const listedIds = new Set(listed.map((row) => row.id))
  const extra = themes
    .filter((theme) => !listedIds.has(theme.id))
    .map((theme): Row => ({ ...theme, preview: previewOf(theme), listed: false, installed: theme }))
  return [...listed, ...extra]
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

export function MarketplacePage({ market, connected, send }: Props) {
  const { catalog, themes, themeFailures } = market
  const { theme: inUse } = useAppearance()
  // Installs sent and not yet answered, with how many failures the theme had when it was sent.
  const [pending, setPending] = useState<Record<string, number>>({})

  useEffect(() => {
    if (connected) send({ type: 'marketplace.list' })
  }, [connected, send])

  useEffect(() => {
    setPending((was) => {
      const still = Object.entries(was).filter(([id, failures]) => {
        const row = rowsOf(market).find((r) => r.id === id)
        const done = row?.installed && (!row.listed || row.installed.version === row.version)
        return !done && (themeFailures[id]?.count ?? 0) === failures
      })
      return still.length === Object.keys(was).length ? was : Object.fromEntries(still)
    })
  }, [themes, themeFailures, catalog])

  const install = (id: string) => {
    setPending((was) => ({ ...was, [id]: themeFailures[id]?.count ?? 0 }))
    send({ type: 'theme.install', id })
  }

  const rows = rowsOf(market)
  return (
    <>
      <div className="pb-8 font-semibold">Themes</div>
      {catalog === undefined && <p className="text-sm text-muted">Loading the marketplace…</p>}
      {catalog?.error && (
        <div className="flex flex-wrap items-center gap-x-12 gap-y-6 pb-12">
          <ErrorText>{catalog.error}</ErrorText>
          <Button disabled={!connected} onClick={() => send({ type: 'marketplace.list' })}>
            Try again
          </Button>
        </div>
      )}
      {catalog?.entries?.length === 0 && !rows.length && (
        <p className="text-sm text-muted">No themes in the marketplace yet.</p>
      )}
      {rows.length > 0 && (
        <div className={GROUP} aria-label="Marketplace themes" role="list">
          {rows.map((row) => {
            const busy = row.id in pending
            const outdated = row.listed && row.installed && row.installed.version !== row.version
            const failure = themeFailures[row.id]
            return (
              <div
                key={row.id}
                role="listitem"
                aria-label={row.name}
                className="flex flex-wrap items-center gap-x-16 gap-y-8 py-12 not-first:border-t"
              >
                <Swatches preview={row.preview} name={row.name} />
                <div className="flex min-w-200 flex-1 flex-col gap-2 wrap-anywhere">
                  <span className="flex flex-wrap items-baseline gap-x-8">
                    <span>{row.name}</span>
                    <span className="text-xs text-faint">by {row.author}</span>
                    {row.installed && <span className="text-xs text-green">Installed</span>}
                  </span>
                  <span className="text-sm text-muted">{row.description}</span>
                  {!row.listed && catalog?.entries && (
                    <span className="text-sm text-faint">No longer in the marketplace</span>
                  )}
                </div>
                <div className="flex items-center gap-6">
                  {row.installed && (
                    <Button
                      variant={inUse === row.id ? 'default' : 'primary'}
                      disabled={inUse === row.id}
                      onClick={() => chooseAppearance({ theme: row.id })}
                    >
                      {inUse === row.id ? 'In use' : 'Use'}
                    </Button>
                  )}
                  {(!row.installed || outdated) && (
                    <Button
                      variant={row.installed ? 'default' : 'primary'}
                      disabled={!connected || busy}
                      onClick={() => install(row.id)}
                    >
                      {busy ? (row.installed ? 'Updating…' : 'Installing…') : row.installed ? 'Update' : 'Install'}
                    </Button>
                  )}
                  {row.installed && (
                    <Button
                      variant="ghost"
                      disabled={!connected || busy}
                      onClick={() => send({ type: 'theme.uninstall', id: row.id })}
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
    </>
  )
}
