# Memory bench: a fresh session per message vs a native long session

Hotrod starts a fresh engine session for every message and seeds it with the chat's memory view: the latest
messages in full, older ones as summaries (`packages/core/src/memory.ts`). Compared with letting the engine keep its
own session across messages, this may:

1. cost more input tokens, since the view is sent again every message;
2. miss prompt-cache reuse whenever the view's prefix changes (summaries rewritten, lines coarsening);
3. lose state the engine keeps internally: files it read, tool results, todo lists, its own compaction.

This bench measures that on scripted multi-turn coding tasks. It drives the real core in a throwaway garage, so
Hotrod mode is exactly what the app does: same instructions, memory view, compactor, sandbox and permission answers.

## Running it

```sh
npm run bench:memory -- --engine claude-code --task short-fix --yes
npm run bench:memory -- --engine claude-code --model claude-haiku-5-5 --yes      # every task, both modes
npm run bench:memory -- --engine pi --task long-recall --mode hotrod --yes
npm run bench:memory -- --engine fake                                            # free: checks the plumbing
```

- **Options:** `--task <name>` (repeatable; default all), `--mode both|hotrod|native`, `--model`, `--thinking`,
  `--out <dir>` (default `bench/memory/results/`, gitignored), `--keep` (keep the throwaway garage and work folder),
  `--unsandboxed` (for machines, or Hotrod chats, where macOS sandboxing can't nest).
- **Real engines bill your login, so they only run with `--yes`.** Without it the command prints the plan and exits.
- **Which login:** the throwaway garage has no saved accounts, so each engine uses its default login: Claude Code
  `~/.claude` (or `CLAUDE_CONFIG_DIR`), pi `~/.pi/agent` (or `PI_CODING_AGENT_DIR`). Point those variables at another
  account to bill that one. Hotrod mode's compactor also runs on that login, with the first of `SUMMARY_MODELS`.
- **Output:** one JSONL file per task and mode (a record per turn, then a `run` record) plus `summary.md`.

### Rough cost

Per task and mode, assuming Claude Code makes about 4 API calls a message and re-reads about 20k tokens of its
own system prompt and tools on each:

| Task | Messages | Input tokens per mode, mostly cache reads | Output |
|---|---|---|---|
| short-fix | 3 + 1 probe | ~0.3–0.5M | ~5–10k |
| feature | 15 + 3 probes | ~2–4M | ~30–60k |
| long-recall | 24 + 4 probes | ~4–8M | ~40–80k |

Cache reads bill at about a tenth of the input price, so on Haiku the whole suite is roughly a few dollars and
short-fix is cents. Opus costs several times more. On a claude.ai subscription it counts against the usage limits
instead. These are estimates; the first real run replaces them.

## What it records

Per turn (`TurnRecord` in `report.ts`):

- **Usage:** uncached input, cache read, cache write and output tokens, plus cost when the engine reports it.
- **Wall time.**
- **Seed:** what Hotrod sent this turn. In Hotrod mode that's the instructions plus the prompt with the memory view.
  In native mode it's the instructions on the first turn, then just the message.
- **Cache-break detection (`seed.ts`):** whether the last turn's view is still a prefix of this one. If not, the
  record says where they first differ, with the old and new line. It also records how many characters the whole
  seed shares with the last one.
- **The reply and any error,** plus how many permission requests the bench allowed and questions it declined.

Per run: whether the task check passed (hidden acceptance tests copied in after the last turn), the recall-probe
answers and whether each matched, and the compactor's calls and characters. The compactor reports no tokens because
`complete` returns text only.

### Tasks

`tasks/*.json`. Each has a fixture repo, a list of messages, a check command, optional hidden tests and probes.

- **short-fix** (3 turns): fix a number-parsing bug in `fixtures/calc`.
- **feature** (15 turns): grow `fixtures/todo` one feature at a time, with a rule set halfway through and a rename.
- **long-recall** (24 turns): print a 7.5 KB CSV again and again while adding functions to `fixtures/inventory`. The
  chat outgrows the 40,000-character tail, so the first turns become summaries. Probes then ask for facts given in
  turns 1, 5 and 7.

### What each engine reports

Both adapters now put a common `usage` on `turn.completed` (`TokenUsage` in `@hotrod/mod-api`), summed over the turn.

- **Claude Code:** the `result` event's `model_usage_since_last_result` gives each model's usage for that turn:
  `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens` (also split into 5-minute and
  1-hour), `costUSD`, `webSearchRequests` and `thinkingTokens`. The recorded fixture writes the cache with a 1-hour
  TTL. Older versions don't have that field. For them the adapter sums each API call's `usage` from `message_start`
  and `message_delta` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`),
  without a cost. Some results carry only `usage.output_tokens`.
- **pi:** each assistant `message_end` has `usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { input,
  output, cacheRead, cacheWrite, total } }`, plus `cacheWrite1h` and `reasoning`. The adapter sums them per turn.

## Native mode and the design rules

Native mode breaks design rule 5 on purpose: the engine keeps its own history. To keep that out of the product, it
lives only in `bench.ts` as a wrapper around any adapter. The first `start` opens a real session. Later ones reuse it
and send only the message as typed, and the core's `close` after each turn is ignored. That works because both Claude
Code (stream-json input) and pi (RPC) already keep a conversation going across prompts within one process. No
adapter or core code knows about the mode, and the normal UI can't reach it.

Native mode also differs from Hotrod in these ways:
- **No memory or zoom instructions:** it drops them, and doesn't connect the Hotrod MCP server.
- **No compaction cost:** the compactor gets stub replies.
- **Subagents are off in both modes.**
- **Unverified:** that pi keeps history across prompts with `--no-session`.

## Cache analysis (the seed as it is today)

### The seed's order

What a fresh Claude Code session sends, oldest prefix first:

1. Claude Code's tool definitions, including the Hotrod MCP tools.
2. Its system prompt.
3. Hotrod's instructions as `--append-system-prompt`: role, write rules with the work folder, checkouts, the memory
   and zoom instructions, the global and per-chat `AGENTS.md`, and pinned files.
4. The first user message: any context Claude Code adds itself, then Hotrod's prompt, `This is the conversation so
   far:` + view + `New message from the user:` + message.

### Which parts are stable

- **Tools, system prompt and Hotrod's instructions:** the same every turn of a chat, unless the user edits
  `AGENTS.md`, a pinned file or a context switch.
- **Claude Code's own environment details (unverified):** it likely adds per-session details such as the date, the
  working folder and a git status snapshot. If so, a git status that changes after each edit would invalidate
  everything after it, including the view, on every new session. A native session takes that snapshot once.
- **The view while the history fits the tail (40,000 characters):** append-only. Each turn adds its messages at the
  end.
- **The view once the history outgrows the tail:** it breaks within its first ~2,000 characters on every turn. A
  simulation of long-recall's shape (`bench.test.ts` has a smaller version) gives these numbers:
  - **Turns 1–13** (up to ~59k characters of history): every view keeps the last one as a prefix.
  - **Turn 14 onwards:** each turn breaks at character 0–2,200 of a ~40k-character view. Writing summaries in
    between doesn't change that.

  Two causes:
  1. **Messages leave the tail.** The oldest full message turns into a line.
  2. **Line levels count from the newest message.** `coverOf` decides which blocks merge (`0+1`, `1+1` into `0+2`)
     counting back from the newest message, so every appended message moves those block boundaries all the way to
     the top.

  Also, a summary arriving from the compactor replaces a fallback line in place.

### Prefix stability isn't enough on its own

As far as I understand Anthropic's prompt caching, it matches exact prefixes at content-block granularity. Entries
are written at cache breakpoints, and a lookup checks only about 20 blocks back from a breakpoint. Hotrod sends the
view and the new message as a single text block. Even a perfectly append-only view therefore can't hit the previous
turn's cache entry, which ended inside a different block (the old prompt with its old "New message" tail). Today a
fresh session can reuse at most tools, system prompt and instructions. Everything from the view on is a cache write
each turn: 1.25× input price, or 2× for 1-hour writes. A native session, by contrast, reads its whole history from
cache and writes only the new turn.

### Suggestions (not implemented)

1. **Send the view in its own content blocks, ahead of the message.** For example one block per stable chunk, and the
   new message last. A turn's prompt then begins with the previous turn's blocks byte for byte. Claude Code takes
   content arrays on stream-json input, so the adapter can do this without engine changes. This is the
   precondition for everything below.
2. **Anchor line levels to the oldest message, not the newest.** Fixed, aligned blocks (`id` a multiple of `n`,
   counted from 0) whose level depends on the block's age bracket, not on the message count. Then appending messages
   doesn't move old boundaries.
3. **Coarsen in epochs, with hysteresis.** Let the tail grow past 40k characters up to, say, 60k. Then fold the oldest
   20k into lines in one step. That gives one cache break every ~20k characters of chat instead of one every turn.
4. **Hold summaries until their epoch.** Keep a fallback line until the next re-layout, so a summary arriving from
   the compactor doesn't rewrite an earlier line in place.
5. **Keep anything volatile out of the instructions,** since they come before the view.
6. **Hybrid sessions:** keep the engine session open while the next view would be the old one plus what this session
   already saw. Restart and re-seed only at an epoch boundary or an engine switch. This keeps rule 5, since Hotrod
   still decides what the session sees. It's the closest to native caching.
7. **Measure the first API call of each turn.** Claude Code reports usage per call. Recording the first call's cache
   read alone would show exactly how much of the seed was reused, separate from the turn's tool loop.

## Limitations

- One sample per task and mode. Real runs are noisy, so repeat them and compare medians.
- The bench allows every permission and declines every question. It also turns off "ask before network commands".
- Native mode also runs the core, so the chat log and the compactor's stubs are still written. Only what the engine
  sees changes.
- The check runs the hidden tests in the sandbox (without `--unsandboxed`). Tests the agent writes can't change
  the hidden ones, but the agent could still edit code to special-case them.
