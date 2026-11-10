// SKILL.md, as the open Agent Skills format has it: YAML front matter with at least name and description, then the
// instructions in Markdown. Only the front matter's top-level scalars are read, by a small parser that covers what skill
// files use (plain, quoted and block scalars); nested maps such as metadata are skipped.

export const MAX_NAME = 64
export const MAX_DESCRIPTION = 1024

export type SkillFile = { name: string; description: string; fields: Record<string, string>; body: string }

const unquote = (value: string) => {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\nt])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  return value
}

// Drops a trailing " # comment" from a plain (unquoted) scalar.
const uncomment = (value: string) => (/^["']/.test(value) ? value : value.replace(/\s+#.*$/, ''))

export function frontMatter(yaml: string): Record<string, string> {
  const lines = yaml.split(/\r?\n/)
  const fields: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*)|\s*)$/.exec(lines[i]!)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const raw = (match[2] ?? '').trim()
    // The lines under the key: indented, or blank.
    const rest: string[] = []
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || (lines[i + 1]!.trim() === '' && i + 2 < lines.length))) {
      rest.push(lines[++i]!)
    }
    while (rest.length && rest.at(-1)!.trim() === '') rest.pop()
    const block = /^([|>])[+-]?\d*$/.exec(raw)
    if (block) {
      const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length))
      const text = rest.map((l) => l.slice(indent))
      fields[key] = (block[1] === '|' ? text.join('\n') : text.join(' ').replace(/ {2,}/g, ' ')).trim()
    } else if (raw === '') {
      // A nested map or list (metadata, allowed-tools as a list): not a scalar.
      if (rest.some((l) => /^\s+[A-Za-z0-9_-]+:|^\s+- /.test(l))) continue
      fields[key] = rest.map((l) => l.trim()).join(' ')
    } else {
      const quoted = /^["']/.test(raw)
      fields[key] = quoted ? unquote([raw, ...rest.map((l) => l.trim())].join(' ')) : [uncomment(raw), ...rest.map((l) => l.trim())].join(' ')
    }
  }
  return fields
}

// The parts of a SKILL.md, or why it isn't one.
export function parseSkill(text: string): SkillFile | { error: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { error: 'its SKILL.md has no front matter (--- name and description ---)' }
  const fields = frontMatter(match[1]!)
  const name = (fields.name ?? '').trim()
  const description = (fields.description ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return { error: 'its SKILL.md has no name' }
  if (!description) return { error: 'its SKILL.md has no description' }
  if (description.length > MAX_DESCRIPTION) return { error: `its description is over ${MAX_DESCRIPTION} characters` }
  return { name, description, fields, body: text.slice(match[0].length) }
}

// The folder name a skill is kept under and agents call it by: its name in lowercase letters, digits and dashes, as
// the format asks names to be. Empty if nothing is left.
export const skillId = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
    .replace(/-+$/, '')

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// A new SKILL.md. Values are quoted so a colon or # in them stays text.
export const skillText = (name: string, description: string, body: string) =>
  `---\nname: ${skillId(name)}\ndescription: ${JSON.stringify(oneLine(description))}\n---\n\n${body.replace(/^\n+/, '').replace(/\s*$/, '\n')}`
