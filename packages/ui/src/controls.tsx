import { useEffect } from 'react'

const TOAST_MS = 6_000

type SwitchProps = { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }

export function Switch({ label, checked, disabled, onChange }: SwitchProps) {
  return (
    <label className="switch" title={label}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" />
    </label>
  )
}

export function Toast({ id, message, dismiss }: { id: number; message: string; dismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [id, dismiss])
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button className="ghost" aria-label="Dismiss" onClick={() => dismiss(id)}>
        ×
      </button>
    </div>
  )
}
