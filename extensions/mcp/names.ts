// What a relayed tool is called in Kothar's MCP server: <server id>__<tool>. Engines put Kothar's server's own prefix
// before it (Claude Code and Codex: mcp__kothar__, OpenCode: kothar_) and most cap a tool's name at 64 characters, so
// ours stays within 48: a longer one is cut and ends in a short hash of the whole, so two long names stay apart.
import { createHash } from 'node:crypto'

export const MAX_TOOL_NAME = 48
export const SEPARATOR = '__'

const clean = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, '_')

export function relayedName(serverId: string, tool: string) {
  const whole = `${clean(serverId)}${SEPARATOR}${clean(tool)}`
  if (whole.length <= MAX_TOOL_NAME) return whole
  const hash = createHash('sha256').update(`${serverId}\0${tool}`).digest('hex').slice(0, 6)
  return `${whole.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`
}
