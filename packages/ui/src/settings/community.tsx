// The Community hub page: the master switch for community extensions and each installed one.
import { EXTENSION_USES, type ClientMessage, type ExtensionInfo } from '@kothar/core/shared'
import { Button, confirm, ErrorText, GROUP, Hint, Switch } from '../controls.tsx'
import { changesSinceApproved, EXTENSION_WARNING, extensionStatus, UsesList } from '../marketplace.tsx'
import { RestartNotice } from '../restart.tsx'
import { SettingRow } from './rows.tsx'
import { NO_RESTART, type PageProps } from './types.ts'

const COMMUNITY_RISKS =
  'Community extensions are code from other people, and they run inside Kothar with your permissions.\n\n' +
  '• They can read your files and settings, and reach the network.\n' +
  "• Kothar doesn't review them.\n" +
  '• An update can change what an extension does.\n\n' +
  'Each extension still stays off until you turn it on.'

async function setCommunityExtensions(enabled: boolean, send: (m: ClientMessage) => void) {
  if (enabled) {
    const ok = await confirm({ text: 'Turn on community extensions?', body: COMMUNITY_RISKS, ok: 'Turn on community extensions' })
    if (!ok) return
  }
  send({ type: 'communityExtensions.setEnabled', enabled })
}

export function CommunityExtensionsPage(props: PageProps) {
  const { extensions, connected, send, communityExtensions = false, restart = NO_RESTART, running = 0, openMarketplace } = props
  const community = extensions.filter((m) => m.community)
  const turn = async (m: ExtensionInfo, enabled: boolean) => {
    if (enabled) {
      const { uses, repo, path } = m.community!
      const listed = uses.map((use) => `• ${EXTENSION_USES[use]}`).join('\n')
      const changes = changesSinceApproved(m)
      const ok = await confirm({
        text: `Turn on ${m.name} ${m.community!.version}?`,
        body:
          `From ${repo ? `github.com/${repo}` : (path ?? 'a folder on this computer')}. It runs code on your computer with ` +
          'your permissions.' +
          (changes ? `\n\n${changes}` : '') +
          (listed ? `\n\nIt says it:\n${listed}` : '') +
          '\n\nKothar runs exactly these files. Any update turns it off again until you turn it on.' +
          '\n\nIt starts when Kothar restarts.',
        ok: 'Turn on',
      })
      if (!ok) return
    }
    send({ type: 'extension.setEnabled', extensionId: m.id, enabled })
  }
  return (
    <>
      <RestartNotice restart={restart} running={running} connected={connected} send={send} />
      <div className={`${GROUP} mb-12`}>
        <SettingRow
          name="Community extensions"
          description={
            communityExtensions ? (
              'On. An extension below runs while its own switch is on.'
            ) : (
              <span className="text-amber">Off. No community extension runs, whatever its own switch says.</span>
            )
          }
        >
          <Switch
            label="Community extensions"
            checked={communityExtensions}
            disabled={!connected}
            onChange={(on) => void setCommunityExtensions(on, send)}
          />
        </SettingRow>
      </div>
      <div className="flex items-start gap-16 pb-12">
        <p className="flex-1 text-sm text-amber">{EXTENSION_WARNING}</p>
        {openMarketplace && <Button onClick={() => openMarketplace()}>Browse…</Button>}
      </div>
      {!community.length && <p className="text-muted">No community extensions installed. Find them in the Marketplace.</p>}
      {community.length > 0 && (
        <div className={`${GROUP} transition-opacity ${communityExtensions ? '' : 'opacity-60'}`} aria-disabled={!communityExtensions}>
          {community.map((m) => {
            const { version, author, uses, source, repo, path } = m.community!
            const status = extensionStatus(m, communityExtensions)
            return (
              <SettingRow
                key={m.id}
                name={
                  <span className="flex flex-wrap items-baseline gap-x-8">
                    <span>{m.name}</span>
                    <span className="text-xs text-faint">
                      {version} by {author}
                    </span>
                    {source === 'local' && (
                      <Hint text={`Installed from ${path ?? 'a folder'}`}>
                        <span className="text-xs text-amber">Local</span>
                      </Hint>
                    )}
                  </span>
                }
                description={
                  <span className="flex flex-col gap-4">
                    <span>{m.description}</span>
                    <UsesList uses={uses} />
                    {repo && (
                      <a
                        className="w-fit text-xs text-faint underline-offset-2 hover:underline"
                        href={`https://github.com/${repo}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {repo}
                      </a>
                    )}
                    {status && <span className="text-faint">{status}</span>}
                  </span>
                }
                below={m.loadError && <ErrorText>Couldn't load: {m.loadError}</ErrorText>}
              >
                <Button
                  variant="ghost"
                  disabled={!connected}
                  onClick={() => send({ type: 'market.uninstall', kind: 'extension', id: m.id })}
                >
                  Uninstall
                </Button>
                <Switch
                  label={m.name}
                  checked={m.enabled}
                  disabled={!connected || (!communityExtensions && !m.enabled)}
                  onChange={(on) => void turn(m, on)}
                />
              </SettingRow>
            )
          })}
        </div>
      )}
    </>
  )
}
