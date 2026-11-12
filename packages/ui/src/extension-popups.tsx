import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog } from 'radix-ui'
import type { ClientMessage, PanelTab } from '@kothar/core/shared'
import { Button, Hint, MOTION } from './controls.tsx'
import { revealLater } from './search.tsx'
import { ExtensionViewer } from './extension-view.tsx'
import { choosePanelTab, currentDock, currentPopup, extensionTabId, openDock, openPopup, usePopup } from './panel-tab.ts'
import { clampPopup, type PopupSize, POPUP_DEFAULT_WIDTH, POPUP_MIN, POPUP_MARGIN, POPUP_STEP, POPUP_TOP, resetPopupSize, setPopupSize, usePopupSize } from './popup-size.ts'
import { conflictsOf, normalize, parseBinding, refusal, registerShortcut, shortcutActions, type ShortcutHandlers } from './shortcuts.ts'
import type { Launcher } from './sidebar.tsx'
import { panelKey, type State } from './state.ts'

/**
 * What extension panels add outside the right sidebar (ExtensionPanel in @kothar/extension-api): popups over the chat,
 * their keys in the shortcut registry, and launchers in the left sidebar. Each belongs to the chat that's open.
 */

export const isPopup = (panel: PanelTab) => panel.placement === 'popup'

/** What opening a panel does, by where it shows: a popup opens, a dock slides in beside the chat, a tab shows. */
function opener(panel: PanelTab, showTab: () => void, toggle: boolean) {
  const id = extensionTabId(panel.extension, panel.id)
  if (panel.placement === 'popup') return () => openPopup(toggle && currentPopup() === id ? null : id)
  if (panel.placement === 'dock') return () => openDock(toggle && currentDock().open === id ? null : id)
  return () => {
    choosePanelTab(id)
    showTab()
  }
}

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
 * Shortcuts), and returns the handlers that run them: a popup or a dock opens or closes, a tab shows in the right
 * sidebar.
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
      return [extensionTabId(panel.extension, panel.id), opener(panel, showTab, true)]
    }),
  )
}

/** The left sidebar's launchers for the open chat's panels that ask for one. */
export function launcherEntries(panels: PanelTab[], keys: Record<string, string | null>, showTab: () => void): Launcher[] {
  return panels
    .filter((p) => p.launcher)
    .map((panel) => {
      const id = extensionTabId(panel.extension, panel.id)
      return {
        key: id,
        label: panel.title,
        keys: keys[id] ?? null,
        open: opener(panel, showTab, false),
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

/**
 * The open chat's popup panel that's open, if any: a large window over the chat. The user resizes it by its corner or
 * maximises it to fill the window, and it opens at that size next time (popup-size.ts). Esc restores a maximised popup,
 * then closes it.
 *
 * Focus: opening it puts focus in the popup itself, not on its Close button, and once the view has drawn, on the field
 * the extension marked autofocus (a search box's, ExtensionView 'search'), unless something in it took focus already
 * (an editor's autofocus). Closing it puts focus back where it was.
 */
export function ExtensionPopup({ chatId, panels, panelViews, connected, send }: PopupProps) {
  const open = usePopup()
  const panel = panels.find((p) => isPopup(p) && extensionTabId(p.extension, p.id) === open)
  const extension = panel?.extension
  const id = panel?.id
  const tabId = panel && extensionTabId(panel.extension, panel.id)
  const size = usePopupSize(tabId)
  const content = useRef<HTMLDivElement>(null)
  // Where focus was before the popup opened: read before anything in the popup can take it.
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (tabId) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [tabId])
  useEffect(() => {
    if (connected && extension && id) send({ type: 'extension.panel.get', chatId, extension, panel: id })
  }, [chatId, connected, extension, id, send])
  const shown = panel && panelViews?.[panelKey(chatId, panel.extension, panel.id)]
  const view = shown?.view
  // Once the view is there, its autofocus field takes focus, while nothing else in the popup has it.
  useEffect(() => {
    const root = content.current
    if (!root || !view) return
    const active = document.activeElement
    if (active !== root && active !== document.body && active !== null) return
    root.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [view, tabId])
  const maximise = (max: boolean) => tabId && setPopupSize(tabId, { max })
  const sized = !size.max && (size.width || size.height)
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
              onOpenAutoFocus={(e) => {
                e.preventDefault()
                content.current?.focus()
              }}
              onCloseAutoFocus={(e) => {
                e.preventDefault()
                if (opener.current?.isConnected) opener.current.focus()
              }}
              onEscapeKeyDown={(e) => {
                if (!size.max) return
                e.preventDefault()
                maximise(false)
              }}
            >
              <m.div
                ref={content}
                tabIndex={-1}
                className={`fixed z-20 flex flex-col overflow-hidden rounded-xl border bg-panel text-text shadow-overlay outline-none ${
                  size.max ? 'inset-8' : 'inset-x-0 top-[6vh] mx-auto h-[88vh] w-[min(1080px,calc(100vw-32px))]'
                }`}
                style={
                  sized
                    ? {
                        width: `min(${size.width ?? POPUP_DEFAULT_WIDTH}px, calc(100vw - ${2 * POPUP_MARGIN}px))`,
                        ...(size.height && { height: `min(${size.height}px, calc(${100 - POPUP_TOP * 100}vh - ${POPUP_MARGIN}px))` }),
                      }
                    : undefined
                }
                data-popup={tabId}
                data-maximised={size.max || undefined}
                {...MOTION.pop}
              >
                <header className="flex h-44 shrink-0 items-center gap-4 border-b pr-8 pl-16" onDoubleClick={(e) => e.target === e.currentTarget && maximise(!size.max)}>
                  <Dialog.Title className="min-w-0 flex-1 truncate font-semibold">{panel.title}</Dialog.Title>
                  <Hint text={size.max ? 'Back to its own size (Esc)' : 'Fill the window'}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="grid place-items-center"
                      aria-label={size.max ? `Restore ${panel.title}` : `Maximise ${panel.title}`}
                      aria-pressed={!!size.max}
                      onClick={() => maximise(!size.max)}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        {size.max ? (
                          <path d="M6.5 2v4.5H2M9.5 14V9.5H14M2 2l4.5 4.5M14 14L9.5 9.5" />
                        ) : (
                          <path d="M10 2h4v4M6 14H2v-4M14 2L9 7M2 14l5-5" />
                        )}
                      </svg>
                    </Button>
                  </Hint>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="icon" aria-label={`Close ${panel.title}`}>
                      ×
                    </Button>
                  </Dialog.Close>
                </header>
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-16">
                  <ExtensionViewer
                    extension={panel.extension}
                    view={view}
                    error={shown?.error}
                    act={(action) =>
                      send({ type: 'extension.panel.action', chatId, extension: panel.extension, panel: panel.id, action })
                    }
                    set={(key, value) => send({ type: 'extension.space.set', chatId, extension: panel.extension, key, value })}
                    reveal={(path) => send({ type: 'reveal', path })}
                  showMessage={(entry) => {
                      revealLater({ chatId, entry })
                      openPopup(null)
                    }}
                  />
                </div>
                {!size.max && <PopupResizer id={tabId!} title={panel.title} box={content} saved={size} />}
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

/**
 * The popup's bottom-right corner, to resize it: drag it (the popup stays centred, so its width grows on both sides),
 * or focus it and use the arrows. Double-click goes back to the default size.
 */
function PopupResizer({ id, title, box, saved }: { id: string; title: string; box: React.RefObject<HTMLDivElement | null>; saved: PopupSize }) {
  const [dragging, setDragging] = useState(false)
  const windowSize = () => ({ width: innerWidth, height: innerHeight })
  // Its size on screen (the saved one may be more than the window allows), else the saved or default size.
  const measure = () => {
    const rect = box.current?.getBoundingClientRect()
    return { width: rect?.width || saved.width || POPUP_DEFAULT_WIDTH, height: rect?.height || saved.height || POPUP_MIN.height }
  }
  const resize = (width: number, height: number) => setPopupSize(id, clampPopup({ width, height }, windowSize()))
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Resize ${title}`}
      data-dragging={dragging || undefined}
      className="absolute right-0 bottom-0 z-10 size-16 cursor-nwse-resize rounded-br-xl text-faint transition-colors hover:text-accent focus-visible:text-accent focus-visible:outline-none data-dragging:text-accent"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const start = { x: e.clientX, y: e.clientY, ...measure() }
        setDragging(true)
        const body = document.body.style
        const saved = { userSelect: body.userSelect, cursor: body.cursor }
        body.userSelect = 'none'
        body.cursor = 'nwse-resize'
        const onMove = (m: PointerEvent) => resize(start.width + 2 * (m.clientX - start.x), start.height + (m.clientY - start.y))
        const onUp = () => {
          setDragging(false)
          Object.assign(body, saved)
          removeEventListener('pointermove', onMove)
          removeEventListener('pointerup', onUp)
          removeEventListener('pointercancel', onUp)
        }
        addEventListener('pointermove', onMove)
        addEventListener('pointerup', onUp)
        addEventListener('pointercancel', onUp)
      }}
      onDoubleClick={() => resetPopupSize(id)}
      onKeyDown={(e) => {
        const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
        if (!dx && !dy) return
        e.preventDefault()
        const now = measure()
        resize(now.width + dx * POPUP_STEP, now.height + dy * POPUP_STEP)
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <path d="M13 7l-6 6M13 11l-2 2" />
      </svg>
    </div>
  )
}
