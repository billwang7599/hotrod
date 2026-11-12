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
| Browser | No | Agents browse the web with Playwright in the background, one browser per space, on a profile of Kothar's own, in your own Chrome through the Kothar extension, or on a copy of one of yours. When a page needs you, or the agent wants to show you something, it opens in a window and the agent carries on when you click Done. |
| Git | No | A Changes tab for spaces with git folders: branches, changed files, diffs and pull requests, kept current while agents work. |
| Account rotation | No | When an account hits its usage limit, switch to the next saved account and carry on. |
| Notes | Yes | Your own Markdown notes, as in Obsidian, global or per space, in a popup over the chat (⌘⇧N). Agents reach them with tools when you ask. |
| Artifacts | Yes | What agents make for you, such as pages, small apps, diagrams, documents and code files, kept per space with every version, shown sandboxed beside the chat, and all in a library popup (⌘⇧A). |
| Plan | Yes | A **Plan first** chip beside the message box, for coding sessions. While it's on, the chat is read only: Kothar's sandbox and permission answers refuse edits and commands that change anything, on every engine, and it plans on your Planning models if you've set some. The agent hands in a plan (goal, files, steps, risks, tests) and the amber bar asks you to approve, edit or cancel it. Approve turns the chip off and starts the work; the Plan tab ticks steps off as the agent goes. Its page in Settings hides the chip, and can stop requiring a tests step. |
| Reconnect | Yes | When a turn ends because the connection dropped or the engine's service was down, wait for it to come back and continue the turn. |
| Skills | Yes | Saved instructions for kinds of task, in the Agent Skills format (a folder with a SKILL.md), the same on every engine. Agents see a one-line list of the skills that are on and read one when a task fits. Its page in Settings lists them, turns each on or off, and imports more from a folder, a .zip or .skill file, a GitHub link, or the skills folders of Claude Code, Codex and pi. Skills from GitHub start off, so you can read them first. |
| Deep Research | Yes | Long, multi-source research that ends in a cited report. Turn on **Deep research** in a chat's composer, use **New research** (⌘⇧D), or ask the agent. You approve a plan of sub-questions, workers search and read the web, and every claim in the report cites a quote Kothar found on its page. |

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

### Artifacts

Notes are your documents; artifacts are what agents build for you to look at, use or keep: a page or small app, a React
component, an SVG, a Mermaid diagram, a Markdown document or a code file. Ask for one ("make me a chart of this", "mock
up the settings page") and the agent makes it with a tool instead of pasting it into its reply.

- **Beside the chat:** when an agent makes or updates an artifact, it opens in a panel beside the chat, and a card in
  the chat opens it again. The panel is also the **Artifacts** tab in the right sidebar. It shows only this space's
  artifacts (a worker's are its space's); **‹** goes to their list, searchable.
- **The library:** **Artifacts** in the left sidebar, or **⌘⇧A** (Ctrl+Shift+A elsewhere; change it in **Settings →
  Shortcuts**), opens every space's artifacts in a popup over the chat, from any chat, Home too. **⋯** beside the
  heading picks one space; search finds one by title, description or type. Click one to see it there, and its **⋯ →
  Open beside chat** moves it into the panel beside the chat you're in.
- **One artifact:** **Preview** draws it, **Code** shows its source, **Changes** what its latest version changed.
  **Copy** and **Download** take it out. Its **⋯** has **Open in browser**, **Rename** and **Delete** (every version,
  after asking).
- **Versions:** an agent changing an artifact saves a new version and keeps the old ones. **‹ ›** step through them;
  hover the version for what changed and when. **Restore this version** saves an old one as the newest.
- **Sandboxed:** an artifact's scripts run, but in a frame of its own. It can't reach Kothar, your token or your
  files, and it can't load anything from the internet. **Load files from the internet**, under this space's list, lets
  this space's artifacts load scripts, styles, fonts, images and media from `https:` sites, such as a chart library from
  a CDN. They still can't fetch data or open WebSockets, but each site they load from sees the request, and a page's
  script could put data in the addresses it loads.
- **Open in browser** opens the file in your default browser, outside Kothar's sandbox, where it can reach the web as any
  local page can.
- **Files:** a space's artifacts are in `<data folder>/chats/<space id>/artifacts/<name>/`: `v1.html`, `v2.html`…
  (each type with its own extension) and `artifact.json` (title, type, description, versions). They go when the space
  is deleted. Home keeps none.
- **Agents** are told when to make one. They use `create_artifact`, `update_artifact`, `list_artifacts` and
  `read_artifact`, which see only their own space's; a worker shares its space's artifacts.

### Deep Research

Deep Research answers a question from many web sources and writes a report with numbered citations.

- **Starting one:** turn on the **Deep research** chip beside Attach in a chat's composer. It's off in each chat until you
  turn it on, and stays on until you turn it off: each message you send then goes to research (a plain "thanks" is just
  answered). Or open **New research** (left sidebar, or **⌘⇧D**) and type a question, or ask the agent to research
  something in depth; agents have a `deep_research` tool.
- **The plan:** first it drafts 3 to 8 sub-questions and the kinds of sources to check, and waits: **Start**, **Edit**
  (change the sub-questions in the **Research** tab) or **Cancel**. Nothing is searched until you start. Turn off **Ask
  before starting research** in **Settings → Extensions → Deep Research** to skip this.
- **The research:** each sub-question goes to a worker, listed under the space while it runs, on your **Searching**
  models (Settings → Models) unless you pick another list. Workers use web search and fetch first, and a browser only
  when a page needs one. Each returns findings: a claim, the exact quote that supports it, and the page. Kothar then
  fetches each page itself and keeps a finding only if the quote is on it. A review step then looks for gaps and
  contradictions and runs one or two more rounds (Standard and Thorough).
- **The report:** an executive summary, sections, notes where sources disagree, a confidence and open questions
  section, and a numbered source list with each page's title, link and the date it was read. Every statement cites a
  kept finding; anything the writer says without one is left out, and the report says how much was. It's saved as an
  artifact if Artifacts is on, else as a note if Notes is on, else as a file in the space's folder, and a card in the chat
  opens it.
- **The Research tab** lists each space's research, newest first, with its phase ("Researching 2 of 5"), sources read
  and time so far. **Stop** ends one early, and you still get a report from what was found, marked partial. A finished
  one opens its report beside the chat in one click; **⋯** shows the evidence (every finding, kept or dropped, with its
  quote) or deletes it.
- **Limits:** depth sets how far it goes: Quick (about 3 sub-questions, up to 4 workers and 12 sources), Standard (4 to 6,
  10 and 30, one follow-up round) and Thorough (6 to 8, 20 and 60, two). **Most workers** and **Most sources** in its
  settings cap any run. Reaching a cap ends the research with a partial report.
- **Files:** each run's plan, findings and sources are in `<data folder>/extensions/deep-research/runs/<space id>/`, so
  you can check where a claim came from later. They go when the space is deleted.
- **What it can't check:** some sites refuse plain page fetches, and their findings are dropped. PDFs aren't read.

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

**Which browser.** Settings → Extensions → Browser → **Browser** picks what runs Kothar's own profile: **Google
Chrome (installed)**, the default, or **Bundled Chromium** (Playwright's Chrome for Testing, installed from the same
page). Chrome runs on a profile of Kothar's own per space (`<data folder>/extensions/browser/chrome-profiles/<space>/`),
never your everyday Chrome profile, its cookies or its tabs. Without Chrome installed, the bundled Chromium runs, and
the settings page says so. The two keep separate folders, since Chrome refuses a profile a newer version last opened,
so switching starts the other one logged out (the old folder stays until you switch back or delete the space).

**Signing in.** Google, and some other sites, refuse to sign you in on a browser that software controls. So signing
in happens in a plain window: **Sign in…** in a chat's General tab or on the Browser row in Processes, and an agent's
`ask_user_in_browser`, open the space's profile as an ordinary browser window, with no remote debugging and nothing of
Kothar's attached, on the agent's tabs. Sign in, then click **Done** (or quit the browser): it closes, and the agents'
browser goes on in the background on the same profile, signed in, with the tabs the window had. Kothar can't see into
that window, so closing its last window doesn't end it on macOS; Done or quitting does.

**Which profile.** Settings → Extensions → Browser → **Profile** lists **Kothar's own** (the default: a profile per
space that starts logged out), every profile of the Chrome, Chrome Beta or Canary, Brave, Edge, Arc and Chromium you
have installed, and **Other folder…** for a profile folder you name. New profiles show up the next time the page opens.

**Your own Chrome.** Pick **Your Chrome (Kothar extension)** in **Profile** and agents browse in the Chrome you use
every day, with your logins, Google included, and nothing copied. No browser of Kothar's starts. Setting it up once:

1. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the folder Settings → Extensions → Browser shows
   (`extensions/browser/chrome-extension/` in Kothar).
3. Click the Kothar extension's icon and paste the pairing code from the same settings page. It turns **Connected**.

Each space gets a blue **Kothar · *space*** tab group, which opens in a window of its own behind yours. Agents open,
read, click, type and close tabs only in their space's group. The extension refuses any other tab, and Kothar refuses
calls that read every cookie, change permissions or close Chrome. Drag a tab out of the group to take it back: agents
lose it at once. Popups from an agent's tab join its group. While agents work, Chrome shows its own "Kothar started
debugging this browser" bar. Clicking its Cancel detaches them until they next browse. `show_browser` and
`ask_user_in_browser` bring the space's group to the front, and **Done** carries on, as above. **Show browser** in a
chat's General tab does the same.

The extension talks only to Kothar on `127.0.0.1`. It has to present the pairing code, and its connection must come
from the extension itself, so web pages can't connect. **New code** on the settings page makes a new code and
disconnects the extension until you paste the new one. If Kothar isn't running, or the extension isn't paired, an
agent's browser calls say so, and it asks you instead.

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
keep working in other apps. They say they're Chrome rather than headless Chrome, which some sites turn away, and they
don't tell pages they're automated (`navigator.webdriver`). Nothing fakes a fingerprint beyond that.

**When you're needed.** An agent calls `ask_user_in_browser` (log in, CAPTCHA, payment: a plain window, as above) or
`show_browser` (look at this). The browser opens in a window with the agent's tabs, in front of your other apps, the chat shows **Open
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
