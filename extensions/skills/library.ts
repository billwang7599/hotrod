import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ExtensionStorage } from '@kothar/extension-api'
import { parseSkill, skillId, skillText } from './skill-md.ts'
import type { ZipEntry } from './zip.ts'

// The user's skills: one folder each in <garage>/extensions/skills/skills/<id>/, holding its SKILL.md and whatever it
// bundles, plain files the user can edit. state.json beside them keeps which are off and where each came from. A folder
// the user puts there by hand is a skill like any other, on, from "Added by hand".

export type Skill = {
  id: string
  name: string
  description: string
  dir: string
  on: boolean
  source: string
}

export type ImportResult = { source: string; imported: string[]; skipped: { name: string; why: string }[] }

type State = { off: string[]; sources: Record<string, { from: string; at: string }> }

const SKILLS_DIR = 'skills'
const STATE = 'state.json'
// What one skill may bring in, so an import can't fill the disk.
export const MAX_SKILL_BYTES = 25 * 1024 * 1024
export const MAX_SKILL_FILES = 1000
const MAX_DEPTH = 12
// How deep under an import's folder skills are looked for (a repo's skills/<name>/ is 2).
const FIND_DEPTH = 4
const LEFT_OUT = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv'])

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function createLibrary(storage: ExtensionStorage) {
  const root = join(storage.dir, SKILLS_DIR)

  const state = (): State => {
    try {
      const saved = JSON.parse(storage.read(STATE) ?? '{}') as Partial<State>
      return { off: Array.isArray(saved.off) ? saved.off : [], sources: saved.sources ?? {} }
    } catch {
      return { off: [], sources: {} }
    }
  }
  const save = (next: State) => storage.write(STATE, `${JSON.stringify(next, null, 2)}\n`)

  // Every skill in the library whose SKILL.md reads, by name.
  const list = (): Skill[] => {
    if (!existsSync(root)) return []
    const { off, sources } = state()
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .flatMap((entry) => {
        const dir = join(root, entry.name)
        try {
          const parsed = parseSkill(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
          if ('error' in parsed) return []
          const id = entry.name
          return [{ id, name: parsed.name, description: parsed.description, dir, on: !off.includes(id), source: sources[id]?.from ?? 'Added by hand' }]
        } catch {
          return []
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  const get = (id: string) => list().find((skill) => skill.id === skillId(id) || skill.name === id)

  const setOn = (id: string, on: boolean) => {
    const next = state()
    next.off = next.off.filter((other) => other !== id)
    if (!on) next.off.push(id)
    save(next)
  }

  const remove = (id: string) => {
    const dir = join(root, id)
    if (skillId(id) !== id || !existsSync(dir)) throw new Error(`There is no skill named ${id}`)
    rmSync(dir, { recursive: true, force: true })
    const next = state()
    next.off = next.off.filter((other) => other !== id)
    delete next.sources[id]
    save(next)
  }

  // A folder of the library's own for unpacking into, removed by the caller.
  const scratch = () => {
    const dir = join(storage.dir, `.incoming-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  // Copies a skill folder into dest: files and folders only. Symlinks are left out, so a skill can't bring in a link to
  // something else on the disk, and so are .git, node_modules and the like.
  const copyTree = (from: string, dest: string) => {
    let bytes = 0
    let files = 0
    const walk = (dir: string, to: string, depth: number) => {
      if (depth > MAX_DEPTH) throw new Error('its folders nest too deep')
      mkdirSync(to, { recursive: true })
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (LEFT_OUT.has(entry.name)) continue
        const path = join(dir, entry.name)
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) walk(path, join(to, entry.name), depth + 1)
        else if (stat.isFile()) {
          bytes += stat.size
          files += 1
          if (bytes > MAX_SKILL_BYTES) throw new Error(`it's over ${MAX_SKILL_BYTES / 1024 / 1024} MB`)
          if (files > MAX_SKILL_FILES) throw new Error(`it has over ${MAX_SKILL_FILES} files`)
          copyFileSync(path, join(to, entry.name))
        }
      }
    }
    walk(from, dest, 0)
  }

  // Skill folders (with a SKILL.md) in or under dir, not looking inside one once found. follow: dir is the user's own
  // (a folder they picked, ~/.claude/skills), so a linked skill folder there counts; never in unpacked archives.
  const findSkills = (dir: string, follow: boolean): string[] => {
    const found: string[] = []
    const walk = (path: string, depth: number) => {
      if (existsSync(join(path, 'SKILL.md'))) return void found.push(path)
      if (depth >= FIND_DEPTH) return
      let entries
      try {
        entries = readdirSync(path, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || LEFT_OUT.has(entry.name)) continue
        const child = join(path, entry.name)
        if (entry.isDirectory() || (follow && entry.isSymbolicLink() && isDir(child))) walk(follow ? realpathSync(child) : child, depth + 1)
      }
    }
    walk(dir, 0)
    return found
  }

  // What a folder holds that the library doesn't have yet: the ids of its skills not in the library.
  const newIn = (dir: string) => {
    if (!isDir(dir)) return []
    const have = new Set(list().map((skill) => skill.id))
    return findSkills(dir, true).flatMap((path) => {
      try {
        const parsed = parseSkill(readFileSync(join(path, 'SKILL.md'), 'utf8'))
        return 'error' in parsed || have.has(skillId(parsed.name)) ? [] : [skillId(parsed.name)]
      } catch {
        return []
      }
    })
  }

  // Copies every skill found in dir into the library, under its name's id. One already there (or twice in the import)
  // is skipped with a reason, as is one that isn't valid; the rest still come in. on: whether they start on.
  const importDir = (dir: string, source: string, options: { on: boolean; follow: boolean }): ImportResult => {
    const result: ImportResult = { source, imported: [], skipped: [] }
    if (!isDir(dir)) throw new Error(`${dir} isn't a folder`)
    const found = findSkills(dir, options.follow)
    if (!found.length) throw new Error(`No skills found in ${source}: a skill is a folder with a SKILL.md`)
    mkdirSync(root, { recursive: true })
    const next = state()
    const label = (path: string) => relative(dir, path) || path.split(sep).at(-1)!
    for (const path of found) {
      let parsed
      try {
        parsed = parseSkill(readFileSync(join(path, 'SKILL.md'), 'utf8'))
      } catch {
        parsed = { error: "its SKILL.md can't be read" }
      }
      if ('error' in parsed) {
        result.skipped.push({ name: label(path), why: parsed.error })
        continue
      }
      const id = skillId(parsed.name)
      if (!id) {
        result.skipped.push({ name: parsed.name, why: 'its name has no letters or digits' })
        continue
      }
      if (existsSync(join(root, id))) {
        const why = result.imported.includes(id)
          ? 'another skill in this import has the same name'
          : 'a skill with this name is already in Kothar; delete that one first to replace it'
        result.skipped.push({ name: id, why })
        continue
      }
      const incoming = join(root, `.incoming-${randomUUID()}`)
      try {
        copyTree(path, incoming)
        renameSync(incoming, join(root, id))
      } catch (error) {
        rmSync(incoming, { recursive: true, force: true })
        result.skipped.push({ name: id, why: error instanceof Error ? error.message : String(error) })
        continue
      }
      result.imported.push(id)
      next.sources[id] = { from: source, at: new Date().toISOString() }
      next.off = next.off.filter((other) => other !== id)
      if (!options.on) next.off.push(id)
    }
    save(next)
    return result
  }

  // Writes an archive's files into a scratch folder, refusing any path that would land outside it, then imports from
  // there. strip: drop the first part of every path (a GitHub archive's <owner>-<repo>-<sha>/). under: only files below
  // this folder of the archive.
  const importEntries = (entries: ZipEntry[], source: string, options: { on: boolean; strip?: boolean; under?: string }) => {
    const dir = scratch()
    try {
      const under = (options.under ?? '').replace(/^\/+|\/+$/g, '')
      let written = 0
      for (const entry of entries) {
        let path = entry.path.replaceAll('\\', '/')
        if (options.strip) path = path.split('/').slice(1).join('/')
        if (under) {
          if (!path.startsWith(`${under}/`)) continue
          path = path.slice(under.length + 1)
        }
        const parts = path.split('/')
        if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || parts.some((part) => part === '..' || part === '')) continue
        if (parts.some((part) => LEFT_OUT.has(part) || part === '__MACOSX')) continue
        const to = resolve(dir, ...parts)
        if (!to.startsWith(dir + sep)) continue
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, entry.data)
        written++
      }
      if (!written) throw new Error(under ? `Nothing found at ${under}` : 'The archive is empty')
      return importDir(dir, source, { on: options.on, follow: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // A new skill written by an agent, on.
  const create = (name: string, description: string, body: string, source: string) => {
    const id = skillId(name)
    if (!id) throw new Error('A skill needs a name with letters or digits')
    const text = skillText(id, description, body)
    const parsed = parseSkill(text)
    if ('error' in parsed) throw new Error(`The skill can't be saved: ${parsed.error}`)
    if (existsSync(join(root, id))) throw new Error(`A skill named ${id} already exists`)
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'SKILL.md'), text)
    const next = state()
    next.sources[id] = { from: source, at: new Date().toISOString() }
    save(next)
    return id
  }

  // A skill's files below its folder, as relative paths, SKILL.md first.
  const filesOf = (skill: Skill, max = 200) => {
    const files: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > MAX_DEPTH || files.length >= max) return
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= max) return
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile()) files.push(relative(skill.dir, path).split(sep).join('/'))
      }
    }
    walk(skill.dir, 0)
    return ['SKILL.md', ...files.filter((file) => file !== 'SKILL.md')]
  }

  // A file of the skill's, if the path stays inside its folder (after links are followed).
  const fileOf = (skill: Skill, file: string) => {
    const path = resolve(skill.dir, file)
    const base = realpathSync(skill.dir)
    if (!existsSync(path)) throw new Error(`${skill.id} has no file ${file}`)
    const real = realpathSync(path)
    if (real !== base && !real.startsWith(base + sep)) throw new Error(`${file} isn't in the skill's folder`)
    if (!statSync(real).isFile()) throw new Error(`${file} is a folder`)
    return real
  }

  return { root, list, get, setOn, remove, newIn, importDir, importEntries, create, filesOf, fileOf, scratch }
}

export type Library = ReturnType<typeof createLibrary>
