---
title: Kothar extension documentation
description: How to use, build and publish extensions and themes for Kothar.
---

# Kothar extension documentation

Kothar is a desktop app for running coding agents. You bring the engines (Claude Code, pi and others), and Kothar
gives you one place to drive them all. A small core does the driving. Extensions add the rest.

An **extension** is written once and works with every engine Kothar drives. It can add panels and commands, give agents tools
and MCP servers, add to their instructions, watch chats as they run, answer permission requests and rewrite messages.

## Start here

- **New to extensions?** Read the [Introduction](introduction.md).
- **Want to install one?** See [Using extensions](using-mods.md).
- **Want to build one?** Follow the [Quick start](quick-start.md), then read [Extension anatomy](anatomy.md).
- **Looking something up?** The [API reference](reference/mod.md) covers every field, hook and host call.
- **Ready to share it?** See [Publishing](publishing.md).
- **Making a theme?** Themes are colour files, not code. See [Themes](themes.md).

## All pages

1. [Introduction](introduction.md): what an extension is, what it can and can't do, and the words these pages use.
2. [Using extensions](using-mods.md): built-in and community extensions, the Marketplace, installing, updating and the risks.
3. [Quick start](quick-start.md): your first extension, from the template to running in Kothar.
4. [Extension anatomy](anatomy.md): `manifest.json`, `main.mjs` and the extension object.
5. API reference
   - [The extension object](reference/mod.md)
   - [Settings and setup](reference/settings.md)
   - [Tools, MCP servers, instructions and memory](reference/agents.md)
   - [Panels and commands](reference/panels.md)
   - [Events and hooks](reference/events.md)
   - [The host](reference/host.md)
   - [The manifest and `uses`](reference/manifest.md)
   - [Types](reference/types.md)
6. [Examples](examples.md): how three built-in extensions are put together.
7. [Publishing](publishing.md): releases, the catalog and updates.
8. [Themes](themes.md): the theme format and how to publish one.
9. [FAQ and troubleshooting](faq.md)

The extension API is [MIT licensed](https://github.com/billwang7599/kothar/blob/main/packages/mod-api/LICENSE), so your
extensions can use any licence you like.
