// The Built-in extensions page, an extension's setup (dialog and row), and the page every extension gets.
import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { AlertDialog } from 'radix-ui'
import { settingProblem, type ClientMessage, type ExtensionInfo } from '@kothar/core/shared'
import type { ExtensionSetting } from '@kothar/extension-api'
import { Button, ErrorText, GROUP, MOTION, Select, Switch, useReturnFocus } from '../controls.tsx'
import { UsesList } from '../marketplace.tsx'
import { ExtensionViewer } from '../extension-view.tsx'
import { linked, SettingRow } from './rows.tsx'
import type { Page, PageProps } from './types.ts'

export function ExtensionsPage({ extensions: all, connected, send }: PageProps) {
  const extensions = all.filter((m) => !m.community)
  const [setupFor, setSetupFor] = useState<string>()
  const [setupShown, setSetupShown] = useState(false)
  const extension = extensions.find((m) => m.id === setupFor && m.enabled)
  const status = extension?.setup?.status
  const settled = !status || status === 'ready'
  if (setupFor && settled && status !== undefined) setSetupFor(undefined)
  const open = !settled && (setupShown || status !== 'checking')
  if (open !== setupShown) setSetupShown(open)
  const close = () => {
    setSetupFor(undefined)
    setSetupShown(false)
  }
  return (
    <div className={GROUP}>
      {extensions.map((m) => (
        <SettingRow
          key={m.id}
          name={m.name}
          description={
            <>
              {m.description}
              {m.enabled && m.setup?.status === 'missing' && <span className="block text-amber">{setupTitle(m)}</span>}
            </>
          }
          below={m.loadError && <ErrorText>Couldn't load: {m.loadError}</ErrorText>}
        >
          <Switch
            label={m.name}
            checked={m.enabled}
            disabled={!connected || m.loadError !== undefined}
            onChange={(enabled) => {
              send({ type: 'extension.setEnabled', extensionId: m.id, enabled })
              if (enabled && m.setup) setSetupFor(m.id)
            }}
          />
        </SettingRow>
      ))}
      {extension?.setup && <ExtensionSetupDialog open={open} extension={extension} connected={connected} send={send} close={close} />}
    </div>
  )
}


const setupTitle = (extension: ExtensionInfo) => extension.setup?.message ?? `${extension.name} isn't set up`

type SetupProps = { extension: ExtensionInfo; connected: boolean; send: (m: ClientMessage) => void }

function SetupStatus({ extension }: { extension: ExtensionInfo }) {
  const setup = extension.setup!
  const percent = Math.round((setup.progress ?? 0) * 100)
  return (
    <>
      {setup.status === 'installing' && (
        <div className="flex flex-col gap-6">
          <div
            role="progressbar"
            aria-label={`Installing ${extension.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-6 overflow-hidden rounded-full bg-raised shadow-sunken"
          >
            <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-sm text-muted">{setup.progressText ?? 'Installing…'}</span>
        </div>
      )}
      {setup.status === 'checking' && <span className="text-sm text-muted">Checking…</span>}
      {setup.error && <ErrorText>{setup.error}</ErrorText>}
    </>
  )
}

function ExtensionSetupDialog({ open, extension, connected, send, close }: SetupProps & { open: boolean; close: () => void }) {
  const focus = useReturnFocus()
  const installing = extension.setup?.status === 'installing'
  const cancel = () => {
    if (installing) send({ type: 'extension.cancelInstall', extensionId: extension.id })
    close()
  }
  return (
    <AlertDialog.Root open={open} onOpenChange={(open) => open || close()}>
      <AnimatePresence>
        {open && (
          <AlertDialog.Portal forceMount>
            <AlertDialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </AlertDialog.Overlay>
            <AlertDialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-0 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] flex-col gap-16 scroll-inset overflow-y-auto rounded-xl border bg-panel pt-14 pr-2 pb-16 pl-16 text-text shadow-overlay"
                {...MOTION.pop}
              >
                <div className="flex flex-col gap-4">
                  <AlertDialog.Title className="text-[16px] font-semibold">{setupTitle(extension)}</AlertDialog.Title>
                  {extension.setup?.description && <p className="text-sm text-muted">{linked(extension.setup.description)}</p>}
                </div>
                <SetupStatus extension={extension} />
                <div className="flex justify-end gap-8">
                  <Button onClick={cancel}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={!connected || extension.setup?.status !== 'missing'}
                    onClick={() => send({ type: 'extension.install', extensionId: extension.id })}
                  >
                    {installing ? 'Installing…' : 'Install'}
                  </Button>
                </div>
              </m.div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        )}
      </AnimatePresence>
    </AlertDialog.Root>
  )
}

function ExtensionSetupRow({ extension, connected, send }: SetupProps) {
  const status = extension.setup!.status
  return (
    <SettingRow
      name={<span className={status === 'ready' ? '' : 'text-amber'}>{setupTitle(extension)}</span>}
      description={linked(extension.setup!.description)}
      below={(status === 'installing' || status === 'checking' || extension.setup!.error) && <SetupStatus extension={extension} />}
    >
      {status === 'ready' && <span className="rounded-full bg-green/14 px-8 py-2 text-xs text-green">Ready</span>}
      {status === 'missing' && (
        <Button variant="primary" disabled={!connected} onClick={() => send({ type: 'extension.install', extensionId: extension.id })}>
          Install
        </Button>
      )}
      {status === 'installing' && (
        <Button disabled={!connected} onClick={() => send({ type: 'extension.cancelInstall', extensionId: extension.id })}>
          Cancel
        </Button>
      )}
    </SettingRow>
  )
}

// The extension's own part of its page (Extension.settingsView), drawn by the core. Opening the page asks for a fresh
// one, as what it shows (such as disk use) may have changed since.
function ExtensionSettingsView({ extension, connected, send }: SetupProps) {
  const { id } = extension
  useEffect(() => {
    if (connected) send({ type: 'extension.settingsView.get', extensionId: id })
  }, [connected, id, send])
  const shown = extension.settingsView
  if (!shown) return null
  return (
    <div className="flex flex-col py-12 not-first:border-t">
      <ExtensionViewer
        view={shown.view}
        error={shown.error}
        act={(action) => connected && send({ type: 'extension.settingsView.action', extensionId: id, action })}
        reveal={(path) => connected && send({ type: 'reveal', path })}
      />
    </div>
  )
}

// An extension with something to set (settings, a setup or a settings view) gets a page, as in Obsidian; one without
// gets none. Each page starts with the same header, saying what it is, whether it's on and what it may do, then its
// setup, settings and settings view. It keeps its page while off. A community extension's page shows while community
// extensions are on (its switch and details are in Community hub too).
export const hasPage = (extension: ExtensionInfo) =>
  !!(extension.setup || extension.settings.length || extension.settingsView)

export const extensionPages = (extensions: ExtensionInfo[], communityExtensions: boolean): Page[] =>
  extensions
    .filter((extension) => (!extension.community || communityExtensions) && hasPage(extension))
    .map((extension) => ({
      id: `extension:${extension.id}`,
      group: 'Extensions',
      title: extension.name,
      body: ({ connected, send }: PageProps) => <ExtensionPage extension={extension} connected={connected} send={send} />,
    }))

function ExtensionPage({ extension, connected, send }: SetupProps) {
  const { enabled, community } = extension
  // A community extension's settings view draws only while it runs; a built-in's, while off too.
  const shownOff = !!extension.settingsView && !community
  const uses = community?.uses ?? extension.uses
  return (
    <div className={GROUP}>
      <SettingRow
        name={extension.name}
        description={
          <>
            {extension.description}
            <span className="block text-faint" data-testid="extension-kind">
              {community
                ? `Community extension · ${community.version}${community.author ? ` by ${community.author}` : ''}`
                : 'Built-in extension'}
            </span>
          </>
        }
        below={extension.loadError && <ErrorText>Couldn't load: {extension.loadError}</ErrorText>}
      >
        <Switch
          label={`${extension.name} on`}
          checked={enabled}
          disabled={!connected || (!community && extension.loadError !== undefined)}
          onChange={(on) => send({ type: 'extension.setEnabled', extensionId: extension.id, enabled: on })}
        />
      </SettingRow>
      {uses && <SettingRow name={community ? 'Uses' : 'What it does'} description={<UsesList uses={uses} />} />}
      {enabled && extension.setup && <ExtensionSetupRow extension={extension} connected={connected} send={send} />}
      {enabled && extension.settings.map((setting) => (
        <ExtensionSettingRow
          key={setting.key}
          setting={setting}
          value={extension.values[setting.key]}
          disabled={!connected}
          save={(value) => send({ type: 'extension.setValue', extensionId: extension.id, key: setting.key, value })}
        />
      ))}
      {extension.settingsView && <ExtensionSettingsView extension={extension} connected={connected} send={send} />}
      {!enabled && !shownOff && (
        <p className="py-12 text-sm text-faint">Turn {extension.name} on to change its settings.</p>
      )}
    </div>
  )
}

type ExtensionSettingProps = {
  setting: ExtensionSetting
  value: string | number | boolean | undefined
  disabled: boolean
  save: (value: string | number | boolean) => void
}

function ExtensionSettingRow({ setting, value, disabled, save }: ExtensionSettingProps) {
  const [draft, setDraft] = useState(String(value))
  const [was, setWas] = useState(value)
  if (value !== was) {
    setWas(value)
    setDraft(String(value))
  }
  const row = (control: ReactNode, below?: ReactNode) => (
    <SettingRow name={setting.label} description={setting.description && linked(setting.description)} below={below}>
      {control}
    </SettingRow>
  )
  if (setting.type === 'boolean') {
    return row(<Switch label={setting.label} checked={value === true} disabled={disabled} onChange={save} />)
  }
  if (setting.type === 'text') {
    const reset = () => {
      setDraft(setting.default)
      save('')
    }
    const commit = () => {
      if (!draft.trim()) reset()
      else if (draft !== value) save(draft)
    }
    return row(
      draft !== setting.default && (
        <Button size="small" disabled={disabled} onClick={reset}>
          Reset to default
        </Button>
      ),
      <textarea
        className="block w-full resize-y px-8 py-6 font-mono text-sm leading-[1.5] focus:border-accent disabled:text-muted"
        aria-label={setting.label}
        rows={setting.rows ?? 4}
        spellCheck={false}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />,
    )
  }
  if (setting.type === 'select') {
    return row(
      <Select
        label={setting.label}
        value={String(value)}
        disabled={disabled}
        options={setting.options.map((option) => ({ value: String(option.value), label: option.label }))}
        onChange={(picked) => {
          const option = setting.options.find((o) => String(o.value) === picked)
          if (option) save(option.value)
        }}
      />,
    )
  }
  const commit = () => {
    const next = Number(draft)
    if (draft.trim() && !settingProblem(setting, next) && next !== value) save(next)
    else setDraft(String(value))
  }
  return row(
    <input
      className="w-72"
      aria-label={setting.label}
      type="number"
      min={setting.min}
      max={setting.max}
      step={setting.integer ? 1 : 'any'}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />,
  )
}
