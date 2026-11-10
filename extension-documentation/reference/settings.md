---
title: Settings and setup
description: Give an extension settings the user can change, and a setup step that installs what it needs.
---

# Settings and setup

## Settings

`settings` lists the extension's settings. While the extension is on, Kothar shows them on the extension's own page in
Settings, under **Extensions**, and saves what the user picks. Every hook gets the current values as `values`, keyed by
each setting's `key`.

```ts
import type { Extension } from '@kothar/extension-api'

const reminders: Extension = {
  id: 'reminders',
  name: 'Reminders',
  description: 'Reminds the agent of your house rules.',
  enabledByDefault: false,
  settings: [
    { key: 'rules', label: 'House rules', type: 'text', default: '', rows: 4 },
    {
      key: 'tone',
      label: 'Tone',
      type: 'select',
      options: [
        { value: 'short', label: 'Short' },
        { value: 'friendly', label: 'Friendly' },
      ],
      default: 'short',
    },
    { key: 'maxWords', label: 'Max words per reply', type: 'number', default: 300, min: 50, integer: true },
    { key: 'onlySpaces', label: 'Only in spaces', description: 'Skip Home and workers.', type: 'boolean', default: true },
  ],
  instructions({ chat }, { values }) {
    if (values.onlySpaces && (chat.extension !== undefined || chat.worker)) return undefined
    const rules = String(values.rules).trim()
    const tone = values.tone === 'friendly' ? 'Be friendly.' : 'Be brief.'
    return `${tone} Keep replies under ${values.maxWords} words.${rules ? `\n\nHouse rules:\n${rules}` : ''}`
  },
}

export default reminders
```

Every setting has a `key`, a `label` and an optional `description`, plus one of these types:

| `type` | Extra fields | Value |
|---|---|---|
| `boolean` | `default: boolean` | A switch. |
| `number` | `default: number`, optional `min`, `max`, `integer` | A number field. |
| `select` | `options: { value, label }[]`, `default` | A picker. Values are strings or numbers. |
| `text` | `default: string`, optional `rows` | A text field; `rows` is how many lines it shows. |

How values behave:

- A saved value that's no longer valid, such as an option you removed, reads as the default.
- A blank `text` value reads as the default.
- `enabled` isn't allowed as a key. Kothar uses it for the extension's own switch.
- Values are typed `string | number | boolean`, so convert them where you use them, as `String(values.rules)` does above.
- A change applies at each chat's next message. Hooks always get the current values.

List `settings` in the manifest's `uses`.

## Settings per space

`spaceSettings` lists settings kept for each space instead of once for all of Kothar. They take the same types as
`settings`. Every space starts at the defaults, and a worker uses its space's values.

- **Read** them with `host.spaceValues(chatId)`, which fills in the defaults. Pass any chat; a worker's id gives its
  space's values.
- **Change** them with `host.setSpaceValue(chatId, key, value)`, which checks the value as Settings does and draws the
  extension's panels again, or let the user change them with a `switch` or `picker` in a
  [panel](panels.md#switches-and-pickers).
- They aren't shown in Settings. An extension that has them shows them in a panel.
- They're saved in the space's `chat.json` (`extensionValues`), so they go when the space is deleted.

```ts
const tidy: Extension = {
  id: 'tidy',
  name: 'Tidy',
  description: 'Asks agents to run the formatter before they finish.',
  enabledByDefault: false,
  spaceSettings: [
    { key: 'on', label: 'Format before finishing', type: 'boolean', default: false },
    {
      key: 'tool',
      label: 'Formatter',
      type: 'select',
      options: [
        { value: 'prettier', label: 'Prettier' },
        { value: 'biome', label: 'Biome' },
      ],
      default: 'prettier',
    },
  ],
  instructions({ chat }, { host }) {
    const { on, tool } = host.spaceValues(chat.id)
    return on ? `Before you finish, run ${tool} on the files you changed.` : undefined
  },
  panels: [
    {
      id: 'tidy',
      title: 'Tidy',
      render: () => ({
        type: 'stack',
        children: [
          { type: 'switch', setting: 'on' },
          { type: 'picker', setting: 'tool' },
        ],
      }),
    },
  ],
}
```

`spaceSettings`, `host.spaceValues` and `host.setSpaceValue` need `settings` in the manifest's `uses`.

## Migrating saved settings

When you rename a setting's key or change what its values mean, give the extension a `settingsVersion` (1 or more) and a
`migrateSettings` function. Raise the version each time the saved shape changes again.

```ts
settingsVersion: 2,
migrateSettings(saved, from, { spaceId }) {
  // from: the version the garage holds; 0 when none was saved.
  if (spaceId) return saved // a space's spaceSettings
  const { colour, ...rest } = saved
  return from < 2 && colour !== undefined ? { ...rest, tint: colour } : saved
},
```

- It runs **once, when Kothar starts**, before the extension is used, if the saved version is older than
  `settingsVersion`.
- It's called with the **saved values as stored**, with no defaults filled in: once for the global values (if any were
  saved), and once per space that has saved `spaceSettings`, with `spaceId` set.
- What it returns replaces the saved values, and the new version is saved.
- If it throws, nothing is saved, the error shows on the extension's page in Settings, and it runs again at the next
  start.
- A value it leaves invalid still reads as the default.

`settingsVersion` and `migrateSettings` need `settings` in the manifest's `uses`.

## Setup

A `setup` checks for something the extension needs, such as a program, and installs it if it's missing. Kothar shows the
setup on the extension's page in Settings: the description, whether it's ready, an **Install** button when it isn't, and
a progress bar while it installs.

```ts
import type { Extension } from '@kothar/extension-api'

const formatter: Extension = {
  id: 'formatter',
  name: 'Formatter',
  description: 'Gives agents a formatter.',
  enabledByDefault: false,
  setup: {
    description: 'Needs the dprint command. Install downloads it with npm.',
    async check(run) {
      const { code } = await run('dprint', ['--version'])
      return code === 0 ? { ready: true, message: 'dprint is installed' } : { ready: false }
    },
    async install(run, report) {
      report({ text: 'Installing dprint…', progress: 0 })
      const { code, stderr } = await run('npm', ['install', '--global', 'dprint'], { timeoutMs: 5 * 60_000 })
      if (code !== 0) throw new Error(stderr.trim() || `npm exited with code ${code}`)
      report({ progress: 1 })
    },
  },
}

export default formatter
```

| Field | What it is |
|---|---|
| `description` | Text, or a function of the extension's values that returns text. |
| `check(run, values)` | Returns `{ ready, message? }`. A throw counts as not ready, with the error shown. |
| `install(run, report, values)` | Installs. Call `report({ text?, progress? })` as it goes; `progress` runs from 0 to 1. A throw shows as the install's error. |

How setup behaves:

- Kothar checks again after an install, and whenever one of the extension's settings changes. So a setup can depend on
  the settings.
- `run` here works like [`host.run`](host.md#run): it runs a command and resolves with `{ code, stdout, stderr }`.
- The user can cancel an install. After that, the next `run` call rejects with "Cancelled".

List `setup` in the manifest's `uses`.
