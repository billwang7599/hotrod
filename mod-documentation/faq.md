---
title: FAQ and troubleshooting
description: Answers to common questions, and what to do when a mod won't load or behave.
---

# FAQ and troubleshooting

## My mod is on, but nothing happens

- Is the **Community mods** switch on, in **Settings → Community mods**? While it's off, no community mod runs.
- Did you restart Kothar? Mods load when Kothar starts. The row says **Starts when Kothar restarts** until you do.
- Does the mod's row show **Couldn't load**? It says why. See below.
- Is your hook in the right place? For example, `tools` only reach engines that take MCP servers (Claude Code and pi),
  and `onPermissionRequested` never fires for pi, which doesn't ask.

## "Couldn't load" errors

| Error | Fix |
|---|---|
| main.mjs has no default export | `export default` your mod object. |
| its id "…" is not its manifest's "…" | Make the mod object's `id` match `manifest.json`. |
| "enabled" is not a setting key | Rename that setting. |
| it uses "…" without listing it in its manifest | Add the value to `uses` in `manifest.json`, or remove the field. |
| it imports …, which its main.mjs doesn't bundle | Bundle your npm packages into `main.mjs` (the template's `npm run build` does). |
| its tool or chat "…" is already taken | Rename the tool or chat id; another mod has it. |

## "can't use host.… : its manifest doesn't list …"

The mod called a host method its manifest didn't list. Add the value the error names to `uses`. See
[The manifest and uses](reference/manifest.md).

## Install from folder says "has no main.mjs. Build the mod first."

Run `npm run build` in your mod's folder, then try again.

## I changed my mod, but Kothar runs the old one

Build again, press **Reinstall** on its Marketplace entry, and restart Kothar. Installing copies the files; Kothar
doesn't watch your folder.

## A hook throws. Does that break the chat?

No. Kothar shows the error as "Mod name: message" and carries on. A transform that throws leaves the text as it was. A
tool that throws sends the error to the agent as a failed tool call.

## Can I keep data between restarts?

Yes. Use [`host.storage`](reference/host.md#storage). Files go in the garage's `mods/<id>/` folder and stay even when
the mod is uninstalled.

## Can my mod use npm packages?

Yes, if you bundle them into `main.mjs`. Kothar installs nothing for a mod. `main.mjs` may import only Node's built-in
modules.

## Can a mod change how the agent works inside a turn?

No. Mods work only through what every engine shares: sessions, prompts, streamed events, permission requests, and what
each session gets at its start. See the [Introduction](introduction.md#what-mods-cant-do).

## Can a mod add a worker under a space?

Yes. `host.createChat` with `parentId` makes a child chat, made just as the built-in Workers mod makes a worker. See
[Child chats](reference/host.md#child-chats). The host sets no limit on how many run, so set one of your own.

## GitHub says the request limit is used up

Kothar asks GitHub about releases without a token, which allows 60 requests an hour. Set `KOTHAR_GITHUB_TOKEN` to a
GitHub token before starting Kothar to lift it.

## Is my mod safe to install?

Read [The risks](using-mods.md#the-risks). In short: Kothar holds a mod to what its manifest lists through the mod API,
but can't stop it from using Node's own APIs. Install only mods you trust, and read **See changes** before you update.
