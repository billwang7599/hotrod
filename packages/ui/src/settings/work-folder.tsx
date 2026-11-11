// The Work folder page and the dialog that picks the work folder (also shown before the first space).
import { useState, type FormEvent } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Dialog } from 'radix-ui'
import { PERMISSION_SWITCHES, switchedOn, type ClientMessage, type WorkFolder } from '@kothar/core/shared'
import { PERMISSIONS } from '../context-panel.tsx'
import { Button, CHAT_NOUN, ErrorText, GROUP, Hint, MOTION, Select, Switch, useReturnFocus } from '../controls.tsx'
import { SettingRow } from './rows.tsx'
import type { PageProps } from './types.ts'

const WORK_FOLDER_TITLE = 'Choose a work folder'
const WORK_FOLDER_HINT =
  'Agents and workers do all their work here, and can write nowhere else unless you allow it, here or for a chat. ' +
  `Each ${CHAT_NOUN.one} gets a folder of its own inside it.`

const TERMINAL_ABOUT =
  'What Open in Terminal opens. Automatic uses the app macOS opens shell scripts with, else Terminal.'

const EDITOR_ABOUT = 'What a file path in a chat opens with when you click it.'
const COMMAND_HINT =
  'Runs without a shell. {file}, {line} and {col} are filled in; without {file}, the file goes at the end.'

const PERMISSION_DEFAULT_HINT = 'The switches below are the default for every chat; each can choose otherwise in its Context panel.'

export const WORK_FOLDER_INTRO = `${WORK_FOLDER_HINT} ${PERMISSION_DEFAULT_HINT}`

// The work folder itself, the terminal Open in Terminal uses, what file links open with, and the default permission
// switches for every chat.
export function WorkFolderPage({ workFolder, chooseWorkFolder, connected, send }: PageProps) {
  return (
    <div className={GROUP}>
      <SettingRow
        name="Work folder"
        description={<span className="font-mono">{workFolder.path ?? 'Not chosen'}</span>}
      >
        <Button disabled={!connected} onClick={chooseWorkFolder}>
          Change…
        </Button>
      </SettingRow>
      {workFolder.terminals && (
        <SettingRow name="Terminal" description={TERMINAL_ABOUT}>
          <Select
            label="Terminal"
            value={workFolder.terminal ?? 'auto'}
            disabled={!connected}
            options={[
              { value: 'auto', label: 'Automatic' },
              ...workFolder.terminals.map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={(terminal) => send({ type: 'terminal.set', terminal })}
          />
        </SettingRow>
      )}
      <EditorRow workFolder={workFolder} connected={connected} send={send} />
      {PERMISSION_SWITCHES.map((name) => {
        const { label, about, amberWhileOn } = PERMISSIONS[name]
        const on = switchedOn(name, workFolder)
        return (
          <SettingRow
            key={name}
            name={<span className={amberWhileOn && on ? 'text-amber' : ''}>{label}</span>}
            description={about}
          >
            <Switch
              label={label}
              checked={on}
              disabled={!connected}
              onChange={(enabled) => send({ type: 'permission.setDefault', name, enabled })}
            />
          </SettingRow>
        )
      })}
    </div>
  )
}

// Open files with: the system's default app, an installed editor Kothar knows, or the user's own command.
function EditorRow({ workFolder, connected, send }: Pick<PageProps, 'workFolder' | 'connected' | 'send'>) {
  const choice = workFolder.editor ?? 'system'
  const saved = workFolder.editorCommand ?? ''
  const [command, setCommand] = useState(saved)
  const [shownSaved, setShownSaved] = useState(saved)
  if (saved !== shownSaved) {
    setShownSaved(saved)
    setCommand(saved)
  }
  const save = () => {
    if (command.trim() !== saved) send({ type: 'editor.set', editor: 'custom', command })
  }
  return (
    <SettingRow
      name="Open files with"
      description={EDITOR_ABOUT}
      below={
        choice === 'custom' && (
          <Hint text={COMMAND_HINT} side="bottom" align="start">
            <input
              className="w-full font-mono text-sm"
              aria-label="Command to open files"
              value={command}
              placeholder="nvim-qt +{line} {file}"
              spellCheck={false}
              disabled={!connected}
              onChange={(e) => setCommand(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          </Hint>
        )
      }
    >
      <Select
        label="Open files with"
        value={choice}
        disabled={!connected}
        options={[
          { value: 'system', label: 'System default' },
          ...(workFolder.editors ?? []).map((e) => ({ value: e.id, label: e.name })),
          { value: 'custom', label: 'Custom command' },
        ]}
        onChange={(editor) => send({ type: 'editor.set', editor })}
      />
    </SettingRow>
  )
}

type WorkFolderDialogProps = {
  open: boolean
  workFolder: WorkFolder
  connected: boolean
  send: (m: ClientMessage) => void
  toasts: { id: number; message: string }[]
  pickFolder?: (title: string) => Promise<string | null>
  close?: () => void
}

export function WorkFolderDialog({ open, workFolder, connected, send, toasts, pickFolder, close }: WorkFolderDialogProps) {
  const [shown, setShown] = useState(false)
  const [path, setPath] = useState('')
  const [sentAfter, setSentAfter] = useState<number>()
  if (open !== shown) {
    setShown(open)
    setPath(workFolder.path ?? '')
    setSentAfter(undefined)
  }
  // The core refuses a folder with an error toast, which the dialog would hide, so it shows here.
  const error = sentAfter === undefined ? undefined : toasts.findLast((t) => t.id > sentAfter)?.message
  const focus = useReturnFocus()
  const choose = (chosen: string) => {
    setSentAfter(toasts.at(-1)?.id ?? 0)
    send({ type: 'workFolder.set', path: chosen })
  }
  const pick = async () => {
    const picked = await pickFolder?.(WORK_FOLDER_TITLE)
    if (!picked) return
    setPath(picked)
    choose(picked)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (connected && path.trim()) choose(path.trim())
  }
  return (
    <Dialog.Root open={open} onOpenChange={(open) => open || close?.()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <m.div className="fixed inset-0 bg-backdrop" {...MOTION.fade} />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={focus.remember}
              onCloseAutoFocus={focus.restore}
            >
              <m.form
                className="fixed inset-0 m-auto flex h-fit max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] flex-col gap-12 scroll-inset overflow-y-auto rounded-xl border bg-panel pt-14 pr-2 pb-16 pl-16 text-text shadow-overlay"
                {...MOTION.pop}
                onSubmit={submit}
              >
                <div className="flex flex-col gap-4">
                  <Dialog.Title className="text-[16px] font-semibold">{WORK_FOLDER_TITLE}</Dialog.Title>
                  <p className="text-sm text-muted">{WORK_FOLDER_HINT}</p>
                </div>
                <label className="flex flex-col gap-4">
                  <span className="text-muted">Folder</span>
                  <span className="flex gap-6">
                    <input
                      className="flex-1 font-mono text-sm"
                      value={path}
                      placeholder={workFolder.defaultPath}
                      spellCheck={false}
                      onChange={(e) => setPath(e.target.value)}
                    />
                    {pickFolder && (
                      <Button type="button" disabled={!connected} onClick={() => void pick()}>
                        Choose…
                      </Button>
                    )}
                  </span>
                </label>
                <p className="text-sm text-muted">
                  Default: <span className="font-mono wrap-anywhere">{workFolder.defaultPath}</span>
                </p>
                {error && <ErrorText>{error}</ErrorText>}
                <div className="flex flex-wrap justify-end gap-8">
                  <Button
                    type="button"
                    className="mr-auto"
                    disabled={!connected}
                    onClick={() => choose(workFolder.defaultPath)}
                  >
                    Use default
                  </Button>
                  {close && (
                    <Dialog.Close asChild>
                      <Button type="button">Cancel</Button>
                    </Dialog.Close>
                  )}
                  <Button variant="primary" disabled={!connected || !path.trim()}>
                    Use this folder
                  </Button>
                </div>
              </m.form>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
