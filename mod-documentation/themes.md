---
title: Themes
description: The Kothar theme format, and how to make and publish a theme.
---

# Themes

A theme is a small JSON file of colours. It runs no code. Kothar checks every theme file before it installs it, so a
theme can only ever change colours.

Kothar ships with two themes, **Default** and **Glass**. More, such as Nord, Catppuccin and Gruvbox, come from the
Marketplace: click **Browse…** in **Settings → Appearance**. Installed themes appear in the theme picker there.

## The format

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "One line about it.",
  "variants": { "dark": "Night", "light": "Day" },
  "dark": {
    "bg": "#1d1f21", "panel": "#25282b", "raised": "#2e3135", "hover": "#373b40", "border": "#373b40",
    "text": "#e6e6e6", "muted": "#b4b7bb", "faint": "#7d8288", "accent": "#5b8def", "on-accent": "#ffffff",
    "green": "#7fbf7f", "amber": "#e3a33b", "red": "#e06c6c"
  },
  "light": {
    "bg": "#ffffff", "panel": "#f4f5f6", "raised": "#ffffff", "hover": "#eceef0", "border": "#dfe2e5",
    "text": "#1d1f21", "muted": "#4f555c", "faint": "#5f656c", "accent": "#2563d9", "on-accent": "#ffffff",
    "green": "#2e7d32", "amber": "#a76a0c", "red": "#c62828"
  }
}
```

| Field | Rule |
|---|---|
| `id` | Lowercase letters, digits and dashes. The file must be named `<id>.json`. |
| `name` | 1 to 40 characters. |
| `version` | Three numbers, like `1.2.3`. |
| `author` | 1 to 60 characters. |
| `description` | One line, 1 to 200 characters. |
| `variants` | Optional. What you call your dark and light palettes, such as Mocha and Latte. Up to 30 characters each. |
| `dark`, `light` | A palette each, with all 13 colours below. |

Every colour is hex: `#rgb`, `#rrggbb` or `#rrggbbaa`. Kothar refuses a file with a missing colour, a colour that isn't
hex, or any field it doesn't know. A theme file may be up to 64 KB.

## The colours

| Colour | Used for |
|---|---|
| `bg` | The page behind everything. |
| `panel` | Sidebars and panels. |
| `raised` | Things that sit above a panel, such as menus and cards. |
| `hover` | What the pointer is over. |
| `border` | Lines and borders. |
| `text` | Main text. |
| `muted` | Secondary text. |
| `faint` | The quietest text, such as hints and timestamps. |
| `accent` | Buttons, links and selection. |
| `on-accent` | Text on `accent`. |
| `green` | Success. |
| `amber` | "Kothar needs you", such as a waiting permission request. Keep `accent` well away from it. |
| `red` | Errors. |

Keep text readable: aim for a contrast of at least 4.5:1 for text on `bg` and `panel`.

## Make and publish a theme

1. Make a repo of your own, or fork [kothar-themes](https://github.com/billwang7599/kothar-themes), with
   `themes/<id>.json`.
2. Copy `scripts/check.mjs` and `.github/` from kothar-themes. `node scripts/check.mjs` checks the format and the
   contrast.
3. Try it in Kothar: open the Marketplace, click **Install from folder…** and pick your `themes/` folder. It installs as
   **Local**.
4. Bump `version`, then push a tag such as `v1.0.0`. The release workflow checks the themes and publishes each one as
   a release asset named `<id>.json`. One release can carry many themes.
5. The first time, add an entry with `"kind": "theme"` to the catalog. See [Publishing](publishing.md#2-list-it-in-the-marketplace).

Later releases reach people without another review: they see **Update** once your latest release has a new `version`.
