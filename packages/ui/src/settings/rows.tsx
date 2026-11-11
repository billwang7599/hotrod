// The row every Settings page is built from, and plain text with its links made clickable.
import type { ReactNode } from 'react'

type RowProps = { name: ReactNode; description?: ReactNode; children?: ReactNode; below?: ReactNode }

export function SettingRow({ name, description, children, below }: RowProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-16 gap-y-8 py-12 not-first:border-t">
      <div className="flex min-w-200 flex-1 flex-col gap-2 wrap-anywhere">
        {name}
        {description && <div className="text-sm text-muted">{description}</div>}
      </div>
      <div className="flex max-w-full min-w-0 items-center gap-6">{children}</div>
      {below && <div className="basis-full">{below}</div>}
    </div>
  )
}

// An extension's text is plain; its web addresses become links.
export const linked = (text: string) =>
  text.split(/(https:\/\/[^\s)]*[^\s).,;:])/).map((part, i) =>
    i % 2 ? (
      <a key={i} className="text-accent underline" href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  )
