---
title: Quick start
description: Build your first Kothar extension from the Hello example, install it from a folder and try it.
---

# Quick start

This page takes you from nothing to your own extension running in Kothar. It starts from **Hello**, the example
extension in the [kothar-sample-mod](https://github.com/billwang7599/kothar-sample-mod) repo. You'll need Node.js 22 or
later, Git and Kothar.

## What Hello does

Hello is small, but it shows the main parts of an extension:

- **A Hello tab** in the right sidebar. It counts your messages and the agent's replies in the chat, shows the time
  since your last message, and has a **Say hello** button.
- **A Say hello command** in each chat's General tab. It writes a greeting into the chat, for you only.
- **A Greeting setting**, on Hello's own page in Settings, for what Say hello writes.
- **A `hello_stats` tool** that agents can call to learn how many messages you've sent in the chat.

Its `manifest.json` lists only what it uses:

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.1.0",
  "author": "Kothar",
  "description": "An example community extension: a tab counting the messages in each space, a greeting command, and a tool.",
  "api": 1,
  "uses": ["panels", "commands", "settings", "tools", "events", "readChats"]
}
```

It never runs programs, reaches the network or sends messages, so it doesn't list `run` or `sendMessages`.

## 1. Try Hello first

To see a finished extension before you build one, install Hello itself:

1. Open **Settings → Community hub** and turn on the **Community extensions** switch. Confirm the warning.
2. Click **Browse…** to open the Marketplace window, find **Hello** and click **Install**.
3. Back in **Settings → Community hub**, turn on Hello's switch, confirm, and click **Restart**.
4. Open any space. A **Hello** tab appears in the right sidebar.

If Hello isn't in the Marketplace yet, clone the repo and use **Install from folder…** instead, as in step 5 below.

## 2. Start from the template

On GitHub, open [kothar-sample-mod](https://github.com/billwang7599/kothar-sample-mod) and click **Use this template**
to make a repo of your own from it. Then:

```sh
git clone https://github.com/you/my-extension.git
cd my-extension
npm install
```

What's inside:

| File | What it is |
|---|---|
| `src/index.ts` | The extension: one object, the default export. |
| `manifest.json` | The extension's id, name, version, author, description, API version and `uses`. |
| `types/extension-api.ts` | Kothar's extension API types, copied in. `npm run update-types` fetches the latest. |
| `scripts/check.mjs` | Checks the built extension the way Kothar will. |
| `.github/workflows/` | Checks every push, and publishes a release when you push a version tag. |

The extension API isn't on npm, so the types are copied into the repo. They're types only, so none of it ends up in your
built extension. In the template you import them from `'../types/extension-api.ts'`; these pages write
`'@kothar/extension-api'` for short.

## 3. Read the code

`src/index.ts` is about a hundred lines. The parts, in order:

**The setting.** `values.greeting` holds what the user picked.

```ts
import type { ExtensionSetting } from '@kothar/extension-api'

const settings: ExtensionSetting[] = [
  {
    key: 'greeting',
    label: 'Greeting',
    description: 'What Say hello writes into the chat.',
    type: 'text',
    default: 'Hello from the Hello extension.',
  },
]

export { settings }
```

**The command.** `host.note` writes a line into the chat that agents don't see. It needs nothing listed.

```ts
import type { ChatDetail, ExtensionCommand, ExtensionContext } from '@kothar/extension-api'

const greet = (chat: ChatDetail, { values, host }: ExtensionContext) => host.note(chat.id, String(values.greeting))

const command: ExtensionCommand = { id: 'greet', label: 'Say hello', run: greet }

export { command, greet }
```

**The tab.** `render` returns the tab's view as data; Kothar draws it. The button sends a `greet` action back to
`onAction`. `host.read` reads the chat's log, which is why the manifest lists `readChats`.

```ts
import type { ExtensionPanel } from '@kothar/extension-api'

const panel: ExtensionPanel = {
  id: 'hello',
  title: 'Hello',
  render(chat, { host }) {
    const yours = host.read(chat.id).filter((entry) => entry.type === 'user.message').length
    return {
      type: 'stack',
      children: [
        { type: 'heading', text: `Hello, ${host.space(chat.id)?.name ?? chat.name}` },
        { type: 'list', items: [{ key: 'yours', label: 'Your messages', detail: String(yours) }] },
        { type: 'button', label: 'Say hello', action: { name: 'greet' }, variant: 'primary' },
      ],
    }
  },
  onAction(action, chat, { host, values }) {
    if (action.name === 'greet') host.note(chat.id, String(values.greeting))
  },
}

export { panel }
```

**The tool.** Agents see `hello_stats` on Kothar's MCP server. `caller` is the chat that called it.

```ts
import type { ExtensionTool } from '@kothar/extension-api'

const tool: ExtensionTool = {
  name: 'hello_stats',
  description: 'Tells you how many messages the user has sent in this chat.',
  inputSchema: { type: 'object', properties: {} },
  offered: () => true,
  run(_input, { caller, host }) {
    const yours = host.read(caller.id).filter((entry) => entry.type === 'user.message').length
    return `${yours} messages from the user.`
  },
}

export { tool }
```

**The events.** The tab's counts change as turns run, so Hello redraws it when a turn starts and when it ends.
`host.refresh` only redraws panels that are open. These hooks are why the manifest lists `events`.

```ts
import type { Extension } from '@kothar/extension-api'

const hooks: Pick<Extension, 'onTurnStarted' | 'onTurnCompleted'> = {
  onTurnStarted: ({ chat }, { host }) => host.refresh(chat.id),
  onTurnCompleted: ({ chat }, { host }) => host.refresh(chat.id),
}

export { hooks }
```

## 4. Make it yours

1. Pick an id: lowercase letters, digits and dashes, such as `my-extension`. Put it in both `manifest.json` and
   `src/index.ts`; the two must match. Change `name`, `description` and `author` too.
2. Change what the extension does. For instance, change the greeting's default, or add a row to the tab.
3. Keep `uses` honest. If you add a call such as `host.send`, add `sendMessages`; if you drop the tool, remove `tools`.
   [The manifest and uses](reference/manifest.md) says what each field and host call needs.

Then build and check it:

```sh
npm run typecheck
npm run build      # bundles src/ into main.mjs
npm run check      # checks main.mjs and manifest.json as Kothar will
```

`main.mjs` must be one ES module that imports only Node's built-in modules (`node:fs`, `node:path` and so on). The
build bundles any npm packages you use into it.

## 5. Install it in Kothar

1. Open **Settings → Community hub** and click **Browse…** to open the Marketplace window.
2. In the Marketplace window, click **Install from folder…** and pick your extension's folder.
3. It installs as **Local**, turned off.
4. In **Settings → Community hub**, turn on the **Community extensions** switch if it's off, then your extension's own
   switch.
5. Click **Restart**.

## 6. Try it

- Open a space. Your tab appears in the right sidebar; click **Say hello**.
- In the space's **General** tab, run **Say hello**.
- Change the greeting on your extension's page in Settings, under **Extensions**, and say hello again.
- Ask the agent: "Call hello_stats and tell me what it says."

To change the extension, edit `src/index.ts`, run `npm run build`, press **Reinstall** on its entry in the Marketplace
window, and restart Kothar.

## Next

- [Extension anatomy](anatomy.md) explains each part of an extension.
- The [API reference](reference/extension.md) lists everything an extension can do.
- [Publishing](publishing.md) shows how to share it.
