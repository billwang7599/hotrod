import { createContext, useSyncExternalStore } from 'react'

/**
 * Whether a chat shows something unfolded: a default set in Settings, and a choice per chat set in its panel's General
 * tab. Two of these: thinking and tool calls (a finished turn's steps stay listed instead of folding into "N steps",
 * and each thinking and tool row starts open; folded by default), and subagent reports (unfolded by default, so a
 * report isn't missed). Each report card also keeps its own choice once the user opens or closes it.
 */
type Saved = { default: boolean; chats: Record<string, boolean> }

function shownStore(key: string, fallback: boolean) {
  const listeners = new Set<() => void>()

  function read(): Saved {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}')
      const chats = saved.chats && typeof saved.chats === 'object' ? saved.chats : {}
      return {
        default: typeof saved.default === 'boolean' ? saved.default : fallback,
        chats: Object.fromEntries(Object.entries(chats).filter(([, on]) => typeof on === 'boolean')) as Saved['chats'],
      }
    } catch {
      return { default: fallback, chats: {} }
    }
  }

  let current = read()

  function save(next: Saved) {
    current = next
    localStorage.setItem(key, JSON.stringify(current))
    for (const listener of listeners) listener()
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const snapshot = () => current

  return {
    /** Sets the default for every chat without a choice of its own. */
    byDefault(shown: boolean) {
      save({ ...current, default: shown })
    },
    /** Sets one chat's choice; undefined drops it, so the chat follows Settings again. */
    setIn(id: string, shown: boolean | undefined) {
      const { [id]: _, ...chats } = current.chats
      save({ ...current, chats: shown === undefined ? chats : { ...chats, [id]: shown } })
    },
    /** Rereads the saved choices, for tests that clear storage. */
    reload() {
      current = read()
      for (const listener of listeners) listener()
    },
    useDefault(): boolean {
      return useSyncExternalStore(subscribe, snapshot, snapshot).default
    },
    /** One id's own choice, if it has one. */
    useChoice(id: string): boolean | undefined {
      return useSyncExternalStore(subscribe, snapshot, snapshot).chats[id]
    },
    /** A chat without a choice of its own follows the first chat above it that has one (a subagent, its space's). */
    useShown(chatId: string, ...above: string[]): boolean {
      const saved = useSyncExternalStore(subscribe, snapshot, snapshot)
      return [chatId, ...above].map((id) => saved.chats[id]).find((on) => on !== undefined) ?? saved.default
    },
  }
}

const steps = shownStore('kothar.showSteps', false)
export const showStepsByDefault = steps.byDefault
export const showStepsIn = steps.setIn
export const useStepsDefault = steps.useDefault
export const useStepsShown = steps.useShown

const reports = shownStore('kothar.showReports', true)
export const showReportsByDefault = reports.byDefault
export const showReportsIn = reports.setIn
export const useReportsDefault = reports.useDefault
export const useReportsShown = reports.useShown

// Each card's own choice, keyed by `<chat id>/<item index>`; the store's default is unused.
const reportCards = shownStore('kothar.reportCards', true)
export const reportCardKey = (chatId: string, at: number) => `${chatId}/${at}`
export const openReportCard = reportCards.setIn
export const useReportCardChoice = reportCards.useChoice

/** Rereads every saved choice, for tests that clear storage. */
export function reloadSteps() {
  steps.reload()
  reports.reload()
  reportCards.reload()
}

/** Whether thinking and tool rows start open, for the rows inside one chat's transcript. */
export const StepsOpen = createContext(false)

/** Whether report cards start open, for the cards inside one chat's transcript. */
export const ReportsOpen = createContext(true)
