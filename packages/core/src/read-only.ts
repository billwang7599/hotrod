// Which actions only read, for the "Read anywhere without asking" switch. Kept on its own so the permission policy can
// move into an extension later. Everything here is conservative: anything it can't prove is a plain read returns false,
// and the chat asks the user as before.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

// Reads change nothing, but these hold logins and keys, so reading them still asks.
const HOME_SECRETS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.config/gcloud',
  '.azure',
  '.kube',
  '.docker/config.json',
  'Library/Keychains',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.claude/.credentials.json',
  '.pi/agent/auth.json',
]
// Files with these names ask wherever they are.
const SECRET_NAME = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|\.credentials\.json)$/
const NOT_SECRET_NAME = /^\.env\.(?:example|sample|template|dist)$/

export type ReadContext = {
  // Where relative paths start.
  cwd: string
  home: string
  // Absolute paths that ask: a home secret, the garage's accounts folder.
  secrets: string[]
}

export const secretPathsOf = (home: string, garage: string) => [
  ...HOME_SECRETS.map((path) => join(home, path)),
  join(garage, 'accounts'),
]

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.replace(/\/?$/, sep))

const realOf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    // A path that doesn't exist yet: resolve the folder it would be in.
    const parent = dirname(path)
    return parent === path ? path : join(realOf(parent), basename(path))
  }
}

const secretName = (name: string) => SECRET_NAME.test(name) && !NOT_SECRET_NAME.test(name)

// True if reading this file could read a login or key.
export const isSecret = (path: string, context: ReadContext) => {
  const absolute = resolve(context.cwd, expandHome(path, context.home))
  const paths = [absolute, realOf(absolute)]
  const secrets = context.secrets.flatMap((secret) => [secret, realOf(secret)])
  return paths.some(
    (p) => secrets.some((secret) => within(p, secret)) || p.split(sep).some((segment) => secretName(segment)),
  )
}

// True if searching under this folder could read a login or key: it is one, or one lies inside it. A path may end in
// a glob (a search's file filter); a wildcard part starting with a dot, which could match .env, asks.
export const searchReachesSecret = (path: string, context: ReadContext): boolean => {
  const segments = path.split('/')
  const wild = segments.findIndex((segment) => /[*?[{]/.test(segment))
  if (wild >= 0) {
    if (segments.slice(wild).some((segment) => segment.startsWith('.') || secretName(segment))) return true
    return searchReachesSecret(segments.slice(0, wild).join('/') || (path.startsWith('/') ? '/' : '.'), context)
  }
  if (isSecret(path, context)) return true
  const absolute = resolve(context.cwd, expandHome(path, context.home))
  const paths = [absolute, realOf(absolute)]
  return context.secrets.some((secret) => paths.some((p) => within(secret, p) || within(realOf(secret), p)))
}

export const expandHome = (path: string, home: string) => path.replace(/^~(?=$|\/)/, home)

// A rough check for commands Kothar runs without parsing (sandboxed auto-run): does the text name a secret?
export const mentionsSecret = (command: string, context: ReadContext) => {
  const names = HOME_SECRETS.map((path) => path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
  const home = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\}|${escape(context.home)})/(?:${names.join('|')})(?=$|[/\\s'"])`)
  const named = /(?:^|[\s'"=/])(?:\.env(?!\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)?|id_(?:rsa|dsa|ecdsa|ed25519))(?=$|[\s'"/;|&)])/
  return home.test(command) || named.test(command) || context.secrets.some((secret) => command.includes(secret))
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// --- Shell parsing ---

type Word = { text: string; globbed: boolean; tilde: boolean }
type Token = { op: string } | { word: Word }

// Splits a command line into words and operators. Undefined for anything it doesn't fully understand: expansions,
// substitutions, here-docs, unbalanced quotes.
const tokenize = (command: string): Token[] | undefined => {
  const tokens: Token[] = []
  let word: Word | undefined
  const push = () => {
    if (word) tokens.push({ word })
    word = undefined
  }
  const add = (text: string, globbable = false) => {
    word ??= { text: '', globbed: false, tilde: false }
    word.text += text
    if (globbable && /[*?[]/.test(text)) word.globbed = true
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === ' ' || c === '\t') {
      push()
      continue
    }
    if (c === '\n') {
      push()
      tokens.push({ op: ';' })
      continue
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return
      add(command.slice(i + 1, end))
      i = end
      continue
    }
    if (c === '"') {
      let j = i + 1
      let text = ''
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!
        if (d === '$' || d === '`') return
        if (d === '\\') {
          const next = command[j + 1]
          if (next === undefined) return
          text += '"\\$`\n'.includes(next) ? next : d + next
          j++
          continue
        }
        text += d
      }
      if (j >= command.length) return
      add(text)
      i = j
      continue
    }
    if (c === '\\') {
      const next = command[i + 1]
      if (next === undefined || next === '\n') return
      add(next)
      i++
      continue
    }
    if (c === '$' || c === '`' || c === '{' || c === '}' || c === '(' || c === ')' || c === '!') return
    if (c === '#' && !word) break
    if ('|&;<>'.includes(c)) {
      // A redirect's file descriptor is the digits just before it, written as one word.
      const fd = word && /^\d+$/.test(word.text) && !word.globbed && '<>'.includes(c) ? word.text : ''
      if (fd) word = undefined
      else push()
      const two = command.slice(i, i + 2)
      const three = command.slice(i, i + 3)
      const op = ['&>>', '<<<', '<<-'].includes(three)
        ? three
        : ['||', '&&', '>>', '&>', '>&', '<<', '|&', ';;', '<&', '<>', '>|'].includes(two)
          ? two
          : c
      tokens.push({ op: fd + op })
      i += op.length - 1
      continue
    }
    if (c === '~' && !word) {
      word = { text: '~', globbed: false, tilde: true }
      continue
    }
    add(c, true)
  }
  push()
  return tokens
}

// Only redirects that throw output away or merge one output into the other are allowed.
const safeRedirect = (op: string, target: string) =>
  (['>', '1>', '2>', '&>', '>>', '1>>', '2>>', '&>>'].includes(op) && target === '/dev/null') ||
  (['>&', '1>&', '2>&'].includes(op) && (target === '1' || target === '2'))

type Simple = Word[]

// Splits tokens into simple commands joined by |, &&, || and ;. Undefined if any other operator is used.
const commandsOf = (tokens: Token[]): Simple[] | undefined => {
  const commands: Simple[] = [[]]
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if ('word' in token) {
      commands.at(-1)!.push(token.word)
      continue
    }
    if (['|', '&&', '||', ';'].includes(token.op)) {
      if (!commands.at(-1)!.length) return
      commands.push([])
      continue
    }
    const target = tokens[i + 1]
    if (!target || !('word' in target) || target.word.globbed || !safeRedirect(token.op, target.word.text)) return
    i++
  }
  if (!commands.at(-1)!.length) {
    // A trailing ; is fine; a trailing | or && is not.
    const before = tokens.at(-1)
    if (commands.length === 1 || !before || 'word' in before || before.op !== ';') return
    commands.pop()
  }
  return commands
}

// Each program's check gets its arguments and says whether they only read. It also lists the arguments that are
// paths, so they can be checked for secrets.
type Check = (args: string[]) => boolean

const noArg = (...bad: string[]): Check => (args) =>
  !args.some((arg) => bad.some((flag) => arg === flag || (flag.startsWith('--') && arg.startsWith(`${flag}=`))))

const any: Check = () => true

// Options that take a value in a separate word, so the value isn't mistaken for an operand.
const operands = (args: string[], valued: string[] = []) => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      out.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (valued.includes(arg)) i++
      continue
    }
    out.push(arg)
  }
  return out
}

const BRANCH_VALUED = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']
const BRANCH_FLAGS = new Set([
  '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '-l', '--list', '--show-current', '--no-color',
  '--color', '--column', '--no-column', '-i', '--ignore-case', '--omit-empty', ...BRANCH_VALUED,
])
const listing = (flags: Set<string>, valued: string[]): Check => (args) => {
  for (const arg of args) {
    if (!arg.startsWith('-')) continue
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (!flags.has(flag)) return false
  }
  // A name without --list creates a branch or tag.
  return !operands(args, valued).length || args.includes('-l') || args.includes('--list')
}

const TAG_FLAGS = new Set(['-l', '--list', '-n', '--sort', '--format', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--column', '--no-column', '-i', '--ignore-case'])

const GIT: Record<string, Check> = {
  status: any,
  log: noArg('--output'),
  show: noArg('--output'),
  diff: noArg('--output', '--ext-diff'),
  'rev-parse': any,
  'ls-files': any,
  'ls-tree': any,
  blame: any,
  'cat-file': any,
  describe: any,
  shortlog: any,
  'merge-base': any,
  'rev-list': any,
  'show-ref': noArg('-d', '--delete'),
  'name-rev': any,
  whatchanged: noArg('--output'),
  'count-objects': any,
  grep: noArg('-O', '--open-files-in-pager'),
  branch: listing(BRANCH_FLAGS, BRANCH_VALUED),
  tag: listing(TAG_FLAGS, ['--sort', '--format', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at']),
  remote: (args) =>
    args.every((arg) => arg === '-v' || arg === '--verbose') ||
    (args[0] === 'get-url' && args.length <= 3 && args.slice(1).every((a) => !a.startsWith('-') || a === '--all' || a === '--push')),
  reflog: (args) => !args.length || (args[0] === 'show' && noArg('--output')(args)) || args[0]?.startsWith('-') === true,
  stash: (args) => args[0] === 'list' || args[0] === 'show',
  worktree: (args) => args[0] === 'list',
  config: (args) =>
    args.length > 0 &&
    args.every((a) => a.startsWith('-') ? ['--get', '--get-all', '--get-regexp', '-l', '--list', '--show-origin', '--global', '--local', '--system', '--name-only', '-z', '--null'].includes(a) : true) &&
    args.some((a) => ['--get', '--get-all', '--get-regexp', '-l', '--list'].includes(a)),
}

const git: Check = (args) => {
  let i = 0
  // Global options: -C is a folder, --no-pager and friends change nothing. -c could set a command to run, so asks.
  for (; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-C') {
      i++
      continue
    }
    if (['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects'].includes(arg)) continue
    break
  }
  const sub = args[i]
  const check = sub === undefined ? undefined : GIT[sub]
  return !!check && check(args.slice(i + 1))
}

// sed only to print lines: `sed -n '1,20p' file`, `sed 5q`, `sed -n '/x/p'`.
const SED_SCRIPT = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?p|\d+q|\/[^/\\]*\/p)$/
const sed: Check = (args) => {
  let script: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (['-n', '-E', '-r', '--quiet', '--silent'].includes(arg)) continue
    if (arg === '-e') {
      if (script !== undefined || args[i + 1] === undefined) return false
      script = args[++i]
      continue
    }
    if (arg.startsWith('-')) return false
    script ??= arg
  }
  return script !== undefined && SED_SCRIPT.test(script)
}

const PROGRAMS: Record<string, Check> = {
  ls: any,
  cat: any,
  head: any,
  tail: any,
  wc: any,
  file: noArg('-C', '--compile'),
  stat: any,
  pwd: any,
  which: any,
  type: any,
  echo: any,
  true: any,
  basename: any,
  dirname: any,
  realpath: any,
  readlink: any,
  cut: any,
  nl: any,
  tr: any,
  diff: noArg('-o', '--output'),
  cmp: any,
  comm: any,
  grep: any,
  egrep: any,
  fgrep: any,
  rg: noArg('--pre', '--pre-glob', '--hostname-bin'),
  find: noArg('-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'),
  tree: noArg('-o', '-R'),
  du: any,
  df: any,
  sort: (args) => noArg('-o', '--output', '--compress-program')(args) && !args.some((a) => /^-[^-]*o/.test(a)),
  // `uniq in out` writes out.
  uniq: (args) => operands(args, ['-f', '-s', '-w']).length <= 1,
  whoami: any,
  id: any,
  uname: any,
  date: (args) => !args.some((a) => a.startsWith('-s') || a.startsWith('--set') || (!a.startsWith('-') && !a.startsWith('+'))),
  ps: any,
  jq: noArg('-f', '--from-file', '--rawfile', '--slurpfile'),
  shasum: any,
  sha256sum: any,
  md5sum: any,
  md5: any,
  od: any,
  hexdump: any,
  strings: any,
  column: any,
  git,
  sed,
}

const isOption = (word: string) => word.startsWith('-') && word !== '-'

// True if every part of the command only reads and none of them names a secret.
export const isReadOnlyCommand = (command: string, context: ReadContext) => {
  const tokens = tokenize(command)
  if (!tokens) return false
  const commands = commandsOf(tokens)
  if (!commands || !commands.length) return false
  let cwd = context.cwd
  for (const words of commands) {
    const [program, ...rest] = words
    if (!program || program.globbed || program.tilde || program.text.includes('/')) return false
    // FOO=bar cmd
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program.text)) return false
    const args = rest.map((word) => (word.tilde ? expandHome(word.text, context.home) : word.text))
    if (rest.some((word) => word.tilde && !/^~(?:$|\/)/.test(word.text))) return false
    const here = { ...context, cwd }
    if (program.text === 'cd') {
      const [to = context.home, ...more] = args
      if (more.length || to === '-' || rest[0]?.globbed) return false
      if (isSecret(to, here)) return false
      cwd = resolve(cwd, to)
      continue
    }
    const check = PROGRAMS[program.text]
    if (!check || !check(args)) return false
    if (program.text === 'git') {
      const at = args.indexOf('-C')
      if (at >= 0 && args[at + 1] !== undefined && searchReachesSecret(args[at + 1]!, here)) return false
    }
    for (const [i, word] of rest.entries()) {
      const arg = args[i]!
      const values = isOption(arg) ? (arg.includes('=') ? [arg.slice(arg.indexOf('=') + 1)] : []) : [arg]
      for (const value of values) {
        if (!value) continue
        if (word.globbed && globReachesSecret(value, here)) return false
        if (isSecret(value, here)) return false
      }
    }
    // A recursive search reads every file under its folders.
    if (recursive(program.text, args) && searchRoots(program.text, args).some((root) => searchReachesSecret(root, here))) {
      return false
    }
  }
  return true
}

const recursive = (program: string, args: string[]) => {
  if (program === 'rg') return true
  if (program === 'grep' || program === 'egrep' || program === 'fgrep')
    return args.some((a) => a === '--recursive' || a === '--dereference-recursive' || /^-[^-]*[rR]/.test(a))
  return false
}

// The folders a recursive search starts from: its operands after the pattern, or the current folder.
const searchRoots = (program: string, args: string[]) => {
  const valued = program === 'rg'
    ? ['-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '-A', '-B', '-C', '-e', '-f', '-j', '-M', '--max-count']
    : ['-e', '-f', '-m', '-A', '-B', '-C', '--include', '--exclude', '--exclude-dir']
  const all = operands(args, valued)
  const explicit = args.some((a) => a === '-e' || a === '-f' || a.startsWith('--regexp') || a.startsWith('--file'))
  const roots = explicit ? all : all.slice(1)
  return roots.length ? roots : ['.']
}

// A glob counts as reaching a secret if a secret could match it. Only the last segment may hold wildcards, and a
// wildcard segment starting with a dot (which could match .env or .ssh) asks. Like the shell, * skips dot files.
const globReachesSecret = (value: string, context: ReadContext) => {
  const segments = value.split('/')
  const last = segments.at(-1)!
  if (segments.slice(0, -1).some((segment) => /[*?[]/.test(segment))) return true
  if (last.startsWith('.')) return true
  const prefix = segments.slice(0, -1).join('/') || (value.startsWith('/') ? '/' : '.')
  const dir = resolve(context.cwd, prefix)
  let pattern: RegExp
  try {
    const body = last.replace(/[.+^${}()|\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')
    pattern = new RegExp(`^(?!\\.)${body}$`)
  } catch {
    return true
  }
  const candidates = context.secrets.flatMap((secret) => [secret, realOf(secret)])
  return [dir, realOf(dir)].some((base) =>
    candidates.some((secret) => {
      if (secret === base || !within(secret, base)) return false
      return pattern.test(secret.slice(base.replace(/\/?$/, sep).length).split(sep)[0]!)
    }),
  )
}
