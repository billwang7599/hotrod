// The apps a file link in a chat opens with: the system's default app, an editor Kothar knows (opened at the line where
// it can be), or a command of the user's own. Only works out what to run; file-links.ts checks the path and runs it.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// settings.json's editor: absent or 'system' for the system's default app, 'custom' for editorCommand, else an
// EDITORS id.
export const SYSTEM_EDITOR = 'system'
export const CUSTOM_EDITOR = 'custom'

export type FileSpot = { file: string; line?: number; col?: number }
export type EditorLaunch = { command: string; args: string[] }

// A macOS editor: its app's name in /Applications (or ~/Applications), the command-line tool inside the app, and how
// that tool takes a file at a line. Running the tool inside the app works without it being on the PATH.
type Editor = { id: string; name: string; app: string; cli: string; args: (spot: FileSpot) => string[] }

// file:line:col, for the editors that read it that way.
const colonSpot = ({ file, line, col }: FileSpot) =>
  line === undefined ? file : col === undefined ? `${file}:${line}` : `${file}:${line}:${col}`
const goto = (spot: FileSpot) => (spot.line === undefined ? [spot.file] : ['-g', colonSpot(spot)])

export const EDITORS: Editor[] = [
  { id: 'vscode', name: 'Visual Studio Code', app: 'Visual Studio Code.app', cli: 'Contents/Resources/app/bin/code', args: goto },
  { id: 'cursor', name: 'Cursor', app: 'Cursor.app', cli: 'Contents/Resources/app/bin/cursor', args: goto },
  { id: 'windsurf', name: 'Windsurf', app: 'Windsurf.app', cli: 'Contents/Resources/app/bin/windsurf', args: goto },
  { id: 'zed', name: 'Zed', app: 'Zed.app', cli: 'Contents/MacOS/cli', args: (spot) => [colonSpot(spot)] },
  { id: 'sublime', name: 'Sublime Text', app: 'Sublime Text.app', cli: 'Contents/SharedSupport/bin/subl', args: (spot) => [colonSpot(spot)] },
]

const appFolders = (home: string) => ['/Applications', join(home, 'Applications')]

// Where an editor's command-line tool is, if its app is installed.
export const editorCli = (editor: Editor, home: string, exists: (path: string) => boolean = existsSync) =>
  appFolders(home)
    .map((folder) => join(folder, editor.app, editor.cli))
    .find((cli) => exists(cli))

// The editors the user can pick: those installed, on macOS only.
export const installedEditors = (platform: NodeJS.Platform, home: string, exists: (path: string) => boolean = existsSync) =>
  platform === 'darwin'
    ? EDITORS.filter((editor) => editorCli(editor, home, exists)).map(({ id, name }) => ({ id, name }))
    : []

export const editorName = (id: string | undefined) => EDITORS.find((e) => e.id === id)?.name

// A command line split into words the way a shell would for plain words and quotes, without running a shell: no
// variables, globs or pipes.
export function splitCommand(line: string): string[] {
  const words: string[] = []
  // undefined between words; '' for a word that's only quotes so far.
  let word: string | undefined
  let quote: '"' | "'" | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word = (word ?? '') + line[++i]
      else word = (word ?? '') + c
    } else if (c === '"' || c === "'") {
      quote = c
      word ??= ''
    } else if (c === '\\' && i + 1 < line.length) word = (word ?? '') + line[++i]
    else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else word = (word ?? '') + c
  }
  if (quote) throw new Error('The command has an unclosed quote')
  if (word !== undefined) words.push(word)
  return words
}

// The user's own command: {file}, {line} and {col} are filled in (line and col with 1 when unknown), and the file is
// added at the end if the command never says {file}.
export function customLaunch(command: string, { file, line, col }: FileSpot): EditorLaunch {
  const words = splitCommand(command)
  if (!words.length) throw new Error('Set a command for Open files with in Settings → Work folder')
  const fill = (word: string) =>
    word.replaceAll('{file}', file).replaceAll('{line}', String(line ?? 1)).replaceAll('{col}', String(col ?? 1))
  const args = words.slice(1).map(fill)
  return { command: fill(words[0]!), args: words.some((w) => w.includes('{file}')) ? args : [...args, file] }
}

// The system's default app for a file, which can't be told a line.
export function systemLaunch(file: string, platform: NodeJS.Platform): EditorLaunch {
  if (platform === 'darwin') return { command: 'open', args: [file] }
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/c', 'start', '', file] }
  return { command: 'xdg-open', args: [file] }
}

// What to run to open spot with the user's choice.
export function editorLaunch(
  spot: FileSpot,
  { choice, command, platform, home, exists = (path) => existsSync(path) }: {
    choice?: string
    command?: string
    platform: NodeJS.Platform
    home: string
    exists?: (path: string) => boolean
  },
): EditorLaunch {
  if (choice === CUSTOM_EDITOR) return customLaunch(command ?? '', spot)
  const editor = EDITORS.find((e) => e.id === choice)
  if (!editor || platform !== 'darwin') return systemLaunch(spot.file, platform)
  const cli = editorCli(editor, home, exists)
  if (!cli) throw new Error(`Couldn't find ${editor.name}. Is it installed?`)
  return { command: cli, args: editor.args(spot) }
}
