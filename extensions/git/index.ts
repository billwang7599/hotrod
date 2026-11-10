import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { ChatDetail, Checkout, Extension, ExtensionHost, ExtensionListItem, ExtensionTone, ExtensionValues, ExtensionView } from '@kothar/extension-api'
import { cleanupCheckout } from './cleanup.ts'

// The Changes tab shows each git folder of a space as its agents left it, and a note follows a turn that
// changed files. Agents already use git and gh through their shell, so this adds no tools and no buttons that change
// anything. The one change it makes is its cleanup: a checkout whose branch is merged goes (cleanup.ts). Every git and
// gh call goes through the Machine (host.run).

export const PANEL = 'changes'
const GIT_TIMEOUT_MS = 30_000
const GH_TIMEOUT_MS = 15_000
// gh asks GitHub, so a PR's status is kept this long between draws, unless the user refreshes or a turn ends.
export const PR_TTL_MS = 60_000
const DIFF_MAX_LINES = 800
// A group lists at most this many files; a build folder an agent forgot to ignore can hold thousands.
export const FILES_MAX = 200
// While a turn runs, the tab is drawn again at most this often after the agent's shell commands and edits.
export const LIVE_REFRESH_MS = 3000

type Run = ExtensionHost['run']

export type FileChange = { path: string; added?: number; removed?: number; binary?: boolean; untracked?: boolean }

export type PrStatus = {
  number: number
  title: string
  state: string
  url: string
  checks?: 'passing' | 'failing' | 'running'
}

// One git folder of a space: its checkout in the work folder, or the folder itself before the first message.
type Target = { folder: string; path: string; checkout?: Checkout }

export type RepoState = {
  target: Target
  branch?: string
  // The commit checked out when no branch is (branch is then HEAD).
  detached?: string
  upstream?: string
  ahead?: number
  behind?: number
  // What committed changes are counted against: the branch the checkout was made from, else the default branch.
  base?: string
  committed: FileChange[]
  uncommitted: FileChange[]
  pr?: PrStatus
  error?: string
}

async function git(run: Run, cwd: string, args: string[], ok = [0]) {
  const result = await run('git', ['-C', cwd, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
  if (!ok.includes(result.code ?? -1)) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
  return result.stdout
}

const tryGit = (run: Run, cwd: string, args: string[]) => git(run, cwd, args).then((out) => out.trim(), () => undefined)

export function parseNumstat(out: string): FileChange[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added = '', removed = '', ...rest] = line.split('\t')
      const path = rest.join('\t')
      return added === '-' ? { path, binary: true } : { path, added: Number(added), removed: Number(removed) }
    })
}

export function checksOf(rollup: unknown): PrStatus['checks'] {
  if (!Array.isArray(rollup) || !rollup.length) return undefined
  const states = rollup.map((c) => String(c?.conclusion || c?.state || c?.status || '').toUpperCase())
  if (states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(s))) {
    return 'failing'
  }
  if (states.some((s) => !['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED'].includes(s))) return 'running'
  return 'passing'
}

export function targetsOf(host: ExtensionHost, chatId: string): Target[] {
  const space = host.space(chatId)
  if (!space) return []
  // A checkout the cleanup removed stays in the space's record until its next message makes a new one. The Machine is
  // this computer for now, so the file system can tell.
  const checkouts = space.checkouts
    .filter((c) => existsSync(c.path))
    .map((checkout) => ({ folder: checkout.folder, path: checkout.path, checkout }))
  const waiting = space.folders
    .filter((f) => f.git && !checkouts.some((c) => c.folder === f.path))
    .map((f) => ({ folder: f.path, path: f.path }))
  return [...checkouts, ...waiting]
}

async function defaultBranch(run: Run, cwd: string) {
  const head = await tryGit(run, cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head) return head
  for (const name of ['main', 'master']) {
    if (await tryGit(run, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name
  }
  return undefined
}

export async function prOf(run: Run, cwd: string, branch: string): Promise<PrStatus | undefined> {
  try {
    const fields = 'number,title,state,url,statusCheckRollup'
    const result = await run('gh', ['pr', 'view', branch, '--json', fields], { cwd, timeoutMs: GH_TIMEOUT_MS })
    if (result.code !== 0) return undefined
    const pr = JSON.parse(result.stdout)
    if (typeof pr?.number !== 'number') return undefined
    const checks = checksOf(pr.statusCheckRollup)
    const { number, title = '', state = '', url = '' } = pr
    return { number, title: String(title), state: String(state), url: String(url), ...(checks && { checks }) }
  } catch {
    // No gh, not signed in, no network: the tab just shows no PR.
    return undefined
  }
}

// git's own words for a folder that isn't a repo, made plain.
export function errorText(message: string, path: string) {
  if (/not a git repository/i.test(message)) return `Not a git repository: ${path}`
  return message.replace(/^fatal: /, '')
}

// The branch checked out. A repo with no commits yet still has one (unborn), which rev-parse can't name.
async function branchOf(run: Run, path: string) {
  const named = await tryGit(run, path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (named) return named
  const unborn = await tryGit(run, path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (unborn) return unborn
  // Neither: say why, in git's words.
  return (await git(run, path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

export async function repoState(run: Run, target: Target, pr?: (branch: string) => Promise<PrStatus | undefined>) {
  const state: RepoState = { target, committed: [], uncommitted: [] }
  const { path } = target
  // The user's folder was moved or deleted. The Machine is this computer for now, so the file system can tell.
  if (!existsSync(path)) return { ...state, error: `Folder not found: ${path}` }
  try {
    state.branch = await branchOf(run, path)
    // Reads that don't depend on each other run together, so a big repo's tab waits for the slowest, not the sum.
    const [upstream, hasHead, defaultBase] = await Promise.all([
      tryGit(run, path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
      tryGit(run, path, ['rev-parse', '--verify', '--quiet', 'HEAD']),
      defaultBranch(run, path),
    ])
    if (state.branch === 'HEAD' && hasHead) state.detached = hasHead.slice(0, 7)
    state.upstream = upstream
    if (state.upstream) {
      const counts = await tryGit(run, path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
      const [behind, ahead] = (counts ?? '').split(/\s+/).map(Number)
      if (Number.isFinite(ahead) && Number.isFinite(behind)) Object.assign(state, { ahead, behind })
    }
    const from = target.checkout?.from
    const base = from && from !== state.branch ? from : defaultBase
    const forkPoint =
      hasHead && base && base !== state.branch ? await tryGit(run, path, ['merge-base', base, 'HEAD']) : undefined
    const [committed, tracked, untracked, prStatus] = await Promise.all([
      base && forkPoint ? git(run, path, ['diff', '--numstat', '--no-renames', forkPoint, 'HEAD']) : undefined,
      hasHead ? git(run, path, ['diff', '--numstat', '--no-renames', 'HEAD']) : '',
      git(run, path, ['ls-files', '--others', '--exclude-standard']),
      pr && state.branch && state.branch !== 'HEAD' ? pr(state.branch) : undefined,
    ])
    if (base && committed !== undefined) {
      state.base = base
      state.committed = parseNumstat(committed)
    }
    const added = untracked
      .split('\n')
      .filter(Boolean)
      .map((file) => ({ path: file, untracked: true }))
    state.uncommitted = [...parseNumstat(tracked), ...added]
    if (prStatus) state.pr = prStatus
  } catch (error) {
    state.error = errorText(error instanceof Error ? error.message : String(error), path)
  }
  return state
}

export type Group = 'uncommitted' | 'committed'
type Selected = { path: string; group: Group; file: string }

export async function diffOf(run: Run, state: RepoState, group: Group, file: string) {
  const { path } = state.target
  const change = state[group].find((f) => f.path === file)
  if (!change) return ''
  if (change.untracked) return git(run, path, ['diff', '--no-index', '--', '/dev/null', file], [0, 1])
  if (group === 'uncommitted') return git(run, path, ['diff', '--no-renames', 'HEAD', '--', file])
  const forkPoint = (await git(run, path, ['merge-base', state.base!, 'HEAD'])).trim()
  return git(run, path, ['diff', '--no-renames', forkPoint, 'HEAD', '--', file])
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function fileItem(state: RepoState, group: Group, file: FileChange, selected?: Selected): ExtensionListItem {
  const counts = file.binary ? 'binary' : file.untracked ? 'new' : `+${file.added} −${file.removed}`
  const open = selected?.path === state.target.path && selected.group === group && selected.file === file.path
  return {
    key: `${group}:${file.path}`,
    label: file.path,
    mono: true,
    detail: counts,
    selected: open,
    action: { name: 'open', value: { path: state.target.path, group, file: file.path } },
    hint: open ? 'Hide the diff' : 'Show the diff',
  }
}

const PR_TONES: Record<string, ExtensionTone> = { OPEN: 'success', MERGED: 'accent', CLOSED: 'faint' }
const CHECK_TONES: Record<NonNullable<PrStatus['checks']>, ExtensionTone> = {
  passing: 'success',
  failing: 'error',
  running: 'warning',
}

// A diff, or why it couldn't be read.
export type Diff = string | { error: string }

export function repoView(state: RepoState, selected?: Selected, diff?: Diff): ExtensionView {
  const { target } = state
  const title = basename(target.folder)
  if (state.error) {
    return { type: 'card', title, children: [{ type: 'text', text: state.error, tone: 'error', small: true }] }
  }
  const badges: NonNullable<ExtensionListItem['badges']> = []
  if (state.detached) {
    badges.push({ text: `detached at ${state.detached}`, tone: 'warning', hint: 'No branch is checked out' })
  } else if (state.branch) {
    const hint = target.checkout ? undefined : 'Not checked out yet: this is the folder itself'
    badges.push({ text: state.branch, tone: 'normal', ...(hint && { hint }) })
  }
  const { upstream, ahead, behind } = state
  if (upstream) {
    if (ahead) badges.push({ text: `↑${ahead}`, hint: `${plural(ahead, 'commit')} not pushed to ${upstream}` })
    if (behind) {
      badges.push({ text: `↓${behind}`, tone: 'warning', hint: `${plural(behind, 'commit')} on ${upstream} not here` })
    }
  } else if (state.branch && state.branch !== 'HEAD') {
    badges.push({ text: 'Not pushed', tone: 'faint', hint: 'The branch has no upstream' })
  }
  const children: ExtensionView[] = []
  if (state.pr) {
    const { pr } = state
    children.push({
      type: 'row',
      children: [
        { type: 'link', text: `#${pr.number} ${pr.title}`, url: pr.url },
        { type: 'badge', text: pr.state.toLowerCase(), tone: PR_TONES[pr.state] ?? 'muted' },
        ...(pr.checks ? [{ type: 'badge' as const, text: `CI ${pr.checks}`, tone: CHECK_TONES[pr.checks] }] : []),
      ],
    })
  }
  const group = (name: Group, heading: string, files: FileChange[]) => {
    if (!files.length) return
    children.push({ type: 'text', text: heading, tone: 'muted', small: true })
    const shown = files.slice(0, FILES_MAX)
    children.push({ type: 'list', label: heading, items: shown.map((f) => fileItem(state, name, f, selected)) })
    if (files.length > shown.length) {
      children.push({ type: 'text', text: `and ${plural(files.length - shown.length, 'more file')}`, tone: 'muted', small: true })
    }
    const open = selected?.path === target.path && selected.group === name
    if (!open || diff === undefined || !shown.some((f) => f.path === selected.file)) return
    if (typeof diff !== 'string') {
      children.push({ type: 'text', text: diff.error, tone: 'error', small: true })
      return
    }
    const code: ExtensionView = { type: 'code', language: 'diff', text: diff, maxLines: DIFF_MAX_LINES }
    children.push(diff.trim() ? code : { type: 'empty', text: 'No diff' })
  }
  group('uncommitted', 'Uncommitted', state.uncommitted)
  group('committed', `Committed since ${state.base}`, state.committed)
  if (!state.uncommitted.length && !state.committed.length) children.push({ type: 'empty', text: 'No changes' })
  return { type: 'card', title, badges, children }
}

// path → numstat line, and HEAD: enough to tell which files a turn touched.
type Snapshot = { head?: string; files: Map<string, string> }

async function snapshot(run: Run, path: string): Promise<Snapshot> {
  const head = await tryGit(run, path, ['rev-parse', 'HEAD'])
  const files = new Map<string, string>()
  const tracked = head ? await git(run, path, ['diff', '--numstat', '--no-renames', 'HEAD']).catch(() => '') : ''
  for (const f of parseNumstat(tracked)) files.set(f.path, `${f.added}/${f.removed}/${f.binary ?? ''}`)
  const untracked = await git(run, path, ['ls-files', '--others', '--exclude-standard']).catch(() => '')
  for (const file of untracked.split('\n').filter(Boolean)) files.set(file, 'new')
  return { ...(head && { head }), files }
}

async function changedSince(run: Run, path: string, before: Snapshot, after: Snapshot) {
  const changed = new Set<string>()
  if (before.head && after.head && before.head !== after.head) {
    const range = [before.head, after.head]
    const committed = await git(run, path, ['diff', '--name-only', '--no-renames', ...range]).catch(() => '')
    committed.split('\n').filter(Boolean).forEach((file) => changed.add(file))
  }
  for (const [file, line] of after.files) if (before.files.get(file) !== line) changed.add(file)
  for (const file of before.files.keys()) if (!after.files.has(file)) changed.add(file)
  return changed.size
}

export function noteText(counts: { branch: string; files: number }[]) {
  const changed = counts.filter((c) => c.files > 0)
  if (!changed.length) return undefined
  const [first, ...rest] = changed
  const others = rest.map((c) => `${c.files} on ${c.branch}`)
  return [`${plural(first!.files, 'file')} changed on ${first!.branch}`, ...others].join(', ')
}

export function createGitExtension(options: { now?: () => number } = {}): Extension {
  const now = options.now ?? Date.now
  const selected = new Map<string, Selected>()
  const prs = new Map<string, { at: number; status?: PrStatus }>()
  const before = new Map<string, Map<string, Snapshot>>()
  // Per chat, what its tab last showed: opening a file's diff draws from it instead of reading every repo again.
  const shownStates = new Map<string, RepoState[]>()
  const reuse = new Set<string>()
  // Per chat, its running shell commands and edits, and when its tab was last drawn for one.
  const writing = new Map<string, Set<string>>()
  const live = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout> }>()

  const prFor = (run: Run, path: string) => async (branch: string) => {
    const key = `${path}\n${branch}`
    const cached = prs.get(key)
    if (cached && now() - cached.at < PR_TTL_MS) return cached.status
    const status = await prOf(run, path, branch)
    prs.set(key, { at: now(), ...(status && { status }) })
    return status
  }
  const forget = (host: ExtensionHost, chatId: string) => {
    for (const target of targetsOf(host, chatId)) {
      for (const key of prs.keys()) if (key.startsWith(`${target.path}\n`)) prs.delete(key)
    }
  }
  // Removes the space's checkouts whose branch is merged, once nothing in the space runs.
  const sweeping = new Set<string>()
  const sweep = async (host: ExtensionHost, chat: ChatDetail) => {
    const space = host.space(chat.id) ?? (chat.parentId === undefined ? undefined : host.space(chat.parentId))
    if (!space || sweeping.has(space.id)) return
    const idle = () => host.chats().every((c) => (c.id !== space.id && c.parentId !== space.id) || c.status === 'idle')
    if (!idle()) return
    sweeping.add(space.id)
    try {
      for (const checkout of space.checkouts) {
        if (!existsSync(checkout.path)) continue
        // One checkout git won't remove doesn't stop the others, or the turn's hook.
        const result = await cleanupCheckout(host.run, checkout, space.workDir, idle).catch(() => undefined)
        if (!result?.removed) continue
        const where = space.checkouts.length > 1 ? ` in ${basename(checkout.folder)}` : ''
        const kept = result.branchKept ? `; its branch ${result.branch} stays, since git wouldn’t delete it` : ''
        const text = `Removed the checkout of ${result.branch}${where}: ${result.reason}${kept}`
        if (host.chat(space.id)) host.note(space.id, text, { panel: PANEL })
        forget(host, space.id)
        host.refresh(space.id)
      }
    } finally {
      sweeping.delete(space.id)
    }
  }
  const cleansUp = (values: ExtensionValues) => values.cleanup === true

  // A turn of the space or one of its workers shows in the space's tab and its own.
  const refreshAround = (host: ExtensionHost, chat: ChatDetail) => {
    host.refresh(chat.id)
    if (chat.parentId && host.chat(chat.parentId)) host.refresh(chat.parentId)
  }
  // An agent's commit or edit shows during a long turn too, not only once it ends: drawn at once, then at most every
  // LIVE_REFRESH_MS, with the last one always drawn. host.refresh draws only tabs that are open.
  const refreshLive = (host: ExtensionHost, chat: ChatDetail) => {
    const last = live.get(chat.id) ?? { at: -Infinity }
    live.set(chat.id, last)
    if (last.timer) return
    const wait = last.at + LIVE_REFRESH_MS - now()
    const draw = () => {
      delete last.timer
      last.at = now()
      if (host.chat(chat.id)) refreshAround(host, chat)
    }
    if (wait <= 0) draw()
    else last.timer = setTimeout(draw, wait)
  }
  const stopLive = (chatId: string) => {
    clearTimeout(live.get(chatId)?.timer)
    live.delete(chatId)
    writing.delete(chatId)
  }

  return {
    id: 'git',
    name: 'Git',
    description:
      'A Changes tab for spaces with git folders: each checkout’s branch, how far it is from its upstream, the files ' +
      'changed with their diffs, and its pull request if gh is signed in. Read-only.',
    enabledByDefault: false,
    settings: [
      {
        key: 'cleanup',
        label: 'Remove merged checkouts',
        description:
          'After a turn, a space’s checkout goes, with its local branch, once the branch’s pull request is merged or ' +
          'the branch is merged into the default branch and deleted on the remote. Never your own checkout, one with ' +
          'uncommitted changes, or one in use by a running chat. The next message makes a fresh checkout.',
        type: 'boolean',
        default: true,
      },
    ],
    panels: [
      {
        id: PANEL,
        title: 'Changes',
        shown: (chat, { host }) => !chat.extension && targetsOf(host, chat.id).length > 0,
        async render(chat, { host }) {
          const targets = targetsOf(host, chat.id)
          const kept = reuse.delete(chat.id) ? shownStates.get(chat.id) : undefined
          const same = kept?.length === targets.length && kept.every((s, i) => s.target.path === targets[i]!.path)
          const states =
            kept && same ? kept : await Promise.all(targets.map((t) => repoState(host.run, t, prFor(host.run, t.path))))
          shownStates.set(chat.id, states)
          let pick = selected.get(chat.id)
          const picked = pick && states.find((s) => s.target.path === pick!.path)
          // A file that left its group (committed, reverted, its checkout gone) closes.
          if (pick && !picked?.[pick.group].some((f) => f.path === pick!.file)) {
            selected.delete(chat.id)
            pick = undefined
          }
          const diff: Diff | undefined =
            picked && pick
              ? await diffOf(host.run, picked, pick.group, pick.file).catch((e) => ({
                  error: `Couldn’t read the diff: ${errorText(String(e?.message ?? e), picked.target.path)}`,
                }))
              : undefined
          const refresh: ExtensionView = {
            type: 'button',
            label: 'Refresh',
            variant: 'ghost',
            action: { name: 'refresh' },
            hint: 'Look at git and the pull requests again',
          }
          return {
            type: 'stack',
            gap: 'loose',
            children: [
              { type: 'row', justify: 'end', children: [refresh] },
              ...states.map((s) => repoView(s, pick, s === picked ? diff : undefined)),
            ],
          }
        },
        async onAction(action, chat, { host, values }) {
          if (action.name === 'refresh') {
            forget(host, chat.id)
            if (cleansUp(values)) await sweep(host, chat)
            return
          }
          if (action.name !== 'open') return
          const value = action.value as { path?: unknown; group?: unknown; file?: unknown } | null
          const { path, group, file } = value ?? {}
          const known = group === 'uncommitted' || group === 'committed'
          if (typeof path !== 'string' || typeof file !== 'string' || !known) return
          const open = selected.get(chat.id)
          const same = open?.path === path && open.group === group && open.file === file
          if (same) selected.delete(chat.id)
          else selected.set(chat.id, { path, group, file })
          reuse.add(chat.id)
        },
      },
    ],
    async onTurnStarted({ chat }, { host }) {
      if (chat.extension || chat.worker) return
      const shots = new Map<string, Snapshot>()
      for (const target of targetsOf(host, chat.id)) shots.set(target.path, await snapshot(host.run, target.path))
      before.set(chat.id, shots)
    },
    onEvent(chat, event, { host }) {
      if (chat.extension) return
      if (event.type === 'tool.started' && (event.kind === 'shell' || event.kind === 'edit')) {
        const ids = writing.get(chat.id) ?? new Set()
        writing.set(chat.id, ids.add(event.toolId))
      } else if (event.type === 'tool.completed' && writing.get(chat.id)?.delete(event.toolId)) {
        refreshLive(host, chat)
      }
    },
    async onTurnCompleted({ chat }, { host, values }) {
      if (chat.extension) return
      stopLive(chat.id)
      const shots = before.get(chat.id)
      before.delete(chat.id)
      forget(host, chat.id)
      if (!chat.worker && shots) {
        const counts: { branch: string; files: number }[] = []
        for (const target of targetsOf(host, chat.id)) {
          const after = await snapshot(host.run, target.path)
          // A checkout made during the turn started clean, from its folder's last commit.
          const head = shots.get(target.folder)?.head
          const start = shots.get(target.path) ?? { ...(head && { head }), files: new Map() }
          const files = await changedSince(host.run, target.path, start, after)
          const current = await tryGit(host.run, target.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
          counts.push({ branch: current ?? target.checkout?.branch ?? basename(target.folder), files })
        }
        const text = noteText(counts)
        if (text && host.chat(chat.id)) host.note(chat.id, text, { panel: PANEL })
      }
      if (host.chat(chat.id)) refreshAround(host, chat)
      else if (chat.parentId && host.chat(chat.parentId)) host.refresh(chat.parentId)
      if (cleansUp(values)) await sweep(host, chat)
    },
    onChatRemoved(chat) {
      selected.delete(chat.id)
      before.delete(chat.id)
      shownStates.delete(chat.id)
      reuse.delete(chat.id)
      stopLive(chat.id)
    },
    onStop() {
      for (const chatId of [...live.keys()]) stopLive(chatId)
    },
  }
}

export default createGitExtension()
