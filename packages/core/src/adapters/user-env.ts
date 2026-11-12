// The user's own environment and home folder, where an adapter finds an engine's default login when no Kothar account
// is picked (CLAUDE_CONFIG_DIR, CODEX_HOME, ~/.pi/agent and so on). Each adapter takes one, so tests pass their own
// instead of changing process.env.
import { homedir } from 'node:os'

export type UserEnv = {
  env: Readonly<Record<string, string | undefined>>
  home: string
}

/** Kothar's own process: its environment (read live) and the OS's home folder. */
export const processUserEnv = (): UserEnv => ({ env: process.env, home: homedir() })
