import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatDetail, ExtensionHost } from '@kothar/extension-api'

// Artifacts as plain files in their space's chat folder, <garage>/chats/<space id>/artifacts/<slug>/: v1.<ext>,
// v2.<ext>… (the extension says what the content is: .html, .jsx, .md, .svg, .mmd, or a code file's own) and
// artifact.json (title, type, language, description, versions). Any of them opens outside Kothar.

export const TYPES = ['html', 'react', 'svg', 'mermaid', 'markdown', 'code'] as const
export type ArtifactType = (typeof TYPES)[number]

export const TYPE_LABEL: Record<ArtifactType, string> = {
  html: 'HTML',
  react: 'React',
  svg: 'SVG',
  mermaid: 'Diagram',
  markdown: 'Document',
  code: 'Code',
}

// chatId: the chat whose agent saved it, so Fix goes back to it. restored: the version it copies.
export type ArtifactVersion = { n: number; at: string; change?: string; chatId?: string; restored?: number }
export type Artifact = {
  slug: string
  title: string
  type: ArtifactType
  // A code artifact's language, lowercase, such as python.
  language?: string
  description: string
  createdAt: string
  versions: ArtifactVersion[]
  // The space it belongs to, and its folder.
  spaceId: string
  dir: string
}

const DIR = 'artifacts'
const META = 'artifact.json'
export const MAX_TITLE = 80
export const MAX_DESCRIPTION = 200
// An artifact is one self-contained thing; this keeps a runaway one from filling the disk or the panel.
export const MAX_CONTENT_BYTES = 2_000_000
const MAX_EDITS = 50

export const oneLine = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim()

export const slugOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

// A code file's extension by its language; anything else is .txt.
const CODE_EXTENSIONS: Record<string, string> = {
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  html: 'html',
  css: 'css',
  json: 'json',
  rust: 'rs',
  go: 'go',
  java: 'java',
  kotlin: 'kt',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  'c#': 'cs',
  ruby: 'rb',
  php: 'php',
  shell: 'sh',
  bash: 'sh',
  sh: 'sh',
  zsh: 'sh',
  sql: 'sql',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  markdown: 'md',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala',
  elixir: 'ex',
  haskell: 'hs',
}

export const extensionOf = (artifact: Pick<Artifact, 'type' | 'language'>) =>
  artifact.type === 'code'
    ? (CODE_EXTENSIONS[artifact.language ?? ''] ?? 'txt')
    : { html: 'html', react: 'jsx', svg: 'svg', mermaid: 'mmd', markdown: 'md' }[artifact.type]

export const MIME: Record<string, string> = { html: 'text/html', svg: 'image/svg+xml', md: 'text/markdown', json: 'application/json' }

export const fileOf = (artifact: Pick<Artifact, 'type' | 'language'>, version: number) => `v${version}.${extensionOf(artifact)}`
export const pathOf = (artifact: Artifact, version = latest(artifact).n) => join(artifact.dir, fileOf(artifact, version))

/** A chat's space: the top of its chain (workers share their space's artifacts). Home keeps no files, so none. */
export function spaceOf(host: ExtensionHost, chatId: string): ChatDetail | undefined {
  let chat = host.chat(chatId)
  for (let i = 0; chat?.parentId !== undefined && i < 32; i++) chat = host.chat(chat.parentId)
  return chat && !chat.extension ? chat : undefined
}

export const needSpace = (host: ExtensionHost, chatId: string) => {
  const space = spaceOf(host, chatId)
  if (!space) throw new Error('Artifacts belong to a space, and this chat keeps none; make it in a space')
  return space
}

const rootOf = (host: ExtensionHost, spaceId: string) => join(host.chatStorage(spaceId).dir, DIR)

const typeOf = (value: unknown): ArtifactType | undefined => (TYPES.includes(value as ArtifactType) ? (value as ArtifactType) : undefined)

function readMeta(dir: string, slug: string, spaceId: string): Artifact | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, META), 'utf8')) as Partial<Artifact>
    // Artifacts from before types were all HTML pages (with a kind, such as chart, that's no longer shown).
    const type = typeOf(meta.type) ?? 'html'
    const language = type === 'code' && typeof meta.language === 'string' ? meta.language : undefined
    const shape = { type, ...(language && { language }) }
    const versions = (Array.isArray(meta.versions) ? meta.versions : []).filter(
      (v): v is ArtifactVersion => typeof v?.n === 'number' && existsSync(join(dir, fileOf(shape, v.n))),
    )
    if (!versions.length) return undefined
    return {
      slug,
      title: oneLine(meta.title) || slug,
      ...shape,
      description: oneLine(meta.description),
      createdAt: String(meta.createdAt ?? versions[0]!.at),
      versions: versions.sort((a, b) => a.n - b.n),
      spaceId,
      dir,
    }
  } catch {
    return undefined
  }
}

export const latest = (artifact: Artifact) => artifact.versions.at(-1)!

/** A space's artifacts, the latest changed first. */
export function artifactsIn(host: ExtensionHost, spaceId: string): Artifact[] {
  const root = rootOf(host, spaceId)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap((entry) => readMeta(join(root, entry.name), entry.name, spaceId) ?? [])
    .sort((a, b) => latest(b).at.localeCompare(latest(a).at) || a.title.localeCompare(b.title))
}

export const contentOf = (artifact: Artifact, version = latest(artifact).n) => readFileSync(pathOf(artifact, version), 'utf8')

const writeMeta = (host: ExtensionHost, artifact: Artifact) => {
  const { title, type, language, description, createdAt, versions } = artifact
  const meta = { title, type, ...(language && { language }), description, createdAt, versions }
  host.chatStorage(artifact.spaceId).write(`${DIR}/${artifact.slug}/${META}`, `${JSON.stringify(meta, null, 2)}\n`)
}

const checkContent = (content: unknown) => {
  if (typeof content !== 'string' || !content.trim()) throw new Error('An artifact needs its content')
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new Error(`An artifact is at most ${MAX_CONTENT_BYTES / 1_000_000} MB`)
  return content
}

export const checkTitle = (input: unknown) => {
  const title = oneLine(input)
  if (!title) throw new Error('An artifact needs a title')
  if (title.length > MAX_TITLE) throw new Error(`An artifact's title is at most ${MAX_TITLE} characters`)
  return title
}

/** The artifact a tool names, by its name (slug) or its title, letter case aside. */
export function findArtifact(artifacts: Artifact[], name: unknown): Artifact {
  const wanted = oneLine(name).toLowerCase()
  const bySlug = artifacts.find((a) => a.slug === wanted)
  if (bySlug) return bySlug
  // Titles can repeat; a title that more than one has is refused rather than guessed.
  const titled = artifacts.filter((a) => a.title.toLowerCase() === wanted)
  if (titled.length > 1) throw new Error(`${titled.length} artifacts are titled "${oneLine(name)}": name one of ${titled.map((a) => a.slug).sort().join(', ')}`)
  const found = titled[0] ?? artifacts.find((a) => a.slug === slugOf(wanted))
  if (!found) throw new Error(`No artifact "${oneLine(name)}" in this space; list_artifacts lists them`)
  return found
}

export type CreateInput = { title?: unknown; type?: unknown; content?: unknown; html?: unknown; language?: unknown; description?: unknown }

export function createArtifact(host: ExtensionHost, chatId: string, input: CreateInput, now = new Date()): Artifact {
  const space = needSpace(host, chatId)
  const title = checkTitle(input.title)
  const description = oneLine(input.description)
  if (description.length > MAX_DESCRIPTION) throw new Error(`An artifact's description is one line of at most ${MAX_DESCRIPTION} characters`)
  // html: the content's name when every artifact was a page.
  const content = checkContent(input.content ?? input.html)
  const type = input.type === undefined ? 'html' : typeOf(oneLine(input.type).toLowerCase())
  if (!type) throw new Error(`An artifact's type is one of ${TYPES.join(', ')}`)
  const language = type === 'code' ? oneLine(input.language).toLowerCase().slice(0, 30) || 'text' : undefined
  // Two artifacts may share a title; each gets a folder of its own.
  const taken = new Set(artifactsIn(host, space.id).map((a) => a.slug))
  const root = rootOf(host, space.id)
  const base = slugOf(title) || 'artifact'
  let slug = base
  for (let i = 2; taken.has(slug) || existsSync(join(root, slug)); i++) slug = `${base}-${i}`
  const at = now.toISOString()
  const artifact: Artifact = {
    slug,
    title,
    type,
    ...(language && { language }),
    description,
    createdAt: at,
    versions: [{ n: 1, at, chatId }],
    spaceId: space.id,
    dir: join(root, slug),
  }
  host.chatStorage(space.id).write(`${DIR}/${slug}/${fileOf(artifact, 1)}`, content)
  writeMeta(host, artifact)
  return artifact
}

export type Edit = { old?: unknown; new?: unknown }

/** The content with each edit's old text, found exactly once, replaced by its new text, in order. */
export function applyEdits(content: string, edits: unknown): string {
  if (!Array.isArray(edits) || !edits.length) throw new Error('edits is a list of { old, new } replacements')
  if (edits.length > MAX_EDITS) throw new Error(`At most ${MAX_EDITS} edits at once; send the whole content instead`)
  return (edits as Edit[]).reduce((text, edit, i) => {
    const before = edit?.old
    const after = edit?.new ?? ''
    if (typeof before !== 'string' || !before) throw new Error(`Edit ${i + 1} needs its old text`)
    if (typeof after !== 'string') throw new Error(`Edit ${i + 1}’s new text must be text`)
    const at = text.indexOf(before)
    if (at < 0) throw new Error(`Edit ${i + 1}’s old text isn’t in the artifact; read_artifact shows it as it is`)
    if (text.indexOf(before, at + 1) >= 0) throw new Error(`Edit ${i + 1}’s old text appears more than once; include more around it`)
    return text.slice(0, at) + after + text.slice(at + before.length)
  }, content)
}

/** Saves content as the artifact's next version. */
export function addVersion(
  host: ExtensionHost,
  artifact: Artifact,
  content: unknown,
  version: Omit<ArtifactVersion, 'n' | 'at' | 'change'> & { change?: unknown },
  now = new Date(),
): Artifact {
  const checked = checkContent(content)
  const n = latest(artifact).n + 1
  const change = oneLine(version.change).slice(0, MAX_DESCRIPTION)
  host.chatStorage(artifact.spaceId).write(`${DIR}/${artifact.slug}/${fileOf(artifact, n)}`, checked)
  const entry: ArtifactVersion = {
    n,
    at: now.toISOString(),
    ...(change && { change }),
    ...(version.chatId && { chatId: version.chatId }),
    ...(version.restored !== undefined && { restored: version.restored }),
  }
  const updated = { ...artifact, versions: [...artifact.versions, entry] }
  writeMeta(host, updated)
  return updated
}

export type UpdateInput = { artifact?: unknown; content?: unknown; html?: unknown; edits?: unknown; change?: unknown }

export function updateArtifact(host: ExtensionHost, chatId: string, input: UpdateInput, now = new Date()): Artifact {
  const space = needSpace(host, chatId)
  const artifact = findArtifact(artifactsIn(host, space.id), input.artifact)
  const whole = input.content ?? input.html
  if (whole !== undefined && input.edits !== undefined) throw new Error('Send either content or edits, not both')
  const content = whole ?? applyEdits(contentOf(artifact), input.edits)
  if (content === contentOf(artifact)) throw new Error('That is the same as its latest version; nothing to save')
  return addVersion(host, artifact, content, { change: input.change, chatId }, now)
}

export function renameArtifact(host: ExtensionHost, artifact: Artifact, title: unknown): Artifact {
  const renamed = { ...artifact, title: checkTitle(title) }
  writeMeta(host, renamed)
  return renamed
}

export function removeArtifact(artifact: Artifact) {
  rmSync(artifact.dir, { recursive: true, force: true })
}
