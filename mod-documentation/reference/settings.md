---
title: Settings and setup
description: Give a mod settings the user can change, and a setup step that installs what it needs.
---

# Settings and setup

## Settings

`settings` lists the mod's settings. While the mod is on, Kothar shows them on the mod's own page in Settings, under
**Mods**, and saves what the user picks. Every hook gets the current values as `values`, keyed by each setting's `key`.

```ts
import type { Mod } from '@kothar/mod-api'

const reminders: Mod = {
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
    if (values.onlySpaces && (chat.mod !== undefined || chat.worker)) return undefined
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
- `enabled` isn't allowed as a key. Kothar uses it for the mod's own switch.
- Values are typed `string | number | boolean`, so convert them where you use them, as `String(values.rules)` does above.
- A change applies at each chat's next message. Hooks always get the current values.

List `settings` in the manifest's `uses`.

## Setup

A `setup` checks for something the mod needs, such as a program, and installs it if it's missing. Kothar shows the
setup on the mod's page in Settings: the description, whether it's ready, an **Install** button when it isn't, and a
progress bar while it installs.

```ts
import type { Mod } from '@kothar/mod-api'

const formatter: Mod = {
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
| `description` | Text, or a function of the mod's values that returns text. |
| `check(run, values)` | Returns `{ ready, message? }`. A throw counts as not ready, with the error shown. |
| `install(run, report, values)` | Installs. Call `report({ text?, progress? })` as it goes; `progress` runs from 0 to 1. A throw shows as the install's error. |

How setup behaves:

- Kothar checks again after an install, and whenever one of the mod's settings changes. So a setup can depend on the
  settings, as the built-in Browser mod's does.
- `run` here works like [`host.run`](host.md#run): it runs a command and resolves with `{ code, stdout, stderr }`.
- The user can cancel an install. After that, the next `run` call rejects with "Cancelled".

List `setup` in the manifest's `uses`.
