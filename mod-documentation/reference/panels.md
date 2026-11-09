---
title: Panels and commands
description: Add tabs to the right sidebar and actions to a chat's General tab.
---

# Panels and commands

## Panels

`panels` adds tabs to the right sidebar, beside **General** and **Context**. A panel's code runs in Kothar's core, not
in the window. It returns its UI as data, a **view**, and Kothar draws it with its own controls. So a panel looks like
the rest of Kothar in every theme, and runs no code in the window.

```ts
import type { Mod } from '@kothar/mod-api'

const counts = new Map<string, number>()

const counter: Mod = {
  id: 'counter',
  name: 'Counter',
  description: 'A tab that counts.',
  enabledByDefault: false,
  panels: [
    {
      id: 'counter',
      title: 'Counter',
      shown: (chat) => chat.mod === undefined, // not in Home
      render(chat) {
        const count = counts.get(chat.id) ?? 0
        return {
          type: 'stack',
          children: [
            { type: 'heading', text: 'Counter' },
            { type: 'text', text: `${count} clicks`, tone: count > 9 ? 'accent' : 'normal' },
            {
              type: 'row',
              children: [
                { type: 'button', label: 'Add one', action: { name: 'add' }, variant: 'primary' },
                { type: 'button', label: 'Reset', action: { name: 'reset' }, disabled: count === 0 },
              ],
            },
          ],
        }
      },
      onAction(action, chat) {
        if (action.name === 'add') counts.set(chat.id, (counts.get(chat.id) ?? 0) + 1)
        if (action.name === 'reset') counts.delete(chat.id)
      },
    },
  ],
}

export default counter
```

A `ModPanel` has:

| Field | What it is |
|---|---|
| `id` | The panel's id, unique within the mod. |
| `title` | The tab's label. |
| `shown(chat, context)` | Optional. Whether this chat gets the tab. Without it, every chat does. |
| `render(chat, context)` | Returns the panel's view, or a promise of one. If it throws, the panel shows the error. |
| `onAction(action, chat, context)` | Optional. Called when the user clicks something with an `action` in the panel. |

When the panel redraws:

- When the user opens the tab.
- After each `onAction` finishes. Kothar waits for its promise, then calls `render` again.
- When the mod calls [`host.refresh(chatId)`](host.md#refresh). Call it when what the panel shows changes on its own,
  such as when a process prints output. `refresh` also asks `shown` again, so a tab can appear or disappear.

List `panels` in the manifest's `uses`.

### Actions

An action is `{ name, value? }`. `name` is a string you choose; `value` is any JSON value. Buttons and list rows carry
one. The same action comes back to `onAction`.

```ts
import type { ModView } from '@kothar/mod-api'

const row: ModView = {
  type: 'list',
  items: [{ key: 'web', label: 'web', action: { name: 'open', value: { id: 'web', tab: 'log' } } }],
}
```

### Views

A view is one of these, nested with `stack`, `row` and `card`:

| `type` | Fields | What it draws |
|---|---|---|
| `stack` | `children`, `gap?: 'tight' \| 'normal' \| 'loose'` | Children one under another. |
| `row` | `children`, `justify?: 'start' \| 'between' \| 'end'` | Children side by side. |
| `card` | `title`, `children`, `badges?`, `open?` | A titled card that folds. `open` says how it starts. |
| `heading` | `text`, `hint?` | A section heading. |
| `text` | `text`, `tone?`, `mono?`, `small?`, `hint?` | A line of text. |
| `badge` | `text`, `tone?`, `hint?` | A small label. |
| `elapsed` | `since` (epoch ms), `tone?`, `mono?`, `small?`, `hint?` | A live time since that moment, such as an uptime. Kothar ticks it, so you needn't redraw. |
| `button` | `label`, `action`, `variant?: 'normal' \| 'primary' \| 'ghost'`, `disabled?`, `hint?` | A button. |
| `link` | `text`, `url` | A link that opens in the browser. |
| `list` | `items`, `empty?`, `label?` | A list of rows. `empty` is shown when there are none. |
| `code` | `text`, `language?`, `maxLines?`, `follow?` | Code or output. See below. |
| `divider` | none | A line. |
| `empty` | `text` | A quiet placeholder, such as "No processes". |

`hint` is an explanation shown on hover. Keep labels short and put explanations in hints.

**Tones** colour text, badges and dots: `normal`, `muted`, `faint`, `accent`, `success`, `warning`, `error`. They follow
the user's theme.

**Code:** `language: 'diff'` colours added and removed lines; other languages are shown plain. For output that grows,
such as a log, set `follow: true`. Then `maxLines` keeps the last lines instead of the first, and the view stays
scrolled to the end as lines arrive, unless the user scrolls up.

### List rows

Each item in a `list` has:

| Field | What it is |
|---|---|
| `key` | Unique within the list. |
| `label` | The row's main text. |
| `detail` | A second, quieter line or column. |
| `since` | A live time since this moment (epoch ms), shown in place of `detail`, such as `5s`, `2m 5s` or `1h 2m`. |
| `mono` | Show the label in a monospace font. |
| `badges` | `{ text, tone?, hint? }[]` |
| `dot` | A status dot before the label, in a tone. |
| `link` | `{ text, url }`: a link at the end of the row, apart from its action. |
| `selected` | Show the row as selected. |
| `action` | Clicking the row sends this action. |
| `hint` | Shown on hover. |

```ts
import type { ModView } from '@kothar/mod-api'

const startedAt = Date.now()

const processes: ModView = {
  type: 'list',
  label: 'Processes',
  empty: 'Nothing running',
  items: [
    {
      key: 'web',
      label: 'npm run dev',
      mono: true,
      dot: 'success',
      since: startedAt,
      badges: [{ text: ':5173', tone: 'accent' }],
      link: { text: 'Open', url: 'http://localhost:5173' },
      action: { name: 'open', value: 'web' },
    },
  ],
}
```

## Commands

`commands` adds actions to a chat's **General** tab. A command is a button with a label. It runs your code and shows
nothing of its own.

```ts
import type { Mod } from '@kothar/mod-api'

const summarize: Mod = {
  id: 'summarize',
  name: 'Summarize',
  description: 'A command that asks the agent for a summary.',
  enabledByDefault: false,
  commands: [
    {
      id: 'summarize',
      label: 'Summarize this chat',
      hint: 'Sends a message asking the agent to summarize the chat so far.',
      shown: (chat) => !chat.worker, // leads and Home, not workers
      run(chat, { host }) {
        host.send(chat.id, 'Summarize this chat so far in five bullet points.')
      },
    },
  ],
}

export default summarize
```

| Field | What it is |
|---|---|
| `id` | Unique within the mod. |
| `label` | The button's text. |
| `hint` | Optional. Shown on hover. |
| `shown(chat, context)` | Optional. Whether this chat gets the command. Asked again on [`host.refresh`](host.md#refresh). |
| `run(chat, context)` | Runs when the user clicks it. A throw or rejection shows as an error. |

List `commands` in the manifest's `uses`. This example also calls `host.send`, so it lists `sendMessages` too.
