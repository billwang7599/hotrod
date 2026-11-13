---
title: Working with other extensions
description: How the agent combines your extension's tools with Kothar's and other extensions', and how to write tools it can combine.
---

# Working with other extensions

Most of the time, your extension never needs to know about another one. **The agent combines them.** Every tool an
extension offers reaches every chat it's on for, on every engine, through Kothar's MCP server. So with Deep Research,
Notes and workers all on, an agent can hand a research run to a worker, then save the report as a note, with no code
linking the three.

Kothar helps it along. Each session's instructions start with a short **What you can use** section, made from what the
chat can use right now:

```text
What you can use, from Kothar and from the extensions the user turned on, is listed below. They work together: when a
task needs more than one, combine them on your own, without being asked. […]

- Workers (spawn_worker, stop_chat): hand a whole task to a new chat below this one, which works while you talk and reports back.
- Deep Research (deep_research): Long, multi-source research that ends in a cited report.
- Notes (list_notes, read_note, write_note, search_notes): …
- Your extension (your_tool): the first sentence of your description.
```

It's made from your extension's `name`, the first sentence of its `description` and the names of the tools it offers
the chat, so a community extension is listed exactly like a built-in one. Only extensions with a tool for the chat are
listed. The user can change the intro in **Settings → Prompts**, and the Inspector shows the whole section under
"What was sent".

## Workers get your tools too

A worker (a chat an agent starts with `spawn_worker`, or an extension with
[`host.createChat({ parentId })`](reference/host.md#start-a-worker)) gets the same extension tools as the chat that
started it, under the same switches: its space's setup and per-chat settings apply. The only thing a worker can't do
is start workers itself. So "run this in a worker" works for any tool you write.

Leave a tool out of workers (`offered: (caller) => !caller.worker`) only when it makes no sense there, such as a tool
that hands the user a plan to approve in their own chat. Built-in tools that do this today:

| Tool | Extension | Why not in a worker |
|---|---|---|
| `submit_plan` | Plan | It hands the plan in to the user's own chat for approval. |
| `create_chat` | Home | Only Home makes spaces. |
| `deep_research` | Deep Research | Not to its own research workers: research doesn't nest. Any other worker can run it. |

## Writing tools an agent can combine

The agent decides what to call from your tool's name and description alone. Write them for an agent that has never
seen your extension, with a dozen others beside it.

- **Name tools for what they do, with a verb and the thing:** `write_note`, `deep_research`, `clip_page`. Not `run`,
  `do_it` or your extension's name alone. Names are global across extensions: a clash leaves your tool out (Kothar logs
  why), so make yours specific.
- **Start the description with what the tool does and returns**, in one sentence. Then when to use it, and when not
  ("not for quick lookups"). Say how long it takes if it's slow, so the agent can hand it to a worker instead of
  waiting.
- **Say what the result is good for next:** "Returns the note's name, which read_note opens." A result another tool
  can take (a name, a path, an id) is what lets the agent chain them.
- **Return paths, ids and short summaries**, not whole documents. A worker's report goes back to its lead as text; keep
  it short enough to pass on.
- **Don't name other extensions' tools in your descriptions.** They may be off, renamed or replaced. Describe your
  tool's inputs and outputs, and let the agent find the rest in What you can use.
- **Keep `instructions` for rules, not a tool list.** Kothar already lists your tools. Use `instructions` for what the
  agent must always do or never do with them ("Ask before deleting a note").
- **Make the first sentence of `description` say what the extension is for:** it's the line agents read in What you can
  use.
- **Make tools safe to run from a worker:** a worker runs while the user talks with its lead, and nobody watches it.
  Don't wait on the user in a worker's chat; use `host.requestPermission`, which reaches the user wherever they are.

## When code has to know about another extension

Use the agent first. Reach for code only when one extension changes how another one looks or behaves, such as a
setting that means nothing without another extension. See
[Depending on other extensions](reference/dependencies.md).
