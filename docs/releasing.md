# Releasing GeoLint

GeoLint uses semantic versioning: patches are backward-compatible fixes, minors add backward-compatible functionality, and majors change public Node, CLI, config, plugin, reporter, or persisted-schema contracts. While the repository version is `0.x`, call out compatibility changes explicitly in the changelog.

From a clean checkout:

```sh
npm ci
npm run verify:release
npm pack --dry-run
```

Inspect the tarball list and sizes, update `CHANGELOG.md`, then set the intended version with `npm version`. Only after CI passes should a maintainer run `npm publish --access public`, push the version commit/tag, and create the matching GitHub release. Publishing and pushing are intentionally manual.

`prepack` rebuilds and runs static checks. `prepublishOnly` runs the complete release verification, including the packed-tarball consumer smoke test.
