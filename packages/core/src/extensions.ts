import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Extension, ExtensionHost, ExtensionManifest, ExtensionPanel, ExtensionUse, ExtensionValues } from '@kothar/extension-api'
import { type CommunityInstall, installedExtensions, EXTENSION_MAIN } from './marketplace.ts'
import { approvalsFor, logHistory, reviewOf } from './approvals.ts'
import { EXTENSION_USES, type InstalledItem, type PanelTab, settingProblem, sortUses } from './shared.ts'

const MISSING_PACKAGE = /^Cannot find (?:package|module) '((?:@[^/']+\/)?[^/'.:][^/':]*)(?:\/[^']*)?'/

function loadErrorOf(error: unknown, community = false) {
  if (!(error instanceof Error)) return String(error)
  const notFound = ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(String((error as NodeJS.ErrnoException).code))
  const missing = notFound && MISSING_PACKAGE.exec(error.message)
  if (!missing) return error.message
  // A community extension's main.mjs must carry its packages; nothing installs them for it.
  if (community) return `it imports ${missing[1]}, which its main.mjs doesn't bundle`
  return `${missing[1]} isn't installed. Run npm install in the Kothar folder, then restart Kothar.`
}

export async function loadExtensions(dir: string) {
  const extensions: Extension[] = []
  const brokenExtensions: { id: string; loadError: string }[] = []
  if (!existsSync(dir)) return { extensions, brokenExtensions }
  for (const id of readdirSync(dir).sort()) {
    const entry = join(dir, id, 'index.ts')
    if (!existsSync(entry)) continue
    try {
      const extension: Extension | undefined = (await import(pathToFileURL(entry).href)).default
      if (!extension) throw new Error('it has no default export')
      if (extension.id !== id) throw new Error(`its id "${extension.id}" is not its folder's name`)
      if (extension.settings?.some((s) => s.key === 'enabled')) throw new Error('"enabled" is not a setting key')
      extensions.push(extension)
    } catch (error) {
      console.error(`Skipped the extension in ${join(dir, id)}: ${error instanceof Error ? error.message : error}`)
      brokenExtensions.push({ id, loadError: loadErrorOf(error) })
    }
  }
  return { extensions, brokenExtensions }
}

export const valuesOf = (extension: Extension, saved: Record<string, unknown> = {}, list = extension.settings): ExtensionValues =>
  Object.fromEntries(
    (list ?? []).map((setting) => {
      const value = saved[setting.key]
      const blank = setting.type === 'text' && !String(value).trim()
      return [setting.key, blank || settingProblem(setting, value) ? setting.default : (value as ExtensionValues[string])]
    }),
  )

// What each Extension field needs listed in a community extension's manifest.
const FIELD_USES: [keyof Extension, ExtensionUse][] = [
  ['tools', 'tools'],
  ['mcpServers', 'mcpServers'],
  ['instructions', 'instructions'],
  ['onPermissionRequested', 'permissions'],
  ['transformMessage', 'transforms'],
  ['transformOutput', 'transforms'],
  ['onEvent', 'events'],
  ['onTurnStarted', 'events'],
  ['onTurnCompleted', 'events'],
  ['onStatusChanged', 'events'],
  ['onSessionEnded', 'events'],
  ['onChatCreated', 'events'],
  ['onChatRemoved', 'events'],
  ['onChatArchived', 'events'],
  ['onSpaceRemoved', 'events'],
  ['onLimitReached', 'events'],
  ['panels', 'panels'],
  ['commands', 'commands'],
  ['messageActions', 'commands'],
  ['settings', 'settings'],
  ['spaceSettings', 'settings'],
  ['migrateSettings', 'settings'],
  ['settingsView', 'settings'],
  ['onSettingsChanged', 'settings'],
  ['chats', 'chats'],
  ['setup', 'setup'],
  ['memory', 'memory'],
  ['onStart', 'events'],
  ['onStop', 'events'],
  ['onWaitAction', 'panels'],
  ['processes', 'panels'],
  ['onProcessAction', 'panels'],
  ['onProcessesChanged', 'panels'],
]

// What the UI gets of a panel: where it shows, its keys and whether it has a launcher in the left sidebar. Anything else an
// extension put there is dropped, and a placement, shortcut or launcher of the wrong kind is left out.
export function panelTabOf(extension: string, panel: ExtensionPanel): PanelTab {
  const { id, title, placement, shortcut, launcher } = panel
  return {
    extension,
    id,
    title,
    ...((placement === 'popup' || placement === 'dock') && { placement }),
    ...(typeof shortcut === 'string' && shortcut.trim() && { shortcut: shortcut.trim() }),
    ...(launcher === true && { launcher }),
  }
}

// What each host call needs listed. FREE_HOST_CALLS need nothing; any other call is refused.
export const HOST_USES: Partial<Record<keyof ExtensionHost, ExtensionUse>> = {
  chats: 'readChats',
  chat: 'readChats',
  read: 'readChats',
  space: 'readChats',
  messages: 'readChats',
  message: 'readChats',
  spaceValues: 'settings',
  setSpaceValue: 'settings',
  reaches: 'readChats',
  reachable: 'readChats',
  chatStorage: 'memory',
  everyChatStorage: 'memory',
  home: 'files',
  complete: 'models',
  send: 'sendMessages',
  createChat: 'sendMessages',
  retry: 'sendMessages',
  continue: 'sendMessages',
  interrupt: 'sendMessages',
  accounts: 'accounts',
  useAccount: 'accounts',
  run: 'run',
  spawn: 'run',
  openTerminal: 'run',
  reveal: 'run',
  addContextFile: 'sendMessages',
  wait: 'panels',
  showPanel: 'panels',
  endWait: 'panels',
  processes: 'panels',
  processAction: 'panels',
  processesChanged: 'panels',
}

// Host calls any extension may make: its own storage, notes and errors in chats, notifications, redrawing its panels,
// the clock.
export const FREE_HOST_CALLS: readonly (keyof ExtensionHost)[] = ['note', 'error', 'notify', 'storage', 'refresh', 'now']

// What Node's own APIs in a community extension's main.mjs need listed, read from its text before it's imported. This
// catches an honest author who forgot to list a use; it isn't a sandbox (code can reach Node in ways no text check
// sees). Module names count only where they're loaded (import, from, require), and calls only outside strings and
// comments, so a method named fetch, a comment or a plain list of names isn't a use. The escape hatches that load Node
// modules by name need all three.
const MODULE = (names: string) => new RegExp(`(?:\\bimport\\s*\\(?|\\bfrom|\\brequire\\s*\\()\\s*['"\`](?:node:)?(?:${names})['"\`]`)
const NODE_MODULES: [RegExp, ExtensionUse[]][] = [
  [MODULE('child_process|worker_threads|cluster'), ['run']],
  [MODULE('https?|http2|net|tls|dgram|dns(?:/promises)?|undici'), ['network']],
  [MODULE('fs(?:/promises)?'), ['files']],
]
const NODE_CALLS: [RegExp, ExtensionUse[]][] = [
  [
    /(?:(?<![\w$.])|\b(?:globalThis|global|self|window)\s*\.\s*)(?:fetch|WebSocket|EventSource|XMLHttpRequest)\s*\(|\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\b/,
    ['network'],
  ],
  [/\b(?:getBuiltinModule|createRequire)\s*\(|\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b/, ['run', 'network', 'files']],
]

// The source without its comments (code), and without the text inside its strings too (bare). Escapes are skipped, so
// a regex like /https?:\/\// isn't read as a comment; a regex holding a quote can blank a little code, which only
// misses a use.
export function codeOf(source: string): { code: string; bare: string } {
  let code = ''
  let bare = ''
  let quote = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quote) {
      if (char === '\\') {
        code += source.slice(i, i + 2)
        bare += '  '
        i++
      } else if (char === quote) {
        quote = ''
        code += char
        bare += char
      } else {
        code += char
        bare += char === '\n' ? char : ' '
      }
      continue
    }
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      i = (end < 0 ? source.length : end) - 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = (end < 0 ? source.length : end + 2) - 1
      code += ' '
      bare += ' '
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    const kept = char === '\\' ? source.slice(i, i + 2) : char
    if (char === '\\') i++
    code += kept
    bare += kept
  }
  return { code, bare }
}

export function nodeUsesOf(source: string): ExtensionUse[] {
  const { code, bare } = codeOf(source)
  return sortUses([
    ...NODE_MODULES.flatMap(([pattern, uses]) => (pattern.test(code) ? uses : [])),
    ...NODE_CALLS.flatMap(([pattern, uses]) => (pattern.test(bare) ? uses : [])),
  ])
}

// The Extension fields an extension sets, as uses. Empty lists count as unset.
export function usesOf(extension: Extension): ExtensionUse[] {
  const set = (value: unknown) => value !== undefined && !(Array.isArray(value) && value.length === 0)
  return sortUses(FIELD_USES.filter(([field]) => set(extension[field])).map(([, use]) => use))
}

// A host that refuses calls the extension's manifest didn't list, and any call Kothar hasn't given a use: a host call
// added later is closed to community extensions until it's listed in HOST_USES or FREE_HOST_CALLS.
export function guardHost(host: ExtensionHost, extension: { name: string }, uses: readonly ExtensionUse[]): ExtensionHost {
  const guarded = {} as Record<string, unknown>
  for (const call of Object.keys(host) as (keyof ExtensionHost)[]) {
    const use = HOST_USES[call]
    if (use ? uses.includes(use) : FREE_HOST_CALLS.includes(call)) {
      guarded[call] = host[call]
      continue
    }
    const refuse = () => {
      throw new Error(
        use
          ? `${extension.name} can't use host.${call}: its manifest doesn't list "${use}" (${EXTENSION_USES[use]})`
          : `${extension.name} can't use host.${call}: community extensions can't use it yet`,
      )
    }
    // A value (host.home) refuses when it's read; a call when it's made.
    if (typeof host[call] === 'function') guarded[call] = refuse
    else Object.defineProperty(guarded, call, { get: refuse, enumerable: true })
  }
  return guarded as ExtensionHost
}

// A community extension installed in the garage. extension is set when this run of Kothar loaded it, which happens only
// at startup and only for extensions the user turned on; loadError says why one that's on didn't load, and held why one
// that's on wasn't imported at all: its files aren't the ones the user turned on.
export type CommunityExtension = CommunityInstall & { extension?: Extension; loadError?: string; held?: string }

// Loads <garage>/community/<id>/main.mjs for each extension that's on, and only while its files are the ones the user
// turned on (see approvals.ts). An extension that's off is never imported, so installing one runs none of its code.
// switchedOn is the extension's own switch alone (isOn also needs the Community extensions switch); it decides which
// extensions a garage without approvals yet carries over.
// It runs at startup, before the core opens, so the clock defaults here; tests pass their own.
export async function loadCommunityExtensions(
  garage: string,
  isOn: (id: string) => boolean,
  switchedOn: (id: string) => boolean = isOn,
  now: () => Date = () => new Date(),
): Promise<CommunityExtension[]> {
  const loaded: CommunityExtension[] = []
  const installs = installedExtensions(garage)
  const approvals = approvalsFor(garage, now, installs, switchedOn)
  for (const install of installs) {
    const { manifest, dir } = install
    if (!isOn(manifest.id)) {
      loaded.push(install)
      continue
    }
    const held = reviewOf(approvals[manifest.id], install)
    if (held) {
      console.error(`Didn't start the community extension in ${dir}: ${held}`)
      logHistory(garage, now, { id: manifest.id, event: 'held', version: manifest.version, reason: held })
      loaded.push({ ...install, held })
      continue
    }
    try {
      // Checked before import, so an extension that would break its list runs none of its code.
      const unlistedNode = nodeUsesOf(readFileSync(join(dir, EXTENSION_MAIN), 'utf8')).filter((use) => !manifest.uses.includes(use))
      if (unlistedNode.length) {
        const list = unlistedNode.map((use) => `"${use}" (${EXTENSION_USES[use].toLowerCase()})`).join(', ')
        throw new Error(`its main.mjs uses Node's own APIs for ${list} without listing it in its manifest`)
      }
      // Node keeps every module it imported, so a core restarted in the same process (npm run dev) would get the old
      // main.mjs back; the file's time asks for the one on disk now.
      const url = `${pathToFileURL(join(dir, EXTENSION_MAIN)).href}?at=${statSync(join(dir, EXTENSION_MAIN)).mtimeMs}`
      const extension: Extension | undefined = (await import(url)).default
      if (!extension || typeof extension !== 'object') throw new Error('main.mjs has no default export')
      if (extension.id !== manifest.id) throw new Error(`its id "${extension.id}" is not its manifest's "${manifest.id}"`)
      if (extension.settings?.some((s) => s.key === 'enabled')) throw new Error('"enabled" is not a setting key')
      const unlisted = usesOf(extension).filter((use) => !manifest.uses.includes(use))
      if (unlisted.length) {
        throw new Error(`it uses ${unlisted.map((use) => `"${use}"`).join(', ')} without listing it in its manifest`)
      }
      loaded.push({ ...install, extension })
    } catch (error) {
      console.error(`Skipped the community extension in ${dir}: ${error instanceof Error ? error.message : error}`)
      loaded.push({ ...install, loadError: loadErrorOf(error, true) })
    }
  }
  return loaded
}

/** The name of one of an extension's hooks: any of its members that's a function. */
export type ExtensionHook = {
  [K in keyof Extension]-?: NonNullable<Extension[K]> extends (...args: never[]) => unknown ? K : never
}[keyof Extension]

/** A community extension as the core keeps it: what's installed, the version running, and why it didn't load or start. */
export type CommunityEntry = { manifest: ExtensionManifest; item: InstalledItem; running?: string; loadError?: string; held?: string }

/** An extension that didn't load (off, or broken) as a stub with no hooks, so it can still be turned on or off. */
export const stubOf = ({ id, name, description }: ExtensionManifest): Extension => ({ id, name, description, enabledByDefault: false })
