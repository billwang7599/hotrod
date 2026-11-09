---
title: Kothar mod documentation
description: How to use, build and publish mods and themes for Kothar.
---

# Kothar mod documentation

Kothar is a desktop app for running coding agents. You bring the engines (Claude Code, pi and others), and Kothar
gives you one place to drive them all. A small core does the driving. Mods add the rest.

A **mod** is written once and works with every engine Kothar drives. It can add panels and commands, give agents tools
and MCP servers, add to their instructions, watch chats as they run, answer permission requests and rewrite messages.

## Start here

- **New to mods?** Read the [Introduction](introduction.md).
- **Want to install one?** See [Using mods](using-mods.md).
- **Want to build one?** Follow the [Quick start](quick-start.md), then read [Mod anatomy](anatomy.md).
- **Looking something up?** The [API reference](reference/mod.md) covers every field, hook and host call.
- **Ready to share it?** See [Publishing](publishing.md).
- **Making a theme?** Themes are colour files, not code. See [Themes](themes.md).

## All pages

1. [Introduction](introduction.md): what a mod is, what it can and can't do, and the words these pages use.
2. [Using mods](using-mods.md): built-in and community mods, the Marketplace, installing, updating and the risks.
3. [Quick start](quick-start.md): your first mod, from the template to running in Kothar.
4. [Mod anatomy](anatomy.md): `manifest.json`, `main.mjs` and the mod object.
5. API reference
   - [The mod object](reference/mod.md)
   - [Settings and setup](reference/settings.md)
   - [Tools, MCP servers, instructions and memory](reference/agents.md)
   - [Panels and commands](reference/panels.md)
   - [Events and hooks](reference/events.md)
   - [The host](reference/host.md)
   - [The manifest and `uses`](reference/manifest.md)
   - [Types](reference/types.md)
6. [Examples](examples.md): how three built-in mods are put together.
7. [Publishing](publishing.md): releases, the catalog and updates.
8. [Themes](themes.md): the theme format and how to publish one.
9. [FAQ and troubleshooting](faq.md)

The mod API is [MIT licensed](https://github.com/billwang7599/kothar/blob/main/packages/mod-api/LICENSE), so your
mods can use any licence you like.
