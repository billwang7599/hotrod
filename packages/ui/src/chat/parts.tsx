// Small pieces the transcript and its cards share: the working dots, a foldable row, and their text styles.
import { useContext, useState, type ReactNode } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Chevron, MOTION } from '../controls.tsx'
import { StepsOpen } from '../steps.ts'

export const ASSISTANT = 'min-w-0 text-body leading-[1.6] wrap-break-word'

export const BODY = 'max-h-320 overflow-y-auto py-8 pr-10 text-muted'

const DOT_STAGGER_MS = 200

export function Dots({ label, className = '' }: { label: string; className?: string }) {
  return (
    <span role="img" aria-label={label} className={`flex h-[1lh] shrink-0 items-center gap-4 ${className}`}>
      {[2, 1, 0].map((lag) => (
        <span
          key={lag}
          className="size-5 rounded-full bg-current animate-blink motion-reduce:animate-none"
          style={{ animationDelay: `-${lag * DOT_STAGGER_MS}ms` }}
        />
      ))}
    </span>
  )
}

export function Row({ summary, quiet, children }: { summary: ReactNode; quiet?: boolean; children: ReactNode }) {
  // Follows the chat's steps setting until the user opens or closes this row.
  const opens = useContext(StepsOpen)
  const [chosen, setOpen] = useState<boolean>()
  const open = chosen ?? opens
  return (
    <div className={`rounded border ${quiet ? 'border-transparent text-muted' : 'bg-panel shadow-raised'}`}>
      <button
        className={`group flex h-28 w-full items-center gap-8 rounded pr-10 pl-8 text-left transition-colors hover:bg-raised ${quiet ? 'text-sm' : 'text-ui'}`}
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => setOpen(!open)}
      >
        <Chevron />
        {summary}
      </button>
      <AnimatePresence initial={false}>{open && <m.div {...MOTION.collapse}>{children}</m.div>}</AnimatePresence>
    </div>
  )
}
