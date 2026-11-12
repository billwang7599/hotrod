// Small helpers the core's modules share, kept in one place.
import { readFileSync } from 'node:fs'
import { sep } from 'node:path'

/** Whether inner is outer or inside it. Both are absolute paths. */
export const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.replace(/\/?$/, sep))

/** An error's message, or the thrown value as text. */
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A file's bytes, or none if it can't be read. */
export const readBytes = (file: string) => {
  try {
    return readFileSync(file)
  } catch {
    return Buffer.alloc(0)
  }
}
