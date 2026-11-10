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
| Browser | No | Agents browse the web with Playwright in the background, one browser per space, on a profile of Kothar's own or a copy of one of yours. When a page needs you, or the agent wants to show you something, it opens in a window and the agent carries on when you click Done. |
| Git | No | A Changes tab for spaces with git folders: branches, changed files, diffs and pull requests, kept current while agents work. |
| Account rotation | No | When an account hits its usage limit, switch to the next saved account and carry on. |
| Notes | Yes | Your own Markdown notes, as in Obsidian, global or per space, in a popup over the chat (⌘⇧N). Agents reach them with tools when you ask. |
| Reconnect | Yes | When a turn ends because the connection dropped or the engine's service was down, wait for it to come back and continue the turn. |

### Where Memory keeps its summaries, and cleaning up

Memory writes its summaries into each chat's own folder, beside the chat's log, in Kothar's data folder:

| Mode (Settings → Extensions → Memory → Older messages) | File |
|---|---|
| Rolling summary (the default) | `<data folder>/chats/<chat id>/rolling.json` |
| Summary tree | `<data folder>/chats/<chat id>/summaries.jsonl` |

On a Mac the data folder is `~/Library/Application Support/Kothar/`. Memory's page in Settings shows the real path, with
a copy button and **Show in Finder**, and how much disk each mode's summaries take.

- **Switching modes deletes nothing.** Kothar summarizes every chat in the new mode right away, reusing what that mode
  had already written, so switching back and forth costs little.
- **Turning Memory off deletes nothing.** Chats then see only their latest messages. Turned on again, Memory carries on
  where it stopped.
- **Deleting a chat deletes its summaries** with it.
- **Delete summaries**, on Memory's page, deletes one mode's files from every chat, workers' and Home's included. It
  works only for a mode that isn't in use, or for either while Memory is off, and asks first. Chat logs stay. If you
  switch back to that mode later, Kothar writes the summaries again with model calls on your own logins.

### Notes

Notes are yours, as in Obsidian: Markdown files you write and keep, global or per space. They open in a popup over the
chat, with **⌘⇧N** (Ctrl+Shift+N elsewhere; change it in **Settings → Shortcuts**) or **Notes** in the sidebar. Esc
closes it.

- **The popup** lists the notes on the left, this space's and global ones, with a search box that searches names,
  descriptions and text. The open note is on the right in a live-preview editor: the Markdown is drawn as it reads, and
  its marks show only on the line you're editing. It saves as you type.
- **Links:** `[[Another note]]` links to a note by name (`[[Name|shown text]]` shows other text). Click it to open
  that note, or to make it if there's none yet; on the line you're editing, ⌘-click. A note in this space wins over a
  global one of the same name. Under the editor, **Linked from** lists the notes that link to the open one.
- **Tags:** `#tag` anywhere in a note's text (not in code) tags it. The tags show as a row above the list: click one,
  or a tag in the editor, to list only the notes that have it, and click it again to show them all.
- **New note** makes an `Untitled` note in this space (**New global** for every space) and asks for its name.
  **Rename** changes its name and its one-line description; **Delete** asks first.
- **Add to context** puts the open note in this space's **Context → Files**, so the space's agents get it in full
  from their next message, as any context file. Remove it there as usual. Home has no context, so no such button.
- **Global notes** are in `<data folder>/extensions/notes/<name>.md`. **A space's notes** are in
  `<data folder>/chats/<space id>/notes/<name>.md`, so they go when the space is deleted. Home keeps no notes of its
  own: it sees global ones.
- **Agents** get nothing from your notes in their prompts unless you add one to context. When you ask ("put that in my notes", "what did I write
  about X"), they use `search_notes`, `list_notes`, `read_note`, `write_note` and `delete_note`. A note's file is named
  from its name, so names that differ only in punctuation (`C++ tests`, `C tests`) would share one: the second is
  refused rather than overwriting the first, and the popup refuses a rename to a name already taken. `delete_note`
  deletes only a note with exactly the name given (letter case aside), and when this space and global notes both have
  that name, the agent must say which.

Notes are plain files: you can also open either folder as an Obsidian vault, edit them in any editor, or add a `.md`
file. A file without the `---` front matter is named after the file. An open popup shows such changes within a couple
of seconds.

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
  Kothar stops trying and the turn ends with its error, and you get a notification saying so.

A Stop, a usage limit or any other error ends the turn as before.

### Browser: your profile, in the background

**Which profile.** Settings → Extensions → Browser → **Profile** lists **Kothar's own** (the default: a profile per
space that starts logged out), every profile of the Chrome, Chrome Beta or Canary, Brave, Edge, Arc and Chromium you
have installed, and **Other folder…** for a profile folder you name. New profiles show up the next time the page opens.

**How your profile is used.** Never in place: your browser keeps running untouched, and its profile folder is only
read. When a space's browser starts, Kothar copies the profile's login state into a folder of its own
(`<data folder>/extensions/browser/mirrors/<space>/`) and runs that browser's own app on the copy:

- Copied: cookies, site storage (Local Storage, IndexedDB, Session Storage) and saved passwords and autofill (Login
  Data, Web Data). A single site's IndexedDB over 200 MB is left out, and the settings page says which.
- Not copied: history, bookmarks, extensions, open tabs, and the browser's own settings and sign-in (Preferences), so
  the agents' browser doesn't open your startup pages or sync.
- On macOS your browser encrypts cookies and passwords with a key in your login Keychain ("Chrome Safe Storage" and
  the like) that only its own app may read without asking. Running the copy on that same app reads it with no prompt.
  A copy run on any other browser would see no cookies, so a folder must belong to an installed browser.
- The copy is made again each time a space's browser starts from closed (on its first browse, after it closed for
  being idle, or after **Refresh logins now**). A hand-off to you in a window keeps the copy it's on. Logins made only
  in the agents' browser are kept in memory across an idle close, and go when Kothar quits; to keep one, log in in your
  own browser.
- Each space's copy goes when the space is deleted. **Refresh logins now** closes the browsers running in the
  background, so the next browse takes a fresh copy.

**In the background.** Agents' browsers run headless: no window, no Dock icon, and they never take focus, so you can
keep working in other apps. They say they're Chrome rather than headless Chrome, which some sites turn away.

**When you're needed.** An agent calls `ask_user_in_browser` (log in, CAPTCHA, payment) or `show_browser` (look at
this). The browser opens in a window with the agent's tabs, in front of your other apps, the chat shows **Open
browser** and **Done** (with a notification if you're away from Kothar), and Done puts it back in the background
where you left it. You can look at any time: **Show browser** in a chat's General tab,
or **Show** on the Browser row in Processes; **Hide** puts it back.

**What agents get.** Playwright's browser tools, less four they rarely need (`browser_run_code_unsafe`, which runs any
code in Playwright's own process, `browser_emulate_media`, `browser_drop` and `browser_resize`): 21 tools, about 17,000
characters (roughly 5,000 tokens) in each session that has the browser.

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

Updating an extension that's on asks first. **Kothar runs only the exact files you turned on**, so any update turns the
extension off until you turn it on again. When you do, the popup names what changed since the version you turned on:
the versions, anything it now also uses (such as running programs), and a link to the changes on GitHub.

The same goes for files changed any other way, such as `main.mjs` edited on disk: at the next start Kothar doesn't run
it, turns it off and says why on its row. Reinstalling a local extension with the same files keeps it on.

Kothar keeps this record as plain files in your garage:

- `community/approvals.json`: for each extension you turned on, the version, what it uses and the sha256 of its
  `manifest.json` and `main.mjs`.
- `community/history.jsonl`: every install, update, approval, held start and uninstall, one line each, with versions
  and hashes.

Extensions that were already on when Kothar started keeping approvals are approved as they were, once, and marked
`carriedOver`. That includes ones whose own switch was on while **Community extensions** was off.

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
- **It lists Node's own APIs too.** An extension that reaches the internet, reads or writes your files, or runs
  programs with Node's own APIs must list **Reaches the internet**, **Reads or writes your files** or **Runs programs on
  your computer**. Kothar reads `main.mjs` before starting it and won't start one that uses an unlisted API in plain
  sight.
- **But Kothar can't sandbox it.** The check above catches mistakes, not someone hiding what their code does: an
  extension still runs inside Kothar, and could read your files, read your settings or reach the network without
  listing anything.
- **Review is one-time.** A person reviews an extension when it first joins the Marketplace. Later updates reach you
  without another review.
- **An update can change what an extension does.** Read **See changes** before you update. Kothar won't run the new
  version until you turn it on again.

Turn on only extensions you trust. Themes are different: they're colour files, checked before they install, so they
can't run code. See [Themes](themes.md).
