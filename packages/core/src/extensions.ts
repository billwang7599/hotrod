import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Extension, ExtensionHost, ExtensionUse, ExtensionValues } from '@kothar/extension-api'
import { type CommunityInstall, installedExtensions, EXTENSION_MAIN } from './marketplace.ts'
import { EXTENSION_USES, settingProblem, sortUses } from './shared.ts'

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
  ['onLimitReached', 'events'],
  ['panels', 'panels'],
  ['commands', 'commands'],
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

// What each host call needs listed. note, storage and refresh need nothing.
export const HOST_USES: Partial<Record<keyof ExtensionHost, ExtensionUse>> = {
  chats: 'readChats',
  chat: 'readChats',
  read: 'readChats',
  space: 'readChats',
  messages: 'readChats',
  spaceValues: 'settings',
  setSpaceValue: 'settings',
  reaches: 'readChats',
  reachable: 'readChats',
  chatStorage: 'memory',
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
  wait: 'panels',
  endWait: 'panels',
  processes: 'panels',
  processAction: 'panels',
  processesChanged: 'panels',
}

// The Extension fields an extension sets, as uses. Empty lists count as unset.
export function usesOf(extension: Extension): ExtensionUse[] {
  const set = (value: unknown) => value !== undefined && !(Array.isArray(value) && value.length === 0)
  return sortUses(FIELD_USES.filter(([field]) => set(extension[field])).map(([, use]) => use))
}

// A host that refuses calls the extension's manifest didn't list.
export function guardHost(host: ExtensionHost, extension: { name: string }, uses: readonly ExtensionUse[]): ExtensionHost {
  const guarded = { ...host }
  for (const [call, use] of Object.entries(HOST_USES) as [keyof ExtensionHost, ExtensionUse][]) {
    if (uses.includes(use)) continue
    Object.assign(guarded, {
      [call]: () => {
        throw new Error(`${extension.name} can't use host.${call}: its manifest doesn't list "${use}" (${EXTENSION_USES[use]})`)
      },
    })
  }
  return guarded
}

// A community extension installed in the garage. extension is set when this run of Kothar loaded it, which happens only
// at startup and only for extensions the user turned on; loadError says why one that's on didn't load.
export type CommunityExtension = CommunityInstall & { extension?: Extension; loadError?: string }

// Loads <garage>/community/<id>/main.mjs for each extension that's on. An extension that's off is never imported, so
// installing one runs none of its code.
export async function loadCommunityExtensions(garage: string, isOn: (id: string) => boolean): Promise<CommunityExtension[]> {
  const loaded: CommunityExtension[] = []
  for (const install of installedExtensions(garage)) {
    const { manifest, dir } = install
    if (!isOn(manifest.id)) {
      loaded.push(install)
      continue
    }
    try {
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
