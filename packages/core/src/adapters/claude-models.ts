// Claude Code has no list command, so this is its catalog; pi lists the same ids for Anthropic.
export const CLAUDE_MODELS = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
]

export function claudeLabel(id: string) {
  const match = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/)
  if (!match) return undefined
  const [, family = '', major, minor] = match
  return `${family[0]?.toUpperCase()}${family.slice(1)} ${major}${minor === undefined ? '' : `.${minor}`}`
}
