---
title: Using extensions
description: Turn built-in extensions on and off, install community extensions from the Marketplace, update them, and
know the risks. ---

# Using extensions

Kothar has two kinds of extensions:

- **Built-in extensions** ship with Kothar. You turn them on and off in **Settings → Built-in extensions**.
- **Community extensions** are written by other people. You install them from the Marketplace or from a folder, and
  manage them in **Settings → Community hub**.

## Built-in extensions

Open **Settings → Built-in extensions** and flip an extension's switch. A built-in extension switches on or off without
a restart. Chats pick up the change at their next message.

An extension with settings, or with a setup step, gets a page of its own under **Extensions** in Settings while it's on.
A setup step installs something the extension needs, such as a browser. Its page shows whether the extension is ready,
with an **Install** button when it isn't.

The built-in extensions today:

| Extension | On by default | What it does |
|---|---|---|
| Home | Yes | A pinned chat beside your spaces, your personal assistant. It can see every space and make new ones. |
| Memory | Yes | Every chat remembers its whole conversation, with older messages as summaries. Off, a fresh session sees only the latest messages that fit. |
| Workers | Yes | Leads can hand a task to a worker chat, which reports back when it ends. |
| Processes | Yes | Agents can run dev servers and watchers that keep going between messages. Adds a Processes tab. |
| Browser | No | Agents browse the web with Playwright in the background, one browser per space. When a page needs you, the agent hands it to you in a window and carries on when you click Done. |
| Git | No | A Changes tab for spaces with git folders: branches, changed files, diffs and pull requests. |
| Account rotation | No | When an account hits its usage limit, switch to the next saved account and carry on. |
| Reconnect | Yes | When a turn ends because the connection dropped or the engine's service was down, wait for it to come back and continue the turn. |

### Where Memory keeps its summaries, and cleaning up

Memory writes its summaries into each chat's own folder, beside the chat's log, in Kothar's data folder:

| Mode (Settings → Extensions → Memory → Older messages) | File |
|---|---|
| Rolling summary (the default) | `<data folder>/chats/<chat id>/rolling.json` |
| Summary tree | `<data folder>/chats/<chat id>/summaries.jsonl` |

On a Mac the data folder is `~/Library/Application Support/Kothar/`. Memory's page in Settings shows the real path, with
a copy button, and how much disk each mode's summaries take.

- **Switching modes deletes nothing.** Kothar summarizes every chat in the new mode right away, reusing what that mode
  had already written, so switching back and forth costs little.
- **Turning Memory off deletes nothing.** Chats then see only their latest messages. Turned on again, Memory carries on
  where it stopped.
- **Deleting a chat deletes its summaries** with it.
- **Delete summaries**, on Memory's page, deletes one mode's files from every chat, workers' and Home's included. It
  works only for a mode that isn't in use, or for either while Memory is off, and asks first. Chat logs stay. If you
  switch back to that mode later, Kothar writes the summaries again with model calls on your own logins.

### When the connection drops

Engines retry short drops on their own. When a drop lasts longer, the turn ends with an error, and Reconnect takes over:

- The chat shows **waiting**, with "Offline: will continue when the connection is back" above the composer. A
  worker's bar shows in its space too, and the worker doesn't report to its lead yet.
- Kothar checks whether the engine's API answers after 5 seconds, then twice as long each time, up to every 5 minutes.
  Once it answers, the chat continues the turn where it stopped, with its memory.
- An overloaded or unavailable service (errors like 529 or 503) waits the same way, without the network check.
- **Try now** checks at once. **Don't continue**, **Stop** or sending a message ends the wait; your message then runs
  as usual.
- After the longest wait (Settings → Extensions → Reconnect, 2 hours by default), or 5 continuations of one message,
  Kothar stops trying and the turn ends with its error.

A Stop, a usage limit or any other error ends the turn as before.

## Community extensions

### Turn community extensions on

Community extensions have a master switch, and it starts **off**. While it's off, no community extension runs, whatever
its own switch says.

1. Open **Settings → Community hub**.
2. Turn on the **Community extensions** switch.
3. Kothar shows what that means. Read it, then confirm.

You can still browse and install extensions while the switch is off. They just won't run.

### Find and install an extension

The **Marketplace** opens in its own window. To open it:

- Click **Browse…** in **Settings → Community hub** or **Settings → Appearance**. It always opens on **All**.
- Or give it a shortcut in **Settings → Shortcuts**. It has none by default.

The window has a search box and filters at the top: **All**, **Themes** or **Extensions**, and **Everything**,
**Installed** or **Updates available**. Pick an entry in the list to see its details on the right: its versions, its
release notes, and for an extension, the list of what it uses.

Click **Install**. For an extension, Kothar first shows what the extension says it uses, such as "Runs programs on your
computer" or "Reads your chats". If you confirm, it downloads the extension from its author's latest GitHub release.

**An extension always arrives turned off.** Installing never runs any of its code.

### Turn an extension on

1. In **Settings → Community hub**, flip the extension's own switch.
2. Kothar shows where the extension comes from and what it says it uses. Confirm.
3. A notice appears: **Restart Kothar to apply**, with a **Restart** button. Click it.

Extensions load when Kothar starts, so turning one on, turning it off, or updating it takes a restart. If chats are
running, Kothar asks before restarting, since a restart stops them. When Kothar runs from source (`npm run dev`), it
can't restart itself; stop it and start it again.

Each extension's row shows its state, such as **Starts when Kothar restarts** or **Running 1.0.0. Restart Kothar to run
1.1.0**. If an extension fails to load, its row says why.

### Update an extension

Kothar never updates an extension by itself. When an author publishes a new release, the Marketplace shows **Update** on
that entry, and the **Updates available** filter counts it.

Before you update, click **See changes**. It opens GitHub's comparison between the release you have and the latest
one, so you can read what changed. Updates aren't reviewed by anyone.

If an update uses more than the version you turned on, such as an extension that now also runs programs, Kothar turns it
off and tells you what's new. Turn it on again to allow that.

### Install from a folder

**Install from folder…**, in the Marketplace window, copies an extension or a theme from a folder on your computer,
without publishing anything. It's how you try your own extension before you share it.

- **An extension:** a folder with `manifest.json` and a built `main.mjs`.
- **Themes:** a folder with `<id>.json` theme files, in the folder itself or in a `themes/` folder inside it.

Things installed this way are marked **Local**, and the Marketplace never offers to update them. After you change
your extension, build it again and press **Reinstall** to copy it again, then restart.

### Uninstall

Click **Uninstall** on the extension's row in **Settings → Community hub**, or on its entry in the Marketplace. Kothar
deletes the extension's code. Files the extension saved for itself stay in your garage, in `extensions/<id>/`.

## The risks

A community extension is code, and it runs inside Kothar with your permissions.

- **Kothar holds an extension to its list.** Every extension lists what it uses. Kothar shows that list before you
  install it, and won't start an extension that uses more than it listed through the extension API.
- **But Kothar can't sandbox it.** An extension could still read your files, read your settings or reach the network
  with Node's own APIs, without listing anything.
- **Review is one-time.** A person reviews an extension when it first joins the Marketplace. Later updates reach you
  without another review.
- **An update can change what an extension does.** Read **See changes** before you update.

Turn on only extensions you trust. Themes are different: they're colour files, checked before they install, so they
can't run code. See [Themes](themes.md).
