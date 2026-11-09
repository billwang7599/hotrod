<p align="center">
  <img src="packages/desktop/assets/icon.png" alt="Kothar's icon: a blue anvil and a spark" width="128" height="128">
</p>

<h1 align="center">Kothar</h1>

<p align="center">A desktop app for running coding agents.</p>

Bring your own engines (coding-agent CLIs like Claude Code, Codex and pi) and drive them all from one place. Kothar
keeps a small core and lets you customize the rest with mods, which work with every engine.

## Mods

A mod is written once and works with every engine. It can add panels and commands, react to chats and turns, answer
permission requests, rewrite messages, and run commands, all through Kothar's public mod API.

**Mod documentation:** [mod-documentation/](mod-documentation/index.md) covers using, building and publishing mods and
themes, with the full API reference.

Community mods install from the marketplace in Settings, from their authors' own repos. A mod is code, so it lists what
it uses through the mod API (running programs, reading chats, answering permission requests and so on). Kothar shows
that list before you install it, refuses to start a mod that does more than it listed, and keeps every community mod
off until you turn it on. Mods load when Kothar starts, so turning one on takes a restart.

**Writing a mod or theme:** start from the template
[billwang7599/kothar-sample-mod](https://github.com/billwang7599/kothar-sample-mod) (or
[kothar-themes](https://github.com/billwang7599/kothar-themes#make-your-own-theme) for a theme). Try it with **Install from
folder…** in the Marketplace window (**Browse…** in Settings → Community mods) before you publish, then follow the
[author guide](https://github.com/billwang7599/kothar-marketplace#submit-a-theme-or-mod) to list it.

## Themes

Kothar ships with two themes, Default and Glass. More themes, such as Nord, Catppuccin and Gruvbox, come from the
marketplace in Settings. A theme is a small JSON file of colours, checked before it installs, so it can't change
anything but colours.

The marketplace is a catalog of pointers in its own repo,
[billwang7599/kothar-marketplace](https://github.com/billwang7599/kothar-marketplace). Each entry names its author's own
repo, and Kothar installs from that repo's latest GitHub release, so authors own and update their work without a PR
here. Its README says how to publish and submit a theme or a mod.

## Status

Early development. Nothing to install yet.

**Building the Mac app:** `npm run package` builds `packages/desktop/release/Kothar-<version>-arm64.dmg` (Apple
Silicon). With no signing setup it's ad-hoc signed, which runs on the Mac that built it; elsewhere macOS blocks it until
it's opened with right-click → Open. Signing and notarization switch on with environment variables:

- **Signing** (Developer ID certificate): `CSC_LINK` (path or base64 of a .p12) with `CSC_KEY_PASSWORD`, or `CSC_NAME`
  naming a certificate in the keychain.
- **Notarization** (needs signing too), one of: `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (App Store
  Connect API key), `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN` +
  `APPLE_KEYCHAIN_PROFILE`.

To try a build beside your own Kothar, run it on a throwaway garage:
`KOTHAR_GARAGE=/tmp/k/garage KOTHAR_WORK=/tmp/k/work KOTHAR_USER_DATA=/tmp/k/data KOTHAR_PORT=4391 packages/desktop/release/mac-arm64/Kothar.app/Contents/MacOS/Kothar`.

## License

- **Kothar's core, app and built-in mods:** [Functional Source License 1.1, Apache 2.0 future licence](LICENSE.md)
  (FSL-1.1-ALv2). You may use, copy, modify and redistribute it for any purpose except a competing commercial
  product or service. Two years after each version is released, that version becomes Apache 2.0.
- **The mod API (`packages/mod-api`):** [MIT](packages/mod-api/LICENSE), so mods can use any licence they like.

Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).
