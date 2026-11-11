// The core's own permission policy: which requests it answers without asking the user. A pure function of the request
// and plain data, so it can be tested alone. Extensions' policies run after it (core.ts); its denials stand.
import { resolve } from 'node:path'
import type { PermissionRequest, PermissionVerdict } from '@kothar/extension-api'
import { realPath } from './machine.ts'
import { isReadOnlyCommand, isSecret, mentionsSecret, searchReachesSecret, secretPathsOf } from './read-only.ts'
import { ASK_FIRST_COMMANDS, switchedOn, type PermissionSwitch, type PermissionSwitches } from './shared.ts'
import { within } from './util.ts'

export const OUTSIDE_EDIT_ADVICE = 'Work there, or ask the user to allow edits outside the work folder for this chat.'
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
}

// A verdict answers the request; undefined leaves it to extensions and then the user.
export const verdictOf = (request: PermissionRequest, context: PermissionContext): PermissionVerdict | undefined => {
  const { cwd, workDir, sandboxed, switches, home, garage } = context
  if (request.kind === 'edit' && request.path !== undefined) {
    // Edits in the work folder need no asking; outside it the sandbox would fail them anyway.
    if (within(realPath(resolve(cwd, request.path)), workDir)) return { allow: true }
    if (!sandboxed) return undefined
    const message = `Kothar lets this chat edit only inside ${workDir}. ${OUTSIDE_EDIT_ADVICE}`
    return { allow: false, message }
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
