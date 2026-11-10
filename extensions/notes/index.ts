import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChatDetail,
  ChatSummary,
  Extension,
  ExtensionAction,
  ExtensionHost,
  ExtensionListItem,
  ExtensionView,
} from '@kothar/extension-api'

// Notes for the user, as in Obsidian: Markdown files, each with a short front matter (name, description), global or
// one space's. They open in a popup over the chat (⌘⇧N, or Notes in the sidebar) with a list and search on the left
// and a live-preview editor on the right. Agents get no notes in their prompts; they search, read and write them with
// the note tools when the user asks.
//
// Global notes live in the extension's own folder, <garage>/extensions/notes/; a space's in its chat folder,
// <garage>/chats/<id>/notes/. Both are plain folders of .md files, so either can be opened as an Obsidian vault.

export type NoteScope = 'global' | 'space'
export type Note = {
  // global:<file> or <space id>:<file>.
  key: string
  name: string
  description: string
  scope: NoteScope
  // The space the note belongs to, for a space note.
  spaceId?: string
  file: string
  path: string
}

const NOTES_DIR = 'notes'
const MAX_NAME = 80
const MAX_DESCRIPTION = 200
// How many matching lines search_notes gives per note, and how many notes at most.
const MAX_HITS_PER_NOTE = 3
const MAX_HIT_NOTES = 20
const MAX_HIT_CHARS = 200

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

const oneLine = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim()

// The front matter's name and description, and the body after it (and after the blank line noteText puts there). A file
// without front matter is named by its file.
export function parseNote(text: string, file: string): { name: string; description: string; body: string } {
  const fallback = file.replace(/\.md$/i, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { name: fallback, description: '', body: text }
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  const body = text.slice(match[0].length).replace(/^\r?\n/, '')
  return { name: fields.name || fallback, description: fields.description ?? '', body }
}

// A note's file. exact: the body as the editor has it, byte for byte, so what's typed comes back the same; otherwise
// (an agent's write_note) its leading blank lines go and it ends in one newline.
export const noteText = (name: string, description: string, body: string, exact = false) =>
  `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n---\n\n${
    exact ? body : body.replace(/^\n+/, '').replace(/\s*$/, '\n')
  }`

// A chat and every chat above it, top first. A note's space is the top: workers share their space's notes.
function chainOf(host: ExtensionHost, chatId: string): ChatDetail[] {
  const chain: ChatDetail[] = []
  for (let chat = host.chat(chatId); chat; chat = chat.parentId === undefined ? undefined : host.chat(chat.parentId)) {
    chain.unshift(chat)
    if (chain.length > 32) break
  }
  return chain
}

// An extension's own chat (Home) keeps no files of its own, so it gets global notes only.
const hasSpaceNotes = (space: ChatDetail | undefined) => !!space && !space.extension

function filesIn(dir: string) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

function notesIn(dir: string, scope: NoteScope, owner: string): Note[] {
  return filesIn(dir).flatMap((file) => {
    const path = join(dir, file)
    try {
      const { name, description } = parseNote(readFileSync(path, 'utf8'), file)
      const key = `${owner}:${file}`
      return [{ key, name, description, scope, ...(scope === 'space' && { spaceId: owner }), file, path }]
    } catch {
      return []
    }
  })
}

const byName = (a: Note, b: Note) => a.name.localeCompare(b.name)

// The notes a chat reaches: global ones, then its space's.
export function notesFor(host: ExtensionHost, chatId: string): Note[] {
  const space = chainOf(host, chatId)[0]
  const global = notesIn(host.storage.dir, 'global', 'global').sort(byName)
  if (!hasSpaceNotes(space)) return global
  const own = notesIn(join(host.chatStorage(space!.id).dir, NOTES_DIR), 'space', space!.id).sort(byName)
  return [...global, ...own]
}

const find = (notes: Note[], name: unknown) => {
  const wanted = oneLine(name).toLowerCase()
  return (
    notes.find((note) => note.name.toLowerCase() === wanted) ??
    notes.find((note) => note.file.toLowerCase() === `${slugOf(wanted)}.md`)
  )
}

export const bodyOf = (note: Note) => parseNote(readFileSync(note.path, 'utf8'), note.file).body

// Saves a note in its scope. replacing: the note being edited, removed if the name changed. Another note already in
// the file the name makes is never overwritten: it's refused when that note has another name (names that differ only in
// punctuation, such as "C++ tests" and "C tests", share a file), and when it has the same name unless sameName is
// 'replace' (write_note's rule; the popup asks for a new name instead). exact: keep the body byte for byte (the editor).
export function saveNote(
  host: ExtensionHost,
  chatId: string,
  input: { name?: unknown; description?: unknown; body?: unknown; scope?: unknown },
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
  const file = `${slug}.md`
  const key = `${scope === 'global' ? 'global' : space.id}:${file}`
  const existing = notesFor(host, chatId).find((note) => note.key === key)
  if (existing && existing.key !== replacing?.key) {
    const where = scope === 'global' ? 'in global notes' : 'in this space'
    if (existing.name.toLowerCase() !== name.toLowerCase()) {
      throw new Error(`"${name}" would share the file ${file} with the note "${existing.name}" ${where}: pick another name`)
    }
    if (sameName === 'refuse') throw new Error(`A note named "${existing.name}" already exists ${where}: pick another name`)
  }
  const text = noteText(name, description, String(input.body ?? ''), exact)
  const storage = scope === 'global' ? host.storage : host.chatStorage(space.id)
  storage.write(scope === 'global' ? file : `${NOTES_DIR}/${file}`, text)
  if (replacing && replacing.key !== key) removeNote(host, replacing)
  const saved = notesFor(host, chatId).find((note) => note.key === key)
  if (!saved) throw new Error('The note was saved but can\'t be read back')
  return saved
}

export function removeNote(host: ExtensionHost, note: Note) {
  if (note.scope === 'global') host.storage.remove(note.file)
  else host.chatStorage(note.spaceId!).remove(`${NOTES_DIR}/${note.file}`)
}

// A name no note in the scope has yet: Untitled, then Untitled 2, 3…
export function freeName(notes: Note[], scope: NoteScope, base = 'Untitled') {
  const taken = new Set(notes.filter((n) => n.scope === scope).map((n) => n.file))
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base} ${i}`
    if (!taken.has(`${slugOf(name)}.md`)) return name
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

// The notes whose name, description or text holds every word of the query (letter case aside), names first.
export function searchNotes(notes: Note[], query: string, body: (note: Note) => string = bodyOf): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return notes
  const named: Note[] = []
  const inText: Note[] = []
  for (const note of notes) {
    const head = `${note.name}\n${note.description}`.toLowerCase()
    if (words.every((w) => head.includes(w))) named.push(note)
    else {
      let text = ''
      try {
        text = body(note).toLowerCase()
      } catch {
        // Gone meanwhile.
      }
      if (words.every((w) => head.includes(w) || text.includes(w))) inText.push(note)
    }
  }
  return [...named, ...inText]
}

// [[wikilinks]]: the target is what's before any | (alias) or # (heading), as Obsidian reads it. The editor draws the
// same syntax (its own parser), and its clicks send the target.
export const linkTarget = (inner: string) => inner.split('|')[0]!.split('#')[0]!.trim()

// Code (fenced blocks and inline spans) holds no links or tags.
const withoutCode = (text: string) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '').replace(/`[^`\n]*`/g, '')

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

// The note a link names, among the notes a chat reaches: by name or file (letter case aside), this space's first, as
// the closest note wins in Obsidian.
export function resolveLink(notes: Note[], target: string): Note | undefined {
  const wanted = target.trim().toLowerCase()
  const file = `${slugOf(target)}.md`
  const matches = (note: Note) =>
    note.name.toLowerCase() === wanted || note.file.toLowerCase() === `${wanted}.md` || note.file.toLowerCase() === file
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

// The lines of a note that hold a word of the query, for search_notes.
function hitsIn(note: Note, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return bodyOf(note)
    .split('\n')
    .filter((line) => words.some((w) => line.toLowerCase().includes(w)))
    .slice(0, MAX_HITS_PER_NOTE)
    .map((line) => (line.length > MAX_HIT_CHARS ? `${line.slice(0, MAX_HIT_CHARS - 1)}…` : line))
}

// Watches the note folders the popup has shown, so a note added, edited or deleted outside Kothar (in an editor, in
// Obsidian, by git, by an agent's own file tools) shows in an open popup without reopening it. owner is 'global' or a
// space id. It polls each folder's file names, sizes and times rather than using fs.watch, whose events don't arrive
// everywhere (they didn't under a sandboxed parent on macOS); a few stats every couple of seconds is cheap.
export function noteWatcher(onChange: (owner: string) => void, intervalMs = 2000) {
  const watched = new Map<string, { owner: string; seen: string }>()
  let timer: ReturnType<typeof setInterval> | undefined
  const signature = (dir: string) => {
    try {
      return filesIn(dir)
        .map((file) => {
          const stat = statSync(join(dir, file))
          return `${file}:${stat.size}:${stat.mtimeMs}`
        })
        .sort()
        .join('\n')
    } catch {
      return ''
    }
  }
  const check = () => {
    const owners = new Set<string>()
    for (const [dir, entry] of watched) {
      const now = signature(dir)
      if (now === entry.seen) continue
      entry.seen = now
      owners.add(entry.owner)
    }
    for (const owner of owners) onChange(owner)
  }
  const stopIfIdle = () => {
    if (watched.size || !timer) return
    clearInterval(timer)
    timer = undefined
  }
  return {
    add(dir: string, owner: string) {
      if (watched.has(dir)) return
      watched.set(dir, { owner, seen: signature(dir) })
      if (timer) return
      timer = setInterval(check, intervalMs)
      timer.unref?.()
    },
    // Takes in a change Kothar made itself, so it isn't reported back as one from outside.
    seen() {
      for (const [dir, entry] of watched) entry.seen = signature(dir)
    },
    // Stops watching what belongs to the owner: a space that was deleted.
    forget(owner: string) {
      for (const [dir, entry] of watched) if (entry.owner === owner) watched.delete(dir)
      stopIfIdle()
    },
    closeAll() {
      watched.clear()
      stopIfIdle()
    },
  }
}

// What the popup shows per chat: the open note, the search, and a rename in progress with why it was refused.
type PopupState = { open?: string; query: string; tag?: string; renaming?: { error?: string } }

const listedNote = (note: Note) => ({ name: note.name, description: note.description, scope: note.scope, path: note.path })

// A note's body, or nothing if it went meanwhile.
const safeBody = (note: Note) => {
  try {
    return bodyOf(note)
  } catch {
    return ''
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// pollMs: how often an open popup looks for notes changed outside Kothar (tests shorten it).
export function createNotesExtension({ pollMs = 2000 }: { pollMs?: number } = {}): Extension {
  const states = new Map<string, PopupState>()
  const stateOf = (chatId: string) => {
    let state = states.get(chatId)
    if (!state) states.set(chatId, (state = { query: '' }))
    return state
  }
  let hostOf: ExtensionHost | undefined
  // A global note changed: every chat's popup. A space's: the space's and its workers'.
  const watcher = noteWatcher((owner) => {
    const host = hostOf
    if (!host) return
    if (owner === 'global') return host.refresh()
    for (const chat of host.chats()) {
      if (chainOf(host, chat.id)[0]?.id !== owner) continue
      try {
        host.refresh(chat.id)
      } catch {
        // Removed meanwhile.
      }
    }
  }, pollMs)
  const watchFor = (host: ExtensionHost, chat: ChatDetail) => {
    hostOf = host
    watcher.add(host.storage.dir, 'global')
    const space = chainOf(host, chat.id)[0]
    if (hasSpaceNotes(space)) watcher.add(join(host.chatStorage(space!.id).dir, NOTES_DIR), space!.id)
  }

  const row = (note: Note, open: string | undefined): ExtensionListItem => ({
    key: note.key,
    label: note.name,
    selected: note.key === open,
    action: { name: 'open', value: note.key },
    ...(note.description && { hint: note.description }),
  })

  const side = (chat: ChatDetail, host: ExtensionHost, notes: Note[], state: PopupState): ExtensionView => {
    const spaceNotes = hasSpaceNotes(chainOf(host, chat.id)[0])
    const bodies = new Map(notes.map((note) => [note.key, safeBody(note)]))
    const tagged = new Map(notes.map((note) => [note.key, tagsIn(bodies.get(note.key)!)]))
    const tags = [...new Set([...tagged.values()].flat())].sort((a, b) => a.localeCompare(b))
    // A tag no note has any more stops filtering.
    if (state.tag && !tags.includes(state.tag)) delete state.tag
    const shown = searchNotes(notes, state.query, (note) => bodies.get(note.key)!).filter(
      (note) => !state.tag || tagged.get(note.key)!.includes(state.tag),
    )
    const filtered = !!state.query || !!state.tag
    const section = (title: string, hint: string, scope: NoteScope, empty: string): ExtensionView[] => {
      const listed = shown.filter((note) => note.scope === scope)
      return [
        { type: 'heading', text: title, hint },
        { type: 'list', label: title, items: listed.map((note) => row(note, state.open)), empty: filtered ? 'Nothing matches' : empty },
      ]
    }
    return {
      type: 'stack',
      gap: 'normal',
      children: [
        {
          type: 'row',
          children: [
            ...(spaceNotes ? [{ type: 'button' as const, label: 'New note', variant: 'primary' as const, action: { name: 'new', value: 'space' } }] : []),
            {
              type: 'button',
              label: spaceNotes ? 'New global' : 'New note',
              variant: spaceNotes ? 'normal' : 'primary',
              action: { name: 'new', value: 'global' },
              hint: 'A note for every space',
            },
          ],
        },
        { type: 'search', key: chat.id, value: state.query, placeholder: 'Search notes', action: 'search' },
        ...(tags.length
          ? [
              {
                type: 'row' as const,
                children: tags.map(
                  (tag): ExtensionView => ({
                    type: 'button',
                    label: `#${tag}`,
                    variant: tag === state.tag ? 'primary' : 'ghost',
                    action: { name: 'tag', value: tag === state.tag ? '' : tag },
                    hint: tag === state.tag ? 'Show every note again' : `Only notes tagged #${tag}`,
                  }),
                ),
              },
            ]
          : []),
        ...(spaceNotes ? section('This space', 'Kept in the space’s folder; gone when the space is', 'space', 'No notes here yet') : []),
        ...section('Global', 'Kept in Kothar’s own folder, for every space', 'global', 'No global notes yet'),
      ],
    }
  }

  const main = (note: Note | undefined, state: PopupState, notes: Note[]): ExtensionView => {
    if (!note) return { type: 'empty', text: 'Pick a note, or make a new one' }
    const scope = note.scope === 'global' ? 'Global' : 'This space'
    const header: ExtensionView = {
      type: 'row',
      justify: 'between',
      children: [
        {
          type: 'row',
          children: [
            { type: 'heading', text: note.name, ...(note.description && { hint: note.description }) },
            { type: 'badge', text: scope, tone: 'muted' },
          ],
        },
        {
          type: 'row',
          children: [
            { type: 'button', label: 'Rename', variant: 'ghost', action: { name: 'rename' } },
            {
              type: 'button',
              label: 'Delete',
              variant: 'ghost',
              action: { name: 'delete', value: note.key },
              confirm: {
                text: `Delete the note "${note.name}"?`,
                body: note.scope === 'global' ? 'Its file goes, for every space.' : 'Its file goes, for this space.',
                ok: 'Delete',
                danger: true,
              },
            },
          ],
        },
      ],
    }
    const rename: ExtensionView[] = state.renaming
      ? [
          ...(state.renaming.error ? [{ type: 'text' as const, text: state.renaming.error, tone: 'error' as const }] : []),
          {
            type: 'form',
            key: `rename:${note.key}`,
            fields: [
              { name: 'name', label: 'Name', value: note.name },
              { name: 'description', label: 'Description', value: note.description, placeholder: 'One line, optional' },
            ],
            submit: { label: 'Save', action: 'renamed' },
            cancel: { label: 'Cancel', action: { name: 'cancel' } },
          },
        ]
      : []
    return {
      type: 'stack',
      gap: 'normal',
      children: [
        header,
        ...rename,
        { type: 'text', text: note.path, mono: true, small: true, tone: 'faint', copy: true, reveal: true },
        {
          type: 'editor',
          key: note.key,
          text: bodyOf(note),
          change: 'write',
          links: 'link',
          tags: 'tag',
          label: note.name,
          placeholder: 'Write in Markdown… [[Another note]] links, #tag tags',
          autofocus: !state.renaming,
        },
        { type: 'divider' },
        { type: 'heading', text: 'Linked from', hint: 'Notes with a [[link]] to this one' },
        { type: 'list', label: 'Linked from', items: backlinksOf(notes, note, safeBody).map((n) => row(n, undefined)), empty: 'No notes link here' },
      ],
    }
  }

  return {
    id: 'notes',
    name: 'Notes',
    description:
      'Your notes, as in Obsidian: Markdown files, global or per space, in a popup over the chat (⌘⇧N) with search ' +
      'and a live-preview editor. Agents read and write them with tools when you ask; nothing goes into their prompts.',
    enabledByDefault: true,
    tools: [
      {
        name: 'list_notes',
        description:
          'Lists the user’s notes this chat can reach: global ones and its space’s, with each one’s description, scope ' +
          'and file. Use when the user mentions their notes.',
        inputSchema: { type: 'object', properties: {} },
        offered: () => true,
        run: (_input, { caller, host }) => notesFor(host, caller.id).map(listedNote),
      },
      {
        name: 'search_notes',
        description:
          'Searches the user’s notes (global and this space’s) for words, in names, descriptions and text, and gives ' +
          'the matching notes with a few matching lines each. read_note reads one in full.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
        offered: () => true,
        run({ query }, { caller, host }) {
          const q = oneLine(query)
          return searchNotes(notesFor(host, caller.id), q)
            .slice(0, MAX_HIT_NOTES)
            .map((note) => ({ ...listedNote(note), lines: hitsIn(note, q) }))
        },
      },
      {
        name: 'read_note',
        description: 'Reads one of the user’s notes in full, by name.',
        inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
        offered: () => true,
        run({ name }, { caller, host }) {
          const note = find(notesFor(host, caller.id), name)
          if (!note) throw new Error(`No note named "${oneLine(name)}"; list_notes lists them`)
          return `${note.name}${note.description ? `: ${note.description}` : ''}\n${note.path}\n\n${bodyOf(note)}`
        },
      },
      {
        name: 'write_note',
        description:
          'Saves one of the user’s notes, only when the user asks. Replaces a note of the same name; a name that would ' +
          'share another note’s file is refused. scope "space" (the default) keeps it in this space; "global" for every ' +
          'space. Home saves global notes only. description is one optional line about it.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: MAX_NAME },
            description: { type: 'string', maxLength: MAX_DESCRIPTION },
            body: { type: 'string' },
            scope: { type: 'string', enum: ['space', 'global'] },
          },
          required: ['name', 'body'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const before = notesFor(host, caller.id)
          const saved = saveNote(host, caller.id, input)
          host.refresh()
          return { saved: listedNote(saved), replaced: !!before.find((note) => note.key === saved.key) }
        },
      },
      {
        name: 'delete_note',
        description:
          'Deletes one of the user’s notes, by name, only when the user asks. Reaches this space’s notes (a worker ' +
          'deletes from its space) and global ones, which go from every space. The name must be the note’s exact name ' +
          '(letter case aside). scope ("space" or "global") picks one when both have a note of that name.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1 }, scope: { type: 'string', enum: ['space', 'global'] } },
          required: ['name'],
        },
        offered: () => true,
        run({ name, scope }, { caller, host }) {
          const note = noteToDelete(notesFor(host, caller.id), name, scope)
          removeNote(host, note)
          host.refresh()
          return { deleted: listedNote(note) }
        },
      },
    ],
    panels: [
      {
        id: 'notes',
        title: 'Notes',
        placement: 'popup',
        shortcut: 'Mod+Shift+N',
        sidebar: true,
        render(chat, { host }) {
          watchFor(host, chat)
          const notes = notesFor(host, chat.id)
          const state = stateOf(chat.id)
          const open = notes.find((note) => note.key === state.open)
          // A note deleted elsewhere closes.
          if (state.open && !open) {
            delete state.open
            delete state.renaming
          }
          return { type: 'split', side: side(chat, host, notes, state), main: main(open, state, notes) }
        },
        onAction(action: ExtensionAction, chat, { host }) {
          const notes = notesFor(host, chat.id)
          const state = stateOf(chat.id)
          const noteOf = (key: unknown) => {
            const note = notes.find((n) => n.key === key)
            if (!note) throw new Error('That note is gone')
            return note
          }
          switch (action.name) {
            case 'search':
              state.query = String(action.value ?? '')
              return
            case 'open':
              state.open = noteOf(action.value).key
              delete state.renaming
              return
            case 'new': {
              const scope: NoteScope = action.value === 'global' ? 'global' : 'space'
              const made = saveNote(host, chat.id, { name: freeName(notes, scope), body: '', scope }, undefined, 'refuse', true)
              state.open = made.key
              state.renaming = {}
              state.query = ''
              break
            }
            case 'write': {
              const note = state.open ? notes.find((n) => n.key === state.open) : undefined
              if (!note) return
              const { name, description } = note
              saveNote(host, chat.id, { name, description, body: String(action.value ?? ''), scope: note.scope }, note, 'refuse', true)
              // Other chats with the popup open see it when the watcher next looks; this editor already has the text.
              return
            }
            case 'rename':
              state.renaming = {}
              return
            case 'tag':
              if (action.value) state.tag = String(action.value).replace(/^#/, '')
              else delete state.tag
              return
            // A [[link]] clicked in the editor: its note opens, made first if there's none, in this space (global
            // for Home), as Obsidian does.
            case 'link': {
              const target = oneLine(action.value)
              if (!target) return
              const found = resolveLink(notes, target)
              if (found) {
                state.open = found.key
                delete state.renaming
                return
              }
              const made = saveNote(host, chat.id, { name: target, body: '' }, undefined, 'refuse', true)
              state.open = made.key
              delete state.renaming
              break
            }
            case 'cancel':
              delete state.renaming
              return
            case 'renamed': {
              const note = noteOf(state.open)
              const fields = (action.value ?? {}) as Record<string, unknown>
              try {
                const saved = saveNote(host, chat.id, { ...fields, body: bodyOf(note), scope: note.scope }, note, 'refuse', true)
                state.open = saved.key
                delete state.renaming
              } catch (error) {
                // Shown above the form, which keeps what the user typed (same key, same starting values).
                state.renaming = { error: errorText(error) }
                return
              }
              break
            }
            case 'delete':
              removeNote(host, noteOf(action.value))
              if (state.open === action.value) delete state.open
              delete state.renaming
              break
            default:
              throw new Error(`Unknown action "${action.name}"`)
          }
          // Other chats showing the same notes draw them again; this one draws after its action anyway.
          watcher.seen()
          host.refresh()
        },
      },
    ],
    // onStop is only called for an extension that started.
    onStart() {},
    onStop() {
      watcher.closeAll()
    },
    onChatRemoved(chat: ChatSummary) {
      states.delete(chat.id)
      watcher.forget(chat.id)
    },
  }
}

export default createNotesExtension()
