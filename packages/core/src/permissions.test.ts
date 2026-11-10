import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionRequest } from '@kothar/extension-api'
import { afterAll, describe, expect, it } from 'vitest'
import { ASKS_FIRST, OUTSIDE_EDIT_ADVICE, type PermissionContext, verdictOf } from './permissions.ts'
import type { PermissionSwitches } from './shared.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-permissions-')))
const home = join(root, 'home')
const garage = join(home, 'Library', 'Application Support', 'Kothar')
const workDir = join(garage, 'work', 'space')
const project = join(home, 'code', 'app')
mkdirSync(join(home, '.ssh'), { recursive: true })
mkdirSync(join(garage, 'accounts'), { recursive: true })
mkdirSync(workDir, { recursive: true })
mkdirSync(project, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ALLOW = { allow: true }

const contextOf = (switches: PermissionSwitches = {}, sandboxed = true, more: PermissionSwitches[] = []): PermissionContext => ({
  cwd: workDir,
  workDir,
  sandboxed,
  switches: [switches, ...more],
  home,
  garage,
})

const request = (kind: PermissionRequest['kind'], fields: { path?: string; command?: string } = {}): PermissionRequest => ({
  type: 'permission.requested',
  requestId: 'r1',
  name: kind,
  kind,
  summary: '',
  input: {},
  ...fields,
})
const shell = (command: string) => request('shell', { command })

describe('edits', () => {
  it('allows edits in the work folder, sandboxed or not', () => {
    expect(verdictOf(request('edit', { path: 'a.ts' }), contextOf())).toEqual(ALLOW)
    expect(verdictOf(request('edit', { path: join(workDir, 'src', 'b.ts') }), contextOf({}, false))).toEqual(ALLOW)
  })

  it('denies edits outside the work folder while sandboxed, with advice', () => {
    const verdict = verdictOf(request('edit', { path: join(project, 'a.ts') }), contextOf())
    expect(verdict).toEqual({ allow: false, message: `Kothar lets this chat edit only inside ${workDir}. ${OUTSIDE_EDIT_ADVICE}` })
  })

  it('leaves edits outside the work folder to the user when unsandboxed (editAnywhere)', () => {
    expect(verdictOf(request('edit', { path: join(project, 'a.ts') }), contextOf({ editAnywhere: true }, false))).toBeUndefined()
  })

  it('treats a path that climbs out of the work folder as outside', () => {
    expect(verdictOf(request('edit', { path: '../other/a.ts' }), contextOf())?.allow).toBe(false)
  })
})

describe('autoFetch', () => {
  it('allows fetches by default, sandboxed or not', () => {
    expect(verdictOf(request('fetch'), contextOf())).toEqual(ALLOW)
    expect(verdictOf(request('fetch'), contextOf({}, false))).toEqual(ALLOW)
  })

  it('asks when off', () => {
    expect(verdictOf(request('fetch'), contextOf({ autoFetch: false }))).toBeUndefined()
  })
})

describe('autoRead', () => {
  it('allows reads and searches by default', () => {
    expect(verdictOf(request('read', { path: join(project, 'a.ts') }), contextOf())).toEqual(ALLOW)
    expect(verdictOf(request('search', { path: project }), contextOf())).toEqual(ALLOW)
    expect(verdictOf(request('search'), contextOf({}, false))).toEqual(ALLOW)
  })

  it('asks for every read, search and read-only command when off', () => {
    const off = contextOf({ autoRead: false, autoRunCommands: false })
    expect(verdictOf(request('read', { path: join(project, 'a.ts') }), off)).toBeUndefined()
    expect(verdictOf(request('search', { path: project }), off)).toBeUndefined()
    expect(verdictOf(shell('ls'), off)).toBeUndefined()
  })

  it('asks for a read with no path', () => {
    expect(verdictOf(request('read'), contextOf())).toBeUndefined()
  })

  it('asks before reading keys, home logins and saved accounts', () => {
    for (const path of [join(home, '.ssh', 'id_rsa'), join(project, 'id_ed25519'), join(garage, 'accounts', 'claude-code.json')]) {
      expect(verdictOf(request('read', { path }), contextOf()), path).toBeUndefined()
    }
    expect(verdictOf(request('search', { path: join(home, '.ssh') }), contextOf())).toBeUndefined()
  })

  it('runs read-only commands without the sandbox or autoRunCommands', () => {
    expect(verdictOf(shell('cat package.json'), contextOf({ autoRunCommands: false }, false))).toEqual(ALLOW)
    expect(verdictOf(shell('cat ~/.ssh/id_rsa'), contextOf({ autoRunCommands: false }, false))).toBeUndefined()
  })
})

describe('autoEnvCommands', () => {
  const env = join(workDir, '.env')

  it('asks for .env reads and commands by default', () => {
    expect(verdictOf(request('read', { path: env }), contextOf())).toBeUndefined()
    expect(verdictOf(shell('npm run db:seed --env-file .env'), contextOf())).toBeUndefined()
  })

  it('lets .env through when on, sandboxed and running commands without asking', () => {
    expect(verdictOf(request('read', { path: env }), contextOf({ autoEnvCommands: true }))).toEqual(ALLOW)
    expect(verdictOf(shell('npm run db:seed --env-file .env'), contextOf({ autoEnvCommands: true }))).toEqual(ALLOW)
  })

  it('needs the sandbox and autoRunCommands', () => {
    expect(verdictOf(request('read', { path: env }), contextOf({ autoEnvCommands: true }, false))).toBeUndefined()
    const noRun = contextOf({ autoEnvCommands: true, autoRunCommands: false })
    expect(verdictOf(request('read', { path: env }), noRun)).toBeUndefined()
  })

  it('still asks for keys and home logins named alongside', () => {
    expect(verdictOf(shell('cat .env ~/.ssh/id_rsa > out'), contextOf({ autoEnvCommands: true }))).toBeUndefined()
    expect(verdictOf(shell('node deploy.js .credentials.json'), contextOf({ autoEnvCommands: true }))).toBeUndefined()
    expect(verdictOf(request('read', { path: join(project, 'id_rsa') }), contextOf({ autoEnvCommands: true }))).toBeUndefined()
  })
})

describe('autoRunCommands', () => {
  it('runs sandboxed commands by default', () => {
    expect(verdictOf(shell('npm test'), contextOf())).toEqual(ALLOW)
  })

  it('asks when off', () => {
    expect(verdictOf(shell('npm test'), contextOf({ autoRunCommands: false }))).toBeUndefined()
  })

  it('asks for every command outside the sandbox, even when on', () => {
    expect(verdictOf(shell('npm test'), contextOf({ editAnywhere: true }, false))).toBeUndefined()
  })

  it('asks for commands naming a secret', () => {
    expect(verdictOf(shell('npm test > ~/.ssh/log'), contextOf())).toBeUndefined()
    expect(verdictOf(shell(`node x.js ${join(garage, 'accounts')}`), contextOf())).toBeUndefined()
  })

  it('asks for a shell request with no command, and for other kinds', () => {
    expect(verdictOf(request('shell'), contextOf())).toBeUndefined()
    expect(verdictOf(request('mcp'), contextOf())).toBeUndefined()
    expect(verdictOf(request('other'), contextOf())).toBeUndefined()
  })
})

describe('autoNetworkCommands', () => {
  const network = ['git push origin main', 'npm publish', 'gh pr create', 'curl https://example.com', 'wget x', 'ssh box', 'scp a b:c', 'rsync -a a b']

  it('asks for network commands by default', () => {
    for (const command of network) expect(verdictOf(shell(command), contextOf()), command).toBeUndefined()
  })

  it('runs them sandboxed when on', () => {
    for (const command of network) {
      expect(verdictOf(shell(command), contextOf({ autoNetworkCommands: true })), command).toEqual(ALLOW)
    }
  })

  it('still needs the sandbox and autoRunCommands', () => {
    expect(verdictOf(shell('curl x'), contextOf({ autoNetworkCommands: true }, false))).toBeUndefined()
    expect(verdictOf(shell('curl x'), contextOf({ autoNetworkCommands: true, autoRunCommands: false }))).toBeUndefined()
  })

  it('ASKS_FIRST matches whole commands, spaces flexible', () => {
    expect(ASKS_FIRST.test('git   push')).toBe(true)
    expect(ASKS_FIRST.test('ghost --version')).toBe(false)
    expect(ASKS_FIRST.test('npm test')).toBe(false)
  })
})

describe('switch layers', () => {
  it('takes the nearest layer that sets a switch, then the defaults', () => {
    const parentOff = contextOf({}, true, [{ autoRunCommands: false }])
    expect(verdictOf(shell('npm test'), parentOff)).toBeUndefined()
    const chatOn = contextOf({ autoRunCommands: true }, true, [{ autoRunCommands: false }])
    expect(verdictOf(shell('npm test'), chatOn)).toEqual(ALLOW)
  })
})
