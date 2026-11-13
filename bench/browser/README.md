# Browser: what agents read

`node bench/browser/measure.ts` measures the text agents get from Kothar's own browser tools: their tool list and
the snapshot of Chrome's accessibility tree (`extensions/browser/snapshot.ts`), on the saved pages in `fixtures/`. It
needs an installed Chromium-family browser, skips without one, and isn't run in CI. `SHOW=1` prints every page's
snapshot. Until the Browser extension dropped Playwright, it ran Playwright MCP beside them; the finding below is from
then.

Tokens are characters / 3.57, the ratio `mcp-filter.ts` measured for Playwright MCP's tool list.

## Finding (13 November 2026, Playwright MCP 0.0.84, Google Chrome 157, macOS)

The tool list every session with the browser pays for, before the agent does anything:

| | Tools | Characters | ~Tokens |
|---|---|---|---|
| Playwright MCP | 25 | 21,060 | 5,899 |
| Playwright MCP behind `mcp-filter.ts` | 21 | 17,340 | 4,857 |
| Kothar's browser tools (`tools.ts`), which replaced it | 7 | 2,901 | 813 |

A page's snapshot, as the agent reads it:

| Page | HTML bytes | Playwright snapshot (~tokens) | Kothar snapshot (~tokens) | Kothar / Playwright |
|---|---|---|---|---|
| news article | 9,317 | 13,033 (~3,651) | 9,029 (~2,529) | 69% |
| checkout form | 4,087 | 5,937 (~1,663) | 2,137 (~599) | 36% |
| issue list (50 rows) | 20,139 | 35,433 (~9,925) | 19,879 (~5,568) | 56% |
| page with a sign-in iframe | 1,218 | 3,077 (~862) | 1,167 (~327) | 38% |

- Kothar's snapshot is a third to two thirds of Playwright's. The less a page is prose, the bigger the saving: an
  article is mostly its own text, which both keep; a form or a list is mostly structure, where Playwright spends a
  ref on every wrapper (`generic [ref=e12]`), a `[cursor=pointer]` on every link and a line of its own for each link's
  `/url`.
- Playwright MCP 0.0.84 no longer puts the snapshot in an action's answer: `browser_navigate`, `browser_click` and the
  like answer in about 300–600 characters and link a `.yml` file holding the snapshot, which the agent then reads
  with its file tool. So every action that the agent follows up costs the whole snapshot again.
- What's left to win is in the tools, not the format: a smaller tool list (the aim is about 1,000 tokens), a size cap
  with a cursor for long pages, and a snapshot of only what changed after an action.
