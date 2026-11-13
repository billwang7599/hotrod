import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionHost } from '@kothar/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLED, checkedEntry, freeId, mergedCatalog, parseCatalog, searched, serverFromEntry, serverFromForm } from './catalog.ts'
import { openClients } from './clients.ts'
import { MANY_TOOLS, pageAction, renderPage, type PageDeps, type PageState } from './settings-view.ts'
import { openStore } from './store.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url))
const now = new Date('2026-11-12T00:00:00.000Z')
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('catalog', () => {
  it('bundles only entries Kothar can add, each checked', () => {
    const raw = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')).servers
    expect(BUNDLED.length).toBe(raw.length)
    expect(BUNDLED.map((e) => e.id)).toEqual([
      'github', 'linear', 'notion', 'sentry', 'atlassian', 'figma', 'figma-desktop', 'stripe', 'supabase', 'vercel',
      'cloudflare-docs', 'context7', 'exa', 'playwright', 'filesystem', 'fetch', 'memory', 'brave-search',
    ])
    for (const entry of BUNDLED) expect(entry.docs ?? '').toMatch(/^https:\/\//)
  })

  it('drops broken entries and lets a remote one replace a bundled one', () => {
    expect(checkedEntry({ id: 'x', name: 'X', transport: 'http', url: 'https://x.dev', auth: { kinds: ['token'] } })).toBeUndefined()
    expect(checkedEntry({ id: 'x', name: 'X', transport: 'stdio', command: 'x', auth: { kinds: ['token'], token: { label: 'K', header: 'H' } } })).toBeUndefined()
    expect(parseCatalog('nope')).toEqual([])
    const remote = parseCatalog(JSON.stringify({ servers: [{ id: 'github', name: 'GitHub (mirror)', transport: 'http', url: 'https://gh.example/mcp' }, { id: 'new', name: 'New', transport: 'stdio', command: 'new-mcp' }] }))
    const merged = mergedCatalog(remote)
    expect(merged.find((e) => e.id === 'github')!.name).toBe('GitHub (mirror)')
    expect(merged.some((e) => e.id === 'new')).toBe(true)
  })

  it('searches by name, publisher and description', () => {
    expect(searched(BUNDLED, 'jira').map((e) => e.id)).toEqual(['atlassian'])
    expect(searched(BUNDLED, 'figma').map((e) => e.id)).toEqual(['figma', 'figma-desktop'])
    expect(searched(BUNDLED, '')).toHaveLength(BUNDLED.length)
  })

  it('makes a server off, with its token as a secret header or env var, and a free id', () => {
    const github = BUNDLED.find((e) => e.id === 'github')!
    const made = serverFromEntry(github, { auth: 'token', token: ' ghp_abc123456 ' }, [], now)
    expect(made.server).toMatchObject({ id: 'github', enabled: false, transport: 'http', secretHeaders: ['Authorization'], approval: 'ask', official: true })
    expect(made.secrets).toEqual({ headers: { Authorization: 'Bearer ghp_abc123456' } })
    expect(JSON.stringify(made.server)).not.toContain('ghp_abc')
    const brave = BUNDLED.find((e) => e.id === 'brave-search')!
    expect(serverFromEntry(brave, { auth: 'token', token: 'BSA1234' }, [], now).secrets).toEqual({ env: { BRAVE_API_KEY: 'BSA1234' } })
    expect(() => serverFromEntry(brave, { auth: 'token' }, [], now)).toThrow('needs its Brave Search API key')
    const fs = BUNDLED.find((e) => e.id === 'filesystem')!
    expect(() => serverFromEntry(fs, { auth: 'none' }, [], now)).toThrow('Pick at least one folder')
    expect(serverFromEntry(fs, { auth: 'none', folders: ['/a', '/b'] }, ['filesystem'], now).server).toMatchObject({ id: 'filesystem-2', args: ['-y', '@modelcontextprotocol/server-filesystem', '/a', '/b'] })
    expect(freeId('Some Thing!', [])).toBe('some-thing-')
  })

  it('reads a custom server from the form, secrets apart', () => {
    const local = serverFromForm({ name: 'Mine', target: 'npx -y mine', args: '--x\n--y', env: 'A=1', secretEnv: 'TOKEN=s3cret-value' }, [], now)
    expect(local.server).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', 'mine', '--x', '--y'], env: { A: '1' }, secretEnv: ['TOKEN'], official: false, publisher: 'You' })
    expect(local.secrets).toEqual({ env: { TOKEN: 's3cret-value' } })
    const sse = serverFromForm({ name: 'Old', target: 'https://x.dev/sse', secretHeaders: 'Authorization: Bearer k-123456' }, [], now)
    expect(sse.server).toMatchObject({ transport: 'sse', secretHeaders: ['Authorization'] })
    expect(() => serverFromForm({ name: 'Bad', target: 'x', env: 'nope' }, [], now)).toThrow('KEY=value')
  })
})

describe('Settings page', () => {
  function page(oauth?: PageDeps['oauth']) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-mcp-page-')))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = openStore(dir)
    const clients = openClients({ store, now: () => Date.now(), record: () => {}, idleMs: () => 60_000 })
    cleanups.push(() => clients.stopAll())
    let refreshed = 0
    const host = {
      now: () => now,
      refresh: () => void refreshed++,
      chats: () => [
        { id: 's1', name: 'Game', archived: false, keepsContext: true },
        { id: 'h', name: 'Home', archived: false, extension: 'home', keepsContext: false },
      ],
    } as unknown as ExtensionHost
    const state: PageState = { query: '' }
    const deps = { store, clients, catalog: () => BUNDLED, host, ...(oauth && { oauth }) }
    const view = () => JSON.stringify(renderPage(state, deps))
    const act = (name: string, value?: unknown) => pageAction({ name, ...(value !== undefined && { value: value as never }) }, state, deps)
    return { store, clients, state, view, act, refreshed: () => refreshed }
  }

  it('adds a catalog server off, shows what it runs and asks before running it', async () => {
    const p = page()
    await p.act('pick', 'brave-search')
    expect(p.view()).toContain('npx -y @brave/brave-search-mcp-server')
    await p.act('add', { token: '' })
    expect(p.state.message?.tone).toBe('error')
    await p.act('add', { token: 'BSA-key-987654' })
    expect(p.store.server('brave-search')).toMatchObject({ enabled: false })
    const page1 = p.view()
    expect(page1).toContain('Run Brave Search on your Mac?')
    expect(page1).toContain('Brave · official')
    expect(page1).not.toContain('BSA-key-987654')
    expect(page1).toContain('••••7654')
  })

  it('tests a custom server, turns it on, sets who may call it and where, and removes it', async () => {
    const p = page()
    await p.act('custom')
    await p.act('addCustom', { name: 'Fake', target: process.execPath, args: FAKE, secretEnv: 'FAKE_TOKEN=tok-1234567' })
    const id = p.store.servers()[0]!.id
    expect(p.view()).toContain('community')
    await p.act('test', id)
    expect(p.state.message).toMatchObject({ tone: 'success', text: expect.stringContaining('5 tools') })
    await p.act('enable', id)
    expect(p.store.server(id)!.enabled).toBe(true)
    await p.act('approval', { id, value: 'reads' })
    await p.act('scope', { id, space: 's1' })
    expect(p.store.server(id)).toMatchObject({ approval: 'reads', spaces: ['s1'] })
    expect(p.view()).toContain('only Game')
    await p.act('scope', { id, space: '' })
    expect(p.store.server(id)!.spaces).toBe('all')
    await p.act(`secrets:${id}`, { FAKE_TOKEN: '' })
    expect(p.store.secrets(id).env).toEqual({ FAKE_TOKEN: 'tok-1234567' })
    await p.act(`secrets:${id}`, { FAKE_TOKEN: 'tok-new-7654321' })
    expect(p.store.secrets(id).env).toEqual({ FAKE_TOKEN: 'tok-new-7654321' })
    await p.act('remove', id)
    expect(p.store.servers()).toEqual([])
    expect(p.store.secrets(id)).toEqual({})
  })

  it('warns when the servers that are on offer many tools', async () => {
    const p = page()
    await p.act('custom')
    await p.act('addCustom', { name: 'Many', target: process.execPath, args: FAKE, env: `FAKE_TOOLS=${MANY_TOOLS}` })
    const id = p.store.servers()[0]!.id
    await p.act('enable', id)
    expect(p.view()).toContain('save tokens')
  })

  it('signs an OAuth server in from its card: Sign in, a link while waiting, then Sign out', async () => {
    let signedIn = false
    let pending: { url: string; done: Promise<void>; cancel: () => void } | undefined
    let finish = () => {}
    const oauth: PageDeps['oauth'] = {
      signIn: async () => {
        pending = { url: 'https://auth.example/authorize?x=1', done: new Promise<void>((resolve) => (finish = resolve)), cancel: () => {} }
        return pending
      },
      signingIn: () => pending,
      signedIn: () => signedIn,
      signOut: () => void (signedIn = false),
    }
    const p = page(oauth)
    await p.act('pick', 'notion')
    expect(p.view()).toContain('press Sign in')
    await p.act('add', {})
    const id = p.state.open!
    expect(p.view()).toContain('Not signed in')
    expect(p.view()).toContain('"label":"Sign in"')
    await p.act('signin', id)
    expect(p.view()).toContain('Open the sign-in page')
    expect(p.view()).toContain('https://auth.example/authorize?x=1')
    expect(p.view()).toContain('Cancel sign-in')
    signedIn = true
    pending = undefined
    finish()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(p.view()).toContain('Sign in again')
    expect(p.view()).toContain('Sign out')
    await p.act('signout', id)
    expect(p.state.message?.text).toContain('Signed out')
    expect(p.view()).toContain('Not signed in')
  })
})
