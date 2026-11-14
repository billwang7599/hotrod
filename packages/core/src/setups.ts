import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Chat } from './chat.ts'
import { isThinkingLevel, MAX_SETUP_INSTRUCTIONS, type ChatInfo, type CoreMessage, type Setup } from './shared.ts'

// Setups: saved choices for a kind of job (engine, model, thinking level, extensions left out, instructions), one plain
// JSON file each in `<garage>/setups/`. openSetups stores and checks them and openChatSetups lets chats pick and follow
// them; models.ts applies a setup's model and the core its extensions and instructions, from a chat's next message.

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
  // Workers became part of the core: an older setup that left the Workers extension out now says workers: false.
  const extensionsOff = [...new Set(off as string[])].filter((id) => id !== 'workers')
  const workers = raw.workers === false || (off as string[]).includes('workers') ? false : undefined
  if (raw.workers !== undefined && raw.workers !== false && raw.workers !== true) throw new Error('workers must be true or false')
  return {
    id,
    name,
    ...(engine !== undefined && { engine }),
    ...(model !== undefined && { model }),
    ...(thinking !== undefined && { thinking }),
    ...(extensionsOff.length && { extensionsOff }),
    ...(workers === false && { workers }),
    ...(instructions && { instructions }),
  }
}

/** What chats do with setups: pick one, and follow a setup that's saved again or removed. */
export function openChatSetups(deps: {
  setups: Pick<ReturnType<typeof openSetups>, 'find' | 'list' | 'save' | 'remove'>
  chats: ReadonlyMap<string, Chat>
  broadcast: (message: CoreMessage) => void
  updateChat: (chat: Chat, change: Partial<ChatInfo>) => void
  familyOf: (chat: Chat) => Chat[]
  setupOf: (chat: Chat) => Setup | undefined
  /** Chats that follow their model list move with it. */
  followModels: () => void
  /** The chat's panels and commands, which its setup's extensions decide. */
  extensionsOf: (chat: Chat) => CoreMessage
}) {
  const { setups: jobSetups, chats, broadcast, updateChat, familyOf, setupOf, followModels, extensionsOf } = deps
  // A setup by id or name, for a spawn or a picker.
  const setupNamed = (name: unknown) => {
    const setup = typeof name === 'string' ? jobSetups.find(name) : undefined
    if (setup) return setup
    const names = jobSetups.list().map((s) => `"${s.name}"`)
    throw new Error(`Unknown setup "${name}". ${names.length ? `The setups are ${names.join(', ')}.` : 'There are no setups.'}`)
  }

  // The setup a chat uses from its next message, or none.
  const setChatSetup = (chat: Chat, name: unknown) => {
    if (chat.info.worker) throw new Error(WORKER_SETUP)
    const setup = name === undefined || name === '' ? undefined : setupNamed(name)
    updateChat(chat, { setup: setup?.id })
    followModels()
    familyOf(chat).forEach((c) => broadcast(extensionsOf(c)))
  }

  const saveSetup = (input: unknown) => {
    const setup = jobSetups.save(input)
    followModels()
    setupChanged(setup.id)
    return setup
  }

  // Chats that used a removed setup go back to Settings.
  const removeSetup = (id: unknown) => {
    jobSetups.remove(id)
    const using = [...chats.values()].filter((chat) => chat.info.setup === id)
    for (const chat of using) updateChat(chat, { setup: undefined })
    followModels()
    using.flatMap(familyOf).forEach((chat) => broadcast(extensionsOf(chat)))
  }

  // A setup's extensions changed: the chats using it get their panels and commands again.
  const setupChanged = (id: string) => {
    for (const chat of chats.values()) if (setupOf(chat)?.id === id) broadcast(extensionsOf(chat))
  }

  return { setupNamed, setChatSetup, saveSetup, removeSetup }
}

export const WORKER_SETUP = "A worker uses its space's setup and can't have its own"
