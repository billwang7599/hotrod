import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ChatDetail, ExtensionHost } from '@kothar/extension-api'

// The notes on disk: plain folders of Markdown files, global ones in the extension's own folder and a space's in its
// chat folder's notes/. Files written elsewhere (an editor, Obsidian, git, an agent's file tools) are read as they are,
// sub-folders included, and saved back without losing what Kothar doesn't use: front matter it doesn't know, a file
// with no front matter at all, the file's name.

export type NoteScope = 'global' | 'space'
export type Note = {
  // global:<file> or <space id>:<file>.
  key: string
  name: string
  description: string
  scope: NoteScope
  // The space the note belongs to, for a space note.
  spaceId?: string
  // Relative to its scope's folder, with / between folders: deploys.md, Projects/plan.md.
  file: string
  path: string
  // The sub-folder it's in ('' or left out at the top).
  folder?: string
  pinned?: boolean
  // When the file was last changed and made (epoch ms; made falls back to changed where the disk doesn't keep it).
  edited?: number
  created?: number
}

export const NOTES_DIR = 'notes'
export const MAX_NAME = 80
export const MAX_DESCRIPTION = 200
// How deep sub-folders are read, and how many files at most, so a huge folder dropped in can't stall the popup.
const MAX_DEPTH = 6
const MAX_FILES = 5000
// Folders never read as notes: Obsidian's settings and trash, and anything hidden.
const SKIPPED_DIRS = new Set(['.obsidian', '.trash', 'node_modules'])
// What an import copies besides notes: pictures and PDFs a note may show or link.
const ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf)$/i

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

export const oneLine = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim()

const baseOf = (file: string) => file.split('/').at(-1)!.replace(/\.md$/i, '')
const folderOf = (file: string) => file.split('/').slice(0, -1).join('/')

export type ParsedNote = {
  name: string
  description: string
  body: string
  // Front matter lines Kothar doesn't use, kept as they were (tags, aliases, dates…).
  extra?: string[]
  pinned?: boolean
  // What the file had, so saving it changes no more than it must: no front matter at all, no name or description
  // line, no blank line after the front matter.
  frontMatter?: false
  noName?: true
  noDescription?: true
  tight?: true
}

// The front matter's name, description and pin, the lines it has besides, and the body after it (and after the blank
// line noteText puts there). A file without front matter, or without a name in it, is named by its file.
export function parseNote(text: string, file: string): ParsedNote {
  const fallback = baseOf(file)
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { name: fallback, description: '', body: text, frontMatter: false }
  const fields: Record<string, string> = {}
  const extra: string[] = []
  // A line that starts with a space or "- " continues the key above it (a YAML list or block); it goes where its key
  // went.
  let keep = true
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (/^\s|^-\s/.test(line) || colon <= 0) {
      if (keep) extra.push(line)
      continue
    }
    const key = line.slice(0, colon).trim().toLowerCase()
    keep = !['name', 'description', 'pinned'].includes(key)
    if (keep) extra.push(line)
    else fields[key] = line.slice(colon + 1).trim()
  }
  const rest = text.slice(match[0].length)
  const gap = /^\r?\n/.exec(rest)
  return {
    name: fields.name || fallback,
    description: fields.description ?? '',
    body: gap ? rest.slice(gap[0].length) : rest,
    ...(extra.length && { extra }),
    ...(fields.pinned === 'true' && { pinned: true }),
    ...(fields.name === undefined && { noName: true }),
    ...(fields.description === undefined && { noDescription: true }),
    ...(!gap && rest && { tight: true }),
  }
}

export type NoteShape = {
  extra?: string[]
  pinned?: boolean
  // Leave out the name line (the file names the note) or an empty description line, as the file had them.
  noName?: boolean
  noDescription?: boolean
  // No blank line after the front matter.
  tight?: boolean
}

// A note's file. exact: the body as the editor has it, byte for byte, so what's typed comes back the same; otherwise
// (an agent's write_note) its leading blank lines go and it ends in one newline. With nothing to put in front matter
// (shape says to leave the name and description out, and there's nothing else), the file is the body alone.
export function noteText(name: string, description: string, body: string, exact = false, shape: NoteShape = {}) {
  const text = exact ? body : body.replace(/^\n+/, '').replace(/\s*$/, '\n')
  const lines = [
    ...(shape.noName ? [] : [`name: ${oneLine(name)}`]),
    ...(shape.noDescription && !oneLine(description) ? [] : [`description: ${oneLine(description)}`]),
    ...(shape.pinned ? ['pinned: true'] : []),
    ...(shape.extra ?? []),
  ]
  if (!lines.length) return text
  return `---\n${lines.join('\n')}\n---\n${shape.tight ? '' : '\n'}${text}`
}

// A chat and every chat above it, top first. A note's space is the top: workers share their space's notes.
export function chainOf(host: ExtensionHost, chatId: string): ChatDetail[] {
  const chain: ChatDetail[] = []
  for (let chat = host.chat(chatId); chat; chat = chat.parentId === undefined ? undefined : host.chat(chat.parentId)) {
    chain.unshift(chat)
    if (chain.length > 32) break
  }
  return chain
}

// A chat that keeps no context of its own (Home) gets global notes only.
export const hasSpaceNotes = (space: ChatDetail | undefined) => !!space?.keepsContext

/** Every note file under dir, as paths relative to it with / between folders, sub-folders included. */
export function filesIn(dir: string): string[] {
  const found: string[] = []
  const walk = (at: string, prefix: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return
      if (entry.name.startsWith('.')) continue
      if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(prefix + entry.name)
      else if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) {
        walk(join(at, entry.name), `${prefix}${entry.name}/`, depth + 1)
      }
    }
  }
  if (existsSync(dir)) walk(dir, '', 0)
  return found
}

export function notesIn(dir: string, scope: NoteScope, owner: string): Note[] {
  return filesIn(dir).flatMap((file) => {
    const path = join(dir, ...file.split('/'))
    try {
      const text = readFileSync(path, 'utf8')
      const stat = statSync(path)
      const { name, description, pinned } = parseNote(text, file)
      const folder = folderOf(file)
      return [
        {
          key: `${owner}:${file}`,
          name,
          description,
          scope,
          ...(scope === 'space' && { spaceId: owner }),
          file,
          path,
          ...(folder && { folder }),
          ...(pinned && { pinned }),
          edited: stat.mtimeMs,
          created: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs,
        },
      ]
    } catch {
      return []
    }
  })
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
// By name, numbers in order (Note 2 before Note 10).
export const byName = (a: Note, b: Note) => collator.compare(a.name, b.name) || collator.compare(a.file, b.file)

export type NoteSort = 'edited' | 'created' | 'title'
export const SORTS: NoteSort[] = ['edited', 'created', 'title']
export function sortNotes(notes: Note[], sort: NoteSort): Note[] {
  const time = (note: Note) => (sort === 'created' ? note.created : note.edited) ?? 0
  return [...notes].sort(sort === 'title' ? byName : (a, b) => time(b) - time(a) || byName(a, b))
}

export const globalDir = (host: ExtensionHost) => host.storage.dir
export const spaceDir = (host: ExtensionHost, spaceId: string) => join(host.chatStorage(spaceId).dir, NOTES_DIR)

// The notes a chat reaches: global ones, then its space's, each by name.
export function notesFor(host: ExtensionHost, chatId: string): Note[] {
  const space = chainOf(host, chatId)[0]
  const global = notesIn(globalDir(host), 'global', 'global').sort(byName)
  if (!hasSpaceNotes(space)) return global
  return [...global, ...notesIn(spaceDir(host, space!.id), 'space', space!.id).sort(byName)]
}

// Every space that keeps notes, for a change to global notes that reaches them all.
export const spacesWithNotes = (host: ExtensionHost) => host.chats().filter((chat) => chat.parentId === undefined && hasSpaceNotes(chat))

export const bodyOf = (note: Note) => parseNote(readFileSync(note.path, 'utf8'), note.file).body

// A note's body, or nothing if it went meanwhile.
export const safeBody = (note: Note) => {
  try {
    return bodyOf(note)
  } catch {
    return ''
  }
}

export function find(notes: Note[], name: unknown) {
  const wanted = oneLine(name).toLowerCase()
  return (
    notes.find((note) => note.name.toLowerCase() === wanted) ??
    notes.find((note) => note.file.toLowerCase() === `${slugOf(wanted)}.md`) ??
    notes.find((note) => baseOf(note.file).toLowerCase() === wanted)
  )
}

// Saves a note in its scope. replacing: the note being edited, removed if its file changed. A note keeps its file (and
// folder) while its name and scope stay; a new name makes a new file from the name, in the same folder. Another note
// already in the file the name makes is never overwritten: it's refused when that note has another name (names that
// differ only in punctuation, such as "C++ tests" and "C tests", share a file), and when it has the same name unless
// sameName is 'replace' (write_note's rule; the popup asks for a new name instead). exact: keep the body byte for byte
// (the editor). The replaced file's front matter that Kothar doesn't use is kept; pinned changes the pin.
export function saveNote(
  host: ExtensionHost,
  chatId: string,
  input: { name?: unknown; description?: unknown; body?: unknown; scope?: unknown; pinned?: boolean },
  replacing?: Note,
  sameName: 'replace' | 'refuse' = 'replace',
  exact = false,
): Note {
  const name = oneLine(input.name)
  if (!name) throw new Error('A note needs a name')
  if (name.length > MAX_NAME) throw new Error(`A note's name is at most ${MAX_NAME} characters`)
  const description = oneLine(input.description)
  if (description.length > MAX_DESCRIPTION) throw new Error(`A note's description is one line of at most ${MAX_DESCRIPTION} characters`)
  const slug = slugOf(name)
  if (!slug) throw new Error('A note\'s name needs a letter or digit')
  const space = chainOf(host, chatId)[0]
  if (!space) throw new Error(`Unknown chat "${chatId}"`)
  const scope: NoteScope = input.scope === 'global' || input.scope === 'space' ? input.scope : hasSpaceNotes(space) ? 'space' : 'global'
  if (scope === 'space' && !hasSpaceNotes(space)) throw new Error(`${space.name} keeps no notes of its own; save a global note`)
  const notes = notesFor(host, chatId)
  // write_note naming a note that's already there replaces that one, in its own file.
  const target = replacing ?? (sameName === 'replace' ? notes.find((n) => n.scope === scope && n.name.toLowerCase() === name.toLowerCase()) : undefined)
  const sameScope = target?.scope === scope
  const keepsFile = sameScope && target!.name === name
  const folder = sameScope ? (target!.folder ?? '') : ''
  const file = keepsFile ? target!.file : `${folder ? `${folder}/` : ''}${slug}.md`
  const key = `${scope === 'global' ? 'global' : space.id}:${file}`
  const existing = notes.find((note) => note.key === key)
  if (existing && existing.key !== target?.key) {
    const where = scope === 'global' ? 'in global notes' : 'in this space'
    if (existing.name.toLowerCase() !== name.toLowerCase()) {
      throw new Error(`"${name}" would share the file ${file} with the note "${existing.name}" ${where}: pick another name`)
    }
    if (sameName === 'refuse') throw new Error(`A note named "${existing.name}" already exists ${where}: pick another name`)
  }
  const before = target ? readShape(target) : undefined
  const shape: NoteShape = {
    ...before,
    pinned: input.pinned ?? target?.pinned ?? false,
    // The name line stays left out only while the file still names the note.
    noName: !!before?.noName && baseOf(file) === name,
  }
  const text = noteText(name, description, String(input.body ?? ''), exact, shape)
  const storage = scope === 'global' ? host.storage : host.chatStorage(space.id)
  storage.write(scope === 'global' ? file : `${NOTES_DIR}/${file}`, text)
  if (replacing && replacing.key !== key) removeNote(host, replacing)
  const saved = notesFor(host, chatId).find((note) => note.key === key)
  if (!saved) throw new Error('The note was saved but can\'t be read back')
  return saved
}

// How a note's file is laid out, to keep when it's saved again.
function readShape(note: Note): NoteShape {
  try {
    const parsed = parseNote(readFileSync(note.path, 'utf8'), note.file)
    if (parsed.frontMatter === false) return { noName: true, noDescription: true }
    return { extra: parsed.extra, noName: parsed.noName, noDescription: parsed.noDescription, tight: parsed.tight }
  } catch {
    return {}
  }
}

export function removeNote(host: ExtensionHost, note: Note) {
  if (note.scope === 'global') host.storage.remove(note.file)
  else host.chatStorage(note.spaceId!).remove(`${NOTES_DIR}/${note.file}`)
}

// A name no note in the scope has yet: Untitled, then Untitled 2, 3…
export function freeName(notes: Note[], scope: NoteScope, base = 'Untitled') {
  const taken = new Set(notes.filter((n) => n.scope === scope).flatMap((n) => [n.file.toLowerCase(), n.name.toLowerCase()]))
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base} ${i}`
    if (!taken.has(`${slugOf(name)}.md`) && !taken.has(name.toLowerCase())) return name
  }
}

// The note whose name is closest to a name no note has, for an error: one sharing its file (names that differ only in
// punctuation, such as "C++ tests" and "C tests"), else one whose name contains it or is contained in it.
const closestTo = (notes: Note[], label: string) => {
  const wanted = label.toLowerCase()
  const slug = slugOf(label)
  return (
    notes.find((note) => slug && note.file.toLowerCase() === `${slug}.md`) ??
    notes.find((note) => wanted && (note.name.toLowerCase().includes(wanted) || wanted.includes(note.name.toLowerCase())))
  )
}

// Finds the note delete_note names, among the notes the caller can see, by exact name only (letter case aside): a
// deletion never falls back to a note that merely shares the name's file. scope picks between a global note and a
// space note of the same name; without it, that case is refused rather than guessed.
export function noteToDelete(notes: Note[], name: unknown, scope?: unknown): Note {
  const scoped = scope === 'global' || scope === 'space'
  const wanted = scoped ? notes.filter((note) => note.scope === scope) : notes
  const label = oneLine(name)
  const exact = wanted.filter((note) => note.name.toLowerCase() === label.toLowerCase())
  if (exact.length > 1) throw new Error(`There's a global note and a space note named "${label}": say which with scope`)
  if (exact[0]) return exact[0]
  const closest = closestTo(notes, label)
  const hint = closest ? `; the closest is "${closest.name}" (${closest.scope === 'global' ? 'global' : 'space'})` : ''
  throw new Error(`No note named "${label}"${scoped ? ` in ${scope} notes` : ''}${hint}; list_notes lists them`)
}

// Whether every letter of query appears in text in order (letter case aside), as a quick switcher matches "grcs" to
// Groceries.
export function fuzzyMatches(text: string, query: string) {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return false
  const t = text.toLowerCase()
  let at = 0
  for (const ch of q) {
    at = t.indexOf(ch, at)
    if (at < 0) return false
    at++
  }
  return true
}

// The notes whose name, description or text holds every word of the query (letter case aside): names first (ones
// starting with the query before the rest), then text. fuzzy: then notes whose name has the query's letters in order.
export function searchNotes(notes: Note[], query: string, body: (note: Note) => string = bodyOf, fuzzy = false): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return notes
  const whole = words.join(' ')
  const starts: Note[] = []
  const named: Note[] = []
  const inText: Note[] = []
  const loose: Note[] = []
  for (const note of notes) {
    const head = `${note.name}\n${note.description}`.toLowerCase()
    if (words.every((w) => head.includes(w))) (note.name.toLowerCase().startsWith(whole) ? starts : named).push(note)
    else {
      let text = ''
      try {
        text = body(note).toLowerCase()
      } catch {
        // Gone meanwhile.
      }
      if (words.every((w) => head.includes(w) || text.includes(w))) inText.push(note)
      else if (fuzzy && fuzzyMatches(note.name, whole)) loose.push(note)
    }
  }
  return [...starts, ...named, ...inText, ...loose]
}

// The first line of a note's text holding a word of the query, trimmed around it, for a search result.
export function snippetOf(text: string, query: string, max = 90): string | undefined {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const lower = line.toLowerCase()
    const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0))
    if (!Number.isFinite(at)) continue
    const start = Math.max(0, at - 30)
    const cut = line.slice(start, start + max)
    return `${start > 0 ? '…' : ''}${cut}${start + max < line.length ? '…' : ''}`
  }
  return undefined
}

// [[wikilinks]]: the target is what's before any | (alias) or # (heading), as Obsidian reads it. The editor draws the
// same syntax (its own parser), and its clicks send the target.
export const linkTarget = (inner: string) => inner.split('|')[0]!.split('#')[0]!.trim()

// Fenced code blocks and inline code spans, which hold no links or tags.
const CODE = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))|`[^`\n]*`/gm
const withoutCode = (text: string) => text.replace(CODE, '')
// Runs edit on the text outside code, keeping code as it is.
function outsideCode(text: string, edit: (part: string) => string) {
  let out = ''
  let last = 0
  for (const match of text.matchAll(CODE)) {
    out += edit(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return out + edit(text.slice(last))
}

/** Every [[wikilink]] target in a note's text, in order, without repeats. */
export function linksIn(text: string): string[] {
  const found: string[] = []
  for (const match of withoutCode(text).matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const target = linkTarget(match[1]!)
    if (target && !found.includes(target)) found.push(target)
  }
  return found
}

/**
 * Every #tag in a note's text, without its #, in order, without repeats: # after a space, a bracket or the line's start,
 * then letters, digits, _, - or /, not all digits (so #12 and headings aren't tags).
 */
export function tagsIn(text: string): string[] {
  const found: string[] = []
  for (const match of withoutCode(text).matchAll(/(?:^|[\s(])#([\p{L}\p{N}_\-/]+)/gmu)) {
    const tag = match[1]!
    if (!/^\d+$/.test(tag) && !found.includes(tag)) found.push(tag)
  }
  return found
}

/** The tags a file's front matter lists (tags: [a, b], tags: a b, or a "- a" list below it), as Obsidian keeps them. */
export function frontMatterTags(extra: string[] | undefined): string[] {
  const found: string[] = []
  const add = (tag: string) => {
    const clean = tag.trim().replace(/^["']|["']$/g, '').replace(/^#/, '')
    if (clean && !found.includes(clean)) found.push(clean)
  }
  let inTags = false
  for (const line of extra ?? []) {
    const field = /^(tags?)\s*:\s*(.*)$/i.exec(line)
    if (field) {
      inTags = true
      for (const tag of field[2]!.replace(/^\[|\]$/g, '').split(/[,\s]+/)) add(tag)
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (inTags && item) add(item[1]!)
    else if (!/^\s/.test(line)) inTags = false
  }
  return found
}

// The note a link names, among the notes a chat reaches: by name or file (letter case aside), this space's first, as
// the closest note wins in Obsidian. A link may name a file in a sub-folder by its path or by its name alone.
export function resolveLink(notes: Note[], target: string): Note | undefined {
  const wanted = target.trim().toLowerCase()
  const file = `${slugOf(target)}.md`
  const matches = (note: Note) => {
    const own = note.file.toLowerCase()
    return note.name.toLowerCase() === wanted || own === `${wanted}.md` || own === file || baseOf(own) === wanted
  }
  return notes.find((note) => note.scope === 'space' && matches(note)) ?? notes.find(matches)
}

// The notes that link to a note, by name.
export function backlinksOf(notes: Note[], to: Note, body: (note: Note) => string = bodyOf): Note[] {
  return notes.filter((note) => {
    if (note.key === to.key) return false
    try {
      return linksIn(body(note)).some((target) => resolveLink(notes, target)?.key === to.key)
    } catch {
      return false
    }
  })
}

/**
 * The text with every [[link]] whose target `points` says names the renamed note pointed at its new name instead,
 * keeping any #heading and |alias; links in code stay as they are.
 */
export function relink(text: string, points: (target: string) => boolean, to: string): string {
  return outsideCode(text, (part) =>
    part.replace(/\[\[([^[\]\n]+)\]\]/g, (whole, inner: string) => {
      if (!points(linkTarget(inner))) return whole
      const cut = inner.search(/[|#]/)
      return `[[${to}${cut < 0 ? '' : inner.slice(cut)}]]`
    }),
  )
}

/**
 * Points every link to `from` at its new name, in the notes that can see it: a space note's own space, or for a global
 * note, global notes and every space's (a space note of the same name still wins there, so its links stay). Returns how
 * many notes changed. Front matter is kept as it was.
 */
export function relinkEverywhere(host: ExtensionHost, from: Note, to: string, savedKey?: string): number {
  const groups: Note[][] = []
  // Called once the note is saved under its new name: links are read as they pointed before.
  const global = [...notesIn(globalDir(host), 'global', 'global').filter((n) => n.key !== savedKey && n.key !== from.key), ...(from.scope === 'global' ? [from] : [])]
  const own = (spaceId: string) => [
    ...notesIn(spaceDir(host, spaceId), 'space', spaceId).filter((n) => n.key !== savedKey && n.key !== from.key),
    ...(from.scope === 'space' && from.spaceId === spaceId ? [from] : []),
  ]
  if (from.scope === 'global') {
    groups.push(global)
    for (const space of spacesWithNotes(host)) groups.push([...global, ...own(space.id)])
  } else groups.push([...global, ...own(from.spaceId!)])
  const changed = new Set<string>()
  for (const notes of groups) {
    for (const note of notes) {
      if (note.key === from.key || note.key === savedKey || changed.has(note.path)) continue
      let text: string
      try {
        text = readFileSync(note.path, 'utf8')
      } catch {
        continue
      }
      const head = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[0] ?? ''
      const body = text.slice(head.length)
      const next = relink(body, (target) => resolveLink(notes, target)?.key === from.key, to)
      if (next === body) continue
      writeFileSync(note.path, head + next)
      changed.add(note.path)
    }
  }
  return changed.size
}

/**
 * The notes that name a note in their text without a [[link]] to it (Obsidian's unlinked mentions): its whole name, as
 * words, outside code and links. Names under 3 letters are too common to count.
 */
export function mentionsOf(notes: Note[], to: Note, body: (note: Note) => string = bodyOf): Note[] {
  if (to.name.trim().length < 3) return []
  const escaped = to.name.trim().replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
  const name = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
  return notes.filter((note) => {
    if (note.key === to.key) return false
    try {
      const text = body(note)
      if (linksIn(text).some((target) => resolveLink(notes, target)?.key === to.key)) return false
      return name.test(withoutCode(text).replace(/\[\[[^\]\n]*\]\]/g, ' '))
    } catch {
      return false
    }
  })
}

// The lines of a note that hold a word of the query, for search_notes.
export function hitsIn(note: Note, query: string, maxHits = 3, maxChars = 200) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return bodyOf(note)
    .split('\n')
    .filter((line) => words.some((w) => line.toLowerCase().includes(w)))
    .slice(0, maxHits)
    .map((line) => (line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line))
}

/** Words in a note's text, as a notes app counts them: runs of letters or digits, Markdown marks aside. */
export const wordCount = (text: string) => text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0

/** A time as a notes list shows it: just now, 5m, 3h, yesterday, a weekday this week, then the date. */
export function shortTime(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const day = new Date(at)
  const days = Math.floor(hours / 24)
  if (days < 2) return 'yesterday'
  if (days < 7) return day.toLocaleDateString(undefined, { weekday: 'short' })
  const thisYear = day.getFullYear() === new Date(now).getFullYear()
  return day.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(!thisYear && { year: 'numeric' }) })
}

export type ImportResult = { notes: number; attachments: number; skipped: number }

/**
 * Copies a folder of Markdown files (an Obsidian vault, a Bear or Notes export) into a notes folder, sub-folders kept,
 * with the pictures and PDFs beside them. Obsidian's settings, hidden files and anything else stay behind. A file
 * already there with the same text is skipped; one with other text gets a free name (plan 2.md). Files are copied as
 * they are, so their front matter, if any, stays.
 */
export function importFolder(from: string, to: string): ImportResult {
  const source = realOf(resolve(from))
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`No folder at ${from}`)
  const target = resolve(to)
  const realTarget = realOf(target)
  const inside = (a: string, b: string) => a === b || a.startsWith(b + sep)
  if (inside(realTarget, source) || inside(source, realTarget)) throw new Error('Pick a folder outside the notes folder')
  const result: ImportResult = { notes: 0, attachments: 0, skipped: 0 }
  let seen = 0
  const walk = (at: string, depth: number) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (seen >= MAX_FILES) return
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
      const path = join(at, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(path, depth + 1)
        continue
      }
      const note = /\.md$/i.test(entry.name)
      if (!entry.isFile() || (!note && !ATTACHMENT.test(entry.name))) continue
      seen++
      const rel = relative(source, path)
      let dest = join(target, rel)
      if (existsSync(dest)) {
        if (readFileSync(dest).equals(readFileSync(path))) {
          result.skipped++
          continue
        }
        dest = freePath(dest)
      }
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(path, dest)
      if (note) result.notes++
      else result.attachments++
    }
  }
  walk(source, 0)
  return result
}

function realOf(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// plan.md → plan 2.md, plan 3.md… whichever is free.
function freePath(path: string) {
  const dot = path.lastIndexOf('.')
  for (let i = 2; ; i++) {
    const next = `${path.slice(0, dot)} ${i}${path.slice(dot)}`
    if (!existsSync(next)) return next
  }
}

/** The headings of a note's text, outside code: each one's level, text (marks dropped) and line (from 1). */
export function headingsIn(text: string): { level: number; text: string; line: number }[] {
  const found: { level: number; text: string; line: number }[] = []
  let fence: string | undefined
  text.split('\n').forEach((raw, i) => {
    const open = /^\s{0,3}(```|~~~)/.exec(raw)?.[1]
    if (open) {
      if (!fence) fence = open
      else if (open === fence) fence = undefined
      return
    }
    if (fence) return
    const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw)
    if (!match || !match[2]!.trim()) return
    found.push({ level: match[1]!.length, text: match[2]!.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/[*_`~]+/g, '').trim(), line: i + 1 })
  })
  return found
}

/** Where each word of the query appears in text (letter case aside), every time, as [start, end) ranges. */
export function wordRanges(text: string, query: string): [number, number][] {
  const lower = text.toLowerCase()
  const ranges: [number, number][] = []
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) ranges.push([at, at + word.length])
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

/** The letters of a fuzzy match in text, in order (as fuzzyMatches finds them), as one-letter ranges; [] if none. */
export function fuzzyRanges(text: string, query: string): [number, number][] {
  const q = query.toLowerCase().replace(/\s+/g, '')
  const t = text.toLowerCase()
  const ranges: [number, number][] = []
  let at = 0
  for (const ch of q) {
    at = t.indexOf(ch, at)
    if (at < 0) return []
    ranges.push([at, at + 1])
    at++
  }
  return ranges
}

/**
 * The text with the first mention of a note's name (as mentionsOf finds it: whole words, outside code, links and URLs)
 * made a [[link]]: [[Name]] when it's written as the name is, else [[Name|as written]]. Unchanged if there's none.
 */
export function linkMention(text: string, name: string): string {
  const escaped = name.trim().replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
  if (name.trim().length < 3) return text
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
  let done = false
  return outsideCode(text, (part) => {
    if (done) return part
    // Links ([[…]], [text](url)) and bare URLs stay as they are; the name is looked for between them.
    const skip = /\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+/g
    let out = ''
    let last = 0
    const scan = (piece: string) => {
      if (done) return piece
      const match = pattern.exec(piece)
      if (!match) return piece
      done = true
      const link = match[0] === name.trim() ? `[[${name.trim()}]]` : `[[${name.trim()}|${match[0]}]]`
      return piece.slice(0, match.index) + link + piece.slice(match.index + match[0].length)
    }
    for (const m of part.matchAll(skip)) {
      out += scan(part.slice(last, m.index)) + m[0]
      last = m.index + m[0].length
    }
    return out + scan(part.slice(last))
  })
}

// Where a pasted picture goes, relative to its note's folder: attachments/<letters, digits, dashes>.<picture type>.
export const PASTED_PICTURE = /^attachments\/[A-Za-z0-9-]{1,80}\.(png|jpg|jpeg|gif|webp)$/

/** The pictures a note's text shows from its own attachments/ folder: ![…](attachments/x.png), without repeats. */
export function attachmentsIn(text: string): string[] {
  const found: string[] = []
  for (const match of withoutCode(text).matchAll(/!\[[^\]\n]*\]\(<?(attachments\/[^)\s>]+)>?\)/g)) {
    let path: string
    try {
      path = decodeURI(match[1]!)
    } catch {
      continue
    }
    if (!path.split('/').includes('..') && !found.includes(path)) found.push(path)
  }
  return found
}
