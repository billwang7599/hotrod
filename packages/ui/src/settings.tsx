// The Settings dialog: its page list and navigation. Each page's content lives in settings/.
import { Fragment } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog, Tabs } from 'radix-ui'
import { CONTEXT_SECTIONS } from '@kothar/core/shared'
import { SECTIONS } from './context-panel.tsx'
import { Button, CHAT_NOUN, GROUP, MOTION, NAV_LABEL, Switch, useReturnFocus } from './controls.tsx'
import { engineProblem } from './state.ts'
import { ShortcutsPage } from './shortcuts-page.tsx'
import { SetupsPage } from './setups-page.tsx'
import { EngineAccountsSection } from './settings/accounts.tsx'
import { AppearancePage } from './settings/appearance.tsx'
import { CommunityExtensionsPage } from './settings/community.tsx'
import { extensionPages, ExtensionsPage } from './settings/extensions.tsx'
import { ModelListsSection } from './settings/models.tsx'
import { SettingRow } from './settings/rows.tsx'
import { NAV_GROUPS, type Page, type PageProps } from './settings/types.ts'
import { WORK_FOLDER_INTRO, WorkFolderPage } from './settings/work-folder.tsx'
import { WORKERS_INTRO, WorkersPage } from './settings/workers.tsx'

const PAGES = [
  {
    id: 'engines',
    group: 'Options',
    title: 'Engines',
    intro: 'Kothar only starts the engines you turn on here.',
    body: ({ engines, connected, send }: PageProps) => (
      <div className={GROUP}>
        {engines.map((engine) => {
          const problem = engineProblem(engine)
          return (
            <SettingRow
              key={engine.id}
              name={<span className="font-mono">{engine.id}</span>}
              description={
                <span className={`block first-letter:uppercase ${problem ? 'text-amber' : 'text-green'}`}>
                  {problem ?? 'Ready'}
                  {engine.detail && ` · ${engine.detail}`}
                </span>
              }
            >
              <Switch
                label={`${engine.id} on`}
                checked={engine.enabled}
                disabled={!connected}
                onChange={(enabled) => send({ type: 'engine.setEnabled', engine: engine.id, enabled })}
              />
            </SettingRow>
          )
        })}
      </div>
    ),
  },
  {
    id: 'work',
    group: 'Options',
    title: 'Work folder',
    intro: WORK_FOLDER_INTRO,
    body: (props: PageProps) => <WorkFolderPage {...props} />,
  },
  {
    id: 'appearance',
    group: 'Options',
    title: 'Appearance',
    body: ({ openMarketplace }: PageProps) => <AppearancePage openMarketplace={openMarketplace} />,
  },
  {
    id: 'shortcuts',
    group: 'Options',
    title: 'Shortcuts',
    intro: 'Click an action\'s keys, then press new ones.',
    body: () => <ShortcutsPage />,
  },
  {
    id: 'accounts',
    group: 'Options',
    title: 'Accounts',
    intro:
      'Each engine runs as its Active account: one saved here, or whoever the engine itself is signed in as. ' +
      'Accounts show while their engine is on.',
    body: ({ engines, accounts, connected, send }: PageProps) => {
      const shown = engines.flatMap((e) => (e.enabled ? accounts.filter((a) => a.engine === e.id) : []))
      if (!shown.length) return <p className="text-muted">Turn on an engine to manage its accounts.</p>
      return shown.map((a) => <EngineAccountsSection key={a.engine} accounts={a} connected={connected} send={send} />)
    },
  },
  {
    id: 'models',
    group: 'Options',
    title: 'Models',
    intro:
      'Each list runs its first model that can run, on any engine; if that engine is off or stops offering it, the ' +
      `next one runs. A ${CHAT_NOUN.one}'s own pick in its message box comes first.`,
    body: ({ engines, modelLists, connected, send }: PageProps) => {
      if (!engines.some((e) => e.enabled)) return <p className="text-muted">Turn on an engine to pick models.</p>
      return <ModelListsSection engines={engines} lists={modelLists} connected={connected} send={send} />
    },
  },
  {
    id: 'workers',
    group: 'Options',
    title: 'Workers',
    intro: WORKERS_INTRO,
    body: ({ workers, connected, send }: PageProps) => <WorkersPage workers={workers} connected={connected} send={send} />,
  },
  {
    id: 'setups',
    group: 'Options',
    title: 'Setups',
    intro:
      `A setup is a saved model, thinking level, extensions and instructions for a kind of job. Pick one for a ${CHAT_NOUN.one} ` +
      'in its General tab; a lead can also start a worker with one by name. What a setup leaves out follows Settings.',
    body: ({ setups = [], setupSave, engines, extensions, connected, send }: PageProps) => (
      <SetupsPage setups={setups} engines={engines} extensions={extensions} connected={connected} send={send} saved={setupSave} />
    ),
  },
  {
    id: 'context',
    group: 'Options',
    title: 'Context',
    intro:
      `What a ${CHAT_NOUN.one} uses from the global AGENTS.md and the chats above it, unless you switch it in its ` +
      'Context panel. Its own AGENTS.md, folders and files always start on.',
    body: ({ contextDefaults, connected, send }: PageProps) => (
      <div className={GROUP}>
        {CONTEXT_SECTIONS.map((section) => (
          <SettingRow key={section} name={SECTIONS[section].label} description={SECTIONS[section].inherited}>
            <Switch
              label={`${SECTIONS[section].label} from above on by default`}
              checked={contextDefaults[section]}
              disabled={!connected}
              onChange={(enabled) => send({ type: 'context.setDefault', section, enabled })}
            />
          </SettingRow>
        ))}
      </div>
    ),
  },
  {
    id: 'extensions',
    group: 'Extensions',
    title: 'Built-in extensions',
    intro: 'Extensions that ship with Kothar. One with settings or a setup gets its own page while it is on.',
    body: (props: PageProps) => <ExtensionsPage {...props} />,
  },
  {
    id: 'community-extensions',
    group: 'Extensions',
    title: 'Community hub',
    intro: 'Extensions installed from the Marketplace or a folder. Each stays off until you turn it on, and changes apply when Kothar restarts.',
    body: (props: PageProps) => <CommunityExtensionsPage {...props} />,
  },
] as const satisfies readonly Page[]

export type SettingsPage = (typeof PAGES)[number]['id'] | `extension:${string}`

type SettingsProps = PageProps & {
  open: boolean
  page: SettingsPage
  openPage: (page: SettingsPage) => void
  close: () => void
}

export function SettingsDialog({ open, page, openPage, close, ...props }: SettingsProps) {
  const focus = useReturnFocus()
  const pages: readonly Page[] = [...PAGES, ...extensionPages(props.extensions, props.communityExtensions ?? false)]
  const current = pages.find((p) => p.id === page) ?? PAGES[0]
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
                className="fixed inset-0 m-auto flex h-[min(620px,calc(100vh-32px))] w-[min(880px,calc(100vw-32px))] overflow-hidden rounded-xl border bg-bg text-text shadow-overlay"
                {...MOTION.pop}
              >
                <Dialog.Title className="sr-only">Settings</Dialog.Title>
                <Tabs.Root
                  className="flex min-w-0 flex-1 max-[600px]:flex-col"
                  orientation="vertical"
                  value={current.id}
                  onValueChange={(id) => openPage(id as SettingsPage)}
                >
                  <Tabs.List
                    aria-label="Settings"
                    className="flex w-200 shrink-0 scroll-inset flex-col gap-1 overflow-y-auto border-r bg-panel pt-4 pr-0 pb-12 pl-8 max-[720px]:w-160 max-[600px]:w-auto max-[600px]:flex-row max-[600px]:flex-wrap max-[600px]:border-r-0 max-[600px]:border-b max-[600px]:py-8 max-[600px]:pr-44"
                  >
                    {NAV_GROUPS.map((group) => (
                      <Fragment key={group}>
                        <div className={`${NAV_LABEL} max-[600px]:hidden`}>{group}</div>
                        {pages
                          .filter((p) => p.group === group)
                          .map((p) => (
                            <Tabs.Trigger key={p.id} value={p.id} asChild>
                              <button className="flex h-control shrink-0 items-center rounded px-8 text-left text-muted transition-colors hover:bg-raised hover:text-text data-[state=active]:bg-raised data-[state=active]:text-text">
                                {p.title}
                              </button>
                            </Tabs.Trigger>
                          ))}
                      </Fragment>
                    ))}
                  </Tabs.List>
                  {pages.map((p) => (
                    <Tabs.Content key={p.id} value={p.id} asChild>
                      <m.div
                        className="min-h-0 min-w-0 flex-1 scroll-inset overflow-y-auto pt-20 pr-18 pb-32 pl-32 [--scroll-top:48px] focus-visible:-outline-offset-2 max-[600px]:pr-2 max-[600px]:pl-16"
                        initial={MOTION.fade.initial}
                        animate={MOTION.fade.animate}
                      >
                        <h2 className="pr-24 text-[16px] font-semibold">{p.title}</h2>
                        {p.intro && <p className="mt-4 max-w-[60ch] pr-24 text-sm text-muted">{p.intro}</p>}
                        <div className="mt-16 flex flex-col">{p.body(props)}</div>
                      </m.div>
                    </Tabs.Content>
                  ))}
                </Tabs.Root>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="icon" aria-label="Close" className="absolute top-14 right-14">
                    ×
                  </Button>
                </Dialog.Close>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
