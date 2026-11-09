import { randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// One process per garage. A second Kothar on the same garage would load every chat the first is running, end their
// turns as "Kothar quit" and sweep their workers' folders away under them. So a core holds <garage>/kothar.lock (its
// pid and a token) from before it reads anything until it closes. A lock whose process is gone is stale and taken over.
// Cores in one process share it (a restart in place, tests reopening a garage); the last to close removes it.

export const LOCK_FILE = 'kothar.lock'

type Holder = { pid: number; token: string }

// The garages this process holds, by their lock file: the token written there, and how many cores hold it.
const held = new Map<string, { token: string; cores: number }>()

const lockFileOf = (garage: string) => join(garage, LOCK_FILE)

const readHolder = (file: string): Holder | undefined => {
  try {
    const { pid, token } = JSON.parse(readFileSync(file, 'utf8'))
    return Number.isInteger(pid) && pid > 0 ? { pid, token: String(token) } : undefined
  } catch {
    return undefined
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it's just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Whether a live core holds the garage. A lock with this pid counts only while this process holds it: otherwise it's
// from an older process that had our pid.
const live = (file: string, holder: Holder | undefined): holder is Holder =>
  !!holder && (holder.pid === process.pid ? held.get(file)?.token === holder.token : alive(holder.pid))

/** The pid of the live core that holds this garage, if one does. Reads only. */
export function garageHolder(garage: string): number | undefined {
  const file = lockFileOf(garage)
  const holder = readHolder(file)
  return live(file, holder) ? holder.pid : undefined
}

/**
 * Takes the garage for this core, or throws if a live core holds it, changing nothing. Returns the release, which
 * removes the lock only while it's still this core's.
 */
export function lockGarage(garage: string): () => void {
  const file = lockFileOf(garage)
  const ours = held.get(file)
  if (ours && readHolder(file)?.token === ours.token) {
    ours.cores++
    return releaseOf(file, ours.token)
  }
  const token = randomBytes(16).toString('hex')
  const write = () => writeFileSync(file, JSON.stringify({ pid: process.pid, token }) + '\n', { flag: 'wx' })
  for (let attempt = 0; ; attempt++) {
    try {
      write()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = readHolder(file)
      if (live(file, holder)) throw new Error(`Kothar is already running on this garage: ${garage} (pid ${holder.pid})`)
      // Another core took the stale lock over between our read and our write.
      if (attempt > 0) throw new Error(`Kothar is already running on this garage: ${garage}`)
      try {
        unlinkSync(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  held.set(file, { token, cores: 1 })
  return releaseOf(file, token)
}

const releaseOf = (file: string, token: string) => {
  let released = false
  return () => {
    const ours = held.get(file)
    if (released || ours?.token !== token) return
    released = true
    if (--ours.cores > 0) return
    held.delete(file)
    if (readHolder(file)?.token !== token) return
    try {
      unlinkSync(file)
    } catch {
      // Gone already.
    }
  }
}
