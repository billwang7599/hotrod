// Checks for what Kothar downloads or reads from outside: marketplace catalogs, theme files and community extension
// manifests. Each check throws, saying why, unless the value has exactly the known fields. The core uses them when it
// installs or loads; the UI uses checkTheme on a theme it kept in localStorage.
import type { ExtensionManifest, ExtensionUse } from '@kothar/extension-api'
import { type CatalogEntry, isExtensionUse, sortUses, THEME_TOKENS, type ThemeFile } from './shared.ts'

export const MAX_THEME_BYTES = 64 * 1024

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
// Lowercase only, so two ids can't name one file on a case-insensitive disk.
const ITEM_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
export const MAX_MANIFEST_BYTES = 64 * 1024
export const MAX_EXTENSION_BYTES = 5 * 1024 * 1024
export const EXTENSION_API_VERSION = 1

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

export const isItemId = (id: unknown): id is string => typeof id === 'string' && ITEM_ID.test(id)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function onlyKeys(value: unknown, what: string, required: readonly string[], optional: readonly string[] = []) {
  if (!isRecord(value)) throw new Error(`${what} must be an object`)
  const extra = Object.keys(value).find((key) => !required.includes(key) && !optional.includes(key))
  if (extra !== undefined) throw new Error(`${what} has an unknown field "${extra}"`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new Error(`${what} is missing "${missing}"`)
  return value
}

function text(value: unknown, what: string, max: number) {
  // oxlint-disable-next-line no-control-regex -- rejects control characters on purpose
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${what} must be text of 1 to ${max} characters`)
  }
  return value
}

function colors<K extends string>(value: unknown, what: string, tokens: readonly K[]) {
  const palette = onlyKeys(value, what, tokens)
  for (const token of tokens) {
    const color = palette[token]
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) throw new Error(`${what} ${token} must be a hex colour`)
  }
  return palette as Record<K, string>
}

function itemFields(value: Record<string, unknown>, what: string) {
  if (!isItemId(value.id)) throw new Error(`${what} id must be lowercase letters, digits and dashes`)
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) {
    throw new Error(`${what} version must look like 1.2.3`)
  }
  return {
    id: value.id,
    name: text(value.name, `${what} name`, 40),
    version: value.version,
    author: text(value.author, `${what} author`, 60),
    description: text(value.description, `${what} description`, 200),
  }
}

// Throws, saying why, unless value is a theme file with exactly the known fields.
export function checkTheme(value: unknown): ThemeFile {
  const fields = ['id', 'name', 'version', 'author', 'description', 'dark', 'light']
  const theme = onlyKeys(value, 'The theme', fields, ['variants'])
  const variants =
    theme.variants === undefined
      ? undefined
      : onlyKeys(theme.variants, 'The theme variants', ['dark', 'light'])
  return {
    ...itemFields(theme, 'The theme'),
    ...(variants && {
      variants: { dark: text(variants.dark, 'The dark variant', 30), light: text(variants.light, 'The light variant', 30) },
    }),
    dark: colors(theme.dark, 'The dark palette', THEME_TOKENS),
    light: colors(theme.light, 'The light palette', THEME_TOKENS),
  }
}

// Throws, saying why, unless value is a community extension's manifest.json with exactly the known fields.
export function checkExtensionManifest(value: unknown): ExtensionManifest {
  const fields = ['id', 'name', 'version', 'author', 'description', 'api', 'uses']
  const manifest = onlyKeys(value, 'manifest.json', fields)
  if (manifest.api !== EXTENSION_API_VERSION) throw new Error(`manifest.json is for extension API ${String(manifest.api)}, not ${EXTENSION_API_VERSION}`)
  if (!Array.isArray(manifest.uses)) throw new Error('manifest.json uses must be a list')
  const unknown = manifest.uses.find((use) => !isExtensionUse(use))
  if (unknown !== undefined) throw new Error(`manifest.json uses "${String(unknown)}", which Kothar doesn't know`)
  return { ...itemFields(manifest, 'manifest.json'), api: EXTENSION_API_VERSION, uses: sortUses(manifest.uses as ExtensionUse[]) }
}

export const isRepo = (repo: unknown): repo is string => typeof repo === 'string' && REPO.test(repo) && !repo.includes('..')

// Throws, saying why, unless value is a marketplace catalog: { version: 2, entries: CatalogEntry[] } with unique ids per
// kind.
export function checkCatalog(value: unknown): CatalogEntry[] {
  const catalog = onlyKeys(value, 'The marketplace catalog', ['entries'], ['version'])
  if (catalog.version !== 2) throw new Error('The marketplace catalog is for another version of Kothar')
  if (!Array.isArray(catalog.entries)) throw new Error('The marketplace catalog entries must be a list')
  const entries = catalog.entries.map((raw, i): CatalogEntry => {
    const what = `Marketplace entry ${i + 1}`
    const entry = onlyKeys(raw, what, ['id', 'kind', 'name', 'author', 'description', 'repo'])
    if (!isItemId(entry.id)) throw new Error(`${what} id must be lowercase letters, digits and dashes`)
    // Extensions were mods, and catalogs written then still say "mod".
    const kind = entry.kind === 'mod' ? 'extension' : entry.kind
    if (kind !== 'theme' && kind !== 'extension') throw new Error(`Marketplace entry "${entry.id}" is a "${entry.kind}"`)
    if (!isRepo(entry.repo)) throw new Error(`Marketplace entry "${entry.id}" repo must be owner/name`)
    return {
      id: entry.id,
      kind,
      name: text(entry.name, `${what} name`, 40),
      author: text(entry.author, `${what} author`, 60),
      description: text(entry.description, `${what} description`, 200),
      repo: entry.repo,
    }
  })
  const keys = entries.map((entry) => `${entry.kind} ${entry.id}`)
  const twin = keys.find((key, i) => keys.indexOf(key) !== i)
  if (twin !== undefined) throw new Error(`Two marketplace entries are the ${twin.replace(' ', ' "')}"`)
  return entries
}
