// Turning extensions on and off: one extension's switch, the master switch for community extensions, what a restart
// would change, and a community extension installed, updated or uninstalled. Turning a community extension on approves
// its exact files (approvals.ts); those approvals are kept here. The core passes in its extensions, chats and the rest.
import type { Extension, ExtensionContext, ExtensionUse } from '@kothar/extension-api'
import { type Approval, approve, forget, logHistory, logInstall, reviewOf } from './approvals.ts'
import type { Chat } from './chat.ts'
import type { Settings } from './chat-store.ts'
import { type CommunityEntry, stubOf } from './extensions.ts'
import { installedExtensions, type openMarketplace } from './marketplace.ts'
import { EXTENSION_USES, type ChatState, type CoreMessage, type ExtensionInfo, type RestartChange, type RestartState } from './shared.ts'

export type ExtensionSwitchDeps = {
  garage: string
  /** The core's clock, for the approvals and history it writes. */
  now: () => Date
  settings: Settings
  saveSettings: () => void
  broadcast: (message: CoreMessage) => void
  /** Every extension, which an install adds to and an uninstall takes from. */
  extensions: Extension[]
  /** Community extensions by id, which installs and uninstalls change. */
  community: Map<string, CommunityEntry>
  /** The community extensions this run imported, by id with their name. */
  imported: ReadonlyMap<string, string>
  /** Those installed again since this run imported them. */
  reinstalled: Set<string>
  /** What the user turned on, per community extension, as read at start. */
  approvals: Record<string, Approval>
  canRestart: boolean
  communityOn: () => boolean
  ownSwitch: (extension: Extension) => boolean
  isOn: (extension: Extension) => boolean
  extensionInfo: (extension: Extension) => ExtensionInfo
  saveExtension: (extension: Extension, change: Record<string, unknown>) => void
  checkSetup: (extension: Extension) => Promise<void>
  startExtension: (extension: Extension) => void
  stopExtension: (extension: Extension) => void
  /** Stops the commands the extension started. */
  stopSpawned: (extension: Extension) => void
  forgetHost: (id: string) => void
  marketplace: Pick<ReturnType<typeof openMarketplace>, 'uninstall'>
  chats: ReadonlyMap<string, Chat>
  familyOf: (chat: Chat) => Chat[]
  shownChats: () => Chat[]
  shownState: (chat: Chat) => ChatState
  setWait: (chat: Chat, extensionId: string, wait: undefined) => void
  extensionsOf: (chat: Chat) => CoreMessage
  /** Why something that needs the extension with this id can't be used now, or undefined while it runs. */
  needs: (id: string) => string | undefined
  /** Runs one of the extension's hooks, showing its error if it throws. */
  callExtension: (extension: Extension, run: () => unknown) => void
  contextOf: (extension: Extension) => ExtensionContext
}

// The other extensions that hear when this one switches: those that list it in optionalDependencies or requires, or
// have a setting that requires it.
const dependsOn = (extension: Extension, id: string) =>
  extension.id !== id &&
  (extension.optionalDependencies?.includes(id) === true ||
    extension.requires?.includes(id) === true ||
    extension.settings?.some((setting) => setting.requires === id) === true ||
    extension.spaceSettings?.some((setting) => setting.requires === id) === true)

export function openExtensionSwitches(deps: ExtensionSwitchDeps) {
  const {
    garage,
    now,
    settings,
    saveSettings,
    broadcast,
    extensions,
    community,
    imported,
    reinstalled,
    communityOn,
    ownSwitch,
    isOn,
    extensionInfo,
    saveExtension,
    checkSetup,
    startExtension,
    stopExtension,
    stopSpawned,
    forgetHost,
    marketplace,
    chats,
    familyOf,
    shownChats,
    shownState,
    setWait,
    extensionsOf,
    needs,
    callExtension,
    contextOf,
  } = deps
  let approvals = deps.approvals

  const setExtensionEnabled = (extension: Extension, enabled: boolean) => {
    if (community.has(extension.id) && !communityOn() && enabled) {
      throw new Error(`Turn on community extensions before turning on ${extension.name}`)
    }
    const family = (extension.chats ?? []).flatMap(({ id }) => {
      const chat = chats.get(id)
      return chat ? familyOf(chat) : []
    })
    const busy = family.find((chat) => chat.status !== 'idle')
    if (busy && !enabled) throw new Error(`Stop "${busy.info.name}" before turning ${extension.name} off`)
    const missing = enabled ? (extension.requires ?? []).filter((id) => needs(id) !== undefined) : []
    if (missing.length) {
      const names = missing.map((id) => extensions.find((m) => m.id === id)?.name ?? id)
      throw new Error(`Turn on ${names.join(' and ')} first: ${extension.name} needs ${missing.length > 1 ? 'them' : 'it'}`)
    }
    const changed = isOn(extension) !== enabled
    const from = community.get(extension.id)
    if (from && enabled) {
      // Turning it on approves these exact files; the loader runs nothing else.
      const install = installedExtensions(garage).find((m) => m.manifest.id === extension.id)
      if (install) approvals = { ...approvals, [extension.id]: approve(garage, now, install) }
      delete from.held
    }
    saveExtension(extension, { enabled })
    if (from) restartChanged()
    if (enabled) void checkSetup(extension)
    if (changed) extensionSwitched(extension, enabled, family)
  }

  // What follows an extension starting or stopping to run: its chats show or hide, spawned processes stop, panels
  // update.
  // Whether each extension ran when last switched, so an extension that starts or stops because one it requires did
  // is found (requires can chain).
  const runningNow = new Map(extensions.map((extension) => [extension.id, isOn(extension)]))
  const extensionSwitched = (extension: Extension, enabled: boolean, family = familyOfExtension(extension)) => {
    const changes: { extension: Extension; enabled: boolean }[] = [{ extension, enabled }]
    runningNow.set(extension.id, enabled)
    switched(extension, enabled, family)
    // The extensions that require it start or stop with it, and theirs with them.
    for (let i = 0; i < changes.length; i++) {
      for (const other of extensions) {
        const now = isOn(other)
        if (runningNow.get(other.id) === now || !other.requires?.some((id) => changes.some((c) => c.extension.id === id))) continue
        runningNow.set(other.id, now)
        changes.push({ extension: other, enabled: now })
        switched(other, now, familyOfExtension(other))
      }
    }
    // Then those that still run hear of each switch they depend on, and every dependent's page redraws.
    for (const change of changes) {
      for (const other of extensions.filter((e) => dependsOn(e, change.extension.id))) {
        if (isOn(other) && other.onDependencyChanged && !changes.some((c) => c.extension === other)) {
          callExtension(other, () => other.onDependencyChanged!({ id: change.extension.id, enabled: change.enabled }, contextOf(other)))
        }
        broadcast({ type: 'extension.updated', extension: extensionInfo(other) })
      }
    }
  }
  const switched = (extension: Extension, enabled: boolean, family: Chat[]) => {
    if (!enabled) stopSpawned(extension)
    if (!enabled) chats.forEach((chat) => setWait(chat, extension.id, undefined))
    if (enabled) startExtension(extension)
    else stopExtension(extension)
    if (enabled) family.toReversed().forEach((chat) => broadcast({ type: 'chat.added', chat: shownState(chat) }))
    else family.forEach((chat) => broadcast({ type: 'chat.removed', chatId: chat.info.id }))
    if (extension.panels?.length || extension.commands?.length || extension.messageActions?.length || extension.composerToggles?.length) shownChats().forEach((chat) => broadcast(extensionsOf(chat)))
  }
  const familyOfExtension = (extension: Extension) =>
    (extension.chats ?? []).flatMap(({ id }) => {
      const chat = chats.get(id)
      return chat ? familyOf(chat) : []
    })

  // The master switch. Off stops every community extension's hooks at once (its code stays loaded until a restart); on
  // lets the ones whose own switch is on run, from the next start for any not loaded yet.
  const setCommunityExtensions = (enabled: boolean) => {
    if (communityOn() === enabled) return
    const running = extensions.filter((extension) => community.has(extension.id) && ownSwitch(extension))
    if (!enabled) {
      const busy = running.flatMap((extension) => familyOfExtension(extension)).find((chat) => chat.status !== 'idle')
      if (busy) throw new Error(`Stop "${busy.info.name}" before turning community extensions off`)
    }
    settings.communityExtensions = enabled
    saveSettings()
    broadcast({ type: 'communityExtensions.updated', enabled })
    for (const extension of running) {
      if (enabled) void checkSetup(extension)
      extensionSwitched(extension, enabled)
    }
    restartChanged()
  }

  // Community extension code this run doesn't match the settings: what a restart would start, update or stop.
  const restartState = (): RestartState => {
    const changes: RestartChange[] = []
    for (const [id, { manifest }] of community) {
      const extension = extensions.find((m) => m.id === id)
      const wanted = !!extension && isOn(extension)
      const loaded = imported.has(id)
      const change = wanted ? (!loaded ? 'start' : reinstalled.has(id) ? 'update' : undefined) : loaded ? 'stop' : undefined
      if (change) changes.push({ id, name: manifest.name, change })
    }
    for (const [id, name] of imported) if (!community.has(id)) changes.push({ id, name, change: 'stop' })
    return { changes, canRestart: deps.canRestart }
  }
  let lastRestart = JSON.stringify(restartState())
  const restartChanged = () => {
    const restart = restartState()
    const text = JSON.stringify(restart)
    if (text === lastRestart) return
    lastRestart = text
    broadcast({ type: 'restart.updated', restart })
  }

  // A community extension was installed or updated. It runs from the next start, and only as the files the user turned
  // on: an update (any change to its files) turns it off until they review it and turn it on again.
  const communityChanged = (id: string, added: ExtensionUse[]) => {
    const install = installedExtensions(garage).find((m) => m.manifest.id === id)
    if (!install) return
    const known = community.get(id)
    logInstall(garage, now, install, !!known)
    community.set(id, { ...known, manifest: install.manifest, item: install.item })
    if (imported.has(id)) reinstalled.add(id)
    const at = extensions.findIndex((m) => m.id === id)
    if (at < 0) extensions.push(stubOf(install.manifest))
    else if (!known?.running) extensions[at] = stubOf(install.manifest)
    const extension = extensions.find((m) => m.id === id)!
    if (ownSwitch(extension) && reviewOf(approvals[id], install)) {
      setExtensionEnabled(extension, false)
      const more = added.map((use) => EXTENSION_USES[use].toLowerCase()).join('; ')
      broadcast({
        type: 'error',
        message: added.length
          ? `${extension.name} was turned off: its update also ${more}. Turn it on again in Community hub to allow that.`
          : `${extension.name} was turned off: ${install.manifest.version} isn't the version you turned on. ` +
            'Read the changes, then turn it on again in Community hub.',
      })
    }
    broadcast({ type: 'extension.updated', extension: extensionInfo(extension) })
    restartChanged()
  }

  // Turns the extension off and deletes its files. Its storage in <garage>/extensions/<id>/ stays, as a built-in
  // extension's does.
  const uninstallExtension = (id: string) => {
    const extension = extensions.find((m) => m.id === id)
    if (!community.has(id) || !extension) return marketplace.uninstall('extension', id)
    if (ownSwitch(extension)) setExtensionEnabled(extension, false)
    const version = community.get(id)?.manifest.version
    marketplace.uninstall('extension', id)
    forget(garage, id)
    const { [id]: _gone, ...rest } = approvals
    approvals = rest
    logHistory(garage, now, { id, event: 'uninstalled', ...(version && { version }) })
    const { enabled: _, ...kept } = settings.extensions?.[id] ?? {}
    settings.extensions = { ...settings.extensions, [id]: kept }
    saveSettings()
    community.delete(id)
    forgetHost(id)
    extensions.splice(extensions.indexOf(extension), 1)
    broadcast({ type: 'extension.removed', extensionId: id })
    restartChanged()
  }

  return {
    setExtensionEnabled,
    setCommunityExtensions,
    restartState,
    communityChanged,
    uninstallExtension,
    approvalOf: (id: string): Approval | undefined => approvals[id],
  }
}
