import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'
import { AnimatePresence, m, type Transition } from 'motion/react'
import { AlertDialog, Select as SelectPrimitive, Switch as SwitchPrimitive } from 'radix-ui'

const TOAST_MS = 6_000
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

export type SelectOption = { value: string; label: string; disabled?: boolean }

type SelectProps = {
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  title?: string
  disabled?: boolean
  variant?: keyof typeof SELECT_TRIGGERS
}

export function Select({ label, value, options, onChange, placeholder, title, disabled, variant = 'field' }: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={label}
        title={title}
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
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-40 max-h-(--radix-select-content-available-height) max-w-[calc(100vw-16px)] min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg border bg-panel text-text shadow-floating"
        >
          <SelectPrimitive.Viewport className="p-4">
            {options.map((o) => (
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
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

type SwitchProps = { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }

export function Switch({ label, checked, disabled, onChange }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      title={label}
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

type PendingConfirm = { text: string; resolve: (ok: boolean) => void }
let pendingConfirm: PendingConfirm | null = null
const confirmListeners = new Set<() => void>()

function settleConfirm(ok: boolean, next: PendingConfirm | null = null) {
  pendingConfirm?.resolve(ok)
  pendingConfirm = next
  confirmListeners.forEach((listener) => listener())
}

export function confirm(text: string) {
  return new Promise<boolean>((resolve) => settleConfirm(false, { text, resolve }))
}

const subscribeConfirm = (listener: () => void) => {
  confirmListeners.add(listener)
  return () => confirmListeners.delete(listener)
}

export function ConfirmDialog() {
  const pending = useSyncExternalStore(subscribeConfirm, () => pendingConfirm)
  const [text, setText] = useState('')
  if (pending && pending.text !== text) setText(pending.text)
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
              aria-describedby={undefined}
              onOpenAutoFocus={(e) => {
                focus.remember()
                e.preventDefault()
                okRef.current?.focus()
              }}
              onCloseAutoFocus={focus.restore}
            >
              <m.div
                className="fixed inset-0 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] flex-col gap-16 overflow-y-auto rounded-xl border bg-panel px-16 pt-14 pb-16 text-text shadow-overlay"
                {...MOTION.pop}
              >
                <AlertDialog.Title className="text-body leading-[1.5]">{text}</AlertDialog.Title>
                <div className="flex justify-end gap-8">
                  <AlertDialog.Cancel asChild>
                    <Button>Cancel</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild onClick={() => settleConfirm(true)}>
                    <Button ref={okRef} variant="primary">
                      OK
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
