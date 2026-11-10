---
title: Publishing
description: Publish an extension from your own GitHub repo, list it in the Marketplace, and ship updates.
---

# Publishing

You own your extension. It lives in your own GitHub repo, and Kothar installs it from your latest GitHub release. The
Marketplace only holds a pointer to your repo; nothing is ever copied into it.

## 1. Publish a release

An extension's release must carry two assets:

- `manifest.json`
- `main.mjs`, at most 5 MB

One extension per repo. The [sample extension template](https://github.com/billwang7599/kothar-sample-mod) builds and
releases both for you:

1. Bump `version` in `manifest.json`, such as `1.0.0` to `1.1.0`.
2. Push a tag of `v` plus that version:

   ```sh
   git tag v1.1.0
   git push --tags
   ```

3. The release workflow type-checks, builds, checks, and publishes a GitHub release with both files.

Kothar reads your repo's **latest** release: published, not a draft or a pre-release.

Before you publish, try the build in Kothar with **Install from folder…**. See the [Quick start](quick-start.md#5-install-it-in-kothar).

## 2. List it in the Marketplace

The Marketplace's catalog lives in [kothar-marketplace](https://github.com/billwang7599/kothar-marketplace). You submit
once:

1. Open a pull request there that adds one entry to `catalog.json`. Keep entries sorted by `name`.

   ```json
   {
     "id": "word-count",
     "kind": "extension",
     "name": "Word count",
     "author": "Your Name",
     "description": "Notes how many words each reply had.",
     "repo": "you/kothar-word-count"
   }
   ```

   | Field | Rule |
   |---|---|
   | `id` | Your manifest's `id`. Unique in the catalog for its kind. |
   | `kind` | `extension`, or `theme` for a theme. |
   | `name` | Up to 40 characters. |
   | `author` | Up to 60 characters. |
   | `description` | One line, up to 200 characters. |
   | `repo` | `owner/name` of your public GitHub repo. |

2. The repo's **Check** workflow validates the entry, checks that your repo exists, and that its latest release has
   valid assets.
3. A maintainer reviews it. For an extension, that means reading its source and checking that `uses` is honest.

## 3. Ship updates

Publish a new release with a higher `version`. You don't need another pull request.

- Kothar users see **Update** on your entry once your latest release's `version` differs from theirs.
- They update when they choose. Kothar never updates an extension by itself.
- **See changes** shows them GitHub's comparison between their release's tag and your latest one. Write clear release
  notes; the Marketplace shows the start of them.
- If an update lists more in `uses` than before, Kothar turns the extension off until each user turns it on again. Add
  to `uses` only when you must.

Later releases aren't reviewed again. Keep your extension honest: people trusted the version that was reviewed.

## Renaming or removing

To rename your entry or take it down, open a pull request on kothar-marketplace. Removing an entry stops new installs;
people who have it keep it until they uninstall it.

## What review promises

- **Themes** are data. Kothar checks every theme file itself, so a theme can never do more than change colours.
- **Extensions** are code that runs with the user's permissions. Kothar enforces `uses` for the extension API, but can't
  sandbox the extension. Review covers the first release only.

To report a harmful extension or theme, open an issue on
[kothar-marketplace](https://github.com/billwang7599/kothar-marketplace/issues).

## Rate limits

Kothar asks GitHub for each repo's latest release at most once every 10 minutes. Without a token, GitHub allows 60
requests an hour. If you hit the limit while testing, set `KOTHAR_GITHUB_TOKEN` to a GitHub token before starting
Kothar.
