// A question an agent asks, answered by picking options (or typing Other) and Submit.
import { useEffect, useRef, useState } from 'react'
import { Button, Hint } from '../controls.tsx'
import type { Item } from '../state.ts'
import type { PromptProps } from './permission.tsx'

type QuestionItem = Extract<Item, { kind: 'question' }>

function ChoiceMark({ multi, on }: { multi: boolean; on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-2 grid size-14 shrink-0 place-items-center border transition-colors ${multi ? 'rounded-sm' : 'rounded-full'} ${on ? 'border-accent bg-accent text-on-accent' : 'bg-panel shadow-sunken'}`}
    >
      {on &&
        (multi ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <path d="M2 5.2 4.2 7.4 8 3" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className="size-6 rounded-full bg-current" />
        ))}
    </span>
  )
}

export function QuestionCard({ item, chat, connected, send }: { item: QuestionItem } & Omit<PromptProps, 'permission'>) {
  const { questions } = item
  const [shown, setShown] = useState(0)
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []))
  // Undefined while Other isn't chosen; the text typed once it is.
  const [typed, setTyped] = useState<(string | undefined)[]>(() => questions.map(() => undefined))
  const [sent, setSent] = useState(false)
  if (sent && !connected) setSent(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const asking = chat.status === 'waiting'
  const live = asking && connected && !sent
  const question = questions[shown]!
  const otherAt = question.options.length
  const answerOf = (i: number) => {
    const other = typed[i]?.trim()
    const labels = questions[i]!.options.flatMap((o) => (picked[i]!.includes(o.label) ? [o.label] : []))
    return other ? [...labels, other] : labels
  }
  const firstOpen = questions.findIndex((_, i) => answerOf(i).length === 0)

  const choose = (n: number) => {
    const mine = picked[shown]!
    if (n === otherAt) {
      setTyped(typed.with(shown, typed[shown] === undefined ? '' : undefined))
      if (!question.multiSelect) setPicked(picked.with(shown, []))
      return
    }
    const { label } = question.options[n]!
    if (question.multiSelect) {
      setPicked(picked.with(shown, mine.includes(label) ? mine.filter((l) => l !== label) : [...mine, label]))
      return
    }
    setPicked(picked.with(shown, [label]))
    setTyped(typed.with(shown, undefined))
    if (shown + 1 < questions.length) setShown(shown + 1)
  }
  const submit = () => {
    if (!live) return
    if (firstOpen >= 0) return setShown(firstOpen)
    const answers = Object.fromEntries(questions.map((q, i) => [q.question, answerOf(i)]))
    setSent(true)
    send({ type: 'question.respond', chatId: chat.id, requestId: item.requestId, answers })
  }
  const skip = () => {
    setSent(true)
    send({ type: 'question.respond', chatId: chat.id, requestId: item.requestId })
  }

  useEffect(() => {
    if (!live) return
    // Keys count while nothing else has focus, so the card answers without being clicked first.
    const onKey = (e: KeyboardEvent) => {
      const card = cardRef.current
      const focus = document.activeElement
      if (!card || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      if (focus && focus !== document.body && !card.contains(focus)) return
      const typing = e.target instanceof HTMLInputElement
      if (e.key === 'Enter') {
        if (!typing && e.target instanceof Element && e.target.closest('[data-action]')) return
        e.preventDefault()
        return submit()
      }
      if (typing) return
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (step && questions[shown + step]) {
        e.preventDefault()
        return setShown(shown + step)
      }
      if (!/^[1-9]$/.test(e.key) || Number(e.key) > otherAt + 1) return
      e.preventDefault()
      choose(Number(e.key) - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const choices = [...question.options, { label: 'Other…', description: '' }]
  return (
    <div
      ref={cardRef}
      role="group"
      aria-label="Question"
      className="flex flex-col gap-10 rounded-lg border border-l-3 border-l-accent bg-panel px-14 py-12 shadow-raised"
    >
      {questions.length > 1 && (
        <div role="tablist" aria-label="Questions" className="-mx-6 -mt-2 flex flex-wrap gap-2">
          {questions.map((q, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === shown}
              className="flex items-center gap-4 rounded px-6 py-2 text-sm font-semibold text-muted transition-[background-color,color] hover:bg-hover hover:text-text aria-selected:bg-hover aria-selected:text-text"
              onClick={() => setShown(i)}
            >
              {answerOf(i).length > 0 && (
                <span className="text-green" aria-hidden="true">
                  ✓
                </span>
              )}
              {q.header}
            </button>
          ))}
        </div>
      )}
      <div className="text-body leading-[1.5]">{question.question}</div>
      <div
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.header}
        className="flex flex-col overflow-hidden rounded border bg-bg"
      >
        {choices.map((choice, n) => {
          const other = n === otherAt
          const on = other ? typed[shown] !== undefined : picked[shown]!.includes(choice.label)
          return (
            <button
              key={n}
              type="button"
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              data-label={other ? 'Other' : choice.label}
              disabled={!live}
              className="flex w-full items-start gap-10 border-t px-10 py-8 text-left transition-colors first:border-t-0 enabled:hover:bg-raised aria-checked:bg-accent/8 disabled:text-muted"
              onClick={() => choose(n)}
            >
              <ChoiceMark multi={question.multiSelect} on={on} />
              <span className="flex min-w-0 flex-1 flex-col gap-1 leading-[1.4]">
                <strong className={`font-semibold ${other && !on ? 'text-muted' : ''}`}>{choice.label}</strong>
                {choice.description && <span className="text-sm text-muted">{choice.description}</span>}
              </span>
              <kbd className="mt-1 shrink-0 rounded-sm border px-4 font-mono text-xs leading-[1.5] text-faint">{n + 1}</kbd>
            </button>
          )
        })}
        {typed[shown] !== undefined && (
          <div className="border-t px-10 py-8">
            <input
              key={shown}
              autoFocus
              aria-label="Other answer"
              placeholder="Your answer"
              className="w-full"
              value={typed[shown]}
              disabled={!live}
              onChange={(e) => setTyped(typed.with(shown, e.target.value))}
            />
          </div>
        )}
      </div>
      {asking ? (
        <div className="flex items-center gap-8">
          <Hint text={`Enter to submit · 1–${otherAt + 1} to pick${questions.length > 1 ? ' · ←→ switch questions' : ''}`}>
            <span className="flex">
              <Button
                variant="primary"
                data-action
                className="disabled:pointer-events-none"
                disabled={!live || firstOpen >= 0}
                onClick={submit}
              >
                Submit
              </Button>
            </span>
          </Hint>
          <Hint text="Tell the agent you'd rather not answer">
            <Button variant="ghost" data-action disabled={!connected || sent} onClick={skip}>
              Skip
            </Button>
          </Hint>
        </div>
      ) : (
        <div className="text-sm text-muted">{chat.status === 'stopping' ? 'Stopping…' : 'Pending'}</div>
      )}
    </div>
  )
}
