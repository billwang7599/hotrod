import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Mod, ModValues } from '@hotrod/mod-api'
import { settingProblem } from './shared.ts'

const MISSING_PACKAGE = /^Cannot find (?:package|module) '((?:@[^/']+\/)?[^/'.:][^/':]*)(?:\/[^']*)?'/

function loadErrorOf(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  const notFound = ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(String((error as NodeJS.ErrnoException).code))
  const missing = notFound && MISSING_PACKAGE.exec(error.message)
  if (!missing) return error.message
  return `${missing[1]} isn't installed. Run npm install in the Hotrod folder, then restart Hotrod.`
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
      console.error(`Skipped the mod in ${join(dir, id)}: ${error instanceof Error ? error.message : error}`)
      brokenMods.push({ id, loadError: loadErrorOf(error) })
    }
  }
  return { mods, brokenMods }
}

export const valuesOf = (mod: Mod, saved: Record<string, unknown> = {}): ModValues =>
  Object.fromEntries(
    (mod.settings ?? []).map((setting) => {
      const value = saved[setting.key]
      const blank = setting.type === 'text' && !String(value).trim()
      return [setting.key, blank || settingProblem(setting, value) ? setting.default : (value as ModValues[string])]
    }),
  )
