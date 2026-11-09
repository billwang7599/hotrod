import { useState, type KeyboardEvent } from 'react'
import { Button, GROUP, Hint } from './controls.tsx'
import {
  bindingOf,
  conflictsOf,
  formatBinding,
  isCustom,
  refusal,
  resetAllBindings,
  resetBinding,
  setBinding,
  shortcutActions,
  useBindings,
  type Binding,
} from './shortcuts.ts'

/** Keys shown as small caps, the way menus and the search palette show them. */
export function Keys({ binding, className = '' }: { binding: Binding | null; className?: string }) {
  if (!binding) return <span className={`text-sm text-faint ${className}`}>None</span>
  return <kbd className={`font-sans text-sm tracking-[0.06em] text-muted ${className}`}>{formatBinding(binding)}</kbd>
}

type Pending = { id: string; keys: Binding; problem: string; conflict?: string[] }

/** Settings → Shortcuts: every action with its keys. Click a row's keys and press new ones to change them. */
export function ShortcutsPage() {
  const keys = useBindings()
  const [recording, setRecording] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const desktop = !!window.kothar
  const shown = shortcutActions().filter((a) => desktop || !a.desktopOnly)
  const anyCustom = shown.some((a) => isCustom(a.id))

  const record = (id: string) => (e: KeyboardEvent) => {
    // Every key goes to the recorder, so nothing else (a shortcut, the dialog) acts on it.
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return setRecording(null)
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      setBinding(id, null)
      setPending(null)
      return setRecording(null)
    }
    const pressed = bindingOf(e.nativeEvent)
    if (!pressed) return
    const refused = refusal(pressed)
    if (refused) return setPending({ id, keys: pressed, problem: refused })
    const others = conflictsOf(id, pressed, keys)
    setRecording(null)
    if (others.length) {
      const names = others.map((o) => o.label)
      return setPending({ id, keys: pressed, problem: `Already ${names.join(' and ')}`, conflict: others.map((o) => o.id) })
    }
    setPending(null)
    setBinding(id, pressed)
  }

  return (
    <>
      <div className={GROUP}>
        {shown.map((action) => {
          const isRecording = recording === action.id
          const problem = pending?.id === action.id ? pending : undefined
          return (
            <div key={action.id} className="flex flex-col gap-6 py-10 not-first:border-t" data-action={action.id}>
              <div className="flex items-center gap-12">
                <span className="min-w-0 flex-1">{action.label}</span>
                <Hint text={isRecording ? 'Press new keys. Esc cancels, Delete clears.' : 'Change keys'}>
                  <button
                    type="button"
                    aria-label={`Keys for ${action.label}`}
                    aria-pressed={isRecording}
                    className={`flex h-26 min-w-90 items-center justify-center rounded border px-8 transition-colors ${isRecording ? 'border-accent bg-bg text-accent' : 'bg-raised hover:bg-hover'}`}
                    onClick={() => {
                      setPending(null)
                      setRecording(isRecording ? null : action.id)
                    }}
                    onKeyDown={isRecording ? record(action.id) : undefined}
                    onBlur={() => isRecording && setRecording(null)}
                  >
                    {isRecording ? <span className="text-sm">Press keys…</span> : <Keys binding={keys[action.id] ?? null} />}
                  </button>
                </Hint>
                <Button
                  variant="ghost"
                  size="small"
                  className={isCustom(action.id) ? '' : 'invisible'}
                  aria-label={`Reset ${action.label}`}
                  onClick={() => {
                    setPending(null)
                    resetBinding(action.id)
                  }}
                >
                  Reset
                </Button>
              </div>
              {problem && (
                <div className="flex items-center justify-end gap-8 text-sm text-amber" role="status">
                  <span>
                    {formatBinding(problem.keys)}: {problem.problem}
                  </span>
                  {problem.conflict && (
                    <Button
                      size="small"
                      onClick={() => {
                        for (const other of problem.conflict!) setBinding(other, null)
                        setBinding(problem.id, problem.keys)
                        setPending(null)
                      }}
                    >
                      Use here instead
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex justify-end pt-12">
        <Button
          disabled={!anyCustom}
          onClick={() => {
            setPending(null)
            resetAllBindings()
          }}
        >
          Reset all
        </Button>
      </div>
    </>
  )
}
