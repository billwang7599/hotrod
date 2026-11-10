import { useEffect } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog } from 'radix-ui'
import type { ClientMessage, PanelTab } from '@kothar/core/shared'
import { Button, MOTION, useReturnFocus } from './controls.tsx'
import { ExtensionViewer } from './extension-view.tsx'
import { choosePanelTab, currentPopup, extensionTabId, openPopup, usePopup } from './panel-tab.ts'
import { conflictsOf, normalize, parseBinding, refusal, registerShortcut, shortcutActions, type ShortcutHandlers } from './shortcuts.ts'
import type { SidebarEntry } from './sidebar.tsx'
import { panelKey, type State } from './state.ts'

/**
 * What extension panels add outside the right sidebar (ExtensionPanel in @kothar/extension-api): popups over the chat,
 * their keys in the shortcut registry, and entries in the left sidebar. Each belongs to the chat that's open.
 */

export const isPopup = (panel: PanelTab) => panel.placement === 'popup'

/** A panel's keys out of the box: the ones it asks for, unless they're not a shortcut or another action has them. */
export function panelDefaultKeys(id: string, asked: string | undefined): string | null {
  if (!asked || !parseBinding(asked) || refusal(asked)) return null
  const keys = normalize(asked)
  // Another action's default or the user's binding for it: the panel never takes keys from something already there.
  const taken = shortcutActions().some((a) => a.id !== id && a.defaultKeys && normalize(a.defaultKeys) === keys)
  return taken || conflictsOf(id, keys).length ? null : keys
}

/**
 * Puts each panel with keys in the shortcut registry (as `extension:<extension>/<panel>`, remappable in Settings →
 * Shortcuts), and returns the handlers that run them: a popup opens or closes, a tab shows in the right sidebar.
 */
export function usePanelShortcuts(panels: PanelTab[], showTab: () => void): ShortcutHandlers {
  const wanted = panels.filter((p) => p.shortcut)
  const signature = wanted.map((p) => `${extensionTabId(p.extension, p.id)}\n${p.title}\n${p.shortcut}`).join('\n\n')
  useEffect(() => {
    for (const panel of wanted) {
      const id = extensionTabId(panel.extension, panel.id)
      const label = `Open ${panel.title}`
      const existing = shortcutActions().find((a) => a.id === id)
      // Registered once with the keys it got then, so another chat drawing the same panel doesn't move them.
      if (existing?.label === label) continue
      registerShortcut({ id, label, defaultKeys: existing?.defaultKeys ?? panelDefaultKeys(id, panel.shortcut) })
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- by signature: the panels array is new on every message
  }, [signature])
  return Object.fromEntries(
    wanted.map((panel) => {
      const id = extensionTabId(panel.extension, panel.id)
      const run = isPopup(panel)
        ? () => openPopup(currentPopup() === id ? null : id)
        : () => {
            choosePanelTab(id)
            showTab()
          }
      return [id, run]
    }),
  )
}

/** The left sidebar's entries for the open chat's panels that ask for one. */
export function sidebarEntries(panels: PanelTab[], keys: Record<string, string | null>, showTab: () => void): SidebarEntry[] {
  return panels
    .filter((p) => p.sidebar)
    .map((panel) => {
      const id = extensionTabId(panel.extension, panel.id)
      return {
        key: id,
        label: panel.title,
        keys: keys[id] ?? null,
        open: isPopup(panel)
          ? () => openPopup(id)
          : () => {
              choosePanelTab(id)
              showTab()
            },
      }
    })
}

type PopupProps = {
  chatId: string
  panels: PanelTab[]
  panelViews: State['panelViews']
  connected: boolean
  send: (m: ClientMessage) => void
}

/** The open chat's popup panel that's open, if any: a large window over the chat. Esc closes it. */
export function ExtensionPopup({ chatId, panels, panelViews, connected, send }: PopupProps) {
  const open = usePopup()
  const panel = panels.find((p) => isPopup(p) && extensionTabId(p.extension, p.id) === open)
  const focus = useReturnFocus()
  const extension = panel?.extension
  const id = panel?.id
  useEffect(() => {
    if (connected && extension && id) send({ type: 'extension.panel.get', chatId, extension, panel: id })
  }, [chatId, connected, extension, id, send])
  const shown = panel && panelViews?.[panelKey(chatId, panel.extension, panel.id)]
  return (
    <Dialog.Root open={!!panel} onOpenChange={(o) => o || openPopup(null)}>
      <AnimatePresence>
        {panel && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 z-20 bg-backdrop" {...MOTION.fade} />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-x-0 top-[6vh] z-20 mx-auto flex h-[88vh] w-[min(1080px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border bg-panel text-text shadow-overlay outline-none"
                data-popup={extensionTabId(panel.extension, panel.id)}
                {...MOTION.pop}
              >
                <header className="flex h-44 shrink-0 items-center justify-between gap-8 border-b px-16">
                  <Dialog.Title className="font-semibold">{panel.title}</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="icon" aria-label={`Close ${panel.title}`}>
                      ×
                    </Button>
                  </Dialog.Close>
                </header>
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-16">
                  <ExtensionViewer
                    view={shown?.view}
                    error={shown?.error}
                    act={(action) =>
                      send({ type: 'extension.panel.action', chatId, extension: panel.extension, panel: panel.id, action })
                    }
                    set={(key, value) => send({ type: 'extension.space.set', chatId, extension: panel.extension, key, value })}
                    reveal={(path) => send({ type: 'reveal', path })}
                  />
                </div>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
