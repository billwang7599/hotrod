import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Mod, ModHost, ModUse, ModValues } from '@kothar/mod-api'
import { type CommunityInstall, installedMods, MOD_MAIN } from './marketplace.ts'
import { MOD_USES, settingProblem, sortUses } from './shared.ts'

const MISSING_PACKAGE = /^Cannot find (?:package|module) '((?:@[^/']+\/)?[^/'.:][^/':]*)(?:\/[^']*)?'/

function loadErrorOf(error: unknown, community = false) {
  if (!(error instanceof Error)) return String(error)
  const notFound = ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(String((error as NodeJS.ErrnoException).code))
  const missing = notFound && MISSING_PACKAGE.exec(error.message)
  if (!missing) return error.message
  // A community mod's main.mjs must carry its packages; nothing installs them for it.
  if (community) return `it imports ${missing[1]}, which its main.mjs doesn't bundle`
  return `${missing[1]} isn't installed. Run npm install in the Kothar folder, then restart Kothar.`
}

export async function loadMods(dir: string) {
  const mods: Mod[] = []
  const brokenMods: { id: string; loadError: string }[] = []
  if (!existsSync(dir)) return { mods, brokenMods }
  for (const id of readdirSync(dir).sort()) {
    const entry = join(dir, id, 'index.ts')
    if (!existsSync(entry)) continue
    try {
      const mod: Mod | undefined = (await import(pathToFileURL(entry).href)).default
      if (!mod) throw new Error('it has no default export')
      if (mod.id !== id) throw new Error(`its id "${mod.id}" is not its folder's name`)
      if (mod.settings?.some((s) => s.key === 'enabled')) throw new Error('"enabled" is not a setting key')
      mods.push(mod)
    } catch (error) {
      console.error(`Skipped the extension in ${join(dir, id)}: ${error instanceof Error ? error.message : error}`)
      brokenMods.push({ id, loadError: loadErrorOf(error) })
    }
  }
  return { mods, brokenMods }
}

export const valuesOf = (mod: Mod, saved: Record<string, unknown> = {}, list = mod.settings): ModValues =>
  Object.fromEntries(
    (list ?? []).map((setting) => {
      const value = saved[setting.key]
      const blank = setting.type === 'text' && !String(value).trim()
      return [setting.key, blank || settingProblem(setting, value) ? setting.default : (value as ModValues[string])]
    }),
  )

// What each Mod field needs listed in a community mod's manifest.
const FIELD_USES: [keyof Mod, ModUse][] = [
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
export const HOST_USES: Partial<Record<keyof ModHost, ModUse>> = {
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

// The Mod fields a mod sets, as uses. Empty lists count as unset.
export function usesOf(mod: Mod): ModUse[] {
  const set = (value: unknown) => value !== undefined && !(Array.isArray(value) && value.length === 0)
  return sortUses(FIELD_USES.filter(([field]) => set(mod[field])).map(([, use]) => use))
}

// A host that refuses calls the mod's manifest didn't list.
export function guardHost(host: ModHost, mod: { name: string }, uses: readonly ModUse[]): ModHost {
  const guarded = { ...host }
  for (const [call, use] of Object.entries(HOST_USES) as [keyof ModHost, ModUse][]) {
    if (uses.includes(use)) continue
    Object.assign(guarded, {
      [call]: () => {
        throw new Error(`${mod.name} can't use host.${call}: its manifest doesn't list "${use}" (${MOD_USES[use]})`)
      },
    })
  }
  return guarded
}

// A community mod installed in the garage. mod is set when this run of Kothar loaded it, which happens only at startup
// and only for mods the user turned on; loadError says why one that's on didn't load.
export type CommunityMod = CommunityInstall & { mod?: Mod; loadError?: string }

// Loads <garage>/community/<id>/main.mjs for each mod that's on. A mod that's off is never imported, so installing
// one runs none of its code.
export async function loadCommunityMods(garage: string, isOn: (id: string) => boolean): Promise<CommunityMod[]> {
  const loaded: CommunityMod[] = []
  for (const install of installedMods(garage)) {
    const { manifest, dir } = install
    if (!isOn(manifest.id)) {
      loaded.push(install)
      continue
    }
    try {
      // Node keeps every module it imported, so a core restarted in the same process (npm run dev) would get the old
      // main.mjs back; the file's time asks for the one on disk now.
      const url = `${pathToFileURL(join(dir, MOD_MAIN)).href}?at=${statSync(join(dir, MOD_MAIN)).mtimeMs}`
      const mod: Mod | undefined = (await import(url)).default
      if (!mod || typeof mod !== 'object') throw new Error('main.mjs has no default export')
      if (mod.id !== manifest.id) throw new Error(`its id "${mod.id}" is not its manifest's "${manifest.id}"`)
      if (mod.settings?.some((s) => s.key === 'enabled')) throw new Error('"enabled" is not a setting key')
      const unlisted = usesOf(mod).filter((use) => !manifest.uses.includes(use))
      if (unlisted.length) {
        throw new Error(`it uses ${unlisted.map((use) => `"${use}"`).join(', ')} without listing it in its manifest`)
      }
      loaded.push({ ...install, mod })
    } catch (error) {
      console.error(`Skipped the community extension in ${dir}: ${error instanceof Error ? error.message : error}`)
      loaded.push({ ...install, loadError: loadErrorOf(error, true) })
    }
  }
  return loaded
}
