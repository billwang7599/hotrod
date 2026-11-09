<img src="packages/ui/src/logo.svg" alt="" width="72" height="72">

# Hotrod

A desktop app for running coding agents.

Bring your own engines (coding-agent CLIs like Claude Code, Codex and pi) and drive them all from one place. Hotrod
keeps a small core and lets you customize the rest with mods, which work with every engine.

## Mods

A mod is written once and works with every engine. It can add panels and commands, react to chats and turns, answer
permission requests, rewrite messages, and run commands, all through Hotrod's public mod API. See
[docs/mods.md](docs/mods.md).

## Research questions

- **Is the mod surface enough?** Mods reach engines only through what every engine shares: sessions, prompts,
  streamed output, permission requests and MCP servers. Is that expressive enough for people to build and adopt
  mods?
- **Does owning the context cost too much?** Hotrod starts a fresh engine session for every message, seeded with
  the chat's memory: recent messages in full, older ones as summaries. Compared with an engine keeping its own long
  session, that may cost more tokens, miss prompt-cache reuse when the summaries change, and lose state the engine
  kept. [bench/memory](bench/memory/README.md) measures both on real multi-turn tasks.

## Status

Early development. Nothing to install yet.

## License

[MIT](LICENSE)
