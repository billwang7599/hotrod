---
title: Types
description: The data types extensions receive - chats, spaces, log entries and engine events.
---

# Types

All of these come from the extension API's types. The full source is
[`packages/extension-api/index.ts`](https://github.com/billwang7599/kothar/blob/main/packages/extension-api/index.ts).

## Chats

`ChatSummary` is a chat's identity. Tools, MCP servers and `onLimitReached` get one.

| Field | What it is |
|---|---|
| `id` | The chat's id. |
| `name` | Its name. |
| `engine` | The engine it runs on, such as `claude-code`, `pi`, `codex` or `opencode`. |
| `parentId` | Set for a worker: the chat that started it. |
| `worker` | `true` for a worker. |

`ChatDetail` is a `ChatSummary` plus:

| Field | What it is |
|---|---|
| `model` | The model its next message runs on, as Kothar picks it (the chat's own pick, then its setup's, then its model list's), in the engine's own id, such as `claude-sonnet-5-5` or `anthropic/claude-sonnet-4-5`. Absent when nothing can run on its engine. Also absent while its model list picks a model on another engine that the chat hasn't moved to yet: a chat busy with a turn when its list changes moves when its next message starts. |
| `status` | `idle`, `running`, `waiting` (on the user) or `stopping`. |
| `archived` | Whether it's archived. |
| `extension` | Set on an extension's own chat, such as Home: the extension's id. |
| `folders` | The folders in its context. |
| `files` | The files in its context. |
| `createdAt` | When it was made (ISO time). |
| `parentMessages` | Set for a worker: how many of its parent's messages there were when it started, so a memory extension can freeze its view of the parent there. |

A **space** is a chat with no `parentId` and no `extension`.

## Spaces

`host.space(chatId)` returns a `SpaceDetail`:

| Field | What it is |
|---|---|
| `id`, `name` | The space's. |
| `workDir` | The folder its agents work in. Absent until the space's first message picks one. |
| `folders` | `{ path, git }[]`: its folders, and whether each is a git repository. |
| `checkouts` | `{ folder, path, branch, from? }[]`: each git folder's checkout in the work folder. `path` and `branch` are the checkout's; `from` is the branch the folder was on when Kothar checked it out. |

## Log entries

`host.read(chatId)` returns `ChatEntry`s. Each has `at` (ISO time) and a `type`:

| `type` | Fields | What it is |
|---|---|---|
| `user.message` | `text`, `attachments?`, `midTurn?` | A message you sent. `midTurn` is set when it was sent while a turn ran and taken in by that turn. |
| `worker.report` | `text`, `chatId`, `name`, `error?` | A worker's final reply, delivered to its lead. |
| `permission.resolved` | `requestId`, `allow`, `auto?` | A permission request was answered. `auto` is set when Kothar or an extension answered it. |
| `question.resolved` | `requestId`, `answers?` | An agent's question was answered, or declined if there are no answers. |
| `extension.note` | `text`, `extension?`, `panel?` | A note from [`host.note`](host.md#notes). |
| Any engine event | | Every [engine event](#engine-events) except streamed deltas and steering. Completed text is logged as `text.completed`. |

## Memory messages

`host.messages(chatId)` and a memory's `view` get a chat's log as `MemoryMessage`s: `{ id, kind, at, text }`. They're
the entries a conversation is made of, numbered from 0 in log order. Every memory numbers them the same way.

| `kind` | What it is |
|---|---|
| `user` | Your words. |
| `work` | A report from a worker, or a message from another chat. |
| `talk` | The agent's reply. |
| `tool` | A tool call. |
| `echo` | A tool call's output. |
| `note` | A turn that ended early. |

## Engine events

Every engine's events are translated into these, so an extension reads the same stream from every engine. `onEvent` gets
all of them.

| `type` | Fields | What it is |
|---|---|---|
| `turn.started` | | A turn began. |
| `text.delta` | `text` | A piece of the reply, as it streams. |
| `text.completed` | `text` | A finished block of reply text. |
| `thinking.delta` | `text` | A piece of the agent's thinking. |
| `tool.started` | `toolId`, `name`, `kind`, `summary`, `input`, `path?` | The agent called a tool. |
| `tool.completed` | `toolId`, `output`, `isError`, `stopped?` | A tool call finished. `stopped`: it was cut short and the engine never reported its result. |
| `permission.requested` | `requestId`, `toolId?`, `name`, `kind`, `summary`, `path?`, `command?`, `input` | The agent asks to do something. |
| `question.asked` | `requestId`, `toolId?`, `questions` | The agent asks you questions with options to pick. |
| `limit.reached` | `message`, `resetsAt?` | The account ran into a usage or rate limit. |
| `steer.landed` | `id` | A message you sent mid-turn entered the running turn. |
| `steer.returned` | `id` | A message you sent mid-turn was handed back unsent. |
| `turn.completed` | `error?` | A turn ended. |
| `session.ended` | `error?` | The engine session ended. |

A tool's `kind` is one of `shell`, `edit`, `read`, `search`, `fetch`, `mcp` or `other`, the same across engines. So one
permission policy works for every engine.
