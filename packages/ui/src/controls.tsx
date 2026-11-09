import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import { AnimatePresence, m, type Transition } from 'motion/react'
import { AlertDialog, Select as SelectPrimitive, Switch as SwitchPrimitive, Tooltip } from 'radix-ui'

const TOAST_MS = 6_000
export const COPIED_MS = 1_500
const EASE_OUT = [0.2, 0, 0, 1] as const

export const TRANSITION: Transition = { duration: 0.18, ease: EASE_OUT }

export const MOTION = {
  fade: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } },
  pop: { initial: { opacity: 0, scale: 0.97 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.97 } },
  rise: { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } },
  menu: { initial: { opacity: 0, y: -4 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.12, ease: EASE_OUT } },
  // Overflow is hidden only while animating, so focus rings aren't clipped once open.
  collapse: {
    initial: { height: 0, opacity: 0, overflow: 'hidden' },
    animate: { height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } },
    exit: { height: 0, opacity: 0, overflow: 'hidden' },
  },
} as const

export function SidePanel({ side, overlay, children }: { side: 'left' | 'right'; overlay: boolean; children: ReactNode }) {
  const position = overlay ? `absolute inset-y-0 z-20 shadow-overlay ${side === 'left' ? 'left-0' : 'right-0'}` : 'shrink-0'
  return (
    <m.div
      className={`flex overflow-hidden ${position}`}
      initial={{ width: 0 }}
      animate={{ width: 'auto' }}
      exit={{ width: 0 }}
    >
      {children}
    </m.div>
  )
}

export function useSettled(ready = true) {
  const settled = useRef(false)
  useEffect(() => {
    if (ready) settled.current = true
  }, [ready])
  return settled
}

export const CHAT_NOUN = { one: 'space', many: 'spaces' }

// Radix Select hands focus back as :focus-visible even after a click, so hints track the last input instead.
let typing = false
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => (typing = true), true)
  document.addEventListener('pointerdown', () => (typing = false), true)
}

type HintProps = Omit<ComponentProps<typeof Tooltip.Trigger>, 'asChild'> & {
  text?: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactElement
}

// Inside another Radix trigger, nest the Hint in it: wrapped around one, the tooltip's data-state would win.
export function Hint({ text, side, align, open, onOpenChange, children, onFocus, ...props }: HintProps) {
  return (
    <Tooltip.Root open={text ? open : false} onOpenChange={onOpenChange}>
      <Tooltip.Trigger
        asChild
        data-hint={text ? '' : undefined}
        {...props}
        onFocus={(e) => {
          onFocus?.(e)
          if (!typing) e.preventDefault()
        }}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content asChild side={side} align={align} sideOffset={6} collisionPadding={8}>
          <m.div
            className="z-50 max-w-280 rounded border bg-panel px-8 py-4 text-sm leading-[1.4] text-text shadow-floating"
            initial={MOTION.menu.initial}
            animate={MOTION.menu.animate}
            transition={MOTION.menu.transition}
          >
            {text}
          </m.div>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

type PanelToggleProps = { side: 'left' | 'right'; label: string; noun: string; open: boolean; toggle: () => void }

export function PanelToggle({ side, label, noun, open, toggle }: PanelToggleProps) {
  return (
    <Hint text={`${open ? 'Hide' : 'Show'} ${noun}`}>
      <Button
        variant="ghost"
        size="icon"
        className="grid place-items-center aria-pressed:text-text"
        aria-label={label}
        aria-pressed={open}
        onClick={toggle}
      >
        <svg
          className={side === 'left' ? '-scale-x-100' : ''}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M10 2.5v11" />
          {open && <path d="M10 2.5h3a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-3z" fill="currentColor" />}
        </svg>
      </Button>
    </Hint>
  )
}

const COPY_RESULTS = {
  copied: { text: 'Copied', color: 'text-green' },
  failed: { text: "Couldn't copy", color: 'text-red' },
}
const COPY_REVEAL = 'opacity-0 [:hover>&]:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'

type CopyButtonProps = { text: string; label: string; className?: string }

export function CopyButton({ text, label, className = '' }: CopyButtonProps) {
  const [result, setResult] = useState<keyof typeof COPY_RESULTS>()
  const [hovered, setHovered] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    let copied = true
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      copied = false
    }
    setResult(copied ? 'copied' : 'failed')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setResult(undefined), COPIED_MS)
  }
  return (
    <Hint text={result ? COPY_RESULTS[result].text : 'Copy'} open={!!result || hovered} onOpenChange={setHovered}>
      <button
        className={`grid size-24 shrink-0 place-items-center rounded text-muted transition-[opacity,background-color,color] duration-150 hover:bg-raised hover:text-text ${result ? '' : COPY_REVEAL} ${className}`}
        aria-label={result ? COPY_RESULTS[result].text : label}
        onClick={copy}
      >
        <svg
          className={result && COPY_RESULTS[result].color}
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          {result === 'copied' ? (
            <path d="M3 8.5 6.5 12 13 4.5" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <g strokeWidth="1.4">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
            </g>
          )}
        </svg>
      </button>
    </Hint>
  )
}

type CopyBlockProps = { text: string; label: string; className?: string; children: ReactNode }

export function CopyBlock({ text, label, className = '', children }: CopyBlockProps) {
  return (
    <div className={`relative ${className}`}>
      {text && (
        <CopyButton text={text} label={label} className="absolute top-6 right-6 border bg-panel shadow-floating" />
      )}
      {children}
    </div>
  )
}

export const GROUP = 'flex flex-col rounded-lg border bg-panel px-14 shadow-raised'

export const NAV_LABEL =
  'mx-8 mt-14 mb-4 flex items-center gap-6 text-xs font-semibold tracking-[0.04em] text-faint uppercase'

const PRESSABLE = 'enabled:shadow-raised enabled:active:shadow-sunken disabled:text-faint'
const BUTTON_VARIANTS = {
  default: `enabled:bg-raised enabled:hover:bg-hover ${PRESSABLE}`,
  primary: `enabled:border-accent enabled:bg-accent enabled:text-on-accent enabled:hover:bg-accent-hover ${PRESSABLE}`,
  danger: `enabled:text-red enabled:hover:border-red enabled:hover:bg-red/10 ${PRESSABLE}`,
  ghost: 'border-transparent text-muted enabled:hover:bg-raised enabled:hover:text-text enabled:active:bg-hover',
}
const BUTTON_SIZES = {
  normal: 'h-control px-12',
  small: 'h-24 px-8 text-sm',
  icon: 'size-24 text-[16px] leading-none',
  none: '',
}

type ButtonProps = ComponentProps<'button'> & {
  variant?: keyof typeof BUTTON_VARIANTS
  size?: keyof typeof BUTTON_SIZES
}

export function Button({ variant = 'default', size = 'normal', className = '', ...props }: ButtonProps) {
  const classes = `rounded border whitespace-nowrap transition-[background-color,border-color,color,box-shadow] ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`
  return <button className={classes} {...props} />
}

const SELECT_TRIGGERS = {
  field: `h-control gap-8 rounded border bg-bg px-8 enabled:hover:bg-raised ${PRESSABLE}`,
  chip: 'h-26 max-w-220 gap-6 rounded border border-transparent pr-6 pl-8 text-sm text-muted enabled:hover:border-border enabled:hover:text-text enabled:hover:shadow-raised disabled:text-faint data-[state=open]:border-border data-[state=open]:text-text max-[900px]:max-w-150',
}

// group: options with one sit under its heading, in the order the groups first appear.
export type SelectOption = { value: string; label: string; disabled?: boolean; group?: string }

type SelectProps = {
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
  disabled?: boolean
  variant?: keyof typeof SELECT_TRIGGERS
}

export function Select({ label, value, options, onChange, placeholder, hint, disabled, variant = 'field' }: SelectProps) {
  const [open, setOpen] = useState(false)
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled} open={open} onOpenChange={setOpen}>
      <SelectPrimitive.Trigger asChild aria-label={label}>
        <Hint text={!open && hint}>
          <button
            className={`flex min-w-0 items-center whitespace-nowrap transition-[background-color,border-color,color,box-shadow] data-placeholder:text-muted ${SELECT_TRIGGERS[variant]}`}
          >
            <span className="min-w-0 truncate">
              <SelectPrimitive.Value placeholder={placeholder} />
            </span>
            <SelectPrimitive.Icon className="shrink-0 text-faint">
              <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M1 1l4 4 4-4" strokeWidth="1.5" />
              </svg>
            </SelectPrimitive.Icon>
          </button>
        </Hint>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-40 max-h-(--radix-select-content-available-height) max-w-[calc(100vw-16px)] min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg border bg-panel text-text shadow-floating"
        >
          <SelectPrimitive.Viewport className="p-4">
            {groupsOf(options).map(({ group, items }) =>
              group === undefined ? (
                items.map(selectItem)
              ) : (
                <SelectPrimitive.Group key={group} className="not-first:pt-4">
                  <SelectPrimitive.Label className="flex h-22 items-center px-8 text-xs text-faint">
                    {group}
                  </SelectPrimitive.Label>
                  {items.map(selectItem)}
                </SelectPrimitive.Group>
              ),
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

function groupsOf(options: SelectOption[]) {
  const groups: { group?: string; items: SelectOption[] }[] = []
  for (const o of options) {
    const found = groups.find((g) => g.group === o.group)
    if (found) found.items.push(o)
    else groups.push({ group: o.group, items: [o] })
  }
  return groups
}

const selectItem = (o: SelectOption) => (
  <SelectPrimitive.Item
    key={o.value}
    value={o.value}
    disabled={o.disabled}
    className="flex h-26 items-center gap-8 rounded-sm pr-12 pl-8 text-sm whitespace-nowrap outline-none data-disabled:text-faint data-highlighted:bg-raised"
  >
    <span className="w-12 shrink-0 text-accent">
      <SelectPrimitive.ItemIndicator>✓</SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
)

type SwitchProps = { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }

export function Switch({ label, checked, disabled, onChange }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      className="relative h-20 w-34 shrink-0 rounded-full border bg-hover shadow-sunken transition-[background-color] duration-150 focus-visible:outline-offset-2 disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
    >
      <SwitchPrimitive.Thumb className="absolute top-2 left-2 size-14 rounded-full bg-muted shadow-raised transition-transform duration-150 data-[state=checked]:translate-x-14 data-[state=checked]:bg-on-accent" />
    </SwitchPrimitive.Root>
  )
}

export function Chevron() {
  return (
    <span className="w-10 shrink-0 text-faint before:inline-block before:text-[14px] before:leading-none before:transition-transform before:duration-120 before:content-['›'] group-open:before:rotate-90 group-data-open:before:rotate-90" />
  )
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-8 text-ui text-red before:size-7 before:shrink-0 before:-translate-y-1 before:rounded-full before:bg-current">
      {children}
    </div>
  )
}

export function Toast({ id, message, dismiss }: { id: number; message: string; dismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [id, dismiss])
  return (
    <m.div {...MOTION.collapse}>
      <div
        className="mb-8 flex items-start gap-8 rounded-lg border border-l-3 border-l-red bg-panel py-8 pr-6 pl-12 shadow-floating"
        role="status"
      >
        <span className="flex-1 pt-3 [word-break:break-word]">{message}</span>
        <Button variant="ghost" size="none" className="size-22" aria-label="Dismiss" onClick={() => dismiss(id)}>
          ×
        </Button>
      </div>
    </m.div>
  )
}

// Radix dialogs return focus to their Trigger, and ours open without one, so put it back where it was.
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null)
  return {
    remember: () => {
      opener.current = document.activeElement as HTMLElement | null
    },
    restore: (e: Event) => {
      e.preventDefault()
      opener.current?.focus()
    },
  }
}

// text: the question, as the dialog's title; body: what follows it, such as risks; ok: the confirming button's label.
export type ConfirmRequest = { text: string; body?: string; ok?: string; danger?: boolean }
type PendingConfirm = ConfirmRequest & { resolve: (ok: boolean) => void }
let pendingConfirm: PendingConfirm | null = null
const confirmListeners = new Set<() => void>()

function settleConfirm(ok: boolean, next: PendingConfirm | null = null) {
  pendingConfirm?.resolve(ok)
  pendingConfirm = next
  confirmListeners.forEach((listener) => listener())
}

export function confirm(request: string | ConfirmRequest) {
  const asked = typeof request === 'string' ? { text: request } : request
  return new Promise<boolean>((resolve) => settleConfirm(false, { ...asked, resolve }))
}

const subscribeConfirm = (listener: () => void) => {
  confirmListeners.add(listener)
  return () => confirmListeners.delete(listener)
}

export function ConfirmDialog() {
  const pending = useSyncExternalStore(subscribeConfirm, () => pendingConfirm)
  // Kept while the dialog animates out, after pending is cleared.
  const [shown, setShown] = useState<ConfirmRequest>({ text: '' })
  if (pending && pending !== shown && (pending.text !== shown.text || pending.body !== shown.body || pending.ok !== shown.ok)) {
    setShown({ text: pending.text, body: pending.body, ok: pending.ok, danger: pending.danger })
  }
  const { text, body, ok, danger } = shown
  const okRef = useRef<HTMLButtonElement>(null)
  const focus = useReturnFocus()
  return (
    <AlertDialog.Root open={!!pending} onOpenChange={(open) => open || settleConfirm(false)}>
      <AnimatePresence>
        {pending && (
          <AlertDialog.Portal forceMount>
            <AlertDialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </AlertDialog.Overlay>
            <AlertDialog.Content
              forceMount
              asChild
              {...(!body && { 'aria-describedby': undefined })}
              onOpenAutoFocus={(e) => {
                focus.remember()
                e.preventDefault()
                okRef.current?.focus()
              }}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-0 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] flex-col gap-16 scroll-inset overflow-y-auto rounded-xl border bg-panel pt-14 pr-2 pb-16 pl-16 text-text shadow-overlay"
                {...MOTION.pop}
              >
                <div className="flex flex-col gap-8">
                  <AlertDialog.Title
                    className={`leading-[1.5] whitespace-pre-line ${body ? 'text-[16px] font-semibold' : 'text-body'}`}
                  >
                    {text}
                  </AlertDialog.Title>
                  {body && (
                    <AlertDialog.Description className="text-ui leading-[1.5] whitespace-pre-line text-muted">
                      {body}
                    </AlertDialog.Description>
                  )}
                </div>
                <div className="flex justify-end gap-8">
                  <AlertDialog.Cancel asChild>
                    <Button>Cancel</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild onClick={() => settleConfirm(true)}>
                    <Button ref={okRef} variant={danger ? 'danger' : 'primary'}>
                      {ok ?? 'OK'}
                    </Button>
                  </AlertDialog.Action>
                </div>
              </m.div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        )}
      </AnimatePresence>
    </AlertDialog.Root>
  )
}
