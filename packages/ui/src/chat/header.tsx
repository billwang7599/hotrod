// The bar across the top of a chat: the panel toggles, its name and folder, a sandbox warning and the account picker.
import { editsAnywhere, type ClientMessage, type EngineAccounts, type WorkFolder } from '@kothar/core/shared'
import { Hint, PanelToggle, Select } from '../controls.tsx'
import { usePathsShown } from '../paths.ts'
import type { SettingsPage } from '../settings.tsx'
import { accountLabel, listedAccounts, type ChatView } from '../state.ts'

const MANAGE_ACCOUNTS = '__manage'
const WARNING_CHIP = 'shrink-0 cursor-help rounded-full bg-warning-bg px-8 py-2 text-xs text-amber'
const EDITS_ANYWHERE_HINT =
  'This chat runs without the work folder’s sandbox: its agents may edit files anywhere, asking you first. Turn ' +
  'it off in the Context panel.'
const EDITS_ANYWHERE_ALL_HINT =
  'Every chat runs without the work folder’s sandbox: agents may edit files anywhere, asking you first. Turn it ' +
  'off in Settings → Work folder.'
const NOT_SANDBOXED_HINT =
  'Kothar can’t sandbox engines on this system yet, so a chat runs only with Edits anywhere on (in its Context ' +
  'panel, or for every chat in Settings → Work folder), and its agents can write anywhere.'

type ChatHeaderProps = {
  chat: ChatView
  // The chat and the chats above it, up to its space.
  line: ChatView[]
  folder?: string
  workFolder: WorkFolder
  accounts?: EngineAccounts
  // The account picker shows only while the chat's model can run, and works only while a message could be sent.
  engineOff: boolean
  canSend: boolean
  send: (m: ClientMessage) => void
  openSettings: (page?: SettingsPage) => void
  sidebarOpen: boolean
  toggleSidebar: () => void
  contextOpen: boolean
  toggleContext: () => void
}

export function ChatHeader(props: ChatHeaderProps) {
  const { chat, line, folder, workFolder, accounts, engineOff, canSend, send, openSettings } = props
  const { sidebarOpen, toggleSidebar, contextOpen, toggleContext } = props
  const paths = usePathsShown()
  const listed = accounts && listedAccounts(accounts)
  return (
    <header className="flex h-44 shrink-0 items-center gap-6 border-b px-12">
      <PanelToggle
        side="left"
        label="Sidebar"
        noun="sidebar"
        open={sidebarOpen}
        toggle={toggleSidebar}
        action="toggleSidebar"
      />
      <div className="flex min-w-64 flex-1 items-baseline gap-10 pl-2 whitespace-nowrap">
        <Hint text={!chat.extension && !paths.header && (folder ?? 'Not tied to a folder')} side="bottom" align="start">
          <span className="max-w-[50%] shrink-0 truncate font-semibold max-[900px]:max-w-full">{chat.name}</span>
        </Hint>
        {!chat.extension && paths.header && (
          <span className="min-w-0 truncate font-mono text-sm leading-[normal] text-faint max-[900px]:hidden">
            {folder ?? 'Not tied to a folder'}
          </span>
        )}
      </div>
      {(editsAnywhere(...line, workFolder) || !workFolder.canSandbox) && (
        <Hint
          text={
            !workFolder.canSandbox
              ? NOT_SANDBOXED_HINT
              : line.every((c) => c.editAnywhere === undefined)
                ? EDITS_ANYWHERE_ALL_HINT
                : EDITS_ANYWHERE_HINT
          }
        >
          <span className={WARNING_CHIP}>{workFolder.canSandbox ? 'Edits anywhere' : 'Not sandboxed'}</span>
        </Hint>
      )}
      {accounts && listed && !engineOff && (
        <Select
          variant="chip"
          label="Account"
          value={listed.active}
          disabled={!canSend}
          options={[
            ...listed.accounts.map((a) => ({ value: a.id, label: accountLabel(a) })),
            { value: MANAGE_ACCOUNTS, label: 'Manage accounts…' },
          ]}
          onChange={(accountId) =>
            accountId === MANAGE_ACCOUNTS
              ? openSettings('accounts')
              : send({ type: 'account.use', engine: accounts.engine, accountId })
          }
        />
      )}
      <PanelToggle
        side="right"
        label="Context panel"
        noun="context"
        open={contextOpen}
        toggle={toggleContext}
        action="toggleContextPanel"
      />
    </header>
  )
}
