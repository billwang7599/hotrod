import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatDetail, ChatSummary, Extension, ExtensionAction, ExtensionHost, ExtensionListItem, ExtensionView } from '@kothar/extension-api'
import {
  backlinksOf,
  bodyOf,
  chainOf,
  filesIn,
  find,
  freeName,
  frontMatterTags,
  globalDir,
  hasSpaceNotes,
  attachmentsIn,
  fuzzyRanges,
  headingsIn,
  hitsIn,
  linkMention,
  mentionsOf,
  PASTED_PICTURE,
  importFolder,
  MAX_DESCRIPTION,
  MAX_NAME,
  type Note,
  type NoteScope,
  type NoteSort,
  notesFor,
  noteToDelete,
  oneLine,
  parseNote,
  relink,
  relinkEverywhere,
  removeNote,
  resolveLink,
  safeBody,
  saveNote,
  searchNotes,
  shortTime,
  slugOf,
  snippetOf,
  SORTS,
  sortNotes,
  spaceDir,
  tagsIn,
  wordCount,
  wordRanges,
} from './store.ts'

export * from './store.ts'

// Notes for the user, as in Obsidian or Apple Notes: Markdown files, global or one space's. They open in a popup over
// the chat (⌘⇧N, or Notes in the sidebar) with a list and search on the left and a live-preview editor on the right.
// Agents get no notes in their prompts; they search, read and write them with the note tools when the user asks.
//
// Global notes live in the extension's own folder, <garage>/extensions/notes/; a space's in its chat folder,
// <garage>/chats/<id>/notes/. Both are plain folders of .md files (sub-folders too), so either can be opened as an
// Obsidian vault, and files edited there show up here.

// How many matching lines search_notes gives per note, and how many notes at most.
const MAX_HIT_NOTES = 20
// How many versions of a note's text count as known (shown in the editor or saved from it), to tell a change made
// outside Kothar from one the editor already has.
const KNOWN_VERSIONS = 8
const PREFS = '.prefs.json'
const SORT_LABELS: Record<NoteSort, string> = { edited: 'Edited', created: 'Created', title: 'Title' }
// A new note's name while it has none of its own; its first line names it as the user types.
const UNTITLED = 'Untitled'
const MAX_TITLE = 60
// A note with this many headings gets an outline to jump by.
const OUTLINE_MIN_HEADINGS = 3
// A pasted picture's bytes, base64 (the editor sends at most 10 MB).
const MAX_PICTURE_BASE64 = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4

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

// What the popup shows per chat.
type PopupState = {
  // Not drawn yet: its first look opens the note last edited, as a notes app opens where you were.
  fresh?: boolean
  // The open note's key, and the editor's key for it: kept through a rename or move, so the editor (its cursor, its
  // undo) stays as it is.
  open?: string
  doc?: string
  query: string
  tag?: string
  renaming?: { error?: string }
  // The open note was made here and is still named Untitled: its first line names it.
  auto?: string
  // The last note deleted here, to bring back.
  deleted?: { name: string; scope: NoteScope; spaceId?: string; file: string; text: string }
  // A line about the last thing done that's worth saying (an import, a conflict, an undo), with its tone.
  notice?: { text: string; tone: 'muted' | 'warning' | 'error' }
  importing?: boolean
  // The note was opened for the user (the popup's first look), so the editor doesn't take the keyboard.
  quiet?: boolean
  // A heading picked in the outline, for the editor to jump to: a new key per pick.
  jump?: { key: string; line: number }
}

const listedNote = (note: Note) => ({ name: note.name, description: note.description, scope: note.scope, path: note.path })

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// A note's title from its first line, as Apple Notes and Bear name a note: its text without Markdown marks.
export function titleFrom(body: string): string {
  const first = body.split('\n').find((line) => line.trim()) ?? ''
  const plain = first
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/[\\/:]/g, ' ')
  const line = oneLine(plain)
  if (line.length <= MAX_TITLE) return line
  const cut = line.slice(0, MAX_TITLE)
  return cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : MAX_TITLE).trim()
}

// pollMs: how often an open popup looks for notes changed outside Kothar (tests shorten it).
export function createNotesExtension({ pollMs = 2000, now = () => Date.now() }: { pollMs?: number; now?: () => number } = {}): Extension {
  const states = new Map<string, PopupState>()
  const stateOf = (chatId: string) => {
    let state = states.get(chatId)
    if (!state) states.set(chatId, (state = { query: '', fresh: true }))
    return state
  }
  // Each note's texts the editor has had or sent, by path: a text on disk that isn't one of them was written outside
  // Kothar since the editor last looked.
  const known = new Map<string, string[]>()
  const know = (path: string, text: string) => {
    const list = (known.get(path) ?? []).filter((t) => t !== text)
    list.push(text)
    known.set(path, list.slice(-KNOWN_VERSIONS))
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
    watcher.add(globalDir(host), 'global')
    const space = chainOf(host, chat.id)[0]
    if (hasSpaceNotes(space)) watcher.add(spaceDir(host, space!.id), space!.id)
  }

  const sortOf = (host: ExtensionHost): NoteSort => {
    try {
      const sort = JSON.parse(host.storage.read(PREFS) ?? '{}').sort
      return SORTS.includes(sort) ? sort : 'edited'
    } catch {
      return 'edited'
    }
  }

  // query: what a search typed, to highlight in the name, and in snippet (the line of text it matched), shown under it.
  const row = (note: Note, open: string | undefined, sort: NoteSort, snippet?: string, query = ''): ExtensionListItem => {
    const time = sort === 'created' ? note.created : note.edited
    const detail = [note.folder, sort !== 'title' && time ? shortTime(time, now()) : undefined].filter(Boolean).join(' · ')
    const words = wordRanges(note.name, query)
    // A name that holds the words gets them marked; one found by its letters in order, those letters.
    const marks = query.trim() ? (words.length ? words : fuzzyRanges(note.name, query)) : []
    return {
      key: note.key,
      label: note.name,
      selected: note.key === open,
      action: { name: 'open', value: note.key },
      ...(detail && { detail }),
      ...(note.description && { hint: note.description }),
      ...(marks.length && { marks }),
      ...(snippet && { excerpt: { text: snippet, marks: wordRanges(snippet, query) } }),
    }
  }

  const side = (chat: ChatDetail, host: ExtensionHost, notes: Note[], state: PopupState): ExtensionView => {
    const spaceNotes = hasSpaceNotes(chainOf(host, chat.id)[0])
    const sort = sortOf(host)
    const bodies = new Map(notes.map((note) => [note.key, safeBody(note)]))
    const tagged = new Map(
      notes.map((note) => {
        let extra: string[] | undefined
        try {
          extra = parseNote(readFileSync(note.path, 'utf8'), note.file).extra
        } catch {
          // Gone meanwhile.
        }
        return [note.key, [...new Set([...frontMatterTags(extra), ...tagsIn(bodies.get(note.key)!)])]]
      }),
    )
    const counts = new Map<string, number>()
    for (const tags of tagged.values()) for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    const tags = [...counts.keys()].sort((a, b) => a.localeCompare(b))
    // A tag no note has any more stops filtering.
    if (state.tag && !counts.has(state.tag)) delete state.tag
    const searching = !!state.query.trim()
    const matched = searchNotes(notes, state.query, (note) => bodies.get(note.key)!, true).filter(
      (note) => !state.tag || tagged.get(note.key)!.includes(state.tag),
    )
    // While searching, best matches first; otherwise the order picked.
    const shown = searching ? matched : sortNotes(matched, sort)
    // The line of text a search matched, for a note whose name doesn't hold every word.
    const snippet = (note: Note) => {
      if (!searching) return undefined
      const words = state.query.toLowerCase().split(/\s+/).filter(Boolean)
      if (words.every((w) => note.name.toLowerCase().includes(w))) return undefined
      return snippetOf(bodies.get(note.key)!, state.query)
    }
    const filtered = searching || !!state.tag
    const sortButton: ExtensionView = {
      type: 'button',
      label: `Sort: ${SORT_LABELS[sort]}`,
      variant: 'ghost',
      action: { name: 'sort', value: SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length] },
      hint: 'Change the order: last edited, made, or by title',
    }
    let sortShown = false
    // The first section heading carries the sort button.
    const heading = (title: string, hint: string): ExtensionView => {
      if (sortShown || searching) return { type: 'heading', text: title, hint }
      sortShown = true
      return { type: 'row', justify: 'between', children: [{ type: 'heading', text: title, hint }, sortButton] }
    }
    const pinned = filtered ? [] : shown.filter((note) => note.pinned)
    const section = (title: string, hint: string, scope: NoteScope, empty: string): ExtensionView[] => {
      const listed = shown.filter((note) => note.scope === scope && !pinned.includes(note))
      return [
        heading(title, hint),
        { type: 'list', label: title, items: listed.map((note) => row(note, state.open, sort, snippet(note), state.query)), empty: filtered ? 'Nothing matches' : empty },
      ]
    }
    const query = oneLine(state.query)
    // Typing a name no note has offers to make it, as a quick switcher does.
    const offerNew = query && query.length <= MAX_NAME && !notes.some((note) => note.name.toLowerCase() === query.toLowerCase())
    const scopeFor: NoteScope = spaceNotes ? 'space' : 'global'
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
              ...(spaceNotes && { hint: 'A note for every space' }),
            },
          ],
        },
        {
          type: 'search',
          key: chat.id,
          value: state.query,
          placeholder: 'Search or make a note',
          action: 'search',
          submit: 'go',
          // Opening the popup goes to the search box, unless a note was opened for typing (a link, a new note).
          autofocus: !state.open || !!state.quiet,
        },
        ...(offerNew
          ? [
              {
                type: 'button' as const,
                label: `New note “${query}”`,
                variant: (matched.length ? 'ghost' : 'primary') as 'ghost' | 'primary',
                action: { name: 'create', value: { name: query, scope: scopeFor } },
              },
            ]
          : []),
        ...(state.deleted
          ? [
              {
                type: 'row' as const,
                justify: 'between' as const,
                children: [
                  { type: 'text' as const, text: `Deleted “${state.deleted.name}”`, tone: 'muted' as const, small: true },
                  { type: 'button' as const, label: 'Undo', variant: 'ghost' as const, action: { name: 'undo' } },
                ],
              },
            ]
          : []),
        ...(state.notice ? [{ type: 'text' as const, text: state.notice.text, tone: state.notice.tone, small: true }] : []),
        ...(tags.length
          ? [
              {
                type: 'row' as const,
                children: tags.map(
                  (tag): ExtensionView => ({
                    type: 'button',
                    label: `#${tag} ${counts.get(tag)}`,
                    variant: tag === state.tag ? 'primary' : 'ghost',
                    action: { name: 'tag', value: tag === state.tag ? '' : tag },
                  }),
                ),
              },
            ]
          : []),
        ...(pinned.length
          ? [heading('Pinned', 'Pinned notes stay on top'), { type: 'list' as const, label: 'Pinned', items: pinned.map((note) => row(note, state.open, sort)) }]
          : []),
        ...(spaceNotes ? section('This space', 'Kept in the space’s folder; gone when the space is', 'space', 'No notes here yet') : []),
        ...section('Global', 'Kept in Kothar’s own folder, for every space', 'global', 'No global notes yet'),
        { type: 'divider' },
        ...importView(state, spaceNotes),
      ],
    }
  }

  // Import from a folder of Markdown files: the system's folder picker in the desktop app, a typed path anywhere.
  const importView = (state: PopupState, spaceNotes: boolean): ExtensionView[] => {
    const into = spaceNotes ? 'this space' : 'global notes'
    if (!state.importing) {
      return [
        {
          type: 'row',
          children: [
            {
              type: 'button',
              label: 'Import…',
              variant: 'ghost',
              action: { name: 'import' },
              pick: { kind: 'folder', title: `Import a folder of Markdown notes into ${into}` },
              hint: `Copies a folder of .md files (an Obsidian vault, a Bear export) into ${into}, sub-folders and pictures too`,
            },
            { type: 'button', label: 'Import from path…', variant: 'ghost', action: { name: 'importing' } },
            { type: 'button', label: 'Show folder', variant: 'ghost', action: { name: 'folder', value: spaceNotes ? 'space' : 'global' } },
          ],
        },
      ]
    }
    return [
      {
        type: 'form',
        key: 'import',
        fields: [{ name: 'path', label: `Folder to import into ${into}`, placeholder: '~/Notes', mono: true }],
        submit: { label: 'Import', action: 'import' },
        cancel: { label: 'Cancel', action: { name: 'cancel-import' } },
      },
    ]
  }

  // Whether the note is one of the space's context files already, or undefined where there's no context to add it to
  // (Home keeps no files).
  const inContext = (host: ExtensionHost, chat: ChatDetail, note: Note) => {
    const space = chainOf(host, chat.id)[0]
    if (!hasSpaceNotes(space)) return undefined
    const real = (path: string) => {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    }
    return space!.files.map(real).includes(real(note.path))
  }

  const main = (host: ExtensionHost, chat: ChatDetail, note: Note | undefined, state: PopupState, notes: Note[]): ExtensionView => {
    if (!note) {
      return { type: 'empty', text: notes.length ? 'Pick a note, or make a new one' : 'No notes yet. Make one with New note, or import a folder of Markdown files' }
    }
    const context = inContext(host, chat, note)
    const spaceNotes = hasSpaceNotes(chainOf(host, chat.id)[0])
    const body = bodyOf(note)
    know(note.path, body)
    const words = wordCount(body)
    const edited = note.edited ? `Edited ${shortTime(note.edited, now())}${/^\d/.test(shortTime(note.edited, now())) ? ' ago' : ''}` : ''
    const meta = [edited, `${words} ${words === 1 ? 'word' : 'words'}`].filter(Boolean).join(' · ')
    const header: ExtensionView = {
      type: 'stack',
      gap: 'tight',
      children: [
        {
          type: 'row',
          children: [
            { type: 'heading', text: note.name, ...(note.description && { hint: note.description }) },
            { type: 'badge', text: note.scope === 'global' ? 'Global' : 'This space', tone: 'muted' },
            ...(note.folder ? [{ type: 'badge' as const, text: note.folder, tone: 'muted' as const }] : []),
            ...(note.pinned ? [{ type: 'badge' as const, text: 'Pinned', tone: 'accent' as const }] : []),
            { type: 'text', text: meta, tone: 'faint', small: true },
          ],
        },
        {
          type: 'row',
          children: [
            ...(context === undefined
              ? []
              : [
                  {
                    type: 'button' as const,
                    label: context ? 'In context' : 'Add to context',
                    variant: 'ghost' as const,
                    disabled: context,
                    action: { name: 'context', value: note.key },
                    hint: context
                      ? 'Already in this space’s Context → Files: pasted into its prompts'
                      : 'Add it to this space’s Context → Files, so its agents get it in full from the next message',
                  },
                ]),
            { type: 'button', label: note.pinned ? 'Unpin' : 'Pin', variant: 'ghost', action: { name: 'pin', value: note.key } },
            { type: 'button', label: 'Rename', variant: 'ghost', action: { name: 'rename' } },
            ...(spaceNotes
              ? [
                  {
                    type: 'button' as const,
                    label: note.scope === 'global' ? 'Move to this space' : 'Move to global',
                    variant: 'ghost' as const,
                    action: { name: 'move', value: note.key },
                    hint: note.scope === 'global' ? 'Only this space sees it then' : 'Every space sees it then',
                  },
                ]
              : []),
            { type: 'button', label: 'Show in Finder', variant: 'ghost', action: { name: 'reveal', value: note.key }, hint: note.path },
            { type: 'button', label: 'Delete', variant: 'ghost', action: { name: 'delete', value: note.key } },
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
    const backlinks = backlinksOf(notes, note, safeBody)
    const mentions = mentionsOf(notes, note, safeBody)
    const headings = headingsIn(body)
    const outline: ExtensionView[] =
      headings.length >= OUTLINE_MIN_HEADINGS
        ? [
            {
              type: 'card',
              title: 'Outline',
              // Folded, so the note's text comes first; one click shows its headings.
              open: false,
              badges: [{ text: String(headings.length), tone: 'muted' }],
              children: [
                {
                  type: 'list',
                  label: 'Outline',
                  items: headings.map((h, i) => ({
                    key: `${i}:${h.line}`,
                    // Deeper headings sit further in.
                    label: `${'\u2003'.repeat(Math.max(0, h.level - headings.reduce((min, x) => Math.min(min, x.level), 6)))}${h.text}`,
                    action: { name: 'jump', value: h.line },
                  })),
                },
              ],
            },
          ]
        : []
    return {
      type: 'stack',
      gap: 'normal',
      children: [
        header,
        ...rename,
        ...outline,
        {
          type: 'editor',
          key: state.doc ?? note.key,
          text: body,
          change: 'write',
          links: 'link',
          tags: 'tag',
          label: note.name,
          placeholder: 'Start typing. The first line names the note. [[Another note]] links, #tag tags',
          autofocus: !state.renaming && !state.quiet,
          completions: [...new Set(notes.filter((n) => n.key !== note.key).map((n) => n.name))].sort((a, b) => a.localeCompare(b)),
          keep: 'keep',
          // Pictures sit beside the note, in attachments/; pasted ones are saved there.
          files: dirname(note.path),
          paste: 'picture',
          ...(state.jump && { jump: state.jump }),
        },
        ...(backlinks.length
          ? [
              { type: 'divider' as const },
              { type: 'heading' as const, text: 'Linked from', hint: 'Notes with a [[link]] to this one' },
              { type: 'list' as const, label: 'Linked from', items: backlinks.map((n) => row(n, undefined, 'title')) },
            ]
          : []),
        ...(mentions.length
          ? [
              ...(backlinks.length ? [] : [{ type: 'divider' as const }]),
              { type: 'heading' as const, text: 'Mentioned in', hint: `Notes that name “${note.name}” without a [[link]]` },
              {
                type: 'list' as const,
                label: 'Mentioned in',
                items: mentions.map((n) => ({
                  ...row(n, undefined, 'title', snippetOf(safeBody(n), note.name), note.name),
                  button: { label: 'Link', action: { name: 'link-mention', value: n.key }, hint: `Make its first mention a [[link]] to “${note.name}”` },
                })),
              },
            ]
          : []),
      ],
    }
  }

  // Keeps a version of the note that's about to be replaced (changed outside Kothar while the user typed) as a note of
  // its own beside it, "<name> (changed outside)", so neither is lost, and says so.
  const keepCopy = (chatId: string, host: ExtensionHost, notes: Note[], note: Note, body: string, state: PopupState) => {
    const copy = saveNote(
      host,
      chatId,
      { name: freeName(notes, note.scope, `${note.name} (changed outside)`.slice(0, MAX_NAME)), description: note.description, body, scope: note.scope },
      undefined,
      'refuse',
      true,
    )
    state.notice = { text: `“${note.name}” changed outside Kothar while you typed. That version is kept as “${copy.name}”.`, tone: 'warning' }
  }

  // Opens a note, as the editor's own (a new editor key) unless it's the same note under a new name.
  const openNote = (state: PopupState, key: string) => {
    state.open = key
    state.doc = key
    delete state.jump
    delete state.renaming
    delete state.auto
    delete state.quiet
  }

  return {
    id: 'notes',
    name: 'Notes',
    description:
      'Your notes, as in Obsidian or Apple Notes: Markdown files, global or per space, in a popup over the chat (⌘⇧N) ' +
      'with search, pins, tags, [[links]] and a live-preview editor. Agents read and write them with tools when you ' +
      'ask; nothing goes into their prompts.',
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
          if (state.fresh) {
            delete state.fresh
            const recent = sortNotes(notes, 'edited')[0]
            if (recent) {
              openNote(state, recent.key)
              state.quiet = true
            }
          }
          const open = notes.find((note) => note.key === state.open)
          // A note deleted elsewhere closes.
          if (state.open && !open) {
            delete state.open
            delete state.doc
            delete state.renaming
            delete state.auto
          }
          return { type: 'split', side: side(chat, host, notes, state), main: main(host, chat, open, state, notes) }
        },
        async onAction(action: ExtensionAction, chat, { host }) {
          const notes = notesFor(host, chat.id)
          const state = stateOf(chat.id)
          const noteOf = (key: unknown) => {
            const note = notes.find((n) => n.key === key)
            if (!note) throw new Error('That note is gone')
            return note
          }
          const spaceNotes = hasSpaceNotes(chainOf(host, chat.id)[0])
          // An action before the first look picks what's open itself.
          delete state.fresh
          // Most actions leave the notice from before behind.
          if (!['write', 'search', 'tag', 'sort'].includes(action.name)) delete state.notice
          switch (action.name) {
            case 'search':
              state.query = String(action.value ?? '')
              return
            case 'open':
              openNote(state, noteOf(action.value).key)
              return
            // Enter in the search box: the best match opens, or a note named as typed is made, as a quick switcher does.
            case 'go': {
              const query = oneLine(action.value)
              state.query = String(action.value ?? '')
              if (!query) return
              const best = searchNotes(notes, query, safeBody, true).find((note) => !state.tag || tagsIn(safeBody(note)).includes(state.tag))
              if (best) {
                openNote(state, best.key)
                return
              }
              const made = saveNote(host, chat.id, { name: query, body: '', scope: spaceNotes ? 'space' : 'global' }, undefined, 'refuse', true)
              openNote(state, made.key)
              state.query = ''
              break
            }
            case 'new':
            case 'create': {
              const asked = (action.value ?? {}) as { name?: unknown; scope?: unknown }
              const scope: NoteScope = (action.name === 'new' ? action.value : asked.scope) === 'global' || !spaceNotes ? 'global' : 'space'
              const name = action.name === 'create' ? oneLine(asked.name) : freeName(notes, scope, UNTITLED)
              const made = saveNote(host, chat.id, { name, body: '', scope }, undefined, 'refuse', true)
              openNote(state, made.key)
              // An Untitled note takes its name from its first line.
              if (action.name === 'new') state.auto = made.key
              state.query = ''
              delete state.tag
              break
            }
            case 'write': {
              const note = state.open ? notes.find((n) => n.key === state.open) : undefined
              if (!note) return
              const text = String(action.value ?? '')
              const onDisk = safeBody(note)
              // The file changed outside Kothar since the editor last had it, and the editor's text isn't that change:
              // the editor's text is saved, and the other one kept beside it as a note of its own, so neither is lost.
              const seen = known.get(note.path) ?? []
              let conflict = false
              if (onDisk !== text && seen.length && !seen.includes(onDisk)) {
                keepCopy(chat.id, host, notes, note, onDisk, state)
                conflict = true
              }
              let saved = saveNote(host, chat.id, { name: note.name, description: note.description, body: text, scope: note.scope }, note, 'refuse', true)
              know(saved.path, text)
              if (state.auto === note.key) {
                const title = titleFrom(text)
                if (title && title !== note.name) {
                  try {
                    saved = saveNote(host, chat.id, { name: title, description: note.description, body: text, scope: note.scope }, saved, 'refuse', true)
                    know(saved.path, text)
                    state.open = saved.key
                    state.auto = saved.key
                  } catch {
                    // Another note has that name: it keeps the one it has until the line names a free one.
                  }
                }
              }
              // Other chats with the popup open see it when the watcher next looks; this editor already has the text.
              if (saved.key === note.key && !conflict) return
              break
            }
            // "Keep mine" in the editor over a version changed elsewhere: that version is kept as a note of its own
            // first; the editor's text follows as a write.
            case 'keep': {
              const note = state.open ? notes.find((n) => n.key === state.open) : undefined
              const theirs = String(action.value ?? '')
              if (!note || !theirs.trim()) return
              keepCopy(chat.id, host, notes, note, theirs, state)
              break
            }
            case 'jump': {
              const line = Number(action.value)
              if (!Number.isInteger(line) || line < 1) return
              state.jump = { key: `${now()}:${line}`, line }
              return
            }
            // A picture pasted or dropped into the editor: saved beside the open note, in attachments/.
            case 'picture': {
              const note = state.open ? notes.find((n) => n.key === state.open) : undefined
              const { path, data } = (action.value ?? {}) as { path?: unknown; data?: unknown }
              if (!note) throw new Error('No note is open to save the picture with')
              if (typeof path !== 'string' || !PASTED_PICTURE.test(path)) throw new Error('A pasted picture goes in attachments/, named by letters, digits and dashes')
              if (typeof data !== 'string' || data.length > MAX_PICTURE_BASE64) throw new Error('That picture is too big (10 MB at most)')
              const file = join(dirname(note.path), ...path.split('/'))
              mkdirSync(dirname(file), { recursive: true })
              try {
                // Never over another picture that has the name.
                writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx' })
              } catch (error) {
                state.notice = { text: (error as NodeJS.ErrnoException).code === 'EEXIST' ? `A picture named ${path} is already there; it shows instead` : errorText(error), tone: 'error' }
                break
              }
              return
            }
            // One click on a mention of the open note in another note: its first mention becomes a [[link]].
            case 'link-mention': {
              const open = noteOf(state.open)
              const other = noteOf(action.value)
              const text = readFileSync(other.path, 'utf8')
              const head = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[0] ?? ''
              const body = text.slice(head.length)
              const linked = linkMention(body, open.name)
              if (linked === body) return
              writeFileSync(other.path, head + linked)
              state.notice = { text: `Linked “${other.name}” to “${open.name}”`, tone: 'muted' }
              break
            }
            case 'rename':
              state.renaming = {}
              return
            case 'pin': {
              const note = noteOf(action.value)
              saveNote(host, chat.id, { name: note.name, description: note.description, body: bodyOf(note), scope: note.scope, pinned: !note.pinned }, note, 'refuse', true)
              break
            }
            case 'move': {
              const note = noteOf(action.value)
              const scope: NoteScope = note.scope === 'global' ? 'space' : 'global'
              try {
                const body = bodyOf(note)
                const moved = saveNote(host, chat.id, { name: note.name, description: note.description, body, scope }, note, 'refuse', true)
                // Its pictures go with it (copied: another note may show them too).
                for (const picture of attachmentsIn(body)) {
                  const from = join(dirname(note.path), ...picture.split('/'))
                  const to = join(dirname(moved.path), ...picture.split('/'))
                  if (!existsSync(from) || existsSync(to)) continue
                  mkdirSync(dirname(to), { recursive: true })
                  copyFileSync(from, to)
                }
                state.open = moved.key
                state.notice = { text: `Moved to ${scope === 'global' ? 'global notes' : 'this space'}`, tone: 'muted' }
              } catch (error) {
                state.notice = { text: errorText(error), tone: 'error' }
              }
              break
            }
            case 'reveal':
              await host.reveal(noteOf(action.value).path)
              return
            case 'folder': {
              const dir = action.value === 'space' && spaceNotes ? spaceDir(host, chainOf(host, chat.id)[0]!.id) : globalDir(host)
              // A folder that has no notes yet is made, so there's something to show.
              mkdirSync(dir, { recursive: true })
              await host.reveal(dir)
              return
            }
            // The note joins the space's context files, as the user adding it in Context does; a worker's space too.
            case 'context':
              host.addContextFile(chat.id, noteOf(action.value).path)
              return
            case 'tag':
              if (action.value) state.tag = String(action.value).replace(/^#/, '')
              else delete state.tag
              return
            case 'sort': {
              const sort = SORTS.includes(action.value as NoteSort) ? action.value : 'edited'
              host.storage.write(PREFS, JSON.stringify({ sort }))
              break
            }
            // A [[link]] clicked in the editor: its note opens, made first if there's none, in this space (global
            // for Home), as Obsidian does.
            case 'link': {
              const target = oneLine(action.value)
              if (!target) return
              const found = resolveLink(notes, target)
              if (found) {
                openNote(state, found.key)
                return
              }
              const made = saveNote(host, chat.id, { name: target, body: '' }, undefined, 'refuse', true)
              openNote(state, made.key)
              break
            }
            case 'cancel':
              delete state.renaming
              return
            case 'renamed': {
              const note = noteOf(state.open)
              const fields = (action.value ?? {}) as Record<string, unknown>
              const name = oneLine(fields.name)
              try {
                // The note's own links to itself follow the new name too.
                const own = relink(bodyOf(note), (target) => resolveLink(notes, target)?.key === note.key, name)
                const saved = saveNote(host, chat.id, { ...fields, body: own, scope: note.scope }, note, 'refuse', true)
                state.open = saved.key
                delete state.renaming
                delete state.auto
                if (saved.name !== note.name) {
                  const changed = relinkEverywhere(host, note, saved.name, saved.key)
                  if (changed) state.notice = { text: `Updated links in ${changed} ${changed === 1 ? 'note' : 'notes'}`, tone: 'muted' }
                }
                // The editor gets the relinked text as a new note's would.
                if (own !== bodyOf(saved)) state.doc = saved.key
              } catch (error) {
                // Shown above the form, which keeps what the user typed (same key, same starting values).
                state.renaming = { error: errorText(error) }
                return
              }
              break
            }
            case 'delete': {
              const note = noteOf(action.value)
              state.deleted = { name: note.name, scope: note.scope, spaceId: note.spaceId, file: note.file, text: readFileSync(note.path, 'utf8') }
              removeNote(host, note)
              if (state.open === action.value) {
                delete state.open
                delete state.doc
              }
              delete state.renaming
              break
            }
            case 'undo': {
              const gone = state.deleted
              if (!gone) return
              delete state.deleted
              const storage = gone.scope === 'global' ? host.storage : host.chatStorage(gone.spaceId!)
              const path = gone.scope === 'global' ? gone.file : `notes/${gone.file}`
              // Another note took its file meanwhile: it comes back under a free name.
              let file = gone.file
              if (storage.read(path) !== undefined) {
                const free = freeName(notes, gone.scope, gone.name)
                file = `${slugOf(free)}.md`
              }
              storage.write(gone.scope === 'global' ? file : `notes/${file}`, gone.text)
              const back = notesFor(host, chat.id).find((n) => n.scope === gone.scope && n.file === file && (gone.scope === 'global' || n.spaceId === gone.spaceId))
              if (back) openNote(state, back.key)
              break
            }
            case 'importing':
              state.importing = true
              return
            case 'cancel-import':
              delete state.importing
              return
            case 'import': {
              const raw = typeof action.value === 'string' ? action.value : String((action.value as { path?: unknown })?.path ?? '')
              const path = raw.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~')
              if (!path) return
              const dir = spaceNotes ? spaceDir(host, chainOf(host, chat.id)[0]!.id) : globalDir(host)
              try {
                const result = importFolder(path, dir)
                delete state.importing
                const parts = [`${result.notes} ${result.notes === 1 ? 'note' : 'notes'}`]
                if (result.attachments) parts.push(`${result.attachments} ${result.attachments === 1 ? 'picture or file' : 'pictures and files'}`)
                const skipped = result.skipped ? `; ${result.skipped} already here` : ''
                state.notice = { text: `Imported ${parts.join(' and ')}${skipped}`, tone: 'muted' }
              } catch (error) {
                state.notice = { text: errorText(error), tone: 'error' }
              }
              break
            }
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
