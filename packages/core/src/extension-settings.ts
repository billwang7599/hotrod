// Extensions in Settings: what the UI shows of each (ExtensionInfo), its settings view, its values and each space's,
// and its setup (checked, installed, cancelled). The core passes in its extensions, settings and chats as plain
// functions; what's installing and each setup's state are kept here.
import type { Extension, ExtensionAction, ExtensionContext, ExtensionRun } from '@kothar/extension-api'
import type { Approval } from './approvals.ts'
import type { Chat } from './chat.ts'
import type { Settings } from './chat-store.ts'
import { type CommunityEntry, usesOf, valuesOf } from './extensions.ts'
import { settingProblem, type ChatInfo, type CoreMessage, type ExtensionInfo, type Machine, type PromptInfo, type SetupState } from './shared.ts'
import { messageOf } from './util.ts'

export type ExtensionSettingsDeps = {
  settings: Settings
  saveSettings: () => void
  broadcast: (message: CoreMessage) => void
  machine: Pick<Machine, 'run'>
  /** Community extensions by id, with what was installed and what loaded. */
  community: ReadonlyMap<string, CommunityEntry>
  /** What the user turned on, per community extension. */
  approvalOf: (id: string) => Approval | undefined
  /** Extensions whose saved settings failed to migrate at load, and why. */
  settingsErrors: ReadonlyMap<string, string>
  isOn: (extension: Extension) => boolean
  ownSwitch: (extension: Extension) => boolean
  extensionValues: (extension: Extension) => ExtensionContext['values']
  /** Whether an extension's background work (onStart) has started. */
  isStarted: (extension: Extension) => boolean
  contextOf: (extension: Extension) => ExtensionContext
  extensionError: (extension: Extension, error: unknown) => void
  callExtension: (extension: Extension, run: () => unknown) => void
  refreshExtension: (extension: Extension, chatId?: string) => void
  chainOf: (chat: Chat) => Chat[]
  updateChat: (chat: Chat, change: Partial<ChatInfo>) => void
  /** The extension's prompts as its page shows them. */
  promptsOf: (extension: Extension) => PromptInfo[]
  /** Why something that requires the extension with this id can't be used now ("Needs the Workers extension"), or
   * undefined while that extension runs. */
  needs: (id: string) => string | undefined
  /** An extension's own switch, apart from whether what it requires is on. */
  switchedOn: (extension: Extension) => boolean
}

export function openExtensionSettings(deps: ExtensionSettingsDeps) {
  const {
    settings,
    saveSettings,
    broadcast,
    machine,
    community,
    approvalOf,
    settingsErrors,
    isOn,
    ownSwitch,
    extensionValues,
    isStarted,
    contextOf,
    extensionError,
    callExtension,
    refreshExtension,
    chainOf,
    updateChat,
    needs,
  } = deps
  const setups = new Map<string, Omit<SetupState, 'description'>>()
  const installs = new Map<string, AbortController>()
  const extensionInfo = (extension: Extension): ExtensionInfo => {
    const { id, name, description, settings: declared = [] } = extension
    const values = extensionValues(extension)
    const about = extension.setup?.description
    const setup = extension.setup && {
      description: typeof about === 'function' ? about(values) : about!,
      ...(setups.get(id) ?? { status: 'checking' }),
    }
    // A community extension shows its own switch; the master switch is beside it in the UI.
    // A built-in one shows its own switch too: one that requires an extension that's off keeps it, greyed (blocked).
    const enabled = community.has(id) ? ownSwitch(extension) : deps.switchedOn(extension)
    const settingsError = settingsErrors.get(id)
    const view = settingsViewOf(extension)
    const prompts = deps.promptsOf(extension)
    const fixedInstructions =
      !!(extension.instructions || extension.memory?.instructions) && !prompts.some((prompt) => prompt.where === 'instructions')
    // What's greyed out for an extension that's off: the extension itself, and each setting that needs it.
    const blocked = [...new Set(extension.requires ?? [])].map(needs).filter((reason) => reason !== undefined)
    const blockedSettings = Object.fromEntries(
      declared.flatMap((setting) => {
        const reason = setting.requires === undefined ? undefined : needs(setting.requires)
        return reason === undefined ? [] : [[setting.key, reason]]
      }),
    )
    const info = {
      id,
      name,
      description,
      enabled,
      settings: declared,
      values,
      ...(view && { settingsView: view }),
      ...(settingsError && { loadError: settingsError }),
      ...(extension.chats?.length && { ownsChat: true }),
      ...(prompts.length && { prompts }),
      ...(fixedInstructions && { fixedInstructions }),
      ...(extension.requires?.length && { requires: [...extension.requires] }),
      ...(blocked.length && { blocked: blocked.join('. ') }),
      ...(Object.keys(blockedSettings).length && { blockedSettings }),
      // A community extension's are its manifest's (community.uses).
      ...(!community.has(id) && { uses: usesOf(extension) }),
    }
    const from = community.get(id)
    const { version, author, uses } = from?.manifest ?? {}
    const { source, repo, path, tag } = from?.item ?? {}
    const approval = approvalOf(id)
    const communityFields = from && {
      community: {
        version: version!,
        author: author!,
        uses: uses!,
        source: source === 'local' ? ('local' as const) : ('marketplace' as const),
        ...(repo && { repo }),
        ...(tag && { tag }),
        ...(path && { path }),
        ...(from.running && { running: from.running }),
        ...(approval && {
          approved: { version: approval.version, uses: approval.uses, ...(approval.tag && { tag: approval.tag }) },
        }),
        ...(from.held && { held: from.held }),
      },
      ...(from.loadError && { loadError: from.loadError }),
    }
    return { ...info, ...(setup && { setup }), ...communityFields }
  }
  // An extension's settings view, drawn now: a built-in extension's even while it's off, a community one's only while
  // it runs.
  const settingsViewOf = (extension: Extension): ExtensionInfo['settingsView'] => {
    if (!extension.settingsView || (community.has(extension.id) && !isOn(extension))) return undefined
    try {
      const view = extension.settingsView.render(contextOf(extension))
      if (view instanceof Promise) throw new Error('A settings view renders synchronously')
      return { view }
    } catch (error) {
      return { error: messageOf(error) }
    }
  }
  const settingsViewChanged = (extension: Extension) => {
    if (extension.settingsView) broadcast({ type: 'extension.updated', extension: extensionInfo(extension) })
  }
  const settingsViewAction = async (extension: Extension, action: ExtensionAction) => {
    if (!extension.settingsView || (community.has(extension.id) && !isOn(extension))) {
      throw new Error(`${extension.name} has no settings view`)
    }
    if (typeof action?.name !== 'string') throw new Error('A settings action needs a name')
    try {
      await extension.settingsView.onAction?.(action, contextOf(extension))
    } catch (error) {
      extensionError(extension, error)
    }
    settingsViewChanged(extension)
  }
  const saveExtension = (extension: Extension, change: Record<string, unknown>) => {
    settings.extensions = { ...settings.extensions, [extension.id]: { ...settings.extensions?.[extension.id], ...change } }
    saveSettings()
    broadcast({ type: 'extension.updated', extension: extensionInfo(extension) })
  }
  const setSetup = (extension: Extension, state: Omit<SetupState, 'description'>) => {
    setups.set(extension.id, state)
    broadcast({ type: 'extension.updated', extension: extensionInfo(extension) })
  }
  const runFor =
    (signal?: AbortSignal): ExtensionRun =>
    (command, args, options) =>
      // A setup that runs several commands stops at its next one once cancelled.
      signal?.aborted
        ? Promise.reject(new Error('Cancelled'))
        : machine.run(command, args, { cwd: '/', ...options, ...(signal && { signal }) })
  const checkSetup = async (extension: Extension, installError?: string) => {
    if (!extension.setup || installs.has(extension.id)) return
    const { message } = setups.get(extension.id) ?? {}
    setSetup(extension, { status: 'checking', ...(message && { message }) })
    let checked: Omit<SetupState, 'description'>
    try {
      const result = await extension.setup.check(runFor(), extensionValues(extension))
      checked = { status: result.ready ? 'ready' : 'missing', ...(result.message && { message: result.message }) }
    } catch (error) {
      checked = { status: 'missing', error: messageOf(error) }
    }
    if (checked.status === 'missing' && installError) checked.error = installError
    if (!installs.has(extension.id)) setSetup(extension, checked)
  }
  const install = (extension: Extension) => {
    if (!extension.setup) throw new Error(`${extension.name} has nothing to install`)
    if (installs.has(extension.id)) throw new Error(`${extension.name} is already installing`)
    if (setups.get(extension.id)?.status === 'ready') throw new Error(`${extension.name} is already installed`)
    const controller = new AbortController()
    installs.set(extension.id, controller)
    const { message } = setups.get(extension.id) ?? {}
    setSetup(extension, { status: 'installing', ...(message && { message }) })
    const report = ({ text, progress }: { text?: string; progress?: number }) => {
      if (installs.get(extension.id) !== controller) return
      const update = { ...(text && { progressText: text }), ...(progress !== undefined && { progress }) }
      setSetup(extension, { ...setups.get(extension.id)!, ...update })
    }
    void extension.setup.install(runFor(controller.signal), report, extensionValues(extension)).then(
      () => {
        installs.delete(extension.id)
        return checkSetup(extension)
      },
      (error) => {
        installs.delete(extension.id)
        return checkSetup(extension, controller.signal.aborted ? undefined : messageOf(error))
      },
    )
  }
  const setExtensionValue = (extension: Extension, key: string, value: unknown) => {
    const setting = extension.settings?.find((s) => s.key === key)
    if (!setting) throw new Error(`${extension.name} has no setting "${key}"`)
    const problem = settingProblem(setting, value)
    if (problem) throw new Error(`${setting.label} ${problem}`)
    const blocked = setting.requires === undefined ? undefined : needs(setting.requires)
    if (blocked) throw new Error(`${setting.label}: ${blocked}`)
    const previous = extensionValues(extension)[key]
    saveExtension(extension, { [key]: value })
    if (isOn(extension)) void checkSetup(extension)
    // An extension with background work hears of it only once that work has started; onStart reads the values itself.
    const running = isOn(extension) && (!extension.onStart || isStarted(extension))
    if (running && previous !== value && extension.onSettingsChanged) {
      callExtension(extension, () => extension.onSettingsChanged!({ key, value, previous }, contextOf(extension)))
      settingsViewChanged(extension)
    }
  }
  // A space's own values for an extension's spaceSettings: the space a worker is in, else the chat itself.
  const spaceChat = (chat: Chat) => chainOf(chat)[0]!
  const spaceValuesOf = (extension: Extension, chat: Chat) =>
    valuesOf(extension, spaceChat(chat).info.extensionValues?.[extension.id], extension.spaceSettings, (id) => !needs(id))
  const setSpaceValue = (extension: Extension, chat: Chat, key: string, value: unknown) => {
    const setting = extension.spaceSettings?.find((s) => s.key === key)
    if (!setting) throw new Error(`${extension.name} has no space setting "${key}"`)
    const problem = settingProblem(setting, value)
    if (problem) throw new Error(`${setting.label} ${problem}`)
    const blocked = setting.requires === undefined ? undefined : needs(setting.requires)
    if (blocked) throw new Error(`${setting.label}: ${blocked}`)
    const space = spaceChat(chat)
    const extensionValues = { ...space.info.extensionValues, [extension.id]: { ...space.info.extensionValues?.[extension.id], [key]: value } }
    updateChat(space, { extensionValues })
    refreshExtension(extension)
  }
  const cancelInstall = (extension: Extension) => installs.get(extension.id)?.abort()
  // Whether an extension with a setup is ready: its MCP servers run only then.
  const setupReady = (extension: Extension) => setups.get(extension.id)?.status === 'ready'

  return {
    extensionInfo,
    settingsViewChanged,
    settingsViewAction,
    saveExtension,
    runFor,
    checkSetup,
    install,
    cancelInstall,
    setupReady,
    setExtensionValue,
    spaceValuesOf,
    setSpaceValue,
  }
}

// Once, as the core opens: each extension whose settings are saved at an older version than its settingsVersion
// migrates them, the global values and every space's together, and they're saved with the new version. A throw saves
// nothing and is kept in settingsErrors, shown on the extension like a load error.
export function migrateExtensionSettings(deps: {
  extensions: readonly Extension[]
  settings: Settings
  saveSettings: () => void
  chats: () => Iterable<Chat>
  saveChat: (chat: Chat) => void
  settingsErrors: Map<string, string>
  extensionError: (extension: Extension, error: unknown) => void
}) {
  const { settings } = deps
  for (const extension of deps.extensions) {
    const version = extension.settingsVersion
    const from = settings.extensionVersions?.[extension.id] ?? 0
    if (!version || from >= version) continue
    try {
      if (!extension.migrateSettings) throw new Error(`settingsVersion ${version} needs a migrateSettings`)
      const global = settings.extensions?.[extension.id]
      const migratedGlobal = global && extension.migrateSettings({ ...global }, from, {})
      const spaces = [...deps.chats()].flatMap((chat) => {
        const saved = chat.info.extensionValues?.[extension.id]
        return saved ? [{ chat, values: extension.migrateSettings!({ ...saved }, from, { spaceId: chat.info.id }) }] : []
      })
      for (const { chat, values } of spaces) {
        chat.info = { ...chat.info, extensionValues: { ...chat.info.extensionValues, [extension.id]: values } }
        deps.saveChat(chat)
      }
      if (migratedGlobal) settings.extensions = { ...settings.extensions, [extension.id]: migratedGlobal }
      settings.extensionVersions = { ...settings.extensionVersions, [extension.id]: version }
      deps.saveSettings()
    } catch (error) {
      deps.settingsErrors.set(extension.id, `Its saved settings couldn't be updated: ${messageOf(error)}`)
      deps.extensionError(extension, error)
    }
  }
}
