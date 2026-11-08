import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Mod, ModValues } from '@hotrod/mod-api'
import { settingProblem } from './shared.ts'

export async function loadMods(dir: string) {
  if (!existsSync(dir)) return []
  const mods: Mod[] = []
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
      console.error(`Skipped the mod in ${join(dir, id)}: ${error instanceof Error ? error.message : error}`)
    }
  }
  return mods
}

export const valuesOf = (mod: Mod, saved: Record<string, unknown> = {}): ModValues =>
  Object.fromEntries(
    (mod.settings ?? []).map((setting) => {
      const value = saved[setting.key]
      return [setting.key, settingProblem(setting, value) ? setting.default : (value as ModValues[string])]
    }),
  )
