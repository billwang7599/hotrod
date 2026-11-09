import { useLayoutEffect, useRef, useState } from 'react'
import { m } from 'motion/react'
import { DropdownMenu } from 'radix-ui'
import { Button, MOTION } from './controls.tsx'

/**
 * The right panel's tab row. Tabs keep their full labels; the ones that don't fit the panel's width move into a "More"
 * menu at the end of the row, and the open tab always stays in the row. Nothing scrolls sideways.
 */
export type TabEntry = { id: string; label: string }

const TAB_CLASS = 'shrink-0 rounded px-8 py-4 font-semibold whitespace-nowrap'
// Matches the row's gap-2.
const GAP_PX = 2

/**
 * Which tabs stay in the row, given each tab's width, the More button's and the room there is. All of them if they
 * fit; otherwise the open tab, then the others in order while they fit beside More. An unmeasured row (width 0, as
 * before layout) shows every tab.
 */
export function fitTabs(widths: number[], room: number, moreWidth: number, active: number): boolean[] {
  const all = widths.map(() => true)
  const total = widths.reduce((sum, w) => sum + w, 0) + GAP_PX * Math.max(widths.length - 1, 0)
  if (room <= 0 || total <= room) return all
  const shown = widths.map((_, i) => i === active)
  let used = moreWidth + (active >= 0 ? widths[active]! + GAP_PX : 0)
  widths.forEach((w, i) => {
    if (i === active || used + w + GAP_PX > room) return
    shown[i] = true
    used += w + GAP_PX
  })
  return shown
}

type PanelTabsProps = { tabs: TabEntry[]; active: string; choose: (id: string) => void }

export function PanelTabs({ tabs, active, choose }: PanelTabsProps) {
  const row = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(0)
  const [widths, setWidths] = useState<number[]>([])
  const labels = tabs.map((t) => t.label).join('\n')
  // Measured before paint, from an invisible copy of every tab, so the row never shows a frame of overflow.
  useLayoutEffect(() => {
    const measure = () => {
      const next = [...(ruler.current?.children ?? [])].map((c) => Math.ceil(c.getBoundingClientRect().width))
      setWidths((prev) => (prev.length === next.length && prev.every((w, i) => w === next[i]) ? prev : next))
      setRoom(row.current?.clientWidth ?? 0)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (row.current) observer.observe(row.current)
    if (ruler.current) observer.observe(ruler.current)
    return () => observer.disconnect()
  }, [labels])
  const activeIndex = tabs.findIndex((t) => t.id === active)
  const measured = widths.length === tabs.length + 1
  const shown = measured ? fitTabs(widths.slice(0, -1), room, widths.at(-1)!, activeIndex) : tabs.map(() => true)
  const hidden = tabs.filter((_, i) => !shown[i])
  return (
    // The row takes the header's free width whatever the tabs need, so measuring it never feeds back.
    <div ref={row} className="relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      <div role="tablist" aria-label="Panel" className="flex min-w-0 items-center gap-2">
        {tabs.map(
          (t, i) =>
            shown[i] && (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === active}
                className={`${TAB_CLASS} text-muted transition-[background-color,color] hover:bg-hover hover:text-text aria-selected:bg-hover aria-selected:text-text`}
                onClick={() => choose(t.id)}
              >
                {t.label}
              </button>
            ),
        )}
      </div>
      {hidden.length > 0 && <MoreTabs tabs={hidden} choose={choose} />}
      {/* The ruler: every tab, then the More button, at natural width; never seen or reached. */}
      <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute top-0 left-0 flex w-max">
        {tabs.map((t) => (
          <span key={t.id} className={TAB_CLASS}>
            {t.label}
          </span>
        ))}
        <span className="size-24 shrink-0" />
      </div>
    </div>
  )
}

function MoreTabs({ tabs, choose }: { tabs: TabEntry[]; choose: (id: string) => void }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" className="shrink-0" aria-label={`More tabs: ${tabs.map((t) => t.label).join(', ')}`}>
          ⋯
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content asChild align="end" sideOffset={4}>
          <m.div
            className="z-20 flex min-w-140 flex-col rounded-lg border bg-panel p-4 shadow-floating outline-none"
            initial={MOTION.menu.initial}
            animate={MOTION.menu.animate}
            transition={MOTION.menu.transition}
          >
            {tabs.map((t) => (
              <DropdownMenu.Item
                key={t.id}
                onSelect={() => choose(t.id)}
                className="flex h-26 items-center rounded-sm px-12 text-sm whitespace-nowrap outline-none data-highlighted:bg-raised"
              >
                {t.label}
              </DropdownMenu.Item>
            ))}
          </m.div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
