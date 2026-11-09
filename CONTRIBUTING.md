# Contributing

Thanks for helping with Kothar.

## Licence of contributions

Contributions are licensed under the licence of the files they change (inbound = outbound):

- `packages/mod-api/`: MIT ([packages/mod-api/LICENSE](packages/mod-api/LICENSE)).
- Everything else: FSL-1.1-ALv2 ([LICENSE.md](LICENSE.md)).

## Adding a theme to the marketplace

1. Add `marketplace/themes/<id>.json`. Copy an existing theme for the format: every colour token for `dark` and
   `light`, each a hex colour (`#rgb`, `#rrggbb` or `#rrggbbaa`). The id is lowercase letters, digits and dashes.
2. Run `node marketplace/build-index.ts` to update `marketplace/index.json` with the file's checksum and preview.
3. Run `npm test`. The tests check every file, its checksum, and that body and secondary text stay readable.

To change a theme, edit its file, bump its `version`, and rebuild the index.

## Sign-off (DCO)

Sign off every commit to certify the [Developer Certificate of Origin](https://developercertificate.org/), that you
wrote the change or otherwise have the right to submit it under that licence:

```sh
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` line, which must match the commit's author.
