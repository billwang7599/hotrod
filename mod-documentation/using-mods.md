---
title: Using mods
description: Turn built-in mods on and off, install community mods from the Marketplace, update them, and know the risks.
---

# Using mods

Kothar has two kinds of mods:

- **Built-in mods** ship with Kothar. You turn them on and off in **Settings → Built-in mods**.
- **Community mods** are written by other people. You install them from the Marketplace or from a folder, and manage
  them in **Settings → Community mods**.

## Built-in mods

Open **Settings → Built-in mods** and flip a mod's switch. A built-in mod switches on or off without a restart. Chats
pick up the change at their next message.

A mod with settings, or with a setup step, gets a page of its own under **Mods** in Settings while it's on. A setup
step installs something the mod needs, such as a browser. Its page shows whether the mod is ready, with an **Install**
button when it isn't.

The built-in mods today:

| Mod | On by default | What it does |
|---|---|---|
| Home | Yes | A pinned chat beside your spaces, your personal assistant. It can see every space and make new ones. |
| Memory | Yes | Every chat remembers its whole conversation, with older messages as summaries. Off, a fresh session sees only the latest messages that fit. |
| Workers | Yes | Leads can hand a task to a worker chat, which reports back when it ends. |
| Processes | Yes | Agents can run dev servers and watchers that keep going between messages. Adds a Processes tab. |
| Browser | No | Agents browse the web with Playwright in the background, one browser per space. When a page needs you, the agent hands it to you in a window and carries on when you click Done. |
| Git | No | A Changes tab for spaces with git folders: branches, changed files, diffs and pull requests. |
| Account rotation | No | When an account hits its usage limit, switch to the next saved account and carry on. |

## Community mods

### Turn community mods on

Community mods have a master switch, and it starts **off**. While it's off, no community mod runs, whatever its own
switch says.

1. Open **Settings → Community mods**.
2. Turn on the **Community mods** switch.
3. Kothar shows what that means. Read it, then confirm.

You can still browse and install mods while the switch is off. They just won't run.

### Find and install a mod

The **Marketplace** opens in its own window. To open it:

- Click **Browse…** in **Settings → Community mods** (it opens on mods), or in **Settings → Appearance** (it opens on
  themes).
- Or give it a shortcut in **Settings → Shortcuts**. It has none by default.

The window has a search box and filters at the top: **All**, **Themes** or **Mods**, and **Everything**, **Installed**
or **Updates available**. Pick an entry in the list to see its details on the right: its versions, its release notes,
and for a mod, the list of what it uses.

Click **Install**. For a mod, Kothar first shows what the mod says it uses, such as "Runs programs on your computer" or
"Reads your chats". If you confirm, it downloads the mod from its author's latest GitHub release.

**A mod always arrives turned off.** Installing never runs any of its code.

### Turn a mod on

1. In **Settings → Community mods**, flip the mod's own switch.
2. Kothar shows where the mod comes from and what it says it uses. Confirm.
3. A notice appears: **Restart Kothar to apply**, with a **Restart** button. Click it.

Mods load when Kothar starts, so turning one on, turning it off, or updating it takes a restart. If chats are running,
Kothar asks before restarting, since a restart stops them. When Kothar runs from source (`npm run dev`), it can't
restart itself; stop it and start it again.

Each mod's row shows its state, such as **Starts when Kothar restarts** or **Running 1.0.0. Restart Kothar to run
1.1.0**. If a mod fails to load, its row says why.

### Update a mod

Kothar never updates a mod by itself. When an author publishes a new release, the Marketplace shows **Update** on that
entry, and the **Updates available** filter counts it.

Before you update, click **See changes**. It opens GitHub's comparison between the release you have and the latest
one, so you can read what changed. Updates aren't reviewed by anyone.

If an update uses more than the version you turned on, such as a mod that now also runs programs, Kothar turns it off
and tells you what's new. Turn it on again to allow that.

### Install from a folder

**Install from folder…**, in the Marketplace window, copies a mod or a theme from a folder on your computer, without
publishing anything. It's how you try your own mod before you share it.

- **A mod:** a folder with `manifest.json` and a built `main.mjs`.
- **Themes:** a folder with `<id>.json` theme files, in the folder itself or in a `themes/` folder inside it.

Things installed this way are marked **Local**, and the Marketplace never offers to update them. After you change
your mod, build it again and press **Reinstall** to copy it again, then restart.

### Uninstall

Click **Uninstall** on the mod's row in **Settings → Community mods**, or on its entry in the Marketplace. Kothar
deletes the mod's code. Files the mod saved for itself stay in your garage, in `mods/<id>/`.

## The risks

A community mod is code, and it runs inside Kothar with your permissions.

- **Kothar holds a mod to its list.** Every mod lists what it uses. Kothar shows that list before you install it, and
  won't start a mod that uses more than it listed through the mod API.
- **But Kothar can't sandbox it.** A mod could still read your files, read your settings or reach the network with
  Node's own APIs, without listing anything.
- **Review is one-time.** A person reviews a mod when it first joins the Marketplace. Later updates reach you without
  another review.
- **An update can change what a mod does.** Read **See changes** before you update.

Turn on only mods you trust. Themes are different: they're colour files, checked before they install, so they can't
run code. See [Themes](themes.md).
