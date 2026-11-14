---
title: Depending on other extensions
description: optionalDependencies, requires, a setting's requires, host.extensionEnabled, onDependencyChanged, and sharing an API with provides, host.provide and host.use.
---

# Depending on other extensions

An extension can work with another one: turn a feature on while the other extension is there, grey out a setting while
it isn't, or refuse to run without it. Extensions are named by `id`, such as `browser` for the built-in Browser.
Workers aren't an extension: they're part of Kothar, so any extension can start one with
[`host.createChat`](host.md#start-a-worker) and needs no dependency for it.

| You want | Use |
|---|---|
| A feature that works only while another extension is on, the rest running without it | `optionalDependencies`, checked with `host.extensionEnabled` |
| A setting that means nothing without another extension | `requires` on the setting |
| To hear when another extension is turned on or off | `onDependencyChanged` |
| An extension that's no use at all without another | `requires` on the extension |
| To call another extension's code, whichever extension provides it | [Capabilities](#capabilities-provide-and-use): `provides`, `host.provide`, `host.use` |

Most extensions need none of this: the agent already combines every extension's tools (see
[Working with other extensions](../working-together.md)). Use it when one extension changes how another one looks or
behaves.

Prefer the soft forms. `requires` on the extension stops it outright whenever the other one is off.

## optionalDependencies

```ts
optionalDependencies: ['browser']
```

The extensions this one works with when they're there. Listing them changes nothing about whether it runs. It tells
Kothar to call `onDependencyChanged` when one is turned on or off, and tells readers what the extension works with.

Check whether one runs with `host.extensionEnabled(id)` when the feature runs, not once at start: the user can turn it
off at any time.

## host.extensionEnabled

```ts
host.extensionEnabled(id: string, chatId?: string): boolean
```

Whether the extension with this id runs now. That means it's installed and on in Settings (a community extension only
while community extensions are on too), and everything it `requires` is on. With `chatId`, it also checks the extension
isn't left out of that chat by the chat's setup. It returns `false` for an id Kothar doesn't know.

Any extension can call it; it needs nothing in `uses`.

## A setting's requires

```ts
settings: [
  {
    key: 'screenshots',
    label: 'Add screenshots to the report',
    type: 'boolean',
    default: false,
    requires: 'browser',
  },
]
```

While the extension named by `requires` is off, or isn't installed:

- Settings greys the setting out and says why under it: "Needs the Browser extension". You write no UI for this.
- Kothar refuses to change it, with the same reason.
- The extension reads the setting's **default** in `values`, not the saved value. Code that reads `values.screenshots`
  falls back on its own, with no check of its own.
- The saved value is kept. It comes back when the other extension is turned on again.

`spaceSettings` take `requires` too. They read as their default and refuse changes the same way.

`values` is read when a hook runs. Work that started earlier and keeps a copy of `values` (a long run, say) should read
them again in `onDependencyChanged`, or check `host.extensionEnabled` before each step.

## onDependencyChanged

```ts
onDependencyChanged?(change: { id: string; enabled: boolean }, context: ExtensionContext): void | Promise<void>
```

Called when an extension this one depends on is turned on or off: one in its `optionalDependencies` or `requires`, or
one a setting of its `requires`. It runs after that extension has started or stopped, with `context.values` as they are
now. It's called only while this extension runs; one stopped because an extension it requires went off gets `onStop`
instead.

It's called for the user's switch and for the community extensions switch alike. A community extension lists it under
`events` in its manifest's `uses`.

## requires

```ts
requires: ['browser']
```

The extensions this one can't run without:

- It can't be turned on while one is off. Settings greys its switch out and says which to turn on first, such as
  "Needs the Browser extension". A `setEnabled` from code throws "Turn on Browser first: Web clipper needs it".
- Turning one off stops this extension too (`onStop`, its panels go). Its own switch stays on, so it starts again
  (`onStart`) once everything it requires is back on. Chains work: an extension that requires this one stops with it.
- `host.extensionEnabled` reports it as off meanwhile.

A loop of `requires` (A requires B, B requires A) runs neither.

## Example: a feature that turns on with Browser

```ts
import type { Extension } from '@kothar/extension-api'

const clipper: Extension = {
  id: 'web-clipper',
  name: 'Web clipper',
  description: 'Saves pages the agent reads as notes.',
  enabledByDefault: false,
  optionalDependencies: ['browser'],
  settings: [
    { key: 'screenshots', label: 'Add screenshots to clips', type: 'boolean', default: false, requires: 'browser' },
  ],
  onDependencyChanged({ id, enabled }, { host }) {
    if (id === 'browser' && !enabled) host.activity({ kind: 'other', title: 'Browser went off: clips are text only' })
  },
  tools: [
    {
      name: 'clip_page',
      description: 'Saves a web page as a note, with a screenshot while the Browser extension is on.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      offered: () => true,
      async run(input, { caller, values, host }) {
        // values.screenshots is already false while Browser is off.
        const shot = values.screenshots === true && host.extensionEnabled('browser', caller.id)
        return shot ? `Clipped ${input.url} with a screenshot` : `Clipped ${input.url}`
      },
    },
  ],
}

export default clipper
```

## Capabilities: provide and use

One extension can share an API for others to call, under a **capability** name. Name the capability for what it does
(`research`, `notes`, `search`), not after the extension, so a community extension can provide the same capability
instead of a built-in one, and every extension that uses it keeps working.

```ts
provides: ['search']                       // on the extension that shares it
host.provide('search', api)                // in its onStart (or later)
host.use<SearchApi>('search')              // in any other extension: the API, or undefined
```

- **`provides`** lists the capability names the extension may share. `host.provide` with a name that isn't listed
  throws.
- **`host.provide(name, api)`** shares `api` (any value: an object of functions is usual). Call it in `onStart`: it's
  withdrawn when the extension stops, and `onStart` runs again when it's turned back on. Providing again replaces
  your earlier API.
- **`host.use(name)`** returns the API of the first running extension that provides it, or `undefined` if none does.
  Call it when the feature runs, not once at start, and handle `undefined`: the user can turn the provider off at any
  time. The API is whatever its provider shared, so type it yourself (`host.use<SearchApi>('search')`); a provider
  should document its API's shape.
- **Hear when a provider comes or goes:** list the capability name in `optionalDependencies`. `onDependencyChanged`
  gets `{ id: 'search', enabled }`, where `enabled` says whether `host.use` finds it now.
- `provide` and `use` need nothing listed in a community extension's manifest.

Use a capability when one extension's code must call another's, such as a notes extension asking whichever search
extension is installed to index a note. When the agent could do the combining itself, give both extensions tools
instead (see [Working with other extensions](../working-together.md)).

```ts
import type { Extension } from '@kothar/extension-api'

type SearchApi = { index: (name: string, text: string) => Promise<void> }

const search: Extension = {
  id: 'quick-search',
  name: 'Quick search',
  description: 'Indexes text for fast lookup.',
  enabledByDefault: true,
  provides: ['search'],
  onStart({ host }) {
    const api: SearchApi = { index: async (name, text) => void host.storage.write(`index/${name}`, text) }
    host.provide('search', api)
  },
}

const journal: Extension = {
  id: 'journal',
  name: 'Journal',
  description: 'A daily journal the agent can add to.',
  enabledByDefault: true,
  optionalDependencies: ['search'],
  onDependencyChanged({ id, enabled }, { host }) {
    if (id === 'search' && !enabled) host.activity({ kind: 'other', title: 'No search extension: entries aren’t indexed' })
  },
  tools: [
    {
      name: 'add_journal_entry',
      description: 'Adds an entry to today’s journal.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      offered: () => true,
      async run(input, { host }) {
        await host.use<SearchApi>('search')?.index(`journal-${host.now().toISOString()}`, String(input.text))
        return 'Added'
      },
    },
  ],
}

export { search, journal }
```
