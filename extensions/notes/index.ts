import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChatDetail,
  ChatSummary,
  Extension,
  ExtensionAction,
  ExtensionHost,
  ExtensionStorage,
  ExtensionView,
} from '@kothar/extension-api'

// A note is a Markdown file with a short front matter (name, description), kept as a plain file so agents can read it
// with their own tools. Global notes live in the extension's own folder, <garage>/extensions/notes/; a space's in its
// chat folder, <garage>/chats/<id>/notes/. Each chat can switch a note off; it's off below a chat that switched it off.

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
  on: boolean
}

const NOTES_DIR = 'notes'
const OFF_FILE = 'notes-off.json'
const MAX_NAME = 80
const MAX_DESCRIPTION = 200
// How many notes the index lists at most; the rest are left to list_notes.
const MAX_INDEXED = 60

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

const oneLine = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim()

// The front matter's name and description, and the body after it. A file without front matter is named by its file.
export function parseNote(text: string, file: string): { name: string; description: string; body: string } {
  const fallback = file.replace(/\.md$/i, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { name: fallback, description: '', body: text }
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { name: fields.name || fallback, description: fields.description ?? '', body: text.slice(match[0].length) }
}

export const noteText = (name: string, description: string, body: string) =>
  `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n---\n\n${body.replace(/^\n+/, '').replace(/\s*$/, '\n')}`

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

function offIn(storage: ExtensionStorage): string[] {
  try {
    const parsed = JSON.parse(storage.read(OFF_FILE) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : []
  } catch {
    return []
  }
}

function filesIn(dir: string) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

function notesIn(dir: string, scope: NoteScope, owner: string, off: Set<string>): Note[] {
  return filesIn(dir).flatMap((file) => {
    const path = join(dir, file)
    try {
      const { name, description } = parseNote(readFileSync(path, 'utf8'), file)
      const key = `${owner}:${file}`
      return [{ key, name, description, scope, ...(scope === 'space' && { spaceId: owner }), file, path, on: !off.has(key) }]
    } catch {
      return []
    }
  })
}

const byName = (a: Note, b: Note) => a.name.localeCompare(b.name)

// The notes that apply to a chat: global ones, then its space's, each marked on unless the chat or one above it switched
// it off.
export function notesFor(host: ExtensionHost, chatId: string): Note[] {
  const chain = chainOf(host, chatId)
  const off = new Set(chain.flatMap((chat) => offIn(host.chatStorage(chat.id))))
  const space = chain[0]
  const global = notesIn(host.storage.dir, 'global', 'global', off).sort(byName)
  if (!hasSpaceNotes(space)) return global
  const own = notesIn(join(host.chatStorage(space!.id).dir, NOTES_DIR), 'space', space!.id, off).sort(byName)
  return [...global, ...own]
}

export function noteIndex(notes: Note[], tools: boolean): string | undefined {
  const on = notes.filter((note) => note.on)
  const how = tools ? 'with read_note or by opening its file' : 'by opening its file'
  const save = tools
    ? ' When the user asks you to remember something, or you learn something clearly worth keeping for later ' +
      "sessions (such as how to run this repo's tests), save it with write_note."
    : ''
  if (!on.length) return tools ? `Notes: none saved yet.${save}` : undefined
  const lines = on.slice(0, MAX_INDEXED).map((note) => {
    const where = note.scope === 'global' ? 'global' : 'space'
    return `- ${note.name} (${where})${note.description ? `: ${note.description}` : ''}. ${note.path}`
  })
  const more = on.length > MAX_INDEXED ? [`- …and ${on.length - MAX_INDEXED} more (list_notes lists them all).`] : []
  return [
    `Notes: saved notes for this chat, by name, with what each is about and its file. Read a note in full (${how}) ` +
      `when it's relevant to what you're doing; don't read them all up front.${save}`,
    ...lines,
    ...more,
  ].join('\n')
}

const find = (notes: Note[], name: unknown) => {
  const wanted = oneLine(name).toLowerCase()
  return (
    notes.find((note) => note.name.toLowerCase() === wanted) ??
    notes.find((note) => note.file.toLowerCase() === `${slugOf(wanted)}.md`)
  )
}

const bodyOf = (note: Note) => parseNote(readFileSync(note.path, 'utf8'), note.file).body

// Saves a note in its scope. replacing: the note being edited, removed if the name changed. Another note already in
// the file the name makes is never overwritten: it's refused when that note has another name (names that differ only in
// punctuation, such as "C++ tests" and "C tests", share a file), and when it has the same name unless sameName is
// 'replace' (write_note's rule; the panel asks for a new name instead).
export function saveNote(
  host: ExtensionHost,
  chatId: string,
  input: { name?: unknown; description?: unknown; body?: unknown; scope?: unknown },
  replacing?: Note,
  sameName: 'replace' | 'refuse' = 'replace',
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
  const text = noteText(name, description, String(input.body ?? ''))
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

export function setNoteOn(host: ExtensionHost, chatId: string, key: string, on: boolean) {
  const storage = host.chatStorage(chatId)
  const off = new Set(offIn(storage))
  if (on) off.delete(key)
  else off.add(key)
  if (off.size) storage.write(OFF_FILE, JSON.stringify([...off], null, 2) + '\n')
  else storage.remove(OFF_FILE)
}

// What the panel is showing per chat: the list, or a form for a new note or one being edited, with why its last save
// was refused.
type Editing = ({ scope: NoteScope } | { key: string }) & { error?: string }

const listedNote = (note: Note) => ({ name: note.name, description: note.description, scope: note.scope, path: note.path, on: note.on })

export function createNotesExtension(): Extension {
  const editing = new Map<string, Editing>()

  const noteCard = (note: Note, chat: ChatDetail, editable: boolean, off: boolean): ExtensionView => ({
    type: 'card',
    title: note.name,
    open: false,
    badges: [
      ...(note.on
        ? []
        : [{ text: off ? 'Off' : 'Off above', tone: 'faint' as const, hint: off ? undefined : 'Switched off in the space' }]),
    ],
    children: [
      ...(note.description ? [{ type: 'text' as const, text: note.description, tone: 'muted' as const, small: true }] : []),
      { type: 'text', text: note.path, mono: true, small: true, tone: 'faint', copy: true, reveal: true },
      { type: 'code', text: bodyOf(note) || '(empty)', language: 'markdown', maxLines: 20 },
      ...(editable
        ? [
            {
              type: 'row' as const,
              children: [
                {
                  type: 'button' as const,
                  label: note.on ? 'Turn off here' : 'Turn on here',
                  action: { name: 'toggle', value: note.key },
                  hint: note.on
                    ? 'Leave this note out of this chat\'s instructions and its workers\''
                    : 'List this note in this chat\'s instructions again',
                  disabled: !note.on && !off,
                },
                { type: 'button' as const, label: 'Edit', action: { name: 'edit', value: note.key } },
                {
                  type: 'button' as const,
                  label: 'Delete',
                  variant: 'ghost' as const,
                  action: { name: 'delete', value: note.key },
                  confirm: {
                    text: `Delete the note "${note.name}"?`,
                    body: note.scope === 'global' ? 'It goes from every chat.' : `It goes from this space and its workers.`,
                    ok: 'Delete',
                    danger: true,
                  },
                },
              ],
            },
          ]
        : []),
    ],
  })

  const form = (chat: ChatDetail, what: Editing, notes: Note[]): ExtensionView => {
    const note = 'key' in what ? notes.find((n) => n.key === what.key) : undefined
    const scope = note?.scope ?? ('scope' in what ? what.scope : 'space')
    return {
      type: 'stack',
      children: [
        { type: 'heading', text: note ? `Edit ${note.name}` : scope === 'global' ? 'New global note' : 'New note in this space' },
        ...(what.error ? [{ type: 'text' as const, text: what.error, tone: 'error' as const }] : []),
        {
          type: 'form',
          key: note?.key ?? `new:${scope}`,
          fields: [
            { name: 'name', label: 'Name', value: note?.name ?? '', placeholder: 'How to run the tests' },
            {
              name: 'description',
              label: 'Description',
              value: note?.description ?? '',
              placeholder: 'One line: when an agent should read it',
              hint: 'Agents see the name and this line, and read the note in full when it fits their task',
            },
            { name: 'body', label: 'Note', value: note ? bodyOf(note) : '', rows: 10, mono: true, placeholder: 'Markdown' },
          ],
          submit: { label: 'Save', action: 'save' },
          cancel: { label: 'Cancel', action: { name: 'cancel' } },
        },
      ],
    }
  }

  return {
    id: 'notes',
    name: 'Notes',
    description:
      'Saved Markdown notes that agents find and read when they’re relevant: global ones for every chat, and each ' +
      'space’s own. Agents see a short index of them and can save new ones.',
    enabledByDefault: true,
    instructions: ({ chat, tools }, { host }) => noteIndex(notesFor(host, chat.id), tools),
    tools: [
      {
        name: 'list_notes',
        description:
          'Lists the saved notes this chat can read: global ones and its space’s, with each one’s description, ' +
          'scope, file and whether it’s on in this chat.',
        inputSchema: { type: 'object', properties: {} },
        offered: () => true,
        run: (_input, { caller, host }) => notesFor(host, caller.id).map(listedNote),
      },
      {
        name: 'read_note',
        description: 'Reads a saved note in full, by name.',
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
          'Saves a note for later sessions: something durable, such as how to run this repo’s tests or a decision ' +
          'the user made. Only when the user asks or it’s clearly worth keeping. Replaces a note of the same name; a ' +
          'name that would share another note’s file is refused. ' +
          'scope "space" (the default) keeps it for this space and its workers; "global" for every chat. Home ' +
          'saves global notes only. description is one line saying when to read it.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: MAX_NAME },
            description: { type: 'string', maxLength: MAX_DESCRIPTION },
            body: { type: 'string' },
            scope: { type: 'string', enum: ['space', 'global'] },
          },
          required: ['name', 'description', 'body'],
        },
        offered: () => true,
        run(input, { caller, host }) {
          const before = notesFor(host, caller.id)
          const saved = saveNote(host, caller.id, input)
          host.refresh()
          return { saved: listedNote(saved), replaced: !!before.find((note) => note.key === saved.key) }
        },
      },
    ],
    panels: [
      {
        id: 'notes',
        title: 'Notes',
        render(chat, { host }) {
          const notes = notesFor(host, chat.id)
          const what = editing.get(chat.id)
          // A worker follows its space, and its panel is read-only, as the rest of its sidebar is.
          const editable = !chat.parentId
          if (what && editable) return form(chat, what, notes)
          const ownOff = new Set(offIn(host.chatStorage(chat.id)))
          const space = chainOf(host, chat.id)[0]
          const spaceNotes = hasSpaceNotes(space)
          const section = (title: string, hint: string, listed: Note[], empty: string): ExtensionView[] => [
            { type: 'heading', text: title, hint },
            ...(listed.length
              ? listed.map((note) => noteCard(note, chat, editable, ownOff.has(note.key)))
              : [{ type: 'empty' as const, text: empty }]),
          ]
          return {
            type: 'stack',
            gap: 'loose',
            children: [
              ...(editable
                ? [
                    {
                      type: 'row' as const,
                      children: [
                        ...(spaceNotes
                          ? [{ type: 'button' as const, label: 'New note', variant: 'primary' as const, action: { name: 'new', value: 'space' } }]
                          : []),
                        {
                          type: 'button' as const,
                          label: 'New global note',
                          variant: spaceNotes ? undefined : ('primary' as const),
                          action: { name: 'new', value: 'global' },
                        },
                      ],
                    },
                  ]
                : []),
              ...(spaceNotes
                ? section(
                    'This space',
                    'Notes for this space and its workers, kept in the space’s folder',
                    notes.filter((note) => note.scope === 'space'),
                    'No notes for this space yet',
                  )
                : []),
              ...section(
                'Global',
                'Notes for every chat, kept in Kothar’s own folder',
                notes.filter((note) => note.scope === 'global'),
                'No global notes yet',
              ),
            ],
          }
        },
        onAction(action: ExtensionAction, chat, { host }) {
          if (chat.parentId) throw new Error('A worker’s notes follow its space')
          const notes = notesFor(host, chat.id)
          const noteOf = (key: unknown) => {
            const note = notes.find((n) => n.key === key)
            if (!note) throw new Error('That note is gone')
            return note
          }
          switch (action.name) {
            case 'new':
              editing.set(chat.id, { scope: action.value === 'global' ? 'global' : 'space' })
              break
            case 'edit':
              editing.set(chat.id, { key: noteOf(action.value).key })
              break
            case 'cancel':
              editing.delete(chat.id)
              break
            case 'save': {
              const what = editing.get(chat.id)
              if (!what) return
              const fields = (action.value ?? {}) as Record<string, unknown>
              const note = 'key' in what ? noteOf(what.key) : undefined
              try {
                saveNote(host, chat.id, { ...fields, scope: note?.scope ?? ('scope' in what ? what.scope : 'space') }, note, 'refuse')
              } catch (error) {
                // Shown above the form, which keeps what the user typed (same key, same starting values).
                editing.set(chat.id, { ...what, error: error instanceof Error ? error.message : String(error) })
                break
              }
              editing.delete(chat.id)
              host.refresh()
              return
            }
            case 'toggle': {
              const note = noteOf(action.value)
              const ownOff = offIn(host.chatStorage(chat.id)).includes(note.key)
              setNoteOn(host, chat.id, note.key, ownOff)
              break
            }
            case 'delete':
              removeNote(host, noteOf(action.value))
              editing.delete(chat.id)
              host.refresh()
              return
            default:
              throw new Error(`Unknown action "${action.name}"`)
          }
          host.refresh(chat.id)
        },
      },
    ],
    onChatRemoved(chat: ChatSummary) {
      editing.delete(chat.id)
    },
  }
}

export default createNotesExtension()
