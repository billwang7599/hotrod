import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isThinkingLevel, MAX_SETUP_INSTRUCTIONS, type CoreMessage, type Setup } from './shared.ts'

// Setups: saved choices for a kind of job (engine, model, thinking level, extensions left out, instructions), one plain
// JSON file each in `<garage>/setups/`. This module only stores and checks them; models.ts applies a setup's model and
// the core its extensions and instructions, from a chat's next message.

const ID = /^[a-z0-9-]{1,64}$/

export function openSetups({
  garage,
  broadcast,
  check,
}: {
  garage: string
  broadcast: (message: CoreMessage) => void
  // Throws when the setup names an engine, model or extension Kothar doesn't have.
  check: (setup: Setup) => void
}) {
  const dir = join(garage, 'setups')
  const fileOf = (id: string) => join(dir, `${id}.json`)

  // A file that isn't a setup (hand-edited badly, say) is skipped, not fatal.
  const read = (file: string): Setup[] => {
    try {
      const id = file.slice(0, -'.json'.length)
      const setup = cleaned({ ...JSON.parse(readFileSync(join(dir, file), 'utf8')), id })
      return [setup]
    } catch {
      return []
    }
  }
  const list = (): Setup[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((file) => file.endsWith('.json') && ID.test(file.slice(0, -5)))
          .flatMap(read)
          .sort((a, b) => a.name.localeCompare(b.name))
      : []
  const changed = () => broadcast({ type: 'setups.updated', setups: list() })

  const get = (id: string | undefined) => (id === undefined ? undefined : list().find((setup) => setup.id === id))

  return {
    list,
    get,

    /** A setup by its id, else by its name (any case), for a worker's spawn. */
    find(name: string) {
      const all = list()
      return all.find((s) => s.id === name) ?? all.find((s) => s.name.toLowerCase() === name.trim().toLowerCase())
    },

    /** Saves `input` as a new setup (no id) or over the one with its id, and returns it as saved. */
    save(input: unknown): Setup {
      const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
      const id = raw.id === undefined ? newId(list().map((s) => s.id)) : String(raw.id)
      if (raw.id !== undefined && !get(id)) throw new Error(`Unknown setup "${id}"`)
      const setup = cleaned({ ...raw, id })
      if (list().some((other) => other.id !== id && other.name.toLowerCase() === setup.name.toLowerCase())) {
        throw new Error(`A setup named "${setup.name}" already exists`)
      }
      check(setup)
      mkdirSync(dir, { recursive: true })
      // The file name is the id. Written aside and moved, so a crash never leaves half a file.
      writeFileSync(fileOf(id) + '.tmp', JSON.stringify({ ...setup, id: undefined }, null, 2) + '\n')
      renameSync(fileOf(id) + '.tmp', fileOf(id))
      changed()
      return setup
    },

    remove(id: unknown) {
      if (typeof id !== 'string' || !get(id)) throw new Error(`Unknown setup "${id}"`)
      rmSync(fileOf(id), { force: true })
      changed()
    },
  }
}

const newId = (taken: string[]) => {
  let id = randomBytes(4).toString('hex')
  while (taken.includes(id)) id = randomBytes(4).toString('hex')
  return id
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/** A setup as stored: a name, and only the fields it sets. Throws on a field of the wrong kind. */
export function cleaned(raw: Record<string, unknown>): Setup {
  const id = String(raw.id)
  if (!ID.test(id)) throw new Error(`Bad setup id "${id}"`)
  const name = text(raw.name)
  if (!name) throw new Error('A setup needs a name')
  if (name.length > 80) throw new Error('A setup name is at most 80 characters')
  const engine = text(raw.engine)
  const model = text(raw.model)
  if (model !== undefined && engine === undefined) throw new Error('A setup with a model needs its engine')
  const thinking = raw.thinking === undefined || raw.thinking === '' ? undefined : raw.thinking
  if (thinking !== undefined && !isThinkingLevel(thinking)) throw new Error(`Unknown thinking level "${thinking}"`)
  const off = raw.extensionsOff ?? []
  if (!Array.isArray(off) || !off.every((id) => typeof id === 'string')) {
    throw new Error('extensionsOff must be a list of extension ids')
  }
  const instructions = typeof raw.instructions === 'string' ? raw.instructions.trim() : ''
  if (instructions.length > MAX_SETUP_INSTRUCTIONS) {
    throw new Error(`A setup's instructions are at most ${MAX_SETUP_INSTRUCTIONS} characters`)
  }
  const extensionsOff = [...new Set(off as string[])]
  return {
    id,
    name,
    ...(engine !== undefined && { engine }),
    ...(model !== undefined && { model }),
    ...(thinking !== undefined && { thinking }),
    ...(extensionsOff.length && { extensionsOff }),
    ...(instructions && { instructions }),
  }
}
