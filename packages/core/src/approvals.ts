import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionUse } from '@kothar/extension-api'
import { type CommunityInstall, communityDir, EXTENSION_MAIN, sha256 } from './marketplace.ts'

// What the user turned on, per community extension: the exact files (by sha256) of the version they reviewed. Kothar
// imports an extension only while its files on disk match this, so an update, a reinstall with other files or an edit
// by hand stays off until the user turns it on again. Plain JSON in the garage, beside the extensions it describes.
export type Approval = {
  version: string
  sha256: Record<string, string>
  uses: ExtensionUse[]
  approvedAt: string
  source: 'marketplace' | 'local' | 'legacy'
  repo?: string
  tag?: string
  path?: string
  // Approved by the Kothar that first kept approvals, because the extension was already on.
  carriedOver?: true
}

// Every install, update, approval and removal, one JSON object a line, oldest first: what ran when, for the user to read.
export type HistoryEntry = {
  at: string
  id: string
  event: 'installed' | 'updated' | 'approved' | 'held' | 'uninstalled'
  version?: string
  sha256?: Record<string, string>
  uses?: ExtensionUse[]
  repo?: string
  tag?: string
  path?: string
  reason?: string
}

export const APPROVALS = 'approvals.json'
export const HISTORY = 'history.jsonl'
const FILES = ['manifest.json', EXTENSION_MAIN]

export const approvalsFile = (garage: string) => join(communityDir(garage), APPROVALS)
export const historyFile = (garage: string) => join(communityDir(garage), HISTORY)

// undefined when no Kothar has kept approvals in this garage yet.
export function readApprovals(garage: string): Record<string, Approval> | undefined {
  const file = approvalsFile(garage)
  if (!existsSync(file)) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Approval>) : {}
  } catch {
    // A file that can't be read approves nothing, so nothing runs that the user didn't see.
    return {}
  }
}

function writeApprovals(garage: string, approvals: Record<string, Approval>) {
  mkdirSync(communityDir(garage), { recursive: true })
  const file = approvalsFile(garage)
  const fresh = `${file}.tmp`
  writeFileSync(fresh, `${JSON.stringify(approvals, null, 2)}\n`)
  renameSync(fresh, file)
}

// now is the core's clock (openCore's now), passed in so tests can fix the time.
export function logHistory(garage: string, now: () => Date, entry: Omit<HistoryEntry, 'at'> & { at?: string }) {
  try {
    mkdirSync(communityDir(garage), { recursive: true })
    appendFileSync(historyFile(garage), `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`)
  } catch (error) {
    console.error(`Couldn't add to the community extension history: ${error instanceof Error ? error.message : error}`)
  }
}

// The sha256 of each of the extension's files as they are on disk now.
export function filesOf(dir: string): Record<string, string> {
  return Object.fromEntries(
    FILES.map((name) => {
      try {
        return [name, sha256(readFileSync(join(dir, name)))]
      } catch {
        return [name, 'missing']
      }
    }),
  )
}

const sameFiles = (a: Record<string, string>, b: Record<string, string>) => FILES.every((name) => a[name] === b[name])

// Why the files on disk aren't the ones the user turned on, or undefined when they are.
export function reviewOf(approval: Approval | undefined, install: CommunityInstall): string | undefined {
  if (!approval) return 'it was never turned on in this Kothar'
  if (sameFiles(approval.sha256, filesOf(install.dir))) return undefined
  const { version } = install.manifest
  if (approval.version !== version) return `it changed from ${approval.version}, which you turned on, to ${version}`
  return `its files changed since you turned on ${version}`
}

const aboutOf = ({ manifest, item }: CommunityInstall) => ({
  version: manifest.version,
  uses: manifest.uses,
  source: item.source,
  ...(item.repo && { repo: item.repo }),
  ...(item.tag && { tag: item.tag }),
  ...(item.path && { path: item.path }),
})

// Records that the user turned on the extension as its files are now.
export function approve(garage: string, now: () => Date, install: CommunityInstall, carriedOver = false): Approval {
  const approval: Approval = {
    ...aboutOf(install),
    sha256: filesOf(install.dir),
    approvedAt: now().toISOString(),
    ...(carriedOver && { carriedOver: true as const }),
  }
  writeApprovals(garage, { ...readApprovals(garage), [install.manifest.id]: approval })
  logHistory(garage, now, { id: install.manifest.id, event: 'approved', ...aboutOf(install), sha256: approval.sha256, ...(carriedOver && { reason: 'already on' }) })
  return approval
}

export function forget(garage: string, id: string) {
  const approvals = readApprovals(garage)
  if (!approvals?.[id]) return
  const { [id]: _, ...rest } = approvals
  writeApprovals(garage, rest)
}

export function logInstall(garage: string, now: () => Date, install: CommunityInstall, updated: boolean) {
  logHistory(garage, now, { id: install.manifest.id, event: updated ? 'updated' : 'installed', ...aboutOf(install), sha256: filesOf(install.dir) })
}

// The approval for each extension that's on, starting approvals in a garage that has none: an extension the user had
// already turned on is approved as it is, once, so updating Kothar doesn't turn everything off. switchedOn is the
// extension's own switch, whatever the Community extensions switch says: one that's on while that switch is off is
// still the user's choice, and would otherwise be held the day they turn community extensions on again.
export function approvalsFor(garage: string, now: () => Date, installs: CommunityInstall[], switchedOn: (id: string) => boolean) {
  const kept = readApprovals(garage)
  if (kept) return kept
  const approvals: Record<string, Approval> = {}
  for (const install of installs) {
    if (switchedOn(install.manifest.id)) approvals[install.manifest.id] = approve(garage, now, install, true)
  }
  if (!Object.keys(approvals).length && installs.length) writeApprovals(garage, {})
  return readApprovals(garage) ?? approvals
}
