---
title: FAQ and troubleshooting
description: Answers to common questions, and what to do when an extension won't load or behave.
---

# FAQ and troubleshooting

## My extension is on, but nothing happens

- Is the **Community extensions** switch on, in **Settings → Community hub**? While it's off, no community extension
  runs.
- Did you restart Kothar? Extensions load when Kothar starts. The row says **Starts when Kothar restarts** until you do.
- Does the extension's row show **Couldn't load**? It says why. See below.
- Is your hook in the right place? For example, `tools` only reach engines that take MCP servers (Claude Code, pi, Codex and OpenCode),
  and `onPermissionRequested` never fires for pi, which doesn't ask.

## "Couldn't load" errors

| Error | Fix |
|---|---|
| main.mjs has no default export | `export default` your extension object. |
| its id "…" is not its manifest's "…" | Make the extension object's `id` match `manifest.json`. |
| "enabled" is not a setting key | Rename that setting. |
| it uses "…" without listing it in its manifest | Add the value to `uses` in `manifest.json`, or remove the field. |
| it imports …, which its main.mjs doesn't bundle | Bundle your npm packages into `main.mjs` (the template's `npm run build` does). |
| its tool or chat "…" is already taken | Rename the tool or chat id; another extension has it. |

## "can't use host.… : its manifest doesn't list …"

The extension called a host method its manifest didn't list. Add the value the error names to `uses`. See
[The manifest and uses](reference/manifest.md).

## Install from folder says "has no main.mjs. Build the extension first."

Run `npm run build` in your extension's folder, then try again.

## I changed my extension, but Kothar runs the old one

Build again, press **Reinstall** on its Marketplace entry, and restart Kothar. Installing copies the files; Kothar
doesn't watch your folder.

## A hook throws. Does that break the chat?

No. Kothar shows the error as "Extension name: message" and carries on. A transform that throws leaves the text as it
was. A tool that throws sends the error to the agent as a failed tool call.

## Can I keep data between restarts?

Yes. Use [`host.storage`](reference/host.md#storage). Files go in the garage's `extensions/<id>/` folder and stay even
when the extension is uninstalled.

## Can my extension use npm packages?

Yes, if you bundle them into `main.mjs`. Kothar installs nothing for an extension. `main.mjs` may import only Node's
built-in modules.

## Can an extension change how the agent works inside a turn?

No. Extensions work only through what every engine shares: sessions, prompts, streamed events, permission requests, and
what each session gets at its start. See the [Introduction](introduction.md#what-extensions-cant-do).

## Can an extension add a worker under a space?

Yes. `host.createChat` with `parentId` makes a child chat, made just as the built-in Workers extension makes a worker.
See [Child chats](reference/host.md#child-chats). The host sets no limit on how many run, so set one of your own.

## GitHub says the request limit is used up

Kothar asks GitHub about releases without a token, which allows 60 requests an hour. Set `KOTHAR_GITHUB_TOKEN` to a
GitHub token before starting Kothar to lift it.

## Is my extension safe to install?

Read [The risks](using-extensions.md#the-risks). In short: Kothar holds an extension to what its manifest lists through
the extension API, but can't stop it from using Node's own APIs. Install only extensions you trust, and read **See
changes** before you update. An update stays off until you turn it on again.

## My extension was written when extensions were called mods

It still loads and type-checks. Nothing an extension does at runtime changed: the default export has the same fields,
`manifest.json` the same keys, and `ChatDetail` still carries the owning extension under `mod` as well as `extension`.
The API package is now `@kothar/extension-api` (it was `@kothar/mod-api`), and its types are named `Extension`,
`ExtensionHost`, `ExtensionContext` and so on. Every old name (`Mod`, `ModHost`, `ModContext`, …) is still exported as a
deprecated alias for the new one. The API is types only, so a built `main.mjs` never imports either package.

Marketplace catalogs may still give an extension's `kind` as `"mod"`; Kothar reads it as `"extension"`. Settings, data
and installs saved under the old names move over on Kothar's first start.
