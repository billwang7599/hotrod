import { useEffect, useRef, useState } from 'react'
import { m } from 'motion/react'
import type { ClientMessage, PanelTab } from '@kothar/core/shared'
import { Button, Hint, TRANSITION } from './controls.tsx'
import { ExtensionViewer } from './extension-view.tsx'
import { extensionTabId, openDock, useDock, widenDock } from './panel-tab.ts'
import { ResizeHandle, usePanelWidth } from './panel-width.tsx'
import { panelKey, type State } from './state.ts'

/**
 * An extension's dock panel (ExtensionPanel placement 'dock'): a column beside the chat, between the transcript and the
 * right sidebar, for something to look at while the chat goes on, such as an artifact. Resized by its left edge,
 * widened to fill the chat pane, closed with ×. It never takes focus when it opens, so typing in the composer carries
 * on. In a pane too narrow for both, it fills the pane.
 */

// The transcript keeps at least this much beside a dock; under it the dock fills the pane.
export const DOCK_CHAT_MIN_PX = 360
const DOCK_MIN_PX = 320

export const isDock = (panel: PanelTab) => panel.placement === 'dock'

type DockProps = {
  chatId: string
  panel: PanelTab
  panelViews?: State['panelViews']
  connected: boolean
  send: (m: ClientMessage) => void
}

/** The open chat's dock panel, if one is open. */
export function useOpenDock(panels: PanelTab[]) {
  const { open } = useDock()
  return panels.find((p) => isDock(p) && extensionTabId(p.extension, p.id) === open)
}

// The width of the element the dock sits in, so it can fill a pane too narrow for it and the chat.
function useParentWidth() {
  const ref = useRef<HTMLElement>(null)
  const [width, setWidth] = useState<number>()
  useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(parent.clientWidth))
    observer.observe(parent)
    setWidth(parent.clientWidth)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** Drawn inside an AnimatePresence, keyed by panel, so it slides in and out. */
export function ExtensionDock({ chatId, panel, panelViews, connected, send }: DockProps) {
  const { wide } = useDock()
  const width = usePanelWidth('dock')
  const [ref, paneWidth] = useParentWidth()
  // Whether it fills, as it last settled: until a change of fill has animated, the width animates.
  const [settledFills, setSettledFills] = useState<boolean>()
  const { extension, id } = panel
  useEffect(() => {
    if (connected && extension && id) send({ type: 'extension.panel.get', chatId, extension, panel: id })
  }, [chatId, connected, extension, id, send])
  // Esc narrows a widened dock again, unless something inside it (a dialog, a field) used the key.
  useEffect(() => {
    if (!wide) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) widenDock(false)
    }
    addEventListener('keydown', onKeyDown)
    return () => removeEventListener('keydown', onKeyDown)
  }, [wide])
  const cramped = paneWidth !== undefined && paneWidth < DOCK_CHAT_MIN_PX + DOCK_MIN_PX
  const fills = wide || cramped
  useEffect(() => {
    // After the slide in, and after each change of fill, so the next width change alone is instant.
    const timer = setTimeout(() => setSettledFills(fills), 250)
    return () => clearTimeout(timer)
  }, [fills])
  // Only the width changed (a drag or a key on the handle), not whether it fills.
  const resized = settledFills === fills
  const shown = panelViews?.[panelKey(chatId, panel.extension, panel.id)]
  const title = panel.title
  return (
    <m.aside
      ref={ref}
      aria-label={title}
      data-dock={extensionTabId(panel.extension, panel.id)}
      data-wide={fills || undefined}
      className={
        fills
          ? 'absolute inset-y-0 right-0 z-10 flex min-w-0 flex-col bg-panel'
          : 'relative flex shrink-0 flex-col overflow-hidden border-l bg-panel'
      }
      style={fills ? undefined : { maxWidth: `calc(100% - ${DOCK_CHAT_MIN_PX}px)` }}
      // Slides in from the edge; widening grows it over the transcript.
      initial={{ width: 0 }}
      animate={{ width: fills ? '100%' : width }}
      // Dragging its edge follows the pointer at once; opening, widening and narrowing animate.
      transition={resized ? { duration: 0 } : TRANSITION}
      exit={{ width: 0, transition: TRANSITION }}
    >
      {!fills && <ResizeHandle panel="dock" label={`Resize ${title}`} />}
      <header className="flex h-44 shrink-0 items-center gap-4 border-b pr-8 pl-16">
        <h2 className="min-w-0 flex-1 truncate font-semibold">{title}</h2>
        {!cramped && (
          <Hint text={wide ? 'Back beside the chat (Esc)' : 'Fill the chat pane'}>
            <Button
              variant="ghost"
              size="icon"
              className="grid place-items-center"
              aria-label={wide ? `Narrow ${title}` : `Widen ${title}`}
              aria-pressed={wide}
              onClick={() => widenDock(!wide)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                {wide ? (
                  <path d="M6.5 2v4.5H2M9.5 14V9.5H14M2 2l4.5 4.5M14 14L9.5 9.5" />
                ) : (
                  <path d="M10 2h4v4M6 14H2v-4M14 2L9 7M2 14l5-5" />
                )}
              </svg>
            </Button>
          </Hint>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Close ${title}`}
          onClick={() => {
            // A draft in the panel saves as it loses focus, before the panel goes.
            if (ref.current?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
              document.activeElement.blur()
            }
            openDock(null)
          }}
        >
          ×
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-12">
        <ExtensionViewer
          extension={panel.extension}
          view={shown?.view}
          error={shown?.error}
          act={(action) => send({ type: 'extension.panel.action', chatId, extension: panel.extension, panel: panel.id, action })}
          set={(key, value) => send({ type: 'extension.space.set', chatId, extension: panel.extension, key, value })}
          reveal={(path) => send({ type: 'reveal', path })}
        />
      </div>
    </m.aside>
  )
}
