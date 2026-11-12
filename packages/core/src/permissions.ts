// The core's own permission policy: which requests it answers without asking the user. A pure function of the request
// and plain data, so it can be tested alone. Extensions' policies run after it (core.ts); its denials stand.
import { resolve } from 'node:path'
import type { PermissionRequest, PermissionVerdict } from '@kothar/extension-api'
import { editableOf, placeOf, refusedEditWhy, type FolderPlace } from './folder-modes.ts'
import { realPath } from './machine.ts'
import { isReadOnlyCommand, isSecret, mentionsSecret, searchReachesSecret, secretPathsOf } from './read-only.ts'
import { ASK_FIRST_COMMANDS, switchedOn, type PermissionSwitch, type PermissionSwitches } from './shared.ts'
import { within } from './util.ts'

export const OUTSIDE_EDIT_ADVICE =
  "Work there, or ask the user to add the folder in the chat's Context panel and set its mode to Edit in place."
export const ASKS_FIRST = new RegExp(`\\b(?:${ASK_FIRST_COMMANDS.map((c) => c.replaceAll(' ', '\\s+')).join('|')})\\b`)

export type PermissionContext = {
  // Where the session runs: relative paths start here.
  cwd: string
  // The chat's work folder: edits inside it never ask.
  workDir: string
  // True while the session runs in the sandbox (the edit anywhere switch is off and the machine can sandbox).
  sandboxed: boolean
  // The chat's switch layers, nearest first (the chat, its parents, then settings).
  switches: PermissionSwitches[]
  home: string
  garage: string
  // The turn's attached folders: each one's mode, or a git folder's checkout. Edits in a folder set to Edit in place
  // are answered like the work folder's; edits in one set to Read only are refused, sandboxed or not.
  folders?: FolderPlace[]
  // The turn is read only (an extension's TurnOptions): edits and commands that may change anything are refused, with
  // reason (or a default) as the agent's message. Reads still follow the switches.
  readOnly?: { reason?: string }
}

export const READ_ONLY_REASON = 'This turn is read only: it may read and search, but not edit files or run commands that change anything.'

// A verdict answers the request; undefined leaves it to extensions and then the user.
export const verdictOf = (request: PermissionRequest, context: PermissionContext): PermissionVerdict | undefined => {
  const { cwd, workDir, sandboxed, switches, home, garage, folders = [], readOnly } = context
  if (readOnly) {
    const refused = { allow: false, message: readOnly.reason?.trim() || READ_ONLY_REASON }
    if (request.kind === 'edit') return refused
    // Whether the command only reads is asked without the login folders, so reading one still asks below rather than
    // being refused as a change.
    if (request.kind === 'shell' && (request.command === undefined || !isReadOnlyCommand(request.command, { cwd, home, secrets: [] }))) {
      return refused
    }
  }
  if (request.kind === 'edit' && request.path !== undefined) {
    // Edits in the work folder need no asking; outside it the sandbox would fail them anyway.
    const target = realPath(resolve(cwd, request.path))
    if (within(target, workDir)) return { allow: true }
    // A folder edited in place is like the work folder, but logins, keys and .env files in it still ask.
    if (editableOf(folders).some((folder) => within(target, realPath(folder)))) {
      return isSecret(target, { cwd, home, secrets: secretPathsOf(home, garage) }) ? undefined : { allow: true }
    }
    // Unsandboxed, an edit elsewhere asks, but a folder the user set to Read only stays read only.
    const place = placeOf(target, folders)
    if (!sandboxed && (!place || place.mode === 'checkout')) return undefined
    return { allow: false, message: refusedEditWhy(target, workDir, folders, OUTSIDE_EDIT_ADVICE) }
  }
  const on = (name: PermissionSwitch) => switchedOn(name, ...switches)
  // Fetching writes nothing, so it needs no sandbox.
  if (request.kind === 'fetch') return on('autoFetch') ? { allow: true } : undefined
  // Reading writes nothing either, but logins and keys still ask.
  const reading = { cwd, home, secrets: secretPathsOf(home, garage) }
  // .env files are let through only where commands run without asking: sandboxed, both switches on.
  const envFiles = sandboxed && on('autoRunCommands') && on('autoEnvCommands')
  const sandboxedReading = { ...reading, envFiles }
  if (request.kind === 'read' || request.kind === 'search') {
    if (!on('autoRead')) return
    if (request.kind === 'read') {
      return request.path !== undefined && !isSecret(request.path, sandboxedReading) ? { allow: true } : undefined
    }
    return searchReachesSecret(request.path ?? cwd, sandboxedReading) ? undefined : { allow: true }
  }
  if (request.kind !== 'shell' || request.command === undefined) return
  if (on('autoRead') && isReadOnlyCommand(request.command, reading)) return { allow: true }
  if (!sandboxed || !on('autoRunCommands')) return
  if (!on('autoNetworkCommands') && ASKS_FIRST.test(request.command)) return
  if (mentionsSecret(request.command, sandboxedReading)) return
  return { allow: true }
}
