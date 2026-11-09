---
title: Introduction
description: What a Kothar mod is, what it can and can't do, and the words these pages use.
---

# Introduction

## What a mod is

Most coding agents have extensions of their own. Those only work with that one agent, and they often break when
another program runs the agent in the background. Kothar moves extensions up a layer. A mod is written once, against
Kothar's mod API, and works with every engine Kothar drives: Claude Code, pi, and any engine added later.

A mod is one JavaScript object. Kothar reads its fields and calls its hooks. Here is a whole mod that adds a command to
every chat:

```ts
import type { Mod } from '@kothar/mod-api'

const hello: Mod = {
  id: 'hello',
  name: 'Hello',
  description: 'Adds a command that writes a greeting into the chat.',
  enabledByDefault: false,
  commands: [
    {
      id: 'greet',
      label: 'Say hello',
      run(chat, { host }) {
        host.note(chat.id, 'Hello!')
      },
    },
  ],
}

export default hello
```

## What mods can do

Mods reach engines only through surfaces that every engine shares:

- **Sessions and prompts.** A mod can send messages, start chats, retry or continue a turn, and stop one.
- **Streamed output.** A mod sees every event as it arrives: text, thinking, tool calls, permission requests and the
  end of each turn.
- **Permission requests.** A mod can allow or deny what an agent asks to do.
- **Session start.** A mod can give each session MCP servers, tools and extra instructions.

On top of those, a mod can add panels to the right sidebar, commands to a chat's General tab, settings to Kothar's
Settings, chats of its own, and a setup step that installs what it needs.

## What mods can't do

A mod can't change how an engine works inside a turn. It can't filter the agent's context mid-turn, route each turn to
a different model, or hook into an engine's own plugin system. Kothar treats engines as black boxes and talks to them
only through their headless mode. That limit is what lets one mod work with every engine.

## Words these pages use

| Word | Meaning |
|---|---|
| **Engine** | A coding agent Kothar drives, such as Claude Code or pi. |
| **Chat** | A conversation in Kothar. Each message starts a fresh engine session, and Kothar gives it the chat's memory. |
| **Space** | A top-level chat with its own context: folders, files and instructions. Its agent works in the space's own work folder. |
| **Lead** | The agent behind a space. It plans, does small tasks itself and hands bigger ones to workers. |
| **Worker** | A chat a lead starts below its own space for one task. Its final reply wakes the lead. Older versions of Kothar called these subagents. |
| **Home** | Your personal assistant: one pinned chat beside your spaces that can see and message all of them. It's a built-in mod. |
| **Built-in mod** | A mod that ships with Kothar, such as Home, Processes or Browser. |
| **Community mod** | A mod someone else wrote, installed from the Marketplace or from a folder. |
| **Garage** | The folder where Kothar keeps settings, accounts, chats and each mod's files. On a Mac it's `~/Library/Application Support/Kothar/`. |
| **Tool** | Something an agent calls: run a command, edit a file, call an MCP server. A mod can give agents tools, but a mod is not a tool. |

## Next

- To install and run mods, see [Using mods](using-mods.md).
- To write one, start with the [Quick start](quick-start.md).
