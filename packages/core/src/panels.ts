// Extensions in a chat: which panels and commands it gets, the panels the UI has open and their views, actions on them,
// and answers to an extension's wait. The core passes in its chats and extensions; open panels are kept here.
import type {
  ChatDetail,
  Extension,
  ExtensionAction,
  ExtensionContext,
  ExtensionPanel,
  ExtensionValues,
  ExtensionView,
  ExtensionWait,
  ExtensionWaitAnswer,
} from '@kothar/extension-api'
import type { Chat } from './chat.ts'
import { panelTabOf } from './extensions.ts'
import type { CommandInfo, CoreMessage, PanelTab } from './shared.ts'
import { messageOf } from './util.ts'

export type PanelDeps = {
  extensions: readonly Extension[]
  extensionFor: (id: string) => Extension
  isOn: (extension: Extension) => boolean
  isOnFor: (extension: Extension, chat: Chat | undefined) => boolean
  contextOf: (extension: Extension) => ExtensionContext
  extensionError: (extension: Extension, error: unknown) => void
  callExtension: (extension: Extension, run: () => unknown) => void
  /** Redraws an extension's settings view. */
  settingsViewChanged: (extension: Extension) => void
  spaceValuesOf: (extension: Extension, chat: Chat) => ExtensionValues
  chats: ReadonlyMap<string, Chat>
  chatFor: (chatId: string) => Chat
  shownChats: () => Chat[]
  detailOf: (chat: Chat) => ChatDetail
  broadcast: (message: CoreMessage) => void
}

export function openPanels(deps: PanelDeps) {
  const {
    extensions,
    extensionFor,
    isOn,
    isOnFor,
    contextOf,
    extensionError,
    callExtension,
    settingsViewChanged,
    spaceValuesOf,
    chats,
    chatFor,
    shownChats,
    detailOf,
    broadcast,
  } = deps
  type Offered = { shown?(chat: ChatDetail, context: ExtensionContext): boolean }
  const offeredBy = (extension: Extension, item: Offered, chat: Chat) => {
    if (!item.shown) return true
    try {
      return item.shown(detailOf(chat), contextOf(extension)) === true
    } catch (error) {
      extensionError(extension, error)
      return false
    }
  }
  // Only the extensions on for this chat (isOnFor): one its setup leaves out shows no panels or commands there.
  const extensionsOf = (chat: Chat): Extract<CoreMessage, { type: 'chat.extensions' }> => {
    const on = extensions.filter((extension) => isOnFor(extension, chat))
    const panels = on.flatMap((extension) =>
      (extension.panels ?? []).flatMap((p): PanelTab[] =>
        offeredBy(extension, p, chat) ? [panelTabOf(extension.id, p)] : [],
      ),
    )
    const commands = on.flatMap((extension) =>
      (extension.commands ?? []).flatMap((c): CommandInfo[] =>
        offeredBy(extension, c, chat) ? [{ extension: extension.id, id: c.id, label: c.label, ...(c.hint && { hint: c.hint }) }] : [],
      ),
    )
    return { type: 'chat.extensions', chatId: chat.info.id, panels, commands }
  }
  const openPanels = new Map<string, Set<string>>()
  const renders = new Map<string, number>()
  const panelOf = (chat: Chat, extensionId: unknown, panelId: unknown) => {
    const extension = extensionFor(String(extensionId))
    if (!isOn(extension)) throw new Error(`${extension.name} is off`)
    if (!isOnFor(extension, chat)) throw new Error(`${extension.name} is left out of this chat by its setup`)
    const panel = extension.panels?.find((p) => p.id === panelId)
    if (!panel) throw new Error(`${extension.name} has no panel "${panelId}"`)
    return { extension, panel }
  }
  // Fills in a panel's switches and pickers from the space's values and the settings they're for.
  const withControls = (extension: Extension, chat: Chat, view: ExtensionView): ExtensionView => {
    if (view.type === 'stack' || view.type === 'row' || view.type === 'card') {
      return { ...view, children: view.children.map((child) => withControls(extension, chat, child)) }
    }
    if (view.type === 'split') {
      return { ...view, side: withControls(extension, chat, view.side), main: withControls(extension, chat, view.main) }
    }
    if (view.type !== 'switch' && view.type !== 'picker') return view
    const setting = extension.spaceSettings?.find((s) => s.key === view.setting)
    const kind = view.type === 'switch' ? 'boolean' : 'select'
    if (setting?.type !== kind) throw new Error(`${extension.name} has no ${kind} space setting "${view.setting}"`)
    const value = spaceValuesOf(extension, chat)[setting.key]!
    const label = view.label ?? setting.label
    if (view.type === 'switch') return { ...view, label, value: value === true }
    const options = setting.type === 'select' ? setting.options : []
    return { ...view, label, value: value as string | number, options }
  }
  const renderPanel = async (chat: Chat, extension: Extension, panel: ExtensionPanel) => {
    const key = `${chat.info.id}\n${extension.id}\n${panel.id}`
    const turn = (renders.get(key) ?? 0) + 1
    renders.set(key, turn)
    const base = { type: 'extension.panel' as const, chatId: chat.info.id, extension: extension.id, panel: panel.id }
    let shownView: Extract<CoreMessage, { type: 'extension.panel' }>
    try {
      shownView = { ...base, view: withControls(extension, chat, await panel.render(detailOf(chat), contextOf(extension))) }
    } catch (error) {
      shownView = { ...base, error: messageOf(error) }
    }
    // An older render that finishes late doesn't replace a newer one.
    if (renders.get(key) === turn && chats.has(chat.info.id)) broadcast(shownView)
  }
  const openPanel = (chat: Chat, extensionId: unknown, panelId: unknown) => {
    const { extension, panel } = panelOf(chat, extensionId, panelId)
    const open = openPanels.get(chat.info.id) ?? new Set()
    open.add(`${extension.id}\n${panel.id}`)
    openPanels.set(chat.info.id, open)
    void renderPanel(chat, extension, panel)
  }
  const refreshExtension = (extension: Extension, chatId?: string) => {
    if (chatId === undefined) settingsViewChanged(extension)
    if (!isOn(extension)) return
    const targets = chatId === undefined ? shownChats() : [chatFor(chatId)]
    for (const chat of targets) {
      broadcast(extensionsOf(chat))
      if (!isOnFor(extension, chat)) continue
      for (const panel of extension.panels ?? []) {
        if (openPanels.get(chat.info.id)?.has(`${extension.id}\n${panel.id}`)) void renderPanel(chat, extension, panel)
      }
    }
  }
  const panelAction = async (chat: Chat, extensionId: unknown, panelId: unknown, action: ExtensionAction) => {
    const { extension, panel } = panelOf(chat, extensionId, panelId)
    if (typeof action?.name !== 'string') throw new Error('A panel action needs a name')
    try {
      await panel.onAction?.(action, detailOf(chat), contextOf(extension))
    } catch (error) {
      extensionError(extension, error)
    }
    if (chats.has(chat.info.id)) await renderPanel(chat, extension, panel)
  }
  const answerWait = (chat: Chat, extensionId: string, answer: ExtensionWaitAnswer) => {
    const wait = chat.waits.get(extensionId)
    if (!wait) throw new Error('Nothing is waiting there any more')
    if ('button' in answer && !wait.buttons.some((b) => b.id === answer.button)) {
      throw new Error(`No button "${answer.button}"`)
    }
    const extension = extensionFor(extensionId)
    callExtension(extension, () => extension.onWaitAction?.(detailOf(chat), answer, contextOf(extension)))
  }
  const checkWait = (wait: ExtensionWait): ExtensionWait => {
    if (typeof wait?.text !== 'string' || !Array.isArray(wait.buttons)) throw new Error('A wait needs text and buttons')
    for (const b of wait.buttons) {
      if (typeof b?.id !== 'string' || typeof b.label !== 'string') throw new Error('Each button needs an id and a label')
    }
    return { text: wait.text, buttons: wait.buttons.map(({ id, label, primary, hint }) => ({ id, label, ...(primary && { primary }), ...(hint && { hint }) })) }
  }
  const runCommand = (chat: Chat, extensionId: unknown, commandId: unknown) => {
    const extension = extensionFor(String(extensionId))
    if (!isOn(extension)) throw new Error(`${extension.name} is off`)
    if (!isOnFor(extension, chat)) throw new Error(`${extension.name} is left out of this chat by its setup`)
    const command = extension.commands?.find((c) => c.id === commandId)
    if (!command || !offeredBy(extension, command, chat)) throw new Error(`${extension.name} has no command "${commandId}" here`)
    callExtension(extension, () => command.run(detailOf(chat), contextOf(extension)))
  }

  return {
    extensionsOf,
    panelOf,
    openPanel,
    panelAction,
    refreshExtension,
    answerWait,
    checkWait,
    runCommand,
    // A removed chat has no panels open.
    forgetChat: (chatId: string) => void openPanels.delete(chatId),
  }
}
