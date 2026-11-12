import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Extension, ExtensionContext, ExtensionHost, ExtensionView } from '@kothar/extension-api'
import { createLibrary, type ImportResult, type Library, type Skill } from './library.ts'
import { engineSources, importAny, importEngine, ON_FROM_INTERNET, type Fetch } from './sources.ts'

// Skills, in the open Agent Skills format: a folder with a SKILL.md (name and description in its front matter, then
// instructions) and any files it bundles. Kothar keeps its own library of them and gives them to every engine the same
// way, never through an engine's own skill loading (engines start clean): each session's instructions list the skills
// that are on, one line each, and the agent reads a skill's SKILL.md and files with read_skill and read_skill_file
// when a task fits it. Settings → Extensions → Skills lists them and imports more.

// How much of the library goes into instructions, so the index stays small.
export const MAX_INDEXED = 100
export const MAX_INDEX_DESCRIPTION = 200
// The most of one file read_skill_file returns.
export const MAX_READ = 200 * 1024

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function skillIndex(skills: Skill[]) {
  const on = skills.filter((skill) => skill.on)
  if (!on.length) return undefined
  const lines = on.slice(0, MAX_INDEXED).map((skill) => `- ${skill.id}: ${cut(skill.description, MAX_INDEX_DESCRIPTION)}`)
  if (on.length > MAX_INDEXED) lines.push(`- …and ${on.length - MAX_INDEXED} more; read_skill with no match lists them all.`)
  return [
    "Skills: the user's saved instructions for particular kinds of task. When a task fits one, call read_skill with its",
    'name before starting and follow it; read_skill_file reads a file it mentions. Run a script it bundles with an',
    'ordinary shell command, at the path read_skill gives.',
    ...lines,
  ].join('\n')
}

// A short word for where a skill came from, for its badge: the engine's name, or GitHub, Folder, File, Agent, By hand.
export function sourceBadge(source: string) {
  for (const word of ['GitHub', 'Folder', 'File']) if (source.startsWith(`${word} `)) return word
  if (source.startsWith('Made by an agent')) return 'Agent'
  if (source === 'Added by hand') return 'By hand'
  return source
}

const looksBinary = (data: Buffer) => data.subarray(0, 8000).includes(0)

export type SkillsOptions = { home?: string; env?: Record<string, string | undefined>; fetch?: Fetch }

export function createSkillsExtension(options: SkillsOptions = {}): Extension {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const fetcher: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  // The Settings page's state, while Kothar runs: the last import's outcome, and one running.
  let last: ImportResult | { error: string } | undefined
  let busy: string | undefined
  // One library per storage folder (a test may start more than one core).
  const libraries = new Map<string, Library>()
  const libraryOf = (host: ExtensionHost) => {
    let library = libraries.get(host.storage.dir)
    if (!library) libraries.set(host.storage.dir, (library = createLibrary(host.storage)))
    return library
  }

  const runImport = async (context: ExtensionContext, label: string, work: () => ImportResult | Promise<ImportResult>) => {
    if (busy) throw new Error(`Still importing ${busy}`)
    busy = label
    context.host.refresh()
    try {
      last = await work()
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) }
    } finally {
      busy = undefined
    }
  }

  const named = (library: Library, input: Record<string, unknown>) => {
    const name = String(input.name ?? '').trim()
    const skill = name ? library.get(name) : undefined
    if (skill?.on) return skill
    const on = library.list().filter((s) => s.on).map((s) => s.id)
    throw new Error(`No skill named ${name || '(none)'} is on. Skills that are: ${on.join(', ') || 'none'}`)
  }

  const skillCard = (skill: Skill): ExtensionView => ({
    type: 'card',
    title: skill.id,
    open: false,
    badges: [
      ...(skill.on ? [] : [{ text: 'Off', tone: 'warning' as const, hint: "Agents don't see it" }]),
      { text: sourceBadge(skill.source), tone: 'muted' as const, hint: skill.source },
    ],
    children: [
      { type: 'text', text: skill.description },
      { type: 'text', text: `From ${skill.source}`, tone: 'faint', small: true },
      { type: 'text', text: skill.dir, mono: true, small: true, reveal: true },
      {
        type: 'row',
        children: [
          {
            type: 'button',
            label: skill.on ? 'Turn off' : 'Turn on',
            variant: skill.on ? 'normal' : 'primary',
            action: { name: skill.on ? 'off' : 'on', value: skill.id },
            hint: skill.on ? 'Agents stop seeing it; its files stay' : 'Agents see its name and description, and read it when a task fits',
          },
          {
            type: 'button',
            label: 'Delete',
            variant: 'ghost',
            action: { name: 'delete', value: skill.id },
            confirm: { text: `Delete ${skill.id}?`, body: 'Its folder and everything in it go.', ok: 'Delete', danger: true },
          },
        ],
      },
    ],
  })

  const outcome = (): ExtensionView[] => {
    if (busy) return [{ type: 'text', text: `Importing ${busy}…`, tone: 'muted' }]
    if (!last) return []
    if ('error' in last) return [{ type: 'text', text: last.error, tone: 'error' }]
    const views: ExtensionView[] = []
    if (last.imported.length) {
      const off = last.source.startsWith('GitHub') && !ON_FROM_INTERNET
      views.push({
        type: 'text',
        text: `Imported ${last.imported.length} from ${last.source}: ${last.imported.join(', ')}.${off ? ' They start off: read them, then turn them on.' : ''}`,
        tone: 'success',
      })
    } else views.push({ type: 'text', text: `Nothing new imported from ${last.source}.`, tone: 'warning' })
    const already = last.skipped.filter((s) => s.why.startsWith('a skill with this name is already'))
    if (already.length) views.push({ type: 'text', text: `Already in Kothar: ${already.map((s) => s.name).join(', ')}`, tone: 'muted', small: true })
    for (const skipped of last.skipped.filter((s) => !already.includes(s))) {
      views.push({ type: 'text', text: `Skipped ${skipped.name}: ${skipped.why}`, tone: 'warning', small: true })
    }
    return views
  }

  return {
    id: 'skills',
    name: 'Skills',
    description:
      'Saved instructions for particular kinds of task, in the Agent Skills format (a folder with a SKILL.md). Agents on every engine see a one-line list and read a skill when a task fits it.',
    enabledByDefault: true,

    instructions({ tools }, { host }) {
      // Without the Kothar MCP server the agent couldn't read a skill, so the list would only cost room.
      if (!tools) return undefined
      return skillIndex(libraryOf(host).list())
    },

    tools: [
      {
        name: 'read_skill',
        description:
          "Reads one of the user's skills (listed in your instructions under Skills): its SKILL.md, the folder it's in, and the files it bundles. Call it before starting a task the skill fits.",
        inputSchema: { type: 'object', properties: { name: { type: 'string', description: "The skill's name" } }, required: ['name'] },
        offered: () => true,
        run(input, { host }) {
          const library = libraryOf(host)
          const skill = named(library, input)
          const files = library.filesOf(skill)
          return [
            `Skill ${skill.id}, in ${skill.dir}`,
            `Files: ${files.join(', ')}${files.length >= 200 ? ', …' : ''}`,
            '',
            readFileSync(`${skill.dir}/SKILL.md`, 'utf8'),
          ].join('\n')
        },
      },
      {
        name: 'read_skill_file',
        description: "Reads a file a skill bundles, by its path inside the skill's folder (as read_skill lists them).",
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: "The skill's name" }, file: { type: 'string', description: 'Path inside the skill, such as reference/forms.md' } },
          required: ['name', 'file'],
        },
        offered: () => true,
        run(input, { host }) {
          const library = libraryOf(host)
          const skill = named(library, input)
          const path = library.fileOf(skill, String(input.file ?? ''))
          const size = statSync(path).size
          const data = readFileSync(path)
          if (looksBinary(data)) return `${input.file} is a binary file (${size} bytes) at ${path}.`
          const text = data.subarray(0, MAX_READ).toString('utf8')
          return size > MAX_READ ? `${text}\n\n[cut at ${MAX_READ} of ${size} bytes; the file is at ${path}]` : text
        },
      },
      {
        name: 'create_skill',
        description:
          "Saves a new skill in the user's library, when the user asks you to make one: a name, a one-line description of when to use it (that line is all agents see until they read it), and the instructions in Markdown. It's on at once, for every chat's next message.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short, lowercase-with-dashes, such as release-notes' },
            description: { type: 'string', description: 'What it does and when to use it, in one line' },
            body: { type: 'string', description: 'The instructions, in Markdown' },
          },
          required: ['name', 'description', 'body'],
        },
        offered: () => true,
        run(input, { host, caller }) {
          const id = libraryOf(host).create(
            String(input.name ?? ''),
            String(input.description ?? ''),
            String(input.body ?? ''),
            `Made by an agent in ${caller.name}`,
          )
          host.refresh()
          return `Saved skill ${id}. The user can see, edit, turn off or delete it in Settings → Extensions → Skills.`
        },
      },
    ],

    settingsView: {
      render({ host }) {
        const library = libraryOf(host)
        const skills = library.list()
        const sources = engineSources(home, env).map((source) => ({ ...source, fresh: library.newIn(source.dir).length }))
        return {
          type: 'stack',
          gap: 'loose',
          children: [
            {
              type: 'stack',
              children: [
                {
                  type: 'heading',
                  text: `Your skills (${skills.length})`,
                  hint: 'Agents see the name and description of each one that is on, and read the rest when a task fits it.',
                },
                { type: 'text', text: library.root, mono: true, small: true, tone: 'faint', reveal: true },
                ...(skills.length
                  ? skills.map(skillCard)
                  : [{ type: 'empty' as const, text: 'No skills yet. Import some below, or ask an agent to make one.' }]),
              ],
            },
            {
              type: 'stack',
              children: [
                { type: 'heading', text: 'Import', hint: 'Skills are copied into your library. Nothing in them is run.' },
                {
                  type: 'row',
                  children: [
                    { type: 'button', label: 'Folder…', action: { name: 'import' }, pick: { kind: 'folder', title: 'Import skills from a folder' }, disabled: !!busy },
                    { type: 'button', label: 'Zip or .skill file…', action: { name: 'import' }, pick: { kind: 'file', title: 'Import a .zip or .skill file' }, disabled: !!busy },
                  ],
                },
                {
                  type: 'form',
                  key: 'import',
                  fields: [
                    {
                      name: 'from',
                      label: 'Folder, file or GitHub link',
                      placeholder: '~/skills/my-skill or https://github.com/owner/repo/tree/main/skills',
                      hint: 'Skills from GitHub start off, so you can read them before agents do',
                    },
                  ],
                  submit: { label: 'Import', action: 'import' },
                },
                {
                  type: 'row',
                  children: sources.map((source) => ({
                    type: 'button' as const,
                    label: source.fresh ? `${source.label} (${source.fresh} new)` : source.label,
                    action: { name: 'engine', value: source.id },
                    disabled: !source.fresh || !!busy,
                    hint: `Copies the skills in ${source.dir}`,
                  })),
                },
                ...outcome(),
              ],
            },
          ],
        }
      },
      async onAction(action, context) {
        const library = libraryOf(context.host)
        const value = action.value
        switch (action.name) {
          case 'on':
          case 'off':
            return library.setOn(String(value), action.name === 'on')
          case 'delete':
            return library.remove(String(value))
          case 'import': {
            const from = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) ? String(value.from ?? '') : ''
            return runImport(context, from.trim() || 'nothing', () => importAny(library, fetcher, home, from))
          }
          case 'engine': {
            const source = engineSources(home, env).find((s) => s.id === value)
            if (!source) throw new Error(`No skills folder ${String(value)}`)
            return runImport(context, `from ${source.label}`, () => importEngine(library, source))
          }
        }
      },
    },
  }
}

export default createSkillsExtension()
