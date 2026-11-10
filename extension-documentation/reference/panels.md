---
title: Panels and commands
description: Add tabs to the right sidebar and actions to a chat's General tab.
---

# Panels and commands

## Panels

`panels` adds tabs to the right sidebar, beside **General** and **Context**, or popups over the chat. A panel's code runs in Kothar's core, not
in the window. It returns its UI as data, a **view**, and Kothar draws it with its own controls. So a panel looks like
the rest of Kothar in every theme, and runs no code in the window.

```ts
import type { Extension } from '@kothar/extension-api'

const counts = new Map<string, number>()

const counter: Extension = {
  id: 'counter',
  name: 'Counter',
  description: 'A tab that counts.',
  enabledByDefault: false,
  panels: [
    {
      id: 'counter',
      title: 'Counter',
      shown: (chat) => chat.extension === undefined, // not in Home
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

A `ExtensionPanel` has:

| Field | What it is |
|---|---|
| `id` | The panel's id, unique within the extension. |
| `title` | The tab's label. |
| `shown(chat, context)` | Optional. Whether this chat gets the tab. Without it, every chat does. |
| `render(chat, context)` | Returns the panel's view, or a promise of one. If it throws, the panel shows the error. |
| `onAction(action, chat, context)` | Optional. Called when the user clicks something with an `action` in the panel. |
| `placement` | Optional. `'tab'` (the default) or `'popup'`: a large window over the chat, for work that wants room, such as notes. Esc closes it. It draws for the chat that's open, as a tab does. |
| `shortcut` | Optional. Keys that open the panel out of the box, such as `'Mod+Shift+N'` (`Mod` is ⌘ on macOS, Ctrl elsewhere). A popup opens or closes; a tab shows in the right sidebar. The user can change them in **Settings → Shortcuts**. Keys another shortcut already has, or that aren't a shortcut (no ⌘, ⌃ or ⌥), are left off. |
| `sidebar` | Optional. `true` adds an entry to the left sidebar, above **Settings**, that opens the panel. |

When the panel redraws:

- When the user opens the tab.
- After each `onAction` finishes. Kothar waits for its promise, then calls `render` again.
- When the extension calls [`host.refresh(chatId)`](host.md#refresh). Call it when what the panel shows changes on its
  own, such as when a process prints output. `refresh` also asks `shown` again, so a tab can appear or disappear.

List `panels` in the manifest's `uses`.

### Actions

An action is `{ name, value? }`. `name` is a string you choose; `value` is any JSON value. Buttons and list rows carry
one. The same action comes back to `onAction`.

```ts
import type { ExtensionView } from '@kothar/extension-api'

const row: ExtensionView = {
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
| `text` | `text`, `tone?`, `mono?`, `small?`, `hint?`, `copy?`, `reveal?` | A line of text. With `copy`, a button beside it copies the text, such as a path. With `reveal`, a **Show in Finder** button shows the path the text is, by [`host.reveal`](host.md#reveal)'s rule: a path outside Kothar's folders shows an error when clicked. |
| `badge` | `text`, `tone?`, `hint?` | A small label. |
| `elapsed` | `since` (epoch ms), `tone?`, `mono?`, `small?`, `hint?` | A live time since that moment, such as an uptime. Kothar ticks it, so you needn't redraw. |
| `button` | `label`, `action`, `variant?: 'normal' \| 'primary' \| 'ghost'`, `disabled?`, `hint?`, `confirm?`, `pick?` | A button. With `confirm: { text, body?, ok?, danger? }`, Kothar asks first in its own dialog and sends the action only if the user confirms. With `pick: { kind: 'folder' \| 'file', title? }`, it opens the system's picker and sends the action with `value`: the picked path (nothing if the user cancels). The picker is only in the desktop app; in a browser tab a pick button isn't drawn, so offer another way too, such as a form for a typed path. |
| `link` | `text`, `url` | A link that opens in the browser. |
| `list` | `items`, `empty?`, `label?` | A list of rows. `empty` is shown when there are none. |
| `code` | `text`, `language?`, `maxLines?`, `follow?` | Code or output. See below. |
| `divider` | none | A line. |
| `form` | `fields`, `submit`, `cancel?`, `key?` | Text fields the user fills in. See below. |
| `empty` | `text` | A quiet placeholder, such as "No processes". |
| `switch` | `setting`, `label?`, `hint?`, `disabled?` | A switch for one of the extension's boolean `spaceSettings`. See below. |
| `picker` | `setting`, `label?`, `hint?`, `disabled?` | A picker for one of the extension's select `spaceSettings`. See below. |
| `split` | `side`, `main` | Two columns, for a popup: a narrow `side`, such as a list, and `main`, such as an editor. Each scrolls on its own. In a narrow panel `side` sits above `main`. |
| `search` | `action`, `key?`, `value?`, `placeholder?`, `label?` | A search box. As the user types, it sends `{ name: action, value: text }` after a short pause. What's typed stays as the panel redraws; a new `key` starts over at `value`. |
| `editor` | `key`, `text`, `change`, `links?`, `tags?`, `label?`, `placeholder?`, `autofocus?` | A Markdown editor with live preview. See below. |

`hint` is an explanation shown on hover. Keep labels short and put explanations in hints.

### Forms

A `form` takes text from the user, such as a note to save. Each field is
`{ name, label, value?, placeholder?, rows?, mono?, hint? }`: `value` is its starting text, and `rows` above 1 makes it a
multi-line box. Kothar keeps what's typed in the window until the user submits, then sends your `onAction` the action
`{ name: submit.action, value: { [field name]: text } }`. `cancel: { label, action }` adds a button that sends its action
as any button does. A form whose `key` or starting values change starts over, so give an edit form the key of what it
edits.

```ts
{
  type: 'form',
  key: 'new-note',
  fields: [
    { name: 'name', label: 'Name' },
    { name: 'body', label: 'Note', rows: 8, mono: true },
  ],
  submit: { label: 'Save', action: 'save' },
  cancel: { label: 'Cancel', action: { name: 'cancel' } },
}
```

**Tones** colour text, badges and dots: `normal`, `muted`, `faint`, `accent`, `success`, `warning`, `error`. They follow
the user's theme.

**Code:** `language: 'diff'` colours added and removed lines; other languages are shown plain. For output that grows,
such as a log, set `follow: true`. Then `maxLines` keeps the last lines instead of the first, and the view stays
scrolled to the end as lines arrive, unless the user scrolls up.

### Editor

An `editor` edits Markdown with a live preview, as Obsidian does. The text stays plain Markdown, but outside the line
being edited its marks are hidden and it's drawn as it reads: headings, bold, italics, code, quotes, lists and links.

- **Saving:** it sends `{ name: change, value: text }` with the whole text, a moment after the user stops typing, and
  when the editor loses focus or closes.
- **Starting over:** a new `key` starts over at `text`. With the same `key`, a new `text` (say, the file changed on
  disk) replaces the editor's only while the user has nothing unsent.
- **Links and tags:** `[[wikilinks]]` and `#tags` are drawn as links. With `links`, clicking one sends
  `{ name: links, value: target }`, where the target is the part before any `|` or `#`. With `tags`, clicking a tag
  sends `{ name: tags, value: tag }`, without the `#`. On the line being edited, ⌘-click (Ctrl-click elsewhere)
  follows them, so a plain click still places the cursor.

```ts
{ type: 'editor', key: note.path, text: note.body, change: 'save', links: 'open-link', tags: 'filter-tag' }
```

### Switches and pickers

A `switch` or `picker` shows one of the extension's [settings per space](settings.md#settings-per-space) for the panel's
space (a worker's panel shows its space's). Name the setting's `key` in `setting`; `label` defaults to the setting's
label.

- Kothar fills in the current value and a picker's options. You don't set them.
- When the user changes one, Kothar checks and saves the value and draws the panel again. No `onAction` is needed.
- A `switch` needs a `boolean` setting and a `picker` a `select` one. Naming anything else shows an error in place of
  the panel.

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
import type { ExtensionView } from '@kothar/extension-api'

const startedAt = Date.now()

const processes: ExtensionView = {
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
import type { Extension } from '@kothar/extension-api'

const summarize: Extension = {
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
| `id` | Unique within the extension. |
| `label` | The button's text. |
| `hint` | Optional. Shown on hover. |
| `shown(chat, context)` | Optional. Whether this chat gets the command. Asked again on [`host.refresh`](host.md#refresh). |
| `run(chat, context)` | Runs when the user clicks it. A throw or rejection shows as an error. |

List `commands` in the manifest's `uses`. This example also calls `host.send`, so it lists `sendMessages` too.
