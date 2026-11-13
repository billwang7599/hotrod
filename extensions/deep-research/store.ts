// Each research run's record, kept so its evidence can be checked later: runs/<space id>/<run id>.json holds the
// question, the plan, every worker's findings (dropped ones too, with why), the sources and where the report went;
// <run id>.md is the report. A space's runs go when the space is deleted.
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionStorage } from '@kothar/extension-api'
import type { Finding, Source } from './report.ts'

export type Depth = 'quick' | 'standard' | 'thorough'
export const DEPTHS: readonly Depth[] = ['quick', 'standard', 'thorough']

// How far each depth goes: workers at once, workers and sources in all, follow-up rounds after the first, and how
// many sub-questions the plan aims for.
export const DEPTH_LIMITS: Record<Depth, { parallel: number; workers: number; sources: number; rounds: number; subs: string }> = {
  quick: { parallel: 2, workers: 4, sources: 12, rounds: 0, subs: '3' },
  standard: { parallel: 3, workers: 10, sources: 30, rounds: 1, subs: '4 to 6' },
  thorough: { parallel: 5, workers: 20, sources: 60, rounds: 2, subs: '6 to 8' },
}

export type Phase = 'planning' | 'awaiting' | 'researching' | 'reviewing' | 'writing' | 'done' | 'stopped' | 'cancelled' | 'failed'
export const ACTIVE: readonly Phase[] = ['planning', 'awaiting', 'researching', 'reviewing', 'writing']

export type Plan = { subQuestions: string[]; sources: string[] }

export type WorkerRecord = { chatId: string; sub: number; round: number; state: 'running' | 'done' | 'failed' | 'stopped'; error?: string }

export type ReportPlace = { kind: 'artifact' | 'note' | 'file'; title: string; ref: string }

export type Run = {
  id: string
  spaceId: string
  // The chat that asked: the agent's (the tool), or the space (the popup).
  chatId: string
  question: string
  depth: Depth
  phase: Phase
  startedAt: string
  endedAt?: string
  round: number
  plan?: Plan
  // Sub-questions added by follow-up rounds come after the plan's, so a finding's sub indexes this list.
  subQuestions: string[]
  workers: WorkerRecord[]
  findings: Finding[]
  sources: Record<string, Source>
  limits: { parallel: number; workers: number; sources: number; rounds: number }
  partial?: string
  summary?: string
  report?: ReportPlace
  error?: string
}

const folderOf = (spaceId: string) => `runs/${spaceId}`
const fileOf = (spaceId: string, runId: string) => `${folderOf(spaceId)}/${runId}.json`
const reportFileOf = (spaceId: string, runId: string) => `${folderOf(spaceId)}/${runId}.md`

export function openStore(storage: ExtensionStorage) {
  const read = (spaceId: string, runId: string): Run | undefined => {
    const text = storage.read(fileOf(spaceId, runId))
    if (!text) return undefined
    try {
      return JSON.parse(text) as Run
    } catch {
      return undefined
    }
  }
  return {
    save: (run: Run) => storage.write(fileOf(run.spaceId, run.id), JSON.stringify(run, null, 2)),
    read,
    // The space's runs, newest first.
    list(spaceId: string): Run[] {
      return storage
        .list(folderOf(spaceId))
        .filter((f) => f.name.endsWith('.json'))
        .flatMap((f) => read(spaceId, f.name.slice(0, -'.json'.length)) ?? [])
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
    // Every space's runs, for finding runs Kothar quit in the middle of.
    spaces: (): string[] => {
      try {
        // Folders aren't listed by storage.list, so the runs folder is read through its path.
        return readdirSync(join(storage.dir, 'runs'))
      } catch {
        return []
      }
    },
    saveReport: (run: Run, markdown: string) => storage.write(reportFileOf(run.spaceId, run.id), markdown),
    readReport: (spaceId: string, runId: string) => storage.read(reportFileOf(spaceId, runId)),
    remove(spaceId: string, runId: string) {
      storage.remove(fileOf(spaceId, runId))
      storage.remove(reportFileOf(spaceId, runId))
    },
    removeSpace: (spaceId: string) => rmSync(join(storage.dir, folderOf(spaceId)), { recursive: true, force: true }),
  }
}

export type Store = ReturnType<typeof openStore>
