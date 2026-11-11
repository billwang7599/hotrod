// Small helpers the core's modules share, kept in one place.
import { sep } from 'node:path'

/** Whether inner is outer or inside it. Both are absolute paths. */
export const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.replace(/\/?$/, sep))

/** An error's message, or the thrown value as text. */
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
